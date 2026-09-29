import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {Telegram} from '../src/telegram.mjs';
import {Control} from '../src/control.mjs';
import {Store} from '../src/store.mjs';
import {Bot} from '../src/bot.mjs';
import {Delivery} from '../src/streaming.mjs';

test('native thinking uses a stable private draft, safe fallback and no unsupported group calls',async()=>{
  const calls=[];
  const tg=new Telegram('test',async(url,options)=>{
    const method=url.split('/').at(-1);calls.push({method,body:JSON.parse(options.body)});
    return {json:async()=>({ok:method==='sendMessageDraft',error_code:400,result:true})};
  });
  assert.equal(await tg.thinking(-123,1,42),false);assert.equal(calls.length,0);
  assert.equal(await tg.thinking(123,55,42),true);
  assert.deepEqual(calls[0].body.rich_message,{blocks:[{type:'thinking',text:'Thinking…'}]});
  assert.equal(calls[0].body.can_stop,false,'no nonfunctional native Stop button');
  assert.equal(calls[1].body.text,'');assert.equal(calls[1].body.draft_id,42);
  const limited=new Telegram('test',async()=>({json:async()=>({ok:false,error_code:429,parameters:{retry_after:4}})}));
  await assert.rejects(limited.thinking(123,55,42),e=>e.retryAfter===4);
});

test('thinking refreshes without delaying answers, uses one group bubble and ends on questions and stop',
 {skip:!process.env.TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});t.after(()=>admin.end());
  await admin.query('CREATE DATABASE thinking_test');
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/thinking_test';
  const cfg={database:url.toString(),owner:123,chat:123,token:'123:test',project:'test',volume:'owner'};
  const control=new Control(cfg);await control.start();t.after(()=>control.close());
  const store=new Store(cfg.database);await store.start();t.after(()=>store.close());
  const calls=[];let messageId=400;
  const tg=new Telegram('test',async(url,options)=>{
    const method=url.split('/').at(-1),body=JSON.parse(options.body);calls.push({method,body});
    return {json:async()=>({ok:true,result:method.endsWith('Draft')?true:{message_id:body.message_id || ++messageId}})};
  });
  let now=Date.now();const delivery=new Delivery(control,tg,()=>now);
  const send=async()=>{now+=2000;await control.exported(store,123);await delivery.tick();await delivery.drain();};
  await store.receive([{update_id:10}]);
  await store.query("INSERT INTO sessions(topic,title,thread_id,cwd) VALUES(55,'Test','thread','/workspace/sessions/55')");
  await store.query("INSERT INTO prompts(update_id,topic,text,state) VALUES(10,55,'Hello','pending')");
  const runtime={generation:'g',rpc:async method=>method==='turn/start'?{turn:{id:'turn'}}:{},reply:async()=>{}};
  const bot=new Bot(cfg,store,tg,runtime);
  await bot.startPrompts();await send();
  assert.equal(calls.at(-1).method,'sendRichMessageDraft');
  const draftId=calls.at(-1).body.draft_id;
  const count=calls.length;await send();assert.equal(calls.length,count,'no refresh before 20 seconds');
  await control.query("UPDATE control.outbox SET thinking_refreshed_at=now()-interval '21 seconds'");
  await send();assert.equal(calls.at(-1).body.draft_id,draftId,'refresh keeps the same draft');
  await bot.stream({generation:'g',threadId:'thread',turnId:'turn',itemId:'answer',text:'Hello there '});
  await send();assert.equal(calls.at(-1).method,'sendRichMessage','answer does not wait for the refresh deadline');
  const answerId=calls.at(-1).body.message_id || messageId;
  await bot.event({seq:1,generation:'g',data:{method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',id:'answer',text:'Hello there!'}}}});
  await send();assert.equal(calls.at(-1).method,'editMessageText');assert.equal(calls.at(-1).body.message_id,answerId);
  await control.query("UPDATE control.outbox SET thinking_refreshed_at=now()-interval '21 seconds'");
  const finished=calls.length;await send();assert.equal(calls.length,finished,'final output never reverts to thinking');
  // A cold-start status already on screen stays in that same bubble.
  await store.progress(20,66,'Getting ready…');await send();const coldId=messageId;
  await store.progress(20,66,'Thinking…',{thinking:true});await send();
  assert.equal(calls.at(-1).method,'editMessageText');assert.equal(calls.at(-1).body.message_id,coldId);
  // Questions pause refresh, and a stopped task resolves its placeholder.
  await store.progress(30,77,'Thinking…',{thinking:true});await send();
  await bot.questions.show({id:'question',topic:77,params:{questions:[{id:'choice',question:'Which one?',options:[]}]}});
  assert.equal((await store.query("SELECT extra FROM outbox WHERE dedup_key='progress:30'")).rows[0].extra.thinking,undefined);
  await store.progress(10,55,'Thinking…',{thinking:true});
  await bot.handle({update_id:31,message:{from:{id:123},chat:{id:123,type:'private'},message_thread_id:55,text:'/stop'}});
  assert.equal((await store.query("SELECT extra FROM outbox WHERE dedup_key='progress:10'")).rows[0].extra.thinking,undefined);
  // Groups use a real message and then edit it; no draft-only API is used.
  await control.query("INSERT INTO control.tenants(user_id,admission,schema_name,volume_name,group_owner) VALUES(-123,'approved','group_123','group',123)");
  await control.query(`INSERT INTO control.outbox(dedup_key,chat_id,topic,text,extra) VALUES('group-thinking',-123,NULL,'Thinking…','{"progress":true,"thinking":true}')`);
  const groupRow=async()=>(await control.query("SELECT * FROM control.outbox WHERE dedup_key='group-thinking'")).rows[0];
  await control.deliver(tg,await groupRow());assert.equal(calls.at(-1).method,'sendMessage');const groupId=messageId;
  await control.query(`UPDATE control.outbox SET text='Group answer',extra='{"progress":true,"rich":true}',revision=2 WHERE dedup_key='group-thinking'`);
  await control.deliver(tg,await groupRow());assert.equal(calls.at(-1).method,'editMessageText');assert.equal(calls.at(-1).body.message_id,groupId);
  assert.equal(calls.some(c=>c.method.endsWith('Draft')&&Number(c.body.chat_id)<0),false);
});
