import test from 'node:test';
import assert from 'node:assert/strict';
import { Control } from '../src/control.mjs';
import { Store } from '../src/store.mjs';
import { Bot } from '../src/bot.mjs';
import { TenantWorker } from '../src/worker.mjs';
import { config, privateUser } from '../src/core.mjs';

const update = (id, user, text, topic) => ({ update_id: id, message: {
  from: { id: user }, chat: { id: user, type: 'private' }, text, ...(topic ? { message_thread_id: topic } : {}),
} });
test('multi-user input rejects group chats, forged owners and invalid identifiers', () => {
  assert.equal(privateUser(update(1, 123, '/start')), 123);
  assert.equal(privateUser({ ...update(1, 123, '/start'), message: { from: { id: 999 }, chat: { id: 123, type: 'private' } } }), null);
  assert.equal(privateUser({ message: { from: { id: 123 }, chat: { id: 123, type: 'group' } } }), null);
  assert.throws(() => new Store('unused', 'tenant_12;DROP SCHEMA public'), /Invalid/);
});

test('admission, per-user data, capacity and idle deletion remain isolated and durable', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const cfg = config({ TELEGRAM_BOT_TOKEN: '999:test', TELEGRAM_OWNER_ID: '880001',
    DATABASE_URL: process.env.TEST_DATABASE_URL, LIZARD_API_KEY: 'controller-secret', LIZARD_PROJECT_ID: 'test',
    OPENAI_API_KEY: 'owner-only-key', MAX_ACTIVE_SANDBOXES: '1' });
  const control = new Control(cfg);
  await control.start();
  await control.gatewayLock();
  const secondGateway = new Control(cfg);
  await secondGateway.start();
  await assert.rejects(secondGateway.gatewayLock(), /Another Telegram gateway/);
  await secondGateway.close();
  t.after(() => control.close());
  const a = 880002, b = 880003;
  await control.receive([update(10000, a, '/start'), update(10001, b, '/start')]);
  assert.equal((await control.tenant(a)).admission, 'pending');
  assert.equal((await control.query("SELECT to_regclass('tenant_880002.sessions') AS name")).rows[0].name, null);
  // A pending user cannot grant themselves access.
  await control.receive([update(10002, a, `/allow ${a}`)]);
  assert.equal((await control.tenant(a)).admission, 'pending');
  await control.receive([update(10003, cfg.owner, `/allow ${a}`), update(10004, cfg.owner, `/allow ${b}`)]);
  assert.equal((await control.tenant(a)).admission, 'approved');
  const first = update(10005, a, 'private A', 55);
  await control.receive([first, update(10006, b, 'private B', 55)]);
  await control.receive([first]);
  assert.equal((await control.query('SELECT count(*) FROM control.inbox WHERE update_id=10005')).rows[0].count, '1');

  const slots = await Promise.all([control.reserve(a), control.reserve(b)]);
  assert.equal(slots.filter(Boolean).length, 1, 'atomic global capacity');
  await control.query("UPDATE control.tenants SET lifecycle='sleeping' WHERE user_id=ANY($1::bigint[])", [[a,b]]);
  const stores = [new Store(cfg.database, `tenant_${a}`), new Store(cfg.database, `tenant_${b}`)];
  t.after(async () => { for (const s of stores) if (!s.pool.ended) await s.close(); });
  await Promise.all(stores.map(s => s.start()));
  const replies = [];
  const runtime = { generation: 'generation', rpc: async method => method === 'thread/start' ? { thread: { id: 'same-thread-id' } } : method === 'account/read' ? { account: { type: 'chatgpt' } } : {}, reply: async (...args) => replies.push(args) };
  const tg = { call: async () => ({}) };
  const bots = stores.map((s,i) => new Bot({ ...cfg, owner: [a,b][i], chat: [a,b][i] }, s, tg, runtime));
  await bots[0].newSession(55, 'A', 'new-a'); await bots[1].newSession(55, 'B', 'new-b');
  const duplicateWorker = new Store(cfg.database, `tenant_${a}`);
  await assert.rejects(duplicateWorker.start(), /Another bot/);
  await duplicateWorker.close();
  assert.equal((await bots[0].session(55)).title, 'A');
  assert.equal((await bots[1].session(55)).title, 'B');
  await stores[0].receive([first]);
  await bots[0].handle(first);
  await stores[0].query("UPDATE inbox SET state='done'");
  assert.equal((await stores[1].query('SELECT count(*) FROM prompts')).rows[0].count, '0');
  const approvalId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  await stores[0].query("INSERT INTO approvals(id,generation,request_id,topic,method,params) VALUES($1,'generation','1',55,'item/commandExecution/requestApproval','{}')", [approvalId]);
  await bots[1].handle({ update_id: 10007, callback_query: { id:'forged', from:{id:b}, data:`approval:${approvalId}:yes`, message:{chat:{id:b,type:'private'},message_thread_id:55} } });
  assert.equal(replies.length, 0, 'another user cannot approve the same topic/request ID');
  await bots[0].event({seq:1,generation:'generation',data:{method:'serverRequest/resolved',params:{requestId:1}}});
  assert.equal((await stores[0].query('SELECT state FROM approvals WHERE id=$1',[approvalId])).rows[0].state,'resolved');
  await stores[0].query("UPDATE approvals SET state='pending' WHERE id=$1",[approvalId]);
  for (const s of stores) await s.enqueue('same',55, s.schema);
  await control.exported(stores[0], a); await control.exported(stores[1], b); await control.exported(stores[0], a);
  const outgoing = (await control.query("SELECT chat_id,text FROM control.outbox WHERE dedup_key LIKE 'tenant:%' ORDER BY chat_id")).rows;
  assert.deepEqual(outgoing.map(r => [Number(r.chat_id),r.text]), [[a,`tenant_${a}`],[b,`tenant_${b}`]]);
  await Promise.all(stores.map(s => s.close()));

  let retired = 0;
  class FakeRuntime { constructor() {} async retire() { retired++; } }
  const worker = new TenantWorker(cfg, control, tg, await control.tenant(a), FakeRuntime);
  assert.equal(worker.cfg.openaiKey, undefined, 'owner API key is not shared');
  await worker.store.start();
  t.after(() => worker.store.close());
  await control.query("UPDATE control.tenants SET lifecycle='running',sandbox_id='test',last_activity=now()-interval '2 hours' WHERE user_id=$1", [a]);
  assert.equal(await worker.retireIfIdle(), false, 'pending prompts/approvals prevent retirement');
  await worker.store.query("UPDATE prompts SET state='completed'");
  await worker.store.query("UPDATE approvals SET state='answered'");
  assert.equal(await worker.retireIfIdle(), false, 'undelivered Telegram update prevents retirement');
  await control.query('UPDATE control.inbox SET delivered=true WHERE user_id=$1', [a]);
  await worker.store.set('loginPendingUntil', Date.now()+60000);
  assert.equal(await worker.retireIfIdle(), false, 'device login prevents retirement');
  await worker.store.set('loginPendingUntil', 0);
  await control.query('UPDATE control.tenants SET last_activity=now() WHERE user_id=$1', [a]);
  assert.equal(await worker.retireIfIdle(), false, 'new activity resets idle timer');
  await control.query("UPDATE control.tenants SET last_activity=now()-interval '2 hours' WHERE user_id=$1", [a]);
  assert.equal(await worker.retireIfIdle(), true);
  assert.equal(retired,1);
  assert.equal((await control.tenant(a)).lifecycle,'sleeping');
  assert.equal((await worker.store.query('SELECT title FROM sessions WHERE topic=55')).rows[0].title,'A','retirement preserves session history');
  await control.receive([update(10008,a,'wake',55)]);
  assert.equal((await control.tenant(a)).has_work,true);
  assert.ok((await control.candidates(10)).some(t => Number(t.user_id)===a),'sleeping user is scheduled after a new message');
  await control.receive([update(10009,cfg.owner,`/block ${a}`),update(10010,a,'must not run',55)]);
  assert.equal((await control.query('SELECT count(*) FROM control.inbox WHERE update_id=10010')).rows[0].count,'0');

  // Telegram's topic notices must not wake a sleeping user's environment.
  await control.query('UPDATE control.inbox SET delivered=true WHERE user_id=$1', [b]);
  let started = 0;
  class SilentRuntime { async start() { started++; throw new Error('Must not start'); } }
  const lazy = new TenantWorker(cfg, control, tg, await control.tenant(b), SilentRuntime);
  await lazy.store.start();
  t.after(() => lazy.store.close());
  const topicNotice = (id,topic,name) => ({...update(id,b,undefined,topic),message:{...update(id,b,undefined,topic).message,forum_topic_created:{name}}});
  await control.receive([topicNotice(10011,56,'/login'),topicNotice(10012,57,'New project')]);
  await lazy.tick();
  assert.equal(started,0);
  assert.equal(await lazy.bot.session(56),undefined,'command topics are not coding sessions');
  assert.equal((await lazy.bot.session(57)).thread_id,null);
  assert.equal((await lazy.store.query('SELECT count(*) FROM outbox')).rows[0].count,'1','only the earlier test reply exists');
  assert.equal((await control.query("SELECT count(*) FROM control.outbox WHERE dedup_key LIKE 'queued-wake:%'")).rows[0].count,'0','no false capacity notices');
});
