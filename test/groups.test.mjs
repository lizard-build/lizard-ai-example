import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {Control} from '../src/control.mjs';
import {Store} from '../src/store.mjs';
import {Bot} from '../src/bot.mjs';
import {TenantWorker} from '../src/worker.mjs';
import {Telegram} from '../src/telegram.mjs';
import {config,authorized} from '../src/core.mjs';
import {GroupChats,GroupMemory,addressedToBot,groupTopic} from '../src/groups.mjs';

const me={id:999,is_bot:true,username:'Lizard_AI_bot',first_name:'Lizard AI'};
const sender={id:930002,first_name:'Maya'};
const mention=text=>({text,entities:[{type:'mention',offset:text.indexOf('@'),length:14}]});
test('an ordinary bot verifies current human admins without getChatMember',async()=>{
  let members=[{user:{id:101},status:'creator'},{user:{id:102},status:'administrator'},
    {user:{id:103},status:'member'}];
  const groups=new GroupChats({}, {call:async(method,body)=>{
    assert.equal(method,'getChatAdministrators');assert.deepEqual(body,{chat_id:-22});
    return members;
  }},me);
  assert.equal(await groups.isAdmin(-22,101),true);
  assert.equal(await groups.isAdmin(-22,102),true);
  assert.equal(await groups.isAdmin(-22,103),false);
  assert.equal(await groups.isAdmin(-22,104),false);
  members=[];
  assert.equal(await groups.isAdmin(-22,102),false,'revocation takes effect on the next check');
});
test('admin verification denies access on API errors and invalid responses',async()=>{
  for(const result of [null,{},[{status:'administrator'}],[{user:{id:101},status:'left'}]]) {
    const groups=new GroupChats({}, {call:async()=>result},me);
    assert.equal(await groups.isAdmin(-22,101),false);
  }
  const groups=new GroupChats({}, {call:async()=>{throw new Error('Telegram unavailable');}},me);
  assert.equal(await groups.isAdmin(-22,101),false);
});
test('group triggers use Telegram entities, exact bot identity and human senders',()=>{
  assert.ok(addressedToBot({from:sender,...mention('🦎 @Lizard_AI_bot build it')},me));
  assert.ok(addressedToBot({from:sender,text:'/status@Lizard_AI_bot',entities:[{type:'bot_command',offset:0,length:21}]},me));
  assert.ok(addressedToBot({from:sender,reply_to_message:{from:me}},me));
  assert.ok(addressedToBot({from:sender,text:'Bot',entities:[{type:'text_mention',offset:0,length:3,user:me}]},me));
  assert.equal(addressedToBot({from:sender,text:'@Lizard_AI_bot',entities:[]},me),false,'quoted/plain text is not a mention');
  assert.equal(addressedToBot({from:{...sender,is_bot:true},...mention('@Lizard_AI_bot hi')},me),false);
  assert.equal(addressedToBot({from:sender,sender_chat:{id:-1},...mention('@Lizard_AI_bot hi')},me),false);
  assert.equal(addressedToBot({from:sender,reply_to_message:{from:{id:888,is_bot:true}}},me),false);
  assert.equal(groupTopic({message_thread_id:99}),1,'reply chains are not forum topics');
  assert.equal(groupTopic({is_topic_message:true,message_thread_id:99}),99);
  assert.equal(authorized({message:{from:sender,chat:{id:-22,type:'supergroup'}}},{groupOwner:930001,chat:-22}),false);
});
test('main group messages omit a synthetic thread ID on Telegram calls and documents',async()=>{
  const sent=[];
  const tg=new Telegram('999:test',async(_url,opts)=>{sent.push(opts.body instanceof FormData ? Object.fromEntries(opts.body) : JSON.parse(opts.body));return {json:async()=>({ok:true,result:{message_id:1}})};});
  await tg.send(-22,1,'Hello');await tg.typing(-22,1);await tg.document(-22,1,'test.txt',Buffer.from('hi'));
  assert.ok(sent.every(x=>!('message_thread_id' in x)));
  await tg.send(-22,77,'Forum');assert.equal(sent.at(-1).message_thread_id,77);
  await tg.send(930001,1,'Private topic');assert.equal(sent.at(-1).message_thread_id,1);
});

