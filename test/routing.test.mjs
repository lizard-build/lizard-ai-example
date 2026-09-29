import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {Store} from '../src/store.mjs';
import {Bot} from '../src/bot.mjs';

test('new-chat routing preserves messages, limits recent choices and survives repeated clicks',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});t.after(()=>admin.end());
  await admin.query('CREATE DATABASE routing_test');
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/routing_test';
  let store=new Store(url.toString());await store.start();t.after(()=>store.close());
  const cfg={owner:123,chat:123,maxSessions:30};
  let nextTopic=100,creates=0;
  const calls=[];
  const telegram={call:async(method,params)=>{
    calls.push({method,params});
    if(method==='createForumTopic') {creates++;return {message_thread_id:nextTopic++};}
    return {};
  }};
  let bot=new Bot(cfg,store,telegram,{});
  const message=(id,fields)=>({update_id:id,message:{from:{id:123},chat:{id:123,type:'private'},...fields}});
  const click=(id,who=123)=>({update_id:1000+id,callback_query:{id:`click-${id}`,from:{id:who},data:`route:${id}:new`,message:{chat:{id:who,type:'private'},message_id:500+id}}});
  const offer=async update=>{
    await store.receive([update]);await bot.handle(update);
    await store.query("UPDATE inbox SET state='done' WHERE update_id=$1",[update.update_id]);
    return (await store.query('SELECT extra FROM outbox WHERE dedup_key=$1',[`choose:${update.update_id}`])).rows[0].extra.reply_markup.inline_keyboard;
  };
  const keyboard=await offer(message(1,{text:'Build a budget planner'}));
  assert.equal(keyboard.length,1,'first-time users can create a chat from the chooser');
  assert.equal(keyboard[0][0].callback_data,'route:1:new');
  await bot.handle(click(1,999));await bot.handle(click(999));assert.equal(creates,0,'forged callbacks do not create topics');
  await bot.handle(click(1));await bot.handle(click(1));assert.equal(creates,1);
  const routed=(await store.query('SELECT * FROM inbox WHERE update_id=1')).rows[0];
  assert.equal(routed.state,'pending');assert.equal(routed.payload.message.message_thread_id,100);
  assert.equal(routed.payload.message.text,'Build a budget planner');
  assert.equal((await bot.session(100)).title,'Build a budget planner');
  assert.ok(calls.some(c=>c.method==='editMessageReplyMarkup'&&c.params.message_id===501));
  // A worker restart cannot create another topic for a routed message.
  await store.close();store=new Store(url.toString());await store.start();bot=new Bot(cfg,store,telegram,{});
  await bot.handle(click(1));assert.equal(creates,1);
  for(const [id,fields] of [[2,{voice:{file_id:'voice',duration:5}}],[3,{photo:[{file_id:'photo',width:10,height:10}],caption:'Read this'}]]) {
    await offer(message(id,fields));await bot.handle(click(id));
    const payload=(await store.query('SELECT payload FROM inbox WHERE update_id=$1',[id])).rows[0].payload;
    for(const [name,value] of Object.entries(fields)) assert.deepEqual(payload.message[name],value);
    assert.ok(payload.message.message_thread_id);
  }
  // Recover a known created topic without repeating the remote create call.
  await offer(message(4,{text:'Resume creation'}));
  await store.set('route-new:4',{topic:900,title:'Resume creation'});
  await bot.handle(click(4));assert.equal(creates,3);assert.ok(await bot.session(900));
  // An uncertain remote result must not create duplicate empty chats.
  await offer(message(5,{text:'Uncertain creation'}));await store.set('route-new:5',{creating:true});
  await bot.handle(click(5));assert.equal(creates,3);
  // More than ten active chats, with an older chat recently used.
  for(let i=200;i<212;i++) {
    await bot.saveSession(i,`Chat ${i}`);
    await store.query("UPDATE sessions SET created_at='2020-01-01'::timestamptz+($1::int*interval '1 hour') WHERE topic=$1",[i]);
  }
  await store.receive([message(50,{text:'Recent task',message_thread_id:200})]);
  await store.query("INSERT INTO prompts(update_id,topic,text) VALUES(50,200,'Recent task')");
  await store.query('UPDATE sessions SET archived=true WHERE topic=211');
  const recent=await offer(message(6,{text:'Pick a chat'}));
  assert.equal(recent.length,11);assert.equal(recent[0][0].callback_data,'route:6:new');
  assert.equal(recent[1][0].callback_data,'route:6:200','latest activity wins over creation date');
  assert.ok(!recent.some(row=>row[0].callback_data==='route:6:211'));
  cfg.maxSessions=1;
  await bot.handle(click(6));assert.equal(creates,3,'new-chat choice respects capacity');
  assert.match(calls.at(-1).params.text,/work pending/);
  assert.equal((await store.query('SELECT state FROM inbox WHERE update_id=6')).rows[0].state,'done','message remains available for another choice');
});
