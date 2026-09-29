import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {Control} from '../src/control.mjs';
import {Store} from '../src/store.mjs';
import {Bot} from '../src/bot.mjs';
import {Telegram} from '../src/telegram.mjs';

test('startup message becomes the first streamed reply, survives recovery and keeps newer edits pending',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});t.after(()=>admin.end());
  await admin.query('CREATE DATABASE progress_test');
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/progress_test';
  const cfg={database:url.toString(),owner:123,chat:123,token:'123:test',project:'test',volume:'owner'};
  const control=new Control(cfg);await control.start();t.after(()=>control.close());
  // Old topics must not get renamed on the next message after migration.
  await control.query("CREATE TABLE public.sessions(topic bigint PRIMARY KEY,title text NOT NULL,thread_id text UNIQUE,cwd text NOT NULL,model text,archived boolean NOT NULL DEFAULT false,turn_id text,created_at timestamptz DEFAULT now())");
  await control.query("INSERT INTO public.sessions(topic,title,cwd) VALUES(54,'An existing title that the user chose and wants to keep','/old')");
  let store=new Store(cfg.database);await store.start();t.after(()=>store.close());
  const calls=[];let messageId=400;
  const telegram=new Telegram('test',async(url,opts)=>{
    const method=url.split('/').at(-1),body=JSON.parse(opts.body);calls.push({method,body});
    return {json:async()=>({ok:true,result:{message_id:body.message_id || ++messageId}})};
  });
  const runtime={generation:'g',rpc:async method=>method==='account/read'?{account:{}}:method==='thread/start'?{thread:{id:'thread'}}:method==='turn/start'?{turn:{id:'turn'}}:{}};
  let bot=new Bot(cfg,store,telegram,runtime);
  await bot.captureTitle(54,'Do not replace the old title',1);await bot.syncTitles();
  assert.equal(calls.length,0);
  const update={update_id:10,message:{from:{id:123},chat:{id:123,type:'private'},message_thread_id:55,text:'The first task'}};
  await store.receive([update]);await store.progress(10,55,'Getting ready to help…');
  const outbox=async()=>(await control.query('SELECT * FROM control.outbox ORDER BY id')).rows;
  await control.exported(store,123);await control.deliver(telegram,(await outbox())[0]);
  assert.equal(calls.at(-1).method,'sendMessage');const firstId=(await outbox())[0].message_ids[0];
  await bot.say('update:10:transcribing',55,'Transcribing your voice message…');
  assert.equal((await store.query("SELECT count(*)::int AS n FROM outbox WHERE topic=55")).rows[0].n,1);
  await bot.handle(update);await bot.syncTitles();await bot.startPrompts();
  const stream={generation:'g',threadId:'thread',turnId:'turn',itemId:'item',text:'**The answer'};
  await bot.stream(stream);await control.exported(store,123);
  await control.deliver(telegram,(await outbox())[0]);
  assert.equal(calls.at(-1).method,'editMessageText');assert.equal(calls.at(-1).body.message_id,firstId);
  assert.equal(calls.some(c=>c.method==='sendRichMessageDraft'),false);
  await store.close();store=new Store(cfg.database);await store.start();bot=new Bot(cfg,store,telegram,runtime);
  await bot.captureTitle(55,'Later task',11);await bot.syncTitles();
  assert.equal(calls.filter(c=>c.method==='editForumTopic').length,1);
  assert.equal((await bot.session(55)).title,'The first task');
  await bot.stream({...stream,text:'**The answer** is ready'});await control.exported(store,123);
  const old=(await outbox())[0];
  const complete={seq:1,generation:'g',data:{method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'item',type:'agentMessage',text:'**Final answer**'}}}};
  await bot.event(complete);await bot.event(complete);await control.exported(store,123);
  await control.deliver(telegram,old);assert.equal((await outbox())[0].sent,false,'in-flight older edit must not swallow the final answer');
  await control.deliver(telegram,(await outbox())[0]);
  assert.equal(calls.at(-1).body.rich_message.markdown,'**Final answer**');
  assert.equal(calls.at(-1).body.message_id,firstId);assert.deepEqual(calls.at(-1).body.reply_markup,{inline_keyboard:[]});
  assert.equal(calls.filter(c=>c.method==='sendMessage'||c.method==='sendRichMessage').length,1);
  // A later model message is a separate message; it must not overwrite the first.
  await bot.event({...complete,seq:2,data:{...complete.data,params:{...complete.data.params,item:{id:'later-item',type:'agentMessage',text:'Follow-up'}}}});
  assert.equal((await store.query("SELECT text FROM outbox WHERE dedup_key='event:2'")).rows[0].text,'Follow-up');
  assert.equal((await store.query("SELECT text FROM outbox WHERE dedup_key='progress:10'")).rows[0].text,'**Final answer**');
  // Different topics and tenants never share the message receipt.
  await store.progress(20,66,'Getting ready to help…');await control.exported(store,123);
  const other=(await outbox()).find(r=>Number(r.topic)===66);assert.deepEqual(other.message_ids,[]);
  assert.equal(await store.progressForTurn('turn',66,'item'),null);
  await store.receive([{update_id:20}]);await bot.saveSession(66,'Failure test');
  await store.query("UPDATE sessions SET thread_id='failed-thread',turn_id='failed-turn' WHERE topic=66");
  await store.query("INSERT INTO prompts(update_id,topic,text,turn_id,state) VALUES(20,66,'Task','failed-turn','running')");
  await bot.event({seq:3,generation:'g',data:{method:'turn/completed',params:{threadId:'failed-thread',turn:{id:'failed-turn',status:'interrupted'}}}});
  assert.equal((await store.query("SELECT text FROM outbox WHERE dedup_key='progress:20'")).rows[0].text,'Task stopped.');
  assert.equal((await store.query("SELECT 1 FROM outbox WHERE dedup_key='event:3'")).rowCount,0);
  // Provider failures replace the same progress bubble and remain literal text.
  const providerError={message:'This content was flagged for possible cybersecurity risk. <b>Literal</b>',codexErrorInfo:'cyberPolicy'};
  const failed={seq:4,generation:'g',data:{method:'turn/completed',params:{threadId:'failed-thread',turn:{id:'failed-turn',status:'failed',error:providerError}}}};
  await bot.event(failed);await bot.event(failed);
  const failureRow=(await store.query("SELECT * FROM outbox WHERE dedup_key='progress:20'")).rows[0];
  assert.match(failureRow.text,/cyberPolicy/);assert.ok(failureRow.text.includes(providerError.message));
  assert.equal(failureRow.extra.rich,false);
  assert.equal((await store.query("SELECT 1 FROM outbox WHERE dedup_key='event:4'")).rowCount,0);
  await control.exported(store,123);await control.deliver(telegram,(await outbox()).find(r=>Number(r.topic)===66));
  assert.equal(calls.at(-1).body.rich_message,undefined);
  assert.ok(calls.at(-1).body.text.includes(providerError.message));
  // A manual title, even a long one, must not trigger automatic shortening later.
  await bot.handle({update_id:29,message:{...update.message,text:undefined,forum_topic_edited:{name:'A long title explicitly chosen by the user'}}});
  await bot.syncTitles();assert.equal(calls.filter(c=>c.method==='editForumTopic').length,1);
  // Voice that cannot be transcribed still consumes the first-message opportunity.
  runtime.rpc=async()=>({account:null,requiresOpenaiAuth:true});
  await bot.handle({update_id:30,message:{...update.message,message_thread_id:77,text:undefined,voice:{file_id:'voice',duration:2}}});
  await bot.handle({update_id:31,message:{...update.message,message_thread_id:77,text:'Later text'}});
  assert.equal((await bot.session(77)).first_message_title,null);
  // Coalescing a newer answer must preserve the Telegram rate-limit deadline.
  await control.query("UPDATE control.outbox SET next_attempt=now()+interval '30 seconds' WHERE dedup_key=$1",[`tenant:123:${(await store.query("SELECT id FROM outbox WHERE dedup_key='progress:10'")).rows[0].id}`]);
  const deadline=(await outbox())[0].next_attempt;
  await store.progress(10,55,'A newer final answer',{rich:true});await control.exported(store,123);
  assert.equal((await outbox())[0].next_attempt.getTime(),deadline.getTime());
  // Warm replies also keep one Telegram message, including after worker recovery.
  await bot.saveSession(88,'Warm reply');
  await store.query("UPDATE sessions SET thread_id='warm-thread',turn_id='warm-turn' WHERE topic=88");
  const warm={generation:'g',threadId:'warm-thread',turnId:'warm-turn',itemId:'warm-item',text:'Hel'};
  const warmRows=async()=>(await outbox()).filter(r=>Number(r.topic)===88);
  await bot.stream(warm);await control.exported(store,123);
  assert.equal((await warmRows()).length,0,'wait for the first whole word');
  await bot.stream({...warm,text:'Hello '});await control.exported(store,123);
  await control.deliver(telegram,(await warmRows())[0]);
  const warmId=(await warmRows())[0].message_ids[0];
  assert.equal(calls.at(-1).method,'sendRichMessage');
  assert.equal(calls.at(-1).body.reply_markup.inline_keyboard[0][0].text,'Stop');
  await store.close();store=new Store(cfg.database);await store.start();bot=new Bot(cfg,store,telegram,runtime);
  await bot.stream({...warm,text:'Hello world '});await control.exported(store,123);
  await control.deliver(telegram,(await warmRows())[0]);
  assert.equal(calls.at(-1).method,'editMessageText');
  assert.equal(calls.at(-1).body.message_id,warmId);
  await bot.event({seq:40,generation:'g',data:{method:'item/completed',params:{threadId:'warm-thread',turnId:'warm-turn',item:{id:'warm-item',type:'agentMessage',text:'Hello world!'}}}});
  await control.exported(store,123);await control.deliver(telegram,(await warmRows())[0]);
  assert.equal((await warmRows()).length,1);
  assert.equal(calls.at(-1).body.message_id,warmId);
  assert.equal(calls.at(-1).body.rich_message.markdown,'Hello world!');
  assert.deepEqual(calls.at(-1).body.reply_markup,{inline_keyboard:[]});
  // Interrupted output stays readable and loses its Stop button in the same bubble.
  await store.query("UPDATE sessions SET turn_id='stopped-turn' WHERE topic=88");
  await bot.stream({...warm,turnId:'stopped-turn',itemId:'stopped-item',text:'Some output '});
  await control.exported(store,123);await control.deliver(telegram,(await warmRows())[1]);
  const stoppedId=(await warmRows())[1].message_ids[0];
  await bot.event({seq:41,generation:'g',data:{method:'turn/completed',params:{threadId:'warm-thread',turn:{id:'stopped-turn',status:'interrupted'}}}});
  await control.exported(store,123);await control.deliver(telegram,(await warmRows())[1]);
  assert.equal((await warmRows()).length,2);
  assert.equal(calls.at(-1).body.message_id,stoppedId);
  assert.equal(calls.at(-1).body.rich_message.markdown,'Some output\n\nTask stopped.');
  assert.deepEqual(calls.at(-1).body.reply_markup,{inline_keyboard:[]});
  assert.equal(calls.some(c=>/Draft$/.test(c.method)),false);
});

