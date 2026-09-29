import test from 'node:test';
import assert from 'node:assert/strict';
import { completeWords, Delivery } from '../src/streaming.mjs';
import { Telegram } from '../src/telegram.mjs';
import { Runtime } from '../src/runtime.mjs';

test('previews emit complete words without a backlog or broken Unicode',()=>{
  assert.equal(completeWords('При'), '');
  assert.equal(completeWords('Привет ми'), 'Привет ');
  assert.equal(completeWords('Привет мир\nСлед'), 'Привет мир\n');
  assert.equal(completeWords('Hello 👩‍💻 wor'), 'Hello 👩‍💻 ');
  assert.equal(completeWords('Many words have arrived together '),'Many words have arrived together ');
  assert.equal(completeWords('```js\nconst value = rea'),'```js\nconst value = ');
});

test('delivery sends the newest preview at 150ms, keeps chat order and does not wait for slow chats',async()=>{
  let now=1000,release;
  const rows=[{id:1,chat_id:1,extra:{progress:true},revision:1,text:'One ',next_attempt:0},
    {id:2,chat_id:2,extra:{},revision:1,text:'Slow',next_attempt:0}];
  const sent=[];
  const control={query:async()=>({rows:rows.filter(r=>!r.sent)}),deliver:async(_tg,row)=>{
    sent.push([row.chat_id,row.text]);
    if(row.chat_id===2) await new Promise(resolve=>release=resolve);
    row.sent=true;
  }};
  const delivery=new Delivery(control,{},()=>now);
  await delivery.tick();await Promise.resolve();
  assert.equal(sent.length,2);
  rows[0]={...rows[0],sent:false,text:'One two ',revision:2};
  now=1149;await delivery.tick();assert.equal(sent.length,2);
  rows[0]={...rows[0],text:'One two three ',revision:3};
  now=1150;await delivery.tick();await Promise.resolve();
  assert.deepEqual(sent.at(-1),[1,'One two three ']);
  assert.equal(sent.filter(([id])=>id===2).length,1,'one in-flight request per chat');
  release();await delivery.drain();
  rows[1]={...rows[1],sent:false,text:'Next'};
  now=2249;await delivery.tick();assert.equal(sent.length,3,'ordinary messages retain their pacing');
});

test('429 defers only its chat and final revisions cannot skip the cooldown',async()=>{
  let now=0;
  const updates=[],sent=[];
  const rows=[{id:1,chat_id:1,revision:1,extra:{progress:true},next_attempt:0}];
  const control={query:async(sql,params)=>{
    if(sql.startsWith('SELECT')) return {rows};
    updates.push({sql,params});return {};
  },deliver:async(_tg,row)=>{
    sent.push(row.text);
    if(sent.length===1) throw Object.assign(new Error('rate'),{telegramCode:429,retryAfter:3});
  }};
  const delivery=new Delivery(control,{},()=>now);
  await delivery.tick();await delivery.drain();
  assert.deepEqual(updates[0].params,[1,3000]);
  rows[0]={...rows[0],revision:2,text:'Final',extra:{progress:true}};
  now=2999;await delivery.tick();assert.equal(sent.length,1);
  now=3000;await delivery.tick();await delivery.drain();assert.equal(sent.at(-1),'Final');
});

test('preview edits return Telegram retry_after without retrying old text',async()=>{
  const calls=[];
  const telegram=new Telegram('secret',async(_url,options)=>{
    calls.push(JSON.parse(options.body));return {json:async()=>({ok:false,error_code:429,parameters:{retry_after:4}})};
  });
  await assert.rejects(telegram.update(1,2,'Ready ',{rich:true,streamPreview:true},[3]),error=>error.retryAfter===4);
  assert.equal(calls.length,1);assert.equal(calls[0].streamPreview,undefined);
});

test('event polling uses one SDK call, validates cursors and contains no user payload',async()=>{
  const calls=[];const runtime=new Runtime({},null,{});
  runtime.sandbox={process:{exec:async command=>{
    calls.push(command);return {exitCode:0,stdout:JSON.stringify({result:{events:[],streams:[]}})};
  }},fs:{write:async()=>assert.fail('events must not upload a request file')}};
  assert.deepEqual(await runtime.events(12),{events:[],streams:[]});
  const encoded=calls[0].match(/^BRIDGE_REQUEST=([a-zA-Z0-9+/=]+) node /)[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded,'base64')),{action:'events',after:12});
  await assert.rejects(runtime.events('1;bad'),/Invalid event cursor/);
  assert.equal(calls.length,1);
});
