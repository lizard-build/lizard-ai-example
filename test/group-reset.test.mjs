import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {Control} from '../src/control.mjs';
import {Store} from '../src/store.mjs';
import {Bot} from '../src/bot.mjs';
import {GroupChats,GroupMemory} from '../src/groups.mjs';

test('group reset checks admins, keeps data, cuts history and survives active turns and replay',
 {skip:!process.env.TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});t.after(()=>admin.end());
  await admin.query('CREATE DATABASE group_reset_test');
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/group_reset_test';
  const cfg={database:url.toString(),owner:91001,chat:91001,token:'999:test',project:'test',volume:'owner',ratePerMinute:20,maxQueued:20};
  const control=new Control(cfg);await control.start();t.after(()=>control.close());
  const chat=-91002,me={id:999,username:'test_bot'},actor={id:cfg.owner};
  const tg={call:async(method)=>{assert.equal(method,'getChatAdministrators');return [{status:'creator',user:actor}];},send:async()=>{throw new Error('Cancelled output must not be sent');}};
  control.groups=new GroupChats(control,tg,me);
  await control.query(`INSERT INTO control.tenants(user_id,admission,schema_name,volume_name,group_owner)
    VALUES($1,'approved','group_91002','group-files',$2)`,[chat,cfg.owner]);
  const store=new Store(cfg.database,'group_91002');await store.start();t.after(()=>store.close());
  const calls=[];let interruptError=false;
  const runtime={generation:'g',bridgeVersion:2,rpc:async(method,params,key)=>{
    calls.push({method,params,key});
    if(method==='account/read')return {account:{}};
    if(method==='turn/interrupt' && interruptError)throw new Error('Lost connection');
    if(method==='thread/start')return {thread:{id:'new-thread'}};
    return {};
  },reply:async()=>{}};
  const groupCfg={...cfg,owner:chat,chat,groupOwner:cfg.owner};
  const makeBot=()=>{const b=new Bot(groupCfg,store,tg,runtime);b.groupMemory=new GroupMemory(control,chat);return b;};
  let bot=makeBot();
  await bot.saveSession(1,'Shared work');await bot.saveSession(99,'Other topic');
  await store.query("UPDATE sessions SET thread_id=CASE WHEN topic=1 THEN 'old-thread' ELSE 'other-thread' END,model='chosen-model'");
  await store.set('loginAttempt',{loginId:'keep-login'});
  await store.receive([{update_id:50}]);
  await store.query("INSERT INTO prompts(update_id,topic,text,state) VALUES(50,1,'Old queued task','pending')");
  await store.query(`INSERT INTO approvals(id,generation,request_id,topic,method,params)
    VALUES('old-question','g','1',1,'item/tool/requestUserInput','{}')`);
  await store.enqueue('old-output',1,'Old reply');await control.exported(store,chat);
  const stale=(await control.query("SELECT * FROM control.outbox WHERE chat_id=$1",[chat])).rows[0];
  const message=(id,text,from=actor)=>({update_id:id,message:{message_id:id,chat:{id:chat,type:'supergroup'},from,text,date:Math.floor(Date.now()/1000)}});
  await control.receive([message(90,'/reset@test_bot',{id:91003})]);
  assert.equal((await control.query('SELECT 1 FROM control.inbox WHERE update_id=90')).rowCount,0);
  // A command addressed to another bot must not reset this one.
  await control.receive([message(91,'/reset@other_bot')]);
  assert.equal((await control.query('SELECT 1 FROM control.inbox WHERE update_id=91')).rowCount,0);
  const reset=message(100,'/reset@test_bot');
  await control.receive([reset]);
  const routed=(await control.query('SELECT payload FROM control.inbox WHERE update_id=100')).rows[0].payload;
  assert.equal(routed.group_reset_authorized,true);
  await bot.handle({...routed,group_reset_authorized:false});
  assert.equal((await bot.session(1)).thread_id,'old-thread');
  await store.receive([routed]);await bot.handle(routed);
  const session=await bot.session(1);
  assert.equal(session.thread_id,null);assert.equal(Number(session.context_after),100);
  assert.equal(session.cwd,'/workspace/sessions/1');assert.equal(session.model,'chosen-model');
  assert.equal((await bot.session(99)).thread_id,'other-thread');
  assert.deepEqual(await store.get('loginAttempt'),{loginId:'keep-login'});
  assert.equal((await store.query('SELECT thread_id FROM session_resets WHERE update_id=100')).rows[0].thread_id,'old-thread');
  assert.equal((await store.query('SELECT state FROM prompts WHERE update_id=50')).rows[0].state,'cancelled');
  assert.equal((await store.query("SELECT state FROM approvals WHERE id='old-question'")).rows[0].state,'expired');
  await control.deliver(tg,stale);
  assert.equal((await control.query('SELECT failed FROM control.outbox WHERE id=$1',[stale.id])).rows[0].failed,true);
  // The new context excludes old recent messages, search hits and quoted replies.
  for(const [id,text] of [[95,'OldProject decision before reset'],[101,'NewProject decision after reset']])
    await control.groups.record(control.pool,chat,message(id,text).message);
  const next={...message(102,'OldProject NewProject'),group_authorized:true};
  next.message.message_thread_id=1;
  next.message.reply_to_message=message(95,'OldProject decision before reset').message;
  await store.receive([next]);await bot.handle(next);
  const prompt=(await store.query('SELECT input FROM prompts WHERE update_id=102')).rows[0];
  assert.doesNotMatch(prompt.input[0].text,/OldProject decision/);assert.match(prompt.input[0].text,/NewProject decision/);
  assert.equal((await bot.session(1)).thread_id,'new-thread');
  assert.equal(calls.find(c=>c.method==='thread/start').params.cwd,session.cwd);
  const history=await bot.groupMemory.search({query:'OldProject'},100);assert.equal(history.length,0);
  assert.equal((await bot.groupMemory.search({query:'OldProject'})).length,1,'stored history remains available to other sessions');
  // Replaying the same update cannot detach the new thread.
  await bot.handle(routed);assert.equal((await bot.session(1)).thread_id,'new-thread');
  const count=async()=>Number((await store.query('SELECT count(*) FROM outbox')).rows[0].count);
  const before=await count();
  await bot.event({seq:1,generation:'g',data:{method:'item/completed',params:{threadId:'old-thread',item:{type:'agentMessage',text:'Late old answer'}}}});
  assert.equal(await count(),before);
  // Active resets wait for a terminal event, including across a worker restart.
  await store.query("UPDATE sessions SET turn_id='active-turn' WHERE topic=1");
  await store.query("UPDATE prompts SET state='running',turn_id='active-turn' WHERE update_id=102");
  await control.receive([message(200,'/reset')]);
  const activeReset=(await control.query('SELECT payload FROM control.inbox WHERE update_id=200')).rows[0].payload;
  interruptError=true;await assert.rejects(bot.handle(activeReset),/Lost connection/);
  assert.equal((await bot.session(1)).reset_pending,true);
  interruptError=false;bot=makeBot();await bot.finishResets();
  assert.equal((await bot.session(1)).thread_id,'new-thread');
  assert.equal(calls.at(-1).key,'reset:200:interrupt');
  await bot.startPrompts();assert.equal(calls.some(c=>c.method==='turn/start'),false);
  const during=await count();
  await bot.event({seq:2,generation:'g',data:{method:'item/completed',params:{threadId:'new-thread',item:{type:'agentMessage',text:'Late running answer'}}}});
  await bot.stream({generation:'g',threadId:'new-thread',turnId:'active-turn',itemId:'late',text:'Late stream'});
  assert.equal(await count(),during);
  await bot.event({seq:3,generation:'g',data:{method:'turn/completed',params:{threadId:'new-thread',turn:{id:'active-turn',status:'interrupted'}}}});
  await bot.finishResets();await bot.finishResets();
  assert.equal((await bot.session(1)).reset_pending,false);assert.equal((await bot.session(1)).thread_id,null);
  const done=(await store.query("SELECT text FROM outbox WHERE dedup_key='reset:200:done'")).rows;
  assert.equal(done.length,1);assert.match(done[0].text,/Conversation reset/);
  assert.equal((await bot.session(99)).thread_id,'other-thread');
});
