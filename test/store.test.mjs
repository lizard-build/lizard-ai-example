import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Bot } from '../src/bot.mjs';

test('PostgreSQL persists updates, serializes sessions, scopes approvals and recovers a controller', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const store = new Store(process.env.TEST_DATABASE_URL);
  await store.start();
  const cfg = { owner: 123, chat: 123 };
  const starts = [];
  const replies = [];
  let signedIn = false;
  let threadsStarted = 0;
  const resumed = [];
  const renamed = [];
  let renameFails = true;
  let transcriptions = 0;
  let downloads = 0;
  const runtime = {
    generation: 'test-generation',
    transcribe: async (audio, id) => { assert.equal(audio.toString(),'voice bytes'); assert.equal(id,12); transcriptions++; return '/new this is spoken task text'; },
    rpc: async (method, params) => {
      if (method === 'account/read') return {account:signedIn ? {type:'chatgpt'} : null, requiresOpenaiAuth:true};
      if (method === 'thread/start') {
        // SandboxMode from the generated schema of the deployed Codex 0.155.1.
        assert.equal(params.sandbox, 'danger-full-access');
        assert.equal(params.approvalPolicy, 'never');
        threadsStarted++; return { thread: { id: `thread-${params.cwd.split('/').at(-1)}` } };
      }
      if (method === 'turn/start') {
        assert.equal(params.approvalPolicy, 'never');
        assert.deepEqual(params.sandboxPolicy, {type:'dangerFullAccess'});
        starts.push(params); return { turn: { id: `turn-${starts.length}` } }; }
      if (method === 'thread/resume') {
        resumed.push(params.threadId);
        assert.equal(params.approvalPolicy, 'never');
        assert.equal(params.sandbox, 'danger-full-access');
        return { thread: { turns: [] } };
      }
      return {};
    }, reply: async (...args) => replies.push(args),
  };
  const telegram = { download: async () => { downloads++; return Buffer.from('voice bytes'); }, call: async (method,params) => {
    if (method === 'editForumTopic') {
      renamed.push(params);
      if (renameFails) throw new Error('Temporary Telegram outage');
      return true;
    }
    return method === 'createForumTopic' ? { message_thread_id: 55 } : method === 'getMe' ? { has_topics_enabled: true } : {};
  } };
  const bot = new Bot(cfg, store, telegram, runtime);
  const update = (id, text, topic = 55) => ({ update_id: id, message: { from: { id: 123 }, chat: { id: 123, type: 'private' }, message_thread_id: topic, text } });
  try {
    const another = new Store(process.env.TEST_DATABASE_URL);
    await assert.rejects(another.start(), /Another bot/);
    await another.close();
    await store.receive([update(1, '/new Work')]);
    await store.receive([update(1, '/new Work')]);
    assert.equal((await store.query('SELECT count(*) FROM inbox')).rows[0].count, '1');
    assert.equal(await store.get('offset'), 2);
    await bot.handle(update(1, '/new Work'));
    assert.equal(threadsStarted,0,'creating a Telegram topic does not start Codex');
    assert.equal((await bot.session(55)).thread_id,null);
    await bot.handle(update(99,'A task before sign-in'));
    assert.equal(threadsStarted,0,'a task before sign-in gets a login hint, not a Codex error');
    assert.equal((await store.query('SELECT count(*) FROM prompts')).rows[0].count,'0');
    assert.match((await store.query("SELECT text FROM outbox WHERE dedup_key='update:99'")).rows[0].text,/Sign in with \/login/);
    await bot.syncTitles();
    assert.equal((await bot.session(55)).title_synced,false,'rename failure must not fail the task');
    renameFails = false;
    bot.nextTitleSync = 0;
    await bot.syncTitles();
    assert.equal((await bot.session(55)).title,'A task before sign-in');
    assert.equal(renamed.at(-1).chat_id,123);
    assert.equal(renamed.at(-1).message_thread_id,55);
    signedIn = true;
    await store.receive([update(2, 'First'), update(3, 'Second')]);
    await bot.handle(update(2, 'First')); await bot.handle(update(3, 'Second'));
    await bot.syncTitles();
    assert.equal(renamed.length,2,'later messages must not rename the topic again');
    await bot.startPrompts(); await bot.startPrompts();
    assert.equal(starts.length, 1);
    await bot.event({ seq: 1, generation: runtime.generation, data: { method: 'turn/completed', params: { threadId: 'thread-55', turn: { id: 'turn-1', status: 'completed' } } } });
    await bot.startPrompts(); assert.equal(starts.length, 2);
    await bot.event({ seq: 2, generation: runtime.generation, data: { id: 50, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-55', turnId: 'turn-2', command: 'git push' } } });
    const approval = (await store.query('SELECT * FROM approvals')).rows[0];
    await bot.handle({ update_id: 10, callback_query: { from: { id: 123 }, id: 'callback', data: `approval:${approval.id}:yes`, message: { chat: { id: 123 }, message_thread_id: 66 } } });
    assert.equal(replies.length, 0);
    await bot.handle({ update_id: 11, callback_query: { from: { id: 123 }, id: 'callback2', data: `approval:${approval.id}:yes`, message: { chat: { id: 123 }, message_thread_id: 55 } } });
    assert.equal(replies.length, 1);
    await store.query("UPDATE inbox SET state='working' WHERE update_id=1");
    await bot.recover();
    assert.equal((await store.query('SELECT state FROM inbox WHERE update_id=1')).rows[0].state, 'failed');
    assert.equal((await bot.session(55)).turn_id, null);
    await store.query("INSERT INTO sessions(topic,title,cwd,thread_id) VALUES(56,'Idle','/workspace/sessions/56','idle-thread')");
    const resumesBefore = resumed.length;
    const restartedBot = new Bot(cfg, store, telegram, runtime);
    await restartedBot.recover();
    assert.equal(resumed.length,resumesBefore,'idle topics must not hold up environment startup');
    await store.receive([update(100,'Continue after restart')]);
    await restartedBot.handle(update(100,'Continue after restart'));
    await restartedBot.startPrompts();
    assert.deepEqual(resumed.slice(resumesBefore),['thread-55'],'only the requested topic resumes');
    await restartedBot.startPrompts();
    assert.equal(resumed.length,resumesBefore+1,'the loaded topic is not resumed again');
    await bot.event({seq:100,generation:runtime.generation,data:{method:'turn/completed',params:{threadId:'thread-55',turn:{id:`turn-${starts.length}`,status:'completed'}}}});
    await store.query('DELETE FROM sessions WHERE topic=56');
    await store.enqueue('same-message', 55, 'Hello'); await store.enqueue('same-message', 55, 'Hello');
    assert.equal((await store.query("SELECT count(*) FROM outbox WHERE dedup_key='same-message'")).rows[0].count, '1');
    const outside = update(13, 'Continue the existing task', null);
    await store.receive([outside]);
    await bot.handle(outside);
    await store.query("UPDATE inbox SET state='done' WHERE update_id=13");
    const chooser = (await store.query("SELECT extra FROM outbox WHERE dedup_key='choose:13'")).rows[0];
    assert.equal(chooser.extra.reply_markup.inline_keyboard[0][0].callback_data, 'route:13:new');
    assert.equal(chooser.extra.reply_markup.inline_keyboard[1][0].callback_data, 'route:13:55');
    const route = {update_id:14,callback_query:{id:'route-click',from:{id:123},data:'route:13:55',message:{chat:{id:123,type:'private'}}}};
    await bot.handle({...route,callback_query:{...route.callback_query,from:{id:999}}});
    assert.equal((await store.query('SELECT state FROM inbox WHERE update_id=13')).rows[0].state,'done');
    await bot.handle(route);
    const routed = (await store.query('SELECT * FROM inbox WHERE update_id=13')).rows[0];
    assert.equal(routed.state,'pending'); assert.equal(routed.payload.message.message_thread_id,55);
    await bot.handle(routed.payload);
    await store.query("UPDATE inbox SET state='done' WHERE update_id=13");
    await bot.handle(route);
    assert.equal((await store.query('SELECT state FROM inbox WHERE update_id=13')).rows[0].state,'done');
    assert.equal((await store.query('SELECT count(*) FROM prompts WHERE update_id=13')).rows[0].count,'1');
    const voice = update(12,undefined);
    voice.message.message_id = 120;
    voice.message.voice = {file_id:'voice-file',duration:8,file_size:100,mime_type:'audio/ogg'};
    await store.progress(12,55,'Thinking…',{thinking:true});
    const coldProgress=(await store.query("SELECT id FROM outbox WHERE dedup_key='progress:12'")).rows[0];
    await store.receive([voice]);
    await bot.handle(voice); await bot.handle(voice);
    assert.equal(downloads,1); assert.equal(transcriptions,1,'transcription survives duplicate delivery');
    const transcript=(await store.query("SELECT * FROM outbox WHERE dedup_key='voice-transcript:12'")).rows;
    assert.equal(transcript.length,1);
    assert.equal(transcript[0].id,coldProgress.id,'the startup placeholder becomes the transcript');
    assert.equal(transcript[0].text,'🎤 /new this is spoken task text');
    assert.equal(transcript[0].extra.thinking,undefined,'transcription ends the initial thinking placeholder');
    assert.deepEqual(transcript[0].extra.reply_parameters,{message_id:120,allow_sending_without_reply:true});
    assert.deepEqual(transcript[0].extra.entities,[{type:'italic',offset:3,length:29}]);
    await store.progress(12,55,'Model answer');
    await bot.handle(voice);
    assert.equal((await store.query("SELECT text FROM outbox WHERE dedup_key='progress:12'")).rows[0].text,'Model answer','replay must leave the model answer alone');
    assert.equal((await store.query('SELECT text FROM prompts WHERE update_id=12')).rows[0].text,'/new this is spoken task text','spoken slash commands are task content');
    assert.equal((await store.query('SELECT count(*) FROM sessions')).rows[0].count,'1','voice cannot trigger /new');
  } finally { await store.close(); }
});
