import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {NotFoundError,AuthenticationError} from '@lizard-build/sdk';
import {mkdtemp,mkdir,readFile,writeFile,stat,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Control} from '../src/control.mjs';
import {TenantWorker} from '../src/worker.mjs';
import {LizardAccounts,sealCredential,openCredential,collectManagedApps} from '../src/lizard-accounts.mjs';
import {installManagedLizard} from '../src/managed-lizard.mjs';

test('stored deployment credentials reject a different user, workspace, key or modified ciphertext',()=>{
  const key=randomBytes(32),value=sealCredential('liz_private',key,'project:user:workspace');
  assert.equal(openCredential(value,key,'project:user:workspace'),'liz_private');
  assert.ok(!value.includes('liz_private'));
  for(const aad of ['project:other:workspace','project:user:other'])assert.throws(()=>openCredential(value,key,aad));
  assert.throws(()=>openCredential(value,randomBytes(32),'project:user:workspace'));
  const parts=value.split('.');parts[2]=Buffer.from('tampered').toString('base64');
  assert.throws(()=>openCredential(parts.join('.'),key,'project:user:workspace'));
});

test('managed CLI restores scoped login, preserves app links and ignores old shell credentials',async()=>{
  const root=await mkdtemp(join(tmpdir(),'managed-lizard-')),target=join(root,'bin/lizard');
  const binary=join(root,'inspect.mjs'),folder=join(root,'lizard-cli/.lizard');
  await mkdir(folder,{recursive:true});
  await writeFile(join(folder,'config.json'),JSON.stringify({projects:{'/workspace/app':{projectId:'app'}}}));
  await writeFile(binary,'#!/usr/bin/env node\nconsole.log(JSON.stringify({home:process.env.LIZARD_HOME,token:process.env.LIZARD_TOKEN,key:process.env.LIZARD_API_KEY,args:process.argv.slice(2)}));',{mode:0o755});
  const input=join(root,'lizard-account-input.json');
  await writeFile(input,JSON.stringify({token:'liz_scoped',workspaceId:'mine',keyId:'key-1'}));
  await installManagedLizard({root,target,binary});
  const cfg=JSON.parse(await readFile(join(folder,'config.json'),'utf8'));
  assert.equal(cfg.credentials.accessToken,'liz_scoped');assert.equal(cfg.projects['/workspace/app'].projectId,'app');
  assert.equal((await stat(join(folder,'config.json'))).mode&0o777,0o600);
  await assert.rejects(access(input));
  const result=JSON.parse(execFileSync(target,['whoami','--json'],{env:{...process.env,LIZARD_TOKEN:'old',LIZARD_API_KEY:'old',LIZARD_HOME:'/wrong'}}));
  assert.equal(result.home,join(root,'lizard-cli'));assert.equal(result.token,undefined);assert.equal(result.key,undefined);
  assert.deepEqual(result.args,['whoami','--json']);
  await installManagedLizard({root,target,binary});
  await writeFile(input,JSON.stringify({token:'liz_other',workspaceId:'other',keyId:'key-2'}));
  await assert.rejects(installManagedLizard({root,target,binary}),/workspace changed/);
  assert.equal(JSON.parse(await readFile(join(folder,'config.json'),'utf8')).credentials.accessToken,'liz_scoped');
});

test('managed gallery checks workspace and service project instead of shared platform account',async()=>{
  const client={projects:{list:async()=>[{id:'mine',name:'My app',workspaceId:'w'}]},services:{list:async()=>[
    {projectId:'other',name:'web',containerPort:3000,domain:'other.example.com',status:'running'},
    {projectId:'mine',name:'web',containerPort:3000,domain:'mine.example.com',status:'running'},
  ]}};
  const result=await collectManagedApps(client,'w');assert.equal(result.items.length,1);assert.equal(result.items[0].url,'https://mine.example.com');
  await assert.rejects(collectManagedApps(client,'other'),/scope/);
});

