import test from 'node:test';
import assert from 'node:assert/strict';
import { topicTitle, authorized, chunks, command, approvalResult, config } from '../src/core.mjs';
import { Telegram } from '../src/telegram.mjs';
import { Bot } from '../src/bot.mjs';

test('only the owner in the configured chat can act, including callbacks', () => {
  const cfg = { owner: 123, chat: 123 };
  const message = { from: { id: 123 }, chat: { id: 123 } };
  assert.equal(authorized({ message }, cfg), true);
  assert.equal(authorized({ message: { ...message, from: { id: 999 } } }, cfg), false);
  assert.equal(authorized({ message: { ...message, chat: { id: -123 } } }, cfg), false);
  assert.equal(authorized({ callback_query: { from: { id: 999 }, message } }, cfg), false);
  assert.equal(authorized({ callback_query: { from: { id: 123 }, message } }, cfg), true);
  assert.equal(authorized({ message: { ...message, from: undefined } }, cfg), false);
});
test('Telegram splitting preserves Unicode and length', () => {
  const source = '🦎aПривет\n'.repeat(1000);
  const split = chunks(source);
  assert.equal(split.join(''), source);
  assert.ok(split.every(part => part.length <= 3800 && part.isWellFormed()));
});
test('commands support group mentions and multiline arguments', () => {
  assert.deepEqual(command('/new@personal_bot Work\nnotes'), { name: 'new', argument: 'Work\nnotes' });
  assert.equal(command('hello /new'), null);
});
test('permissions require an explicit bounded decision', () => {
  assert.deepEqual(approvalResult('item/commandExecution/requestApproval', {}, true), { decision: 'accept' });
  assert.deepEqual(approvalResult('item/permissions/requestApproval', { permissions: { network: true } }, false), { permissions: {}, scope: 'turn' });
  assert.throws(() => approvalResult('unknown', {}, true));
});
test('invalid owner IDs fail before polling', () => {
  assert.throws(() => config({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_OWNER_ID: 'no', DATABASE_URL: 'x', LIZARD_API_KEY: 'x', LIZARD_PROJECT_ID: 'x' }), /Invalid Telegram/);
});
test('Telegram network errors do not leak the token or retry uncertain sends', async () => {
  let calls = 0;
  const tg = new Telegram('SECRET', async () => { calls++; throw new Error('https://api.telegram.org/botSECRET/sendMessage'); });
  await assert.rejects(tg.send(1, 2, 'Hello'), error => !error.message.includes('SECRET'));
  assert.equal(calls, 1);
});
test('every output chunk keeps the target topic', async () => {
  const bodies = [];
  const tg = new Telegram('token', async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return { json: async () => ({ ok: true, result: { message_id: bodies.length } }) };
  });
  await tg.send(123, 42, 'x'.repeat(9000));
  assert.equal(bodies.length, 3);
  assert.ok(bodies.every(body => body.message_thread_id === 42 && body.chat_id === 123));
});
test('background account events advance the cursor without resetting user idle time', async () => {
  let cursor = 0;
  const bot = new Bot({}, {get:async()=>cursor,set:async(_k,v)=>{cursor=v}}, {}, {
    events:async()=>({events:[{seq:7,generation:'g',data:{method:'account/rateLimits/updated',params:{}}}]}),
  });
  assert.equal(await bot.events(),0);
  assert.equal(cursor,7);
});

test('topic names stay short without splitting Unicode characters', () => {
  assert.equal(topicTitle('  A short\n title  '), 'A short title');
  assert.equal(topicTitle('x'.repeat(32)), 'x'.repeat(32));
  assert.equal(topicTitle('🦎'.repeat(40)), '🦎'.repeat(31) + '…');
  assert.equal(topicTitle('Build a small website for my company'), 'Build a small website for my…');
});
