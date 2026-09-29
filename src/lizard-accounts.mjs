import {Lizard,NotFoundError,AuthenticationError} from '@lizard-build/sdk';
import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {appCards} from './apps.mjs';

export function credentialKey(value) {
  const key=Buffer.from(value || '', 'base64');
  if(key.length!==32) throw new Error('TENANT_CREDENTIAL_KEY must contain 32 bytes in base64');
  return key;
}
export function sealCredential(token,key,aad) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),encrypted].map(b=>b.toString('base64')).join('.');
}
export function openCredential(value,key,aad) {
  const [iv,tag,data]=value.split('.').map(s=>Buffer.from(s,'base64'));
  const cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data),cipher.final()]).toString('utf8');
}
export function workspaceScope(scopes,id) {
  return Array.isArray(scopes) && scopes.length===1 && scopes[0].type==='workspace' && scopes[0].id===id;
}
export async function collectManagedApps(client,workspaceId,metadata=[]) {
  const projects=await client.projects.list({workspaceId});
  if(!Array.isArray(projects) || projects.some(p=>p.workspaceId!==workspaceId)) throw new Error('Unexpected project scope');
  let partial=projects.length>200,index=0;const items=[],list=projects.slice(0,200);
  await Promise.all(Array.from({length:Math.min(4,list.length)},async()=>{
    while(index<list.length) {
      const project=list[index++];
      try {items.push(...appCards(project,await client.services.list({projectId:project.id}),null,metadata,{projectScoped:true}));}
      catch {partial=true;}
    }
  }));
  return {state:'connected',items,partial,updatedAt:new Date().toISOString()};
}