test('managed gallery refresh does not start an idle Sandbox',async()=>{
  let saved,reads=0;
  const tenant={user_id:501,admission:'approved',schema_name:'tenant_501',apps_request_seq:1,apps_done_seq:0};
  const control={cfg:{},query:async(_sql,values)=>{saved=values;}};
  const accounts={apps:async()=>{reads++;return {state:'connected',items:[]};}};
  class Runtime {collectApps(){assert.fail('must not use Sandbox');} start(){assert.fail('must not wake Sandbox');}}
  const worker=new TenantWorker({owner:1},control,{},tenant,Runtime,accounts);
  worker.managedAccount={workspaceId:'w'};worker.refreshApps(tenant);await worker.appsRefresh;
  assert.equal(reads,1);assert.equal(saved[0],501);await worker.store.close();
});

test('paused rollout cannot start new users in the shared project',async()=>{
  class Runtime {}
  const tenant={user_id:502,admission:'approved',schema_name:'tenant_502'};
  const worker=new TenantWorker({owner:1,project:'controller',provisionerKey:'server-only'},{cfg:{}},{},tenant,Runtime);
  await assert.rejects(worker.prepareAccount(tenant),/shared compute is disabled/);
  await worker.prepareAccount({...tenant,runtime_project_id:'own-state'});await worker.store.close();
});

test('compute selection waits for migration and retries a failed volume read before caching access',async()=>{
  let mode='error',committed=false;
  const account={workspaceId:'workspace-a',serviceProjectId:'state-a',token:'liz_a'};
  const tenant={user_id:501,admission:'approved',schema_name:'tenant_501',volume_name:'v'};
  const control={cfg:{provisionerKey:'server-only'},transaction:async fn=>{await fn({query:async()=>{}});committed=true;}};
  const accounts={ensure:async()=>account};
  class Runtime {constructor(cfg){this.cfg=cfg;this.client={volumes:{get:async()=>{
    if(mode==='error')throw new Error('temporary network failure');
    if(mode==='missing')throw new NotFoundError('missing');
    return {};
  }}};}}
  const worker=new TenantWorker({owner:1,project:'controller',managedAccounts:true},control,{},tenant,Runtime,accounts);
  await assert.rejects(worker.prepareAccount(tenant),/network/);assert.equal(worker.managedAccount,undefined);
  mode='exists';await assert.rejects(worker.prepareAccount(tenant),/needs migration/);assert.equal(committed,false);
  mode='missing';await worker.prepareAccount(tenant);assert.equal(committed,true);
  assert.equal(worker.runtime.cfg.project,'state-a');assert.equal(worker.runtime.cfg.apiKey,'server-only');
  assert.equal(worker.runtime.cfg.managedLizard.token,'liz_a');assert.equal(worker.bot.runtime,worker.runtime);
  await worker.store.close();
});