test('editing handles unchanged text and rich fallback without sending another message',async()=>{
  const calls=[];
  const tg=new Telegram('test',async(url,opts)=>{
    const body=JSON.parse(opts.body);calls.push({method:url.split('/').at(-1),body});
    return {json:async()=>body.rich_message?{ok:false,error_code:400,description:'unsupported rich content'}:{ok:false,error_code:400,description:'Bad Request: message is not modified'}};
  });
  const ids=await tg.update(123,55,'**Hello**',{rich:true},[999]);
  assert.deepEqual(ids,[999]);assert.ok(calls.every(c=>c.method==='editMessageText'));
  assert.equal(calls.at(-1).body.text,'Hello');
});

test('long final answers retain all text and checkpoint every message part',async()=>{
  let id=80;const calls=[],saved=[];
  const tg=new Telegram('test',async(url,opts)=>{
    const body=JSON.parse(opts.body);calls.push({method:url.split('/').at(-1),body});
    return {json:async()=>body.rich_message?{ok:false,error_code:400}:{ok:true,result:{message_id:body.message_id || ++id}}};
  });
  const text='x'.repeat(9000);
  const ids=await tg.update(123,55,text,{rich:true},[70],async ids=>saved.push([...ids]));
  assert.equal(calls.filter(c=>c.body.text).map(c=>c.body.text).join(''),text);
  assert.equal(ids.length,3);assert.equal(ids[0],70);assert.deepEqual(saved.at(-1),ids);
  assert.ok(calls.filter(c=>c.method==='sendMessage').every(c=>c.body.message_thread_id===55));
});
