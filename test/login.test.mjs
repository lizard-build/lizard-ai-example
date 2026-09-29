import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.mjs';

function fixture() {
  const state = new Map(), messages = new Map(), calls = [];
  let counter = 0;
  const store = {
    query:async()=>({rows:[],rowCount:0}),
    get: async (key, fallback = null) => state.get(key) ?? fallback,
    set: async (key, value) => state.set(key, value),
    enqueue: async (key, topic, text) => { if (!messages.has(key)) messages.set(key, {topic, text}); },
  };
  const runtime = {
    generation: 'current',
    rpc: async method => {
      calls.push(method);
      if (method === 'account/read') return {account:null, requiresOpenaiAuth:true};
      assert.equal(method,'account/login/start');
      counter++;
      return {type:'chatgptDeviceCode',loginId:`attempt-${counter}`,verificationUrl:'https://auth.openai.com/codex/device',userCode:`TEST-${counter}`};
    },
  };
  const bot = new Bot({owner:123,chat:123}, store, {}, runtime);
  const login = (id,topic) => bot.handle({update_id:id,message:{from:{id:123},chat:{id:123,type:'private'},message_thread_id:topic,text:'/login'}});
  const event = (seq,loginId,success,generation='current') => ({seq,generation,data:{method:'account/login/completed',params:{loginId,success}}});
  return {bot,state,messages,calls,runtime,login,event};
}

test('repeated login reuses its code; old failures cannot invalidate a newer attempt', async () => {
  const f=fixture();
  await f.login(1,55);
  await f.login(2,66);
  assert.equal(f.calls.filter(m=>m==='account/login/start').length,1);
  assert.equal(f.messages.get('update:1').text,f.messages.get('update:2').text);
  f.state.get('loginAttempt').expiresAt=Date.now()-1;
  await f.login(3,77);
  const deadline=f.state.get('loginPendingUntil');
  assert.equal(f.state.get('loginAttempt').loginId,'attempt-2');
  f.runtime.events=async()=>({events:[f.event(1,'attempt-1',false)]});
  assert.equal(await f.bot.events(),0);
  assert.equal(f.state.get('eventCursor'),1);
  assert.equal(f.state.get('loginPendingUntil'),deadline);
  assert.equal(f.messages.size,3);
  await f.bot.event(f.event(2,'attempt-2',true,'old-generation'));
  assert.equal(f.messages.size,3);
  await f.bot.event(f.event(3,'attempt-2',true));
  assert.equal(f.messages.get('event:3').topic,77);
  assert.match(f.messages.get('event:3').text,/ChatGPT is connected/);
  assert.equal(f.state.get('loginPendingUntil'),0);
  assert.equal(f.state.get('loginAttempt'),null);
  await f.bot.event(f.event(4,'attempt-2',false));
  assert.equal(f.messages.size,4,'duplicate completions are silent');
});

test('only a matching current failure clears login; a restarted runtime issues a new code', async () => {
  const f=fixture();
  await f.login(1,55);
  f.runtime.generation='restarted';
  await f.login(2,66);
  assert.equal(f.state.get('loginAttempt').loginId,'attempt-2');
  await f.bot.event(f.event(1,'attempt-1',false));
  assert.ok(f.state.get('loginPendingUntil')>Date.now());
  await f.bot.event(f.event(2,'attempt-2',false,'restarted'));
  assert.equal(f.state.get('loginPendingUntil'),0);
  assert.equal(f.messages.get('event:2').topic,66);
  assert.match(f.messages.get('event:2').text,/new code/);
});

test('a Telegram topic notice named after a command creates no Codex session or reply', async () => {
  const f=fixture();
  await f.bot.handle({update_id:1,message:{from:{id:123},chat:{id:123,type:'private'},message_thread_id:55,forum_topic_created:{name:'/login'}}});
  assert.equal(f.calls.length,0);
  assert.equal(f.messages.size,0);
  assert.equal(f.state.size,0);
});