export class LizardAccounts {
  constructor(cfg,control,client,scopedClient) {
    Object.assign(this,{cfg,control});
    this.key=cfg.tenantCredentialKey ? credentialKey(cfg.tenantCredentialKey) : null;
    this.client=client || new Lizard({apiKey:cfg.provisionerKey || cfg.apiKey,apiUrl:cfg.apiUrl});
    this.scopedClient=scopedClient || (apiKey=>new Lizard({apiKey,apiUrl:cfg.apiUrl}));
  }
  aad(user,workspace) {return `${this.cfg.project}:${user}:${workspace}`;}
  async lock(user,fn) {
    const db=await this.control.pool.connect();let locked=false;
    try {
      locked=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[`lizard-account:${user}`])).rows[0].locked;
      if(!locked) throw new Error('Account setup in progress');
      return await fn(db);
    } finally {
      try {if(locked) await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`lizard-account:${user}`]);} finally {db.release();}
    }
  }
  async ensure(user,{credentials=true}={}) {
    if(credentials && !this.key) throw new Error('Deployment credential encryption is not configured');
    return this.lock(user,async db=>{
      if((await db.query('SELECT admission FROM control.tenants WHERE user_id=$1',[user])).rows[0]?.admission!=='approved') throw new Error('Access is not approved');
      const name=`tg-${this.cfg.token.split(':')[0]}-${user<0 ? `group-${-user}` : user}`;
      await db.query('INSERT INTO control.lizard_accounts(user_id,workspace_name) VALUES($1,$2) ON CONFLICT DO NOTHING',[user,name]);
      let a=(await db.query('SELECT * FROM control.lizard_accounts WHERE user_id=$1',[user])).rows[0];
      if(!a.workspace_id) {
        const matches=(await this.client.workspaces.list()).filter(w=>w.name===a.workspace_name);
        if(matches.length>1) throw new Error('Workspace name is ambiguous');
        let workspace=matches[0];
        if(!workspace) {
          if(a.workspace_attempt) throw new Error('Workspace creation outcome unknown');
          await db.query('UPDATE control.lizard_accounts SET workspace_attempt=true WHERE user_id=$1',[user]);
          workspace=await this.client.workspaces.create({name:a.workspace_name});
        }
        await db.query('UPDATE control.lizard_accounts SET workspace_id=$2 WHERE user_id=$1',[user,workspace.id]);
        a.workspace_id=workspace.id;
      }
      if(!a.service_project_id) {
        const existing=(await this.client.projects.list({workspaceId:a.workspace_id})).filter(p=>p.workspaceId===a.workspace_id && p.name==='agent-state');
        if(existing.length>1) throw new Error('Service project is ambiguous');
        let project=existing[0];
        if(!project) {
          if(a.project_attempt) throw new Error('Service project creation outcome unknown');
          await db.query('UPDATE control.lizard_accounts SET project_attempt=true WHERE user_id=$1',[user]);
          project=await this.client.projects.create({workspaceId:a.workspace_id,name:'agent-state'});
        }
        a.service_project_id=project.id;
        await db.query('UPDATE control.lizard_accounts SET service_project_id=$2 WHERE user_id=$1',[user,project.id]);
      }
      // Compute setup needs no credential inside the user's Sandbox. Keep it
      // available while scoped deployment-key issuance is disabled.
      if(!credentials) {
        if((await db.query('SELECT admission FROM control.tenants WHERE user_id=$1',[user])).rows[0]?.admission!=='approved') throw new Error('Access was blocked during setup');
        return {workspaceId:a.workspace_id,workspaceName:a.workspace_name,serviceProjectId:a.service_project_id};
      }
      if(!a.key_cipher) {
        // A create response is the only chance to read a key. Reconcile an orphan
        // from a lost response by revoking only the exact key this job requested.
        if(a.key_name) {
          for(const old of (await this.client.apiKeys.list()).filter(k=>k.name===a.key_name)) {
            if(!workspaceScope(old.scopes,a.workspace_id)) throw new Error('Unexpected key scope');
            await this.client.apiKeys.delete(old.id);
          }
        }
        a.key_name=`${name}-${randomUUID()}`;
        await db.query("UPDATE control.lizard_accounts SET key_name=$2,state='pending' WHERE user_id=$1",[user,a.key_name]);
        const key=await this.client.apiKeys.create({name:a.key_name,workspaces:[a.workspace_id]});
        if(!key.key || !workspaceScope(key.scopes,a.workspace_id)) throw new Error('Invalid scoped credential');
        a.key_id=key.id;
        a.key_cipher=sealCredential(key.key,this.key,this.aad(user,a.workspace_id));
        await db.query('UPDATE control.lizard_accounts SET key_id=$2,key_cipher=$3 WHERE user_id=$1',[user,a.key_id,a.key_cipher]);
      }
      const token=openCredential(a.key_cipher,this.key,this.aad(user,a.workspace_id));
      // Read back scope using the new credential before allowing it into a sandbox.
      const scoped=this.scopedClient(token),identity=await scoped.whoami();
      if(identity.scoped!==true || !workspaceScope(identity.scopes,a.workspace_id)) throw new Error('Credential isolation check failed');
      const visible=await scoped.workspaces.list();
      if(visible.length!==1 || visible[0].id!==a.workspace_id) throw new Error('Workspace isolation check failed');
      // A workspace key must not reach account key management or the bot project.
      for(const probe of [()=>scoped.apiKeys.list(),()=>scoped.services.list({projectId:this.cfg.project})]) {
        let denied=false;
        try {await probe();} catch(e) {if(e instanceof AuthenticationError || e instanceof NotFoundError)denied=true;else throw e;}
        if(!denied) throw new Error('Platform credential isolation is not enforced');
      }
      if((await db.query('SELECT admission FROM control.tenants WHERE user_id=$1',[user])).rows[0]?.admission!=='approved') {
        await this.revokeKey(db,user,a);throw new Error('Access was blocked during setup');
      }
      await db.query("UPDATE control.lizard_accounts SET state='ready',updated_at=now() WHERE user_id=$1",[user]);
      if(a.state!=='ready') await db.query(`UPDATE control.tenants SET apps='{"state":"connected","items":[]}',apps_request_seq=apps_request_seq+1 WHERE user_id=$1`,[user]);
      return {workspaceId:a.workspace_id,workspaceName:a.workspace_name,serviceProjectId:a.service_project_id,keyId:a.key_id,token};
    });
  }
  async revokeKey(db,user,a) {
    if(a?.key_name && !a.key_id) {
      for(const orphan of (await this.client.apiKeys.list()).filter(k=>k.name===a.key_name)) {
        if(!workspaceScope(orphan.scopes,a.workspace_id)) throw new Error('Unexpected key scope');
        await this.client.apiKeys.delete(orphan.id);
      }
    }
    if(a?.key_id) try {await this.client.apiKeys.delete(a.key_id);}catch(e){if(!(e instanceof NotFoundError))throw e;}
    await db.query("UPDATE control.lizard_accounts SET state='revoked',key_cipher=NULL,key_id=NULL,key_name=NULL,updated_at=now() WHERE user_id=$1",[user]);
  }
  async revoke(user) {
    return this.lock(user,async db=>{
      const a=(await db.query('SELECT * FROM control.lizard_accounts WHERE user_id=$1',[user])).rows[0];
      if(a && a.state!=='revoked') await this.revokeKey(db,user,a);
    });
  }
  async apps(account,metadata) {
    const result=await collectManagedApps(this.scopedClient(account.token),account.workspaceId,metadata);
    result.items=result.items.filter(item=>item.key!==account.serviceProjectId);
    return result;
  }
}