test('group activation, passive memory, shared tasks, questions, login and disconnection stay isolated',
 {skip:!process.env.TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});t.after(()=>admin.end());
  await admin.query('CREATE DATABASE groups_test');
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/groups_test';
  const cfg=config({TELEGRAM_BOT_TOKEN:'999:test',TELEGRAM_OWNER_ID:'930001',DATABASE_URL:url.toString(),LIZARD_API_KEY:'private-controller',LIZARD_PROJECT_ID:'test',OPENAI_API_KEY:'owner-only'});
  const control=new Control(cfg);await control.start();t.after(()=>control.close());
  const calls=[];let sentId=500;
  const telegram={call:async(method,body)=>{calls.push([method,body]);assert.notEqual(method,'getChatMember');return method==='getChatAdministrators'?[{status:'administrator',user:{id:cfg.owner}}]:{};},
    send:async()=>({message_id:++sentId}),update:async(_chat,_topic,_text,_extra,ids,checkpoint)=>{const next=ids.length?ids:[++sentId];await checkpoint(next);return next;}};
  control.groups=new GroupChats(control,telegram,me);
  const chat=-930010,other=-930020;
  const message=(id,text,opts={})=>({update_id:id,message:{message_id:id,chat:{id:chat,type:'supergroup',title:'Shared build'},from:sender,date:Math.floor(Date.now()/1000),text,...opts}});
  await control.receive([message(1,'/connect')]);assert.equal(await control.tenant(chat),undefined);
  const notice=(await control.query("SELECT * FROM control.outbox WHERE dedup_key='group:1'")).rows[0];
  await control.deliver(telegram,notice);assert.equal(sentId,501,'unconnected groups still receive setup guidance');
  await control.receive([message(2,'/connect',{from:{id:cfg.owner}})]);
  const tenant=await control.tenant(chat);assert.equal(tenant.admission,'approved');assert.equal(tenant.schema_name,'group_930010');
  assert.equal(tenant.volume_name,'tg-group-930010');assert.equal(Number(tenant.group_owner),cfg.owner);
  await control.receive([message(3,'We decided to use Postgres. The deadline is Friday.'),message(4,'hello @OtherBot',{entities:[{type:'mention',offset:6,length:9}]})]);
  assert.equal((await control.query('SELECT count(*) FROM control.inbox WHERE user_id=$1',[chat])).rows[0].count,'0');
  assert.equal((await control.tenant(chat)).has_work,false);
  assert.equal((await control.tenant(chat)).last_activity.getTime(),tenant.last_activity.getTime(),'passive conversation does not keep compute alive');
  const addressed=message(5,'@Lizard_AI_bot remind me of the deadline',mention('@Lizard_AI_bot remind me of the deadline'));
  await control.receive([addressed,addressed]);
  const row=(await control.query('SELECT payload FROM control.inbox WHERE update_id=5')).rows[0];
  assert.equal(row.payload.message.text,'remind me of the deadline');assert.equal(row.payload.message.message_thread_id,1);
  assert.equal(row.payload.group_authorized,true);
  assert.equal((await control.query('SELECT count(*) FROM control.inbox WHERE update_id=5')).rows[0].count,'1');
  assert.equal(await control.tenant(sender.id),undefined,'participants need no personal account');
  await control.receive([{update_id:6,edited_message:{...addressed.message,message_id:3,text:'We decided to use Postgres. The deadline is Monday.'}}]);
  assert.equal((await control.query('SELECT text FROM control.group_messages WHERE chat_id=$1 AND message_id=3',[chat])).rows[0].text.includes('Monday'),true);
  assert.equal((await control.query('SELECT count(*) FROM control.inbox WHERE update_id=6')).rows[0].count,'0','edits never rerun tasks');
  await control.receive([{...message(7,'/connect',{from:{id:cfg.owner}}),message:{...message(7,'/connect',{from:{id:cfg.owner}}).message,chat:{id:other,type:'group',title:'Other group'}}}]);
  await control.groups.record(control.pool,other,{message_id:8,from:sender,text:'Other group secret deadline',date:Math.floor(Date.now()/1000)});
  const worker=new TenantWorker(cfg,control,telegram,tenant,class {});
  assert.equal(worker.cfg.openaiKey,undefined);assert.notEqual(worker.cfg.volume,cfg.volume);assert.equal(worker.cfg.owner,chat);
  const store=worker.store;await store.start();t.after(()=>store.close());
  let connected=true;
  const rpc=[],replies=[];
  const runtime={generation:'group-test',bridgeVersion:2,rpc:async(method,params)=>{
    rpc.push([method,params]);
    if(method==='account/read') return {account:connected?{}:null};
    if(method==='account/login/start')return {loginId:'group-login',verificationUrl:'https://auth.openai.com/codex/device',userCode:'GROUP-CODE'};
    if(method==='thread/start')return {thread:{id:'group-thread'}};
    return {};
  },reply:async(...args)=>replies.push(args)};
  const bot=new Bot(worker.cfg,store,telegram,runtime);bot.groupMemory=new GroupMemory(control,chat);
  await store.receive([row.payload]);await bot.handle(row.payload);
  const prompt=(await store.query('SELECT * FROM prompts WHERE update_id=5')).rows[0];
  assert.match(prompt.input[0].text,/Monday/);assert.doesNotMatch(prompt.input[0].text,/Other group secret/);
  assert.equal(prompt.input.at(-1).text,'remind me of the deadline');
  assert.equal(rpc.find(x=>x[0]==='thread/start')[1].dynamicTools.some(x=>x.name==='telegram_group_history'),true);
  await bot.event({generation:runtime.generation,seq:1,data:{id:42,method:'item/tool/call',params:{threadId:'group-thread',tool:'telegram_group_history',arguments:{query:'Postgres'}}}});
  assert.match(JSON.stringify(replies.at(-1)),/Monday/);assert.doesNotMatch(JSON.stringify(replies.at(-1)),/Other group secret/);
  const aid='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  await store.query(`INSERT INTO approvals(id,generation,request_id,topic,method,params) VALUES($1,$2,'1',1,'item/tool/requestUserInput',$3)`,
    [aid,runtime.generation,JSON.stringify({questions:[{id:'color',question:'Which color?',options:[{label:'Blue',description:'Calm'}]}]})]);
  await bot.questions.show((await store.query('SELECT * FROM approvals WHERE id=$1',[aid])).rows[0]);
  await control.exported(store,chat);
  const question=(await control.query("SELECT * FROM control.outbox WHERE chat_id=$1 AND text LIKE '%Which color%'",[chat])).rows[0];
  await control.deliver(telegram,question);
  await bot.questions.callback({id:'custom-choice',message:{message_thread_id:1}},['',aid,'0','other']);
  await control.exported(store,chat);
  const custom=(await control.query("SELECT * FROM control.outbox WHERE chat_id=$1 AND text='Which color?'",[chat])).rows[0];
  await control.deliver(telegram,custom);
  const replyId=sentId;
  await control.receive([message(9,'Blue',{reply_to_message:{message_id:replyId,from:me}})]);
  const answer=(await control.query('SELECT payload FROM control.inbox WHERE update_id=9')).rows[0].payload;
  assert.equal(answer.group_question_id,aid);
  await bot.handle(answer);assert.equal((await store.query('SELECT state FROM approvals WHERE id=$1',[aid])).rows[0].state,'answered');
  const replyCount=replies.length;await bot.handle({...answer,update_id:90});
  assert.equal(replies.length,replyCount,'a stale reply cannot answer twice or start another task');
  assert.equal((await store.query('SELECT count(*) FROM prompts WHERE update_id=90')).rows[0].count,'0');
  // A non-owner cannot start account authorization, even though everyone can task the group.
  await control.receive([message(10,'/login@Lizard_AI_bot',{entities:[{type:'bot_command',offset:0,length:20}]})]);
  assert.equal((await control.query('SELECT count(*) FROM control.inbox WHERE update_id=10')).rows[0].count,'0');
  connected=false;
  await control.receive([message(11,'/login@Lizard_AI_bot',{from:{id:cfg.owner},entities:[{type:'bot_command',offset:0,length:20}]})]);
  const login=(await control.query('SELECT payload FROM control.inbox WHERE update_id=11')).rows[0].payload;
  await bot.handle(login);await control.exported(store,chat);
  const codes=(await control.query("SELECT chat_id,topic,extra FROM control.outbox WHERE text LIKE '%GROUP-CODE%'")).rows;
  assert.equal(codes.length,1);assert.equal(Number(codes[0].chat_id),cfg.owner);assert.equal(codes[0].topic,null);assert.equal(codes[0].extra.privateChat,undefined);
  assert.equal((await store.query('SELECT title_captured FROM sessions WHERE topic=1')).rows[0].title_captured,false);
  await bot.syncTitles();assert.ok(!calls.some(c=>c[0]==='editForumTopic'));
  await control.receive([message(12,'@Lizard_AI_bot this topic',{...mention('@Lizard_AI_bot this topic'),is_topic_message:true,message_thread_id:77})]);
  const forum=(await control.query('SELECT payload FROM control.inbox WHERE update_id=12')).rows[0].payload;
  assert.equal(forum.message.message_thread_id,77);
  assert.equal(forum.group_question_id,undefined);
  const memory=new GroupMemory(control,chat);
  await control.groups.record(control.pool,chat,{message_id:1000,from:sender,text:'Expired context',date:Math.floor(Date.now()/1000)-91*86400});
  assert.equal((await memory.search({query:'Expired'})).length,0);
  for(let id=1001;id<=1008;id++) await control.groups.record(control.pool,chat,{message_id:id,from:sender,text:'Large '+('x'.repeat(5900)),date:Math.floor(Date.now()/1000)});
  assert.ok(JSON.stringify(await memory.search({limit:50})).length<24500);
  await assert.rejects(memory.search({before:-1}),/Invalid/);
  await assert.rejects(memory.search({query:'x'.repeat(301)}),/Invalid/);
  assert.equal((await memory.search({query:'"; DROP TABLE users; --'})).length,0);
  await control.receive([{update_id:13,my_chat_member:{chat:{id:chat,type:'supergroup'},new_chat_member:{status:'left'}}},message(14,'@Lizard_AI_bot ignored',mention('@Lizard_AI_bot ignored'))]);
  assert.equal((await control.tenant(chat)).admission,'blocked');
  assert.equal((await control.query('SELECT count(*) FROM control.group_messages WHERE chat_id=$1 AND message_id=14',[chat])).rows[0].count,'0');
  const previous=sentId;await control.deliver(telegram,question);assert.equal(sentId,previous,'no late replies after removal');
});
