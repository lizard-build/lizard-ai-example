import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {Store} from '../src/store.mjs';
import {Bot} from '../src/bot.mjs';

test('new-topic messages explain the chat limit before voice or file processing, and work after archiving',
  {skip:!process.env.TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});t.after(()=>admin.end());
  await admin.query('CREATE DATABASE session_limit_test');
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/session_limit_test';
  const store=new Store(url.toString());await store.start();t.after(()=>store.close());
  const bot=new Bot({owner:123,chat:123,maxSessions:1},store,{},{});
  await bot.saveSession(55,'Existing');
  await store.query("UPDATE sessions SET turn_id='active' WHERE topic=55");
  const base={from:{id:123},chat:{id:123,type:'private'},message_thread_id:56};
  const inputs=[{voice:{file_id:'voice',duration:6}},{text:'Hello'},
    {photo:[{file_id:'photo',width:100,height:100}],caption:'Look at this'},
    {document:{file_id:'file',file_name:'notes.txt'},caption:'Read this'},{text:'/model default'}];
  for(let i=0;i<inputs.length;i++) {
    await bot.handle({update_id:i+1,message:{...base,...inputs[i]}});
    const reply=(await store.query('SELECT text FROM outbox WHERE dedup_key=$1',[`update:${i+1}`])).rows[0].text;
    assert.match(reply,/All 1 active chats/);assert.match(reply,/automatically/);
    assert.equal(await bot.session(56),undefined);
  }
  // An existing session still accepts commands at the limit.
  await bot.handle({update_id:6,message:{...base,message_thread_id:55,text:'/model default'}});
  assert.match((await store.query("SELECT text FROM outbox WHERE dedup_key='update:6'")).rows[0].text,/model from Settings/);
  await store.query('UPDATE sessions SET turn_id=NULL WHERE topic=55');
  await bot.handle({update_id:7,message:{...base,message_thread_id:55,text:'/archive'}});
  assert.equal((await bot.session(55)).archived,true);
  bot.runtime={rpc:async()=>({account:null,requiresOpenaiAuth:true})};
  await bot.handle({update_id:8,message:{...base,voice:{file_id:'voice',duration:6}}});
  assert.ok(await bot.session(56));
  assert.match((await store.query("SELECT text FROM outbox WHERE dedup_key='update:8'")).rows[0].text,/Sign in with \/login/);
});

test('new chats archive the least recently used idle session, preserve history and protect pending work',
  {skip:!process.env.TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});t.after(()=>admin.end());
  await admin.query('CREATE DATABASE auto_archive_test');
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/auto_archive_test';
  const store=new Store(url.toString());await store.start();t.after(()=>store.close());
  const bot=new Bot({owner:123,chat:123,maxSessions:3},store,{},{});
  for(const topic of [1,2,3])await bot.saveSession(topic,`Chat ${topic}`);
  await store.query("UPDATE sessions SET created_at=now()-interval '2 days'");
  await store.query("UPDATE sessions SET turn_id='busy' WHERE topic=2");
  await store.receive([{update_id:1,message:{message_thread_id:1,text:'Recent message'}}]);
  await store.query("UPDATE inbox SET state='done'");
  await bot.saveSession(4,'New chat');
  assert.equal((await bot.session(3)).archived,true,'recent use matters more than creation order');
  assert.equal((await bot.session(1)).archived,false);
  assert.equal((await bot.session(2)).archived,false);
  assert.equal((await bot.session(3)).cwd,'/workspace/sessions/3','session history remains');
  await store.query("INSERT INTO approvals(id,generation,request_id,topic,method,params) VALUES('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa','g','1',1,'question','{}')");
  await store.receive([{update_id:2,message:{message_thread_id:4,text:'Queued'}}]);
  assert.equal(await bot.makeRoomForSession(),false,'turns, questions and unprocessed messages are protected');
  await store.query("UPDATE inbox SET state='done' WHERE update_id=2");
  await store.query("INSERT INTO prompts(update_id,topic,text) VALUES(2,4,'Queued')");
  assert.equal(await bot.makeRoomForSession(),false,'queued tasks are protected');
  await store.query("UPDATE prompts SET state='completed' WHERE update_id=2");
  bot.pendingTopics=async()=>[4];
  assert.equal(await bot.makeRoomForSession(),false,'gateway messages not yet received by this worker are protected');
  bot.pendingTopics=async()=>[];
  await store.set('loginTopic',4);await store.set('loginPendingUntil',Date.now()+60000);
  assert.equal(await bot.makeRoomForSession(),false,'pending login is protected');
  await store.set('loginPendingUntil',0);
  await bot.saveSession(5,'Next chat');
  assert.equal((await bot.session(4)).archived,true);
  assert.equal((await store.query('SELECT count(*) FROM sessions WHERE archived=false')).rows[0].count,'3');
  assert.equal((await store.query('SELECT text FROM prompts WHERE topic=4')).rows[0].text,'Queued');
  bot.telegram={call:async method=>method==='getMe'?{has_topics_enabled:true}:{message_thread_id:6}};
  const base={from:{id:123},chat:{id:123,type:'private'}};
  await bot.handle({update_id:3,message:{...base,text:'/new Another'}});
  assert.equal((await bot.session(5)).archived,true);
  assert.equal((await bot.session(6)).archived,false);
  await bot.handle({update_id:4,message:{...base,message_thread_id:7,forum_topic_created:{name:'New Thread'}}});
  assert.equal((await bot.session(6)).archived,true);
  assert.equal((await bot.session(7)).archived,false);
});
