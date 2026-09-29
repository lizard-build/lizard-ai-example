// Run on the worker after deploying migration support, before enabling managed accounts.
// Original volumes remain intact. Only switch ownership after the copy is verified.
import {randomBytes,randomUUID,randomInt} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Lizard,NotFoundError} from '@lizard-build/sdk';
import {config,sleep} from '../src/core.mjs';
import {Control} from '../src/control.mjs';
import {Store} from '../src/store.mjs';
import {LizardAccounts} from '../src/lizard-accounts.mjs';
const cfg=config(),control=new Control(cfg),accounts=new LizardAccounts(cfg,control);
const user=Number(process.argv[2]);if(!Number.isSafeInteger(user)||user<1)throw new Error('Invalid user');
let store,switched=false,stage='account';
try {
  const tenant=await control.tenant(user);if(tenant?.admission!=='approved')throw new Error('User is not approved');
  const account=await accounts.ensure(user);
  if(tenant.runtime_project_id===account.serviceProjectId){console.log(JSON.stringify({user,alreadyMigrated:true}));process.exitCode=0;}
  else {
    stage='tenant-lock';
    await control.query('UPDATE control.tenants SET migrating=true WHERE user_id=$1',[user]);
    for(let attempt=0;attempt<30;attempt++) {
      store=new Store(cfg.database,tenant.schema_name);
      try {await store.start();break;}catch{await store.close();store=null;await sleep(1000);}
    }
    if(!store)throw new Error('Worker did not release the tenant');
    const busy=(await store.query(`SELECT EXISTS(SELECT 1 FROM sessions WHERE turn_id IS NOT NULL)
      OR EXISTS(SELECT 1 FROM prompts WHERE state IN ('running','starting'))
      OR EXISTS(SELECT 1 FROM approvals WHERE state='pending') AS busy`)).rows[0].busy;
    if(busy || Number(await store.get('loginPendingUntil',0))>Date.now()) throw new Error('Active task or sign-in; retry after it finishes');
    const oldProject=tenant.runtime_project_id || cfg.project;
    const old=new Lizard({project:oldProject,apiKey:cfg.provisionerKey,apiUrl:cfg.apiUrl});
    const next=new Lizard({project:account.serviceProjectId,apiKey:cfg.provisionerKey,apiUrl:cfg.apiUrl});
    stage='source-volume';
    let info;try {info=await (await old.volumes.get(tenant.volume_name)).getInfo(oldProject);}catch(e){if(!(e instanceof NotFoundError))throw e;}
    let source,target;
    if(info) {
      const attached=info.attachedSandboxId ?? info.attachedTo;
      stage='source-sandbox';
      source=attached ? await old.connect(attached) : await old.create(cfg.template,{volumeName:tenant.volume_name,timeoutMs:3600000});
      await source.setTimeout(3600000);
      // Drain Codex before copying its SQLite journal and saved authentication.
      await source.process.exec(`node -e 'const f=require("fs");for(const p of f.readdirSync("/proc")){if(!/^\\d+$/.test(p))continue;try{if(f.readFileSync("/proc/"+p+"/cmdline","utf8").split("\\0").includes("/opt/telegram-codex/bridge.mjs"))process.kill(Number(p),"SIGTERM")}catch{}}'`);
      await sleep(1500);
      stage='target-volume';
      const volume=await next.volumes.getOrCreate(tenant.volume_name,{sizeGb:info.sizeGb || (user===cfg.owner?cfg.sizeGb:cfg.tenantSizeGb),region:info.region});
      const destination=await volume.getInfo(account.serviceProjectId);
      const targetAttached=destination.attachedSandboxId ?? destination.attachedTo;
      stage='target-sandbox';
      target=targetAttached ? await next.connect(targetAttached) : await next.create(cfg.template,{volumeName:tenant.volume_name,timeoutMs:3600000});
      stage='copy';
      const transfer=await readFile(new URL('../src/volume-transfer.mjs',import.meta.url),'utf8');
      const token=randomBytes(32).toString('hex'),jobId=randomUUID(),port=randomInt(44000,49000);
      const inputPath=`/tmp/tg-volume-${jobId}.json`,output=`/tmp/tg-volume-${jobId}-result.json`;
      await source.fs.write('/tmp/tg-volume-transfer.mjs',transfer);
      await source.fs.write(inputPath,JSON.stringify({token,jobId,port}));
      const launched=await source.process.exec(`nohup node /tmp/tg-volume-transfer.mjs serve ${inputPath} </dev/null >/tmp/tg-volume-transfer.log 2>&1 &`);
      if(launched.exitCode)throw new Error('Could not start transfer');
      const host=await source.getHost(port),url=host.startsWith('https://')?host:`https://${host}`;
      await target.fs.write('/tmp/tg-volume-transfer.mjs',transfer);
      await target.fs.write(inputPath,JSON.stringify({token,url,jobId,output}));
      await target.process.exec(`nohup node /tmp/tg-volume-transfer.mjs receive ${inputPath} </dev/null >/tmp/tg-volume-transfer.log 2>&1 &`);
      let copied;
      for(let i=0;i<240;i++) {
        const result=await target.process.exec(`if test -f ${output}; then cat ${output}; fi`);
        if(result.stdout.trim()){copied=JSON.parse(result.stdout);break;}
        await sleep(5000);
      }
      if(!copied?.ok || copied.jobId!==jobId)throw new Error('Volume copy did not verify; original volume is unchanged');
      await store.set('compute-migration',{sourceProject:oldProject,sourceVolume:info.id,targetProject:account.serviceProjectId,targetVolume:destination.id,sha256:copied.sha256,bytes:copied.bytes});
      console.log(JSON.stringify({user,copiedBytes:copied.bytes,verified:true}));
    }
    stage='switch';
    await control.transaction(async db=>{
      await db.query(`UPDATE ${store.schema}.bot_state SET value=jsonb_set(value,'{project}',to_jsonb($1::text)) WHERE key='identity'`,[account.serviceProjectId]);
      await db.query(`INSERT INTO ${store.schema}.bot_state VALUES('sandbox',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[JSON.stringify(target?.sandboxId || null)]);
      await db.query(`INSERT INTO ${store.schema}.bot_state VALUES('creationAttempt','null') ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
      await db.query("UPDATE control.tenants SET runtime_project_id=$2,sandbox_id=$3,lifecycle=$4,migrating=false,next_check=now() WHERE user_id=$1",[user,account.serviceProjectId,target?.sandboxId || null,target?'running':'sleeping']);
    });
    switched=true;
    if(source)await source.kill();
    console.log(JSON.stringify({user,migrated:true,originalVolumeRetained:Boolean(info)}));
  }
} catch(error) {console.error(JSON.stringify({stage,errorType:error.constructor.name}));console.error(error.message?.startsWith('Active task')?error.message:'Migration did not complete; inspect its state before retrying.');process.exitCode=1;}
finally {if(!switched)await control.query('UPDATE control.tenants SET migrating=false,next_check=now() WHERE user_id=$1',[user]).catch(()=>{});await store?.close();await control.close();}
