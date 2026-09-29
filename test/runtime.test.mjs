import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../src/runtime.mjs';
import { NotFoundError } from '@lizard-build/sdk';

function fixture() {
  const state = new Map(); const files = new Map(); let attached = null; let created = 0; let killed = 0;
  const live = new Map(); let lostReply = false;
  const volume = { getInfo: async () => ({ attachedSandboxId: attached, status: attached ? 'attached' : 'available' }) };
  const client = {
    volumes: { getOrCreate: async () => volume, get: async () => volume },
    connect: async id => { if (!live.has(id)) throw new NotFoundError('gone'); return live.get(id); },
    create: async (_template, opts) => {
      assert.equal(opts.volumeName,'user-volume'); assert.ok(opts.timeoutMs > 0);
      const id = `sandbox-${++created}`;
      const sb = { sandboxId: id, setTimeout: async () => {},
        fs: { write: async (p,s) => files.set(p,s) },
        process: { exec: async cmd => {
          if (cmd.includes('warm-start.mjs')) return {exitCode:42,stdout:''};
          if (cmd.includes('bridge-client.mjs')) {
            const request = JSON.parse(files.get(cmd.split(' ').at(-1)));
            assert.equal(request.action,'health');
            return {exitCode:0,stdout:JSON.stringify({result:{ready:true,version:2,generation:id}})};
          }
          return {exitCode:0,stdout:''};
        } },
        kill: async () => { killed++; live.delete(id); attached=null; return true; },
      };
      live.set(id,sb); attached=id;
      if (lostReply) { lostReply=false; throw new Error('connection dropped after create'); }
      return sb;
    },
  };
  const store={get:async(k,d)=>state.get(k)??d,set:async(k,v)=>state.set(k,v)};
  const cfg={project:'project',volume:'user-volume',sizeGb:2,template:'codex',owner:123,sandboxLifetimeMs:7200000};
  return {state,files,client,store,cfg,volume,stats:()=>({created,killed}),loseReply:()=>{lostReply=true},setAttached:id=>{attached=id}};
}

test('sandbox deletion retains volume files and next start creates a new sandbox', async () => {
  const f=fixture(); const runtime=new Runtime(f.cfg,f.store,f.client,()=>f.volume);
  await runtime.start();
  f.files.set('/workspace/sessions/55/work.txt','keep my work');
  assert.equal(f.state.get('sandbox'),'sandbox-1');
  await runtime.retire();
  assert.equal(f.state.get('sandbox'),null);
  assert.equal(f.files.get('/workspace/sessions/55/work.txt'),'keep my work');
  await runtime.start();
  assert.equal(f.state.get('sandbox'),'sandbox-2');
  assert.equal(f.files.get('/workspace/sessions/55/work.txt'),'keep my work');
  assert.deepEqual(f.stats(),{created:2,killed:1});
});
test('lost create reply reconnects by the same volume without duplicating a sandbox', async () => {
  const f=fixture(); const runtime=new Runtime(f.cfg,f.store,f.client,()=>f.volume); f.loseReply();
  await assert.rejects(runtime.start(),/dropped/);
  assert.ok(f.state.get('creationAttempt'));
  await runtime.start();
  assert.deepEqual(f.stats(),{created:1,killed:0});
  assert.equal(f.state.get('sandbox'),'sandbox-1');
});
test('unknown allocation stays blocked and a mismatched volume cannot be retired', async () => {
  const f=fixture(); const runtime=new Runtime(f.cfg,f.store,f.client,()=>f.volume);
  f.state.set('creationAttempt',{at:Date.now()});
  await assert.rejects(runtime.start(),/outcome unknown/);
  await assert.rejects(runtime.retire(),/outcome unknown/);
  assert.ok(f.state.get('creationAttempt'));
  assert.equal(f.stats().created,0);
  f.state.set('creationAttempt',null);
  await runtime.start(); f.setAttached('someone-else');
  await assert.rejects(runtime.retire(),/different volume/);
  assert.equal(f.stats().killed,0);
  assert.equal(f.state.get('sandbox'),'sandbox-1');
});
test('retirement reconciles a lost creation reply through the tenant volume', async () => {
  const f=fixture(); const runtime=new Runtime(f.cfg,f.store,f.client,()=>f.volume); f.loseReply();
  await assert.rejects(runtime.start(),/dropped/);
  await runtime.retire();
  assert.deepEqual(f.stats(),{created:1,killed:1});
  assert.equal(f.state.get('sandbox'),null);
  assert.equal(f.state.get('creationAttempt'),null);
});

test('missing CLIs must finish installation before the runtime can start', async () => {
  const runtime = new Runtime({}, {}, {});
  let checks = 0; let launched = false;
  runtime.sandbox = {process:{exec:async cmd => {
    if (cmd.includes('test -f /opt/telegram-codex/tools-ready-v3')) return {exitCode:checks++ ? 0 : 1,stdout:''};
    if (cmd.startsWith('nohup')) { launched=true; return {exitCode:0,stdout:''}; }
    assert.ok(launched); return {exitCode:0,stdout:'ready'};
  }}};
  await runtime.ensureTools();
  assert.equal(checks,2);
  runtime.sandbox.process.exec = async cmd => ({exitCode:cmd.includes('test -f /opt/telegram-codex/tools-ready-v3') ? 1 : 0,stdout:cmd.startsWith('if test')?'failed':''});
  await assert.rejects(runtime.ensureTools(), /CLI installation failed/);
});

test('prepared runtime restores without controller uploads or installer polling', async () => {
  const f=fixture(); const first=new Runtime(f.cfg,f.store,f.client,()=>f.volume); await first.start();
  const sandbox=first.sandbox;
  sandbox.fs.write=async()=>{throw new Error('Warm restore must not upload files');};
  const calls=[];
  sandbox.process.exec=async cmd=>{calls.push(cmd);return {exitCode:0,stdout:JSON.stringify({ready:true,version:2,dead:false,generation:'restored',restoredMs:80,localReadyMs:150})};};
  const second=new Runtime(f.cfg,f.store,f.client,()=>f.volume); await second.start();
  assert.equal(calls.length,1);
  assert.match(calls[0],/warm-start/);
  assert.equal(second.generation,'restored');
  assert.equal(second.startup.cached,true);
});

test('an existing volume needs one attachment read and no provisioning call', async () => {
  const f=fixture();
  f.client.volumes.getOrCreate=async()=>{throw new Error('Existing volume must not be provisioned again');};
  let reads=0;
  const getInfo=f.volume.getInfo;
  f.volume.getInfo=async()=>{reads++;return getInfo();};
  await new Runtime(f.cfg,f.store,f.client,()=>f.volume).start();
  assert.equal(reads,1);
});

test('only a missing volume triggers provisioning; other read failures stop startup', async () => {
  const f=fixture(); let provisioned=0;
  f.client.volumes.getOrCreate=async()=>{provisioned++;return f.volume;};
  await new Runtime(f.cfg,f.store,f.client,()=>({getInfo:async()=>{throw new NotFoundError('missing');}})).start();
  assert.equal(provisioned,1);
  await assert.rejects(new Runtime(f.cfg,f.store,f.client,()=>({getInfo:async()=>{throw new Error('forbidden');}})).start(),/forbidden/);
  assert.equal(provisioned,1);
  assert.equal(f.stats().created,1);
});
