import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {NotFoundError} from '@lizard-build/sdk';
import {config} from '../src/core.mjs';
import {Control} from '../src/control.mjs';
import {TenantWorker,Workers} from '../src/worker.mjs';

test('workspace provisioning remains available when deployment credentials are paused',async()=>{
  const workers=new Workers({role:'worker',managedAccounts:false,provisionerKey:'server-only'}, {}, {});
  assert.ok(workers.accounts);
  assert.equal(new Workers({role:'gateway',managedAccounts:false,provisionerKey:'server-only'}, {}, {}).accounts,null);
});

test('approved users get command replies during setup failures and can sign in without a deployment key',
  {skip:!process.env.TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});t.after(()=>admin.end());
  await admin.query('CREATE DATABASE onboarding_test');
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/onboarding_test';
  const cfg=config({TELEGRAM_BOT_TOKEN:'999:test',TELEGRAM_OWNER_ID:'920001',DATABASE_URL:url.toString(),
    LIZARD_PROJECT_ID:'controller',LIZARD_API_KEY:'controller-only',LIZARD_PROVISIONER_KEY:'server-only',BOT_ROLE:'worker'});
  const control=new Control(cfg);await control.start();t.after(()=>control.close());
  const user=920002;
  const message=(id,text)=>({update_id:id,message:{from:{id:user},chat:{id:user,type:'private'},text}});
  await control.receive([message(1,'/start')]);
  await control.receive([{update_id:2,message:{from:{id:cfg.owner},chat:{id:cfg.owner,type:'private'},text:`/allow ${user}`}}]);
  let fail=true,attempts=0,starts=0,loginCalls=0;
  const accounts={ensure:async(id,options)=>{
    assert.equal(id,user);assert.deepEqual(options,{credentials:false});attempts++;
    if(fail) throw new Error('Workspace temporarily unavailable');
    return {workspaceId:'user-workspace',serviceProjectId:'user-state'};
  }};
  class Runtime {
    constructor(c){this.cfg=c;this.generation='test-generation';this.renewedAt=Date.now();
      this.client={volumes:{get:async()=>{throw new NotFoundError('No legacy volume');}}};}
    async start(){starts++;assert.equal(this.cfg.project,'user-state');assert.equal(this.cfg.managedLizard,undefined);
      this.sandbox={sandboxId:'user-sandbox'};return true;}
    async rpc(method){
      if(method==='account/read')return {account:null};
      if(method==='account/login/start'){loginCalls++;return {loginId:'login',verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-CODE'};}
      if(method==='model/list')return {data:[]};
      throw new Error(`Unexpected RPC ${method}`);
    }
    async events(){return {events:[],streams:[]};}
  }
  const telegram={call:async method=>method==='getMe'?{has_topics_enabled:true}:{message_thread_id:55}};
  const worker=new TenantWorker(cfg,control,telegram,await control.tenant(user),Runtime,accounts);
  await worker.store.start();t.after(()=>worker.store.close());
  await worker.store.set('identity',{project:'controller'});
  // A failing login must not hide later help or session commands.
  await control.receive([message(3,'/login'),message(4,'/start'),message(5,'/new Demo'),message(6,'/sessions')]);
  await assert.rejects(worker.tick(),/temporarily unavailable/);
  assert.equal(attempts,1);assert.equal(starts,0);
  assert.deepEqual((await worker.store.query('SELECT update_id,state FROM inbox ORDER BY update_id')).rows.map(r=>[Number(r.update_id),r.state]),
    [[3,'pending'],[4,'done'],[5,'done'],[6,'done']]);
  const replies=(await control.query('SELECT text FROM control.outbox WHERE chat_id=$1',[user])).rows.map(r=>r.text);
  assert.ok(replies.some(text=>text.includes('Your Codex assistant')));
  assert.ok(replies.some(text=>text.includes('request is saved')));
  assert.ok(replies.some(text=>text.includes('Demo')));
  assert.equal((await control.tenant(user)).lifecycle,'sleeping','failed setup does not reserve shared compute');
  fail=false;
  await worker.tick();
  assert.equal(starts,1);assert.equal(loginCalls,1);
  assert.equal((await control.tenant(user)).runtime_project_id,'user-state');
  assert.equal((await worker.store.get('identity')).project,'user-state');
  assert.equal((await worker.store.query('SELECT state FROM inbox WHERE update_id=3')).rows[0].state,'done');
  assert.ok((await control.query('SELECT text FROM control.outbox WHERE chat_id=$1',[user])).rows.some(r=>r.text.includes('TEST-CODE')));
  // Device login is reused when a user repeats /login.
  await control.receive([message(7,'/login')]);await worker.tick();
  assert.equal(loginCalls,1);assert.equal(attempts,2);
});
