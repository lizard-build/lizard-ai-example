import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { sleep } from '../src/core.mjs';

test('bridge client resumes large chats without exporting history and preserves active turns', async t => {
  const root=await mkdtemp(join(tmpdir(),'codex-bridge-response-'));
  await writeFile(join(root,'bridge.key'),'test-key');
  const large={result:{thread:{id:'group-thread',turns:[
    {id:'old',status:'completed',items:[{text:'История 🦎 '.repeat(150000)}]},
    {id:'active',status:'inProgress',items:[{text:'PRIVATE TOOL OUTPUT'}]},
  ]},initialTurnsPage:{turns:[{items:['ALSO PRIVATE']}]}}};
  const server=httpServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer test-key');
    let body='';for await(const part of req)body+=part;
    const request=JSON.parse(body);
    res.setHeader('content-type','application/json');
    if(request.method==='account/read')return res.end(JSON.stringify({result:{account:{type:'chatgpt'}}}));
    if(request.key==='error') {res.writeHead(400);return res.end(JSON.stringify({error:'Resume failed'}));}
    res.end(JSON.stringify(large));
  }).listen(0,'127.0.0.1');
  await once(server,'listening');t.after(()=>server.close());
  const run=key=>promisify(execFile)(process.execPath,['src/bridge-client.mjs'],{env:{...process.env,
    BRIDGE_ROOT:root,BRIDGE_PORT:String(server.address().port),
    BRIDGE_REQUEST:Buffer.from(JSON.stringify({action:'rpc',method:key==='account'?'account/read':'thread/resume',key})).toString('base64'),
  },maxBuffer:512*1024});
  const {stdout}=await run('resume');
  assert.ok(Buffer.byteLength(stdout)<512);
  assert.deepEqual(JSON.parse(stdout),{result:{thread:{id:'group-thread',turns:[{id:'active',status:'inProgress'}]}}});
  assert.equal(large.result.thread.turns.length,2,'history itself is not changed');
  assert.deepEqual(JSON.parse((await run('account')).stdout),{result:{account:{type:'chatgpt'}}});
  await assert.rejects(run('error'),error=>error.code===1 && JSON.parse(error.stdout).error==='Resume failed');
});

test('bridge authenticates, journals events, deduplicates turns and rejects stale approvals', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bot-test-'));
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  let child;
  async function launch() {
    child = spawn(process.execPath, ['src/bridge.mjs'], { cwd: resolve('.'), env: {
      ...process.env, BRIDGE_ROOT: root, BRIDGE_PORT: String(port), CODEX_BIN: resolve('test/fixtures/fake-codex.mjs'),
    }, stdio: 'ignore' });
    for (let i = 0; i < 80; i++) {
      try { const health = await call({ action: 'health' }); if (health.ready) return health; } catch {}
      await sleep(50);
    }
    throw new Error('Bridge did not start');
  }
  async function call(body, token) {
    const response = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: {
      authorization: `Bearer ${token ?? await readFile(join(root, 'bridge.key'), 'utf8')}`,
    }, body: JSON.stringify(body) });
    if (response.status === 403) throw new Error('Forbidden');
    const value = await response.json();
    if (value.error) throw new Error(value.error);
    return value.result;
  }
  async function stop() { if (child?.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; } }
  t.after(stop);
  const health = await launch();
  await call({action:'rpc',method:'thread/read',params:{threadId:'stream-thread'},key:'stream-read'});
  const live=await call({action:'events',after:0});
  assert.equal(live.streams[0].text,'Hello **world**');
  assert.ok(!JSON.stringify(live).includes('PRIVATE REASONING'));
  assert.ok(!live.events.some(e=>e.data.method==='item/agentMessage/delta'),'token deltas must not grow the event journal');
  await call({action:'rpc',method:'turn/interrupt',params:{threadId:'stream-thread',turnId:'stream-turn'},key:'stream-stop'});
  assert.equal((await call({action:'events',after:0})).streams.length,0);
  await assert.rejects(call({ action: 'health' }, 'wrong-key'), /Forbidden/);
  const request = { action: 'rpc', method: 'turn/start', params: { threadId: 'test-thread' }, key: 'one-prompt' };
  const [a, b] = await Promise.all([call(request), call(request)]);
  assert.equal(a.turn.id, b.turn.id);
  const account = await call({ action: 'rpc', method: 'account/read', key: 'read-account' });
  assert.equal(account.calls, 1);
  const first = await call({ action: 'events', after: 0 });
  const approval = first.events.find(event => event.data.id === 901);
  assert.ok(first.events.some(event => event.data.params?.item?.text === 'Готово 🦎'));
  await assert.rejects(call({ action: 'reply', key: 'wrong-generation', generation: 'old', id: 901, result: { decision: 'accept' } }), /expired/);
  await call({ action: 'reply', key: 'decision', generation: health.generation, id: 901, result: { decision: 'decline' } });
  await assert.rejects(call({ action: 'reply', key: 'second-decision', generation: approval.generation, id: 901, result: { decision: 'accept' } }), /expired/);
  await stop();
  const second = await launch();
  assert.notEqual(second.generation, health.generation);
  assert.deepEqual(await call(request), a);
  assert.ok((await call({ action: 'events', after: 0 })).events.length > first.events.length);
});