test('approved users get one isolated workspace and state project across retries and revocation',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});t.after(()=>admin.end());
  await admin.query('CREATE DATABASE accounts_test');const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/accounts_test';
  const cfg={database:url.toString(),token:'999:test',owner:910001,project:'controller',volume:'owner',managedAccounts:true,
    tenantCredentialKey:randomBytes(32).toString('base64')};
  const control=new Control(cfg);await control.start();t.after(()=>control.close());
  await control.query("INSERT INTO control.tenants(user_id,admission,schema_name,volume_name) VALUES(910002,'pending','tenant_910002','v2'),(910003,'approved','tenant_910003','v3')");
  const workspaces=[],projects=[],keys=[];let seq=0,loseWorkspace=false,loseKey=false,wrongScope=false,unsafeAccount=false;
  const client={workspaces:{list:async()=>workspaces,create:async input=>{
    const w={...input,id:`w${++seq}`};workspaces.push(w);if(loseWorkspace){loseWorkspace=false;throw new Error('lost workspace response');}return w;
  }},projects:{list:async({workspaceId})=>projects.filter(p=>p.workspaceId===workspaceId),create:async input=>{const p={...input,id:`p${++seq}`};projects.push(p);return p;}},
  apiKeys:{list:async()=>keys,create:async input=>{
    const k={id:`k${++seq}`,name:input.name,key:`liz_${seq}`,scopes:[{type:'workspace',id:input.workspaces[0]}]};keys.push(k);
    if(loseKey){loseKey=false;throw new Error('lost key response');}return k;
  },delete:async id=>{keys.splice(keys.findIndex(k=>k.id===id),1);}}};
  const scoped=token=>({whoami:async()=>({scoped:!wrongScope,scopes:keys.find(k=>k.key===token)?.scopes}),
    workspaces:{list:async()=>workspaces.filter(w=>keys.find(k=>k.key===token)?.scopes[0].id===w.id)},
    projects:{list:async()=>[]},apiKeys:{list:async()=>{if(unsafeAccount)return [];throw new AuthenticationError('account access required');}},
    services:{list:async()=>{throw new NotFoundError('outside scope');}}});
  const accounts=new LizardAccounts(cfg,control,client,scoped);
  await assert.rejects(accounts.ensure(910002),/not approved/);assert.equal(workspaces.length,0);
  const computeOnly=new LizardAccounts({...cfg,tenantCredentialKey:undefined},control,client,()=>assert.fail('compute setup must not use a scoped key'));
  const compute=await computeOnly.ensure(910003,{credentials:false});
  assert.equal(compute.token,undefined);assert.equal(keys.length,0);
  assert.deepEqual(await computeOnly.ensure(910003,{credentials:false}),compute);
  assert.equal(workspaces.length,1);assert.equal(projects.length,1);
  loseWorkspace=true;await assert.rejects(accounts.ensure(cfg.owner),/lost workspace/);
  loseKey=true;await assert.rejects(accounts.ensure(cfg.owner),/lost key/);
  assert.equal(keys.length,1);const orphan=keys[0].id;
  const first=await accounts.ensure(cfg.owner);assert.notEqual(first.keyId,orphan);assert.equal(keys.length,1);
  const resumed=new LizardAccounts(cfg,control,client,scoped);
  assert.deepEqual(await resumed.ensure(cfg.owner),first);assert.equal(workspaces.length,2);assert.equal(projects.length,2);
  assert.equal(projects[1].name,'agent-state');assert.equal(projects[1].workspaceId,first.workspaceId);
  const second=await accounts.ensure(910003);assert.notEqual(first.workspaceId,second.workspaceId);assert.notEqual(first.serviceProjectId,second.serviceProjectId);
  assert.equal(second.workspaceId,compute.workspaceId);assert.equal(second.serviceProjectId,compute.serviceProjectId);
  const row=(await control.query('SELECT * FROM control.lizard_accounts WHERE user_id=$1',[cfg.owner])).rows[0];
  assert.ok(!JSON.stringify(row).includes(first.token));
  wrongScope=true;await assert.rejects(accounts.ensure(cfg.owner),/isolation/);wrongScope=false;
  unsafeAccount=true;await assert.rejects(accounts.ensure(cfg.owner),/isolation is not enforced/);unsafeAccount=false;
  await control.query("UPDATE control.tenants SET admission='blocked' WHERE user_id=$1",[cfg.owner]);
  await accounts.revoke(cfg.owner);assert.equal(keys.some(k=>k.id===first.keyId),false);assert.equal(keys.some(k=>k.id===second.keyId),true);
  await assert.rejects(accounts.ensure(cfg.owner),/not approved/);
  await control.query("UPDATE control.tenants SET admission='approved' WHERE user_id=$1",[cfg.owner]);
  const reapproved=await accounts.ensure(cfg.owner);assert.equal(reapproved.workspaceId,first.workspaceId);assert.notEqual(reapproved.keyId,first.keyId);
  const db=await control.pool.connect();await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[`lizard-account:${cfg.owner}`]);
  await assert.rejects(accounts.ensure(cfg.owner),/in progress/);await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`lizard-account:${cfg.owner}`]);db.release();
  await control.query('UPDATE control.tenants SET migrating=true,next_check=now() WHERE user_id=$1',[cfg.owner]);
  assert.ok(!(await control.candidates(100)).some(t=>Number(t.user_id)===cfg.owner));
});
