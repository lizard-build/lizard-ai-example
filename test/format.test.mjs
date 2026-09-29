import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMarkdown } from '../src/format.mjs';
import { Telegram } from '../src/telegram.mjs';

test('Codex Markdown renders links, code and bold with UTF-16 offsets', () => {
  const result = formatMarkdown('🦎 **Ready**: [GitHub](https://github.com/login/device), `path<&>`.\n```js\nconst x = 1;\n```');
  assert.equal(result.text, '🦎 Ready: GitHub, path<&>.\nconst x = 1;\n');
  assert.deepEqual(result.entities.map(e => [e.type,result.text.slice(e.offset,e.offset+e.length)]), [['bold','Ready'],['text_link','GitHub'],['code','path<&>'],['pre','const x = 1;\n']]);
  assert.equal(result.entities[0].offset,3);
});
test('formatted long replies retain topic routing and valid per-message entities', async () => {
  const bodies=[];
  const tg=new Telegram('SECRET',async (_url,opts) => {bodies.push(JSON.parse(opts.body));return {json:async()=>({ok:true,result:{message_id:bodies.length}})};});
  await tg.send(123,55,'```\n'+'🦎'.repeat(4000)+'\n```',{markdown:true});
  assert.equal(bodies.length,3);
  for(const b of bodies){assert.equal(b.message_thread_id,55);assert.ok(b.text.isWellFormed());assert.equal(b.markdown,undefined);assert.equal(b.entities[0].length,b.text.length);assert.equal(b.entities[0].offset,0);}
});
test('GitHub device codes get copy formatting and a native copy button',async () => {
  let body;
  const tg=new Telegram('SECRET',async (_url,opts)=>{body=JSON.parse(opts.body);return {json:async()=>({ok:true,result:{}})};});
  await tg.send(123,55,'Open [GitHub](https://github.com/login/device) and enter **AB12-CD34**.',{markdown:true});
  assert.equal(body.text,'Open GitHub and enter AB12-CD34.');
  assert.equal(body.reply_markup.inline_keyboard[0][0].copy_text.text,'AB12-CD34');
  assert.equal(body.entities.find(e=>e.type==='code').length,9);
});
