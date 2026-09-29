import { safeAppResult } from './apps.mjs';
import { settingsFor, modelCatalog } from './settings.mjs';
import { Store } from './store.mjs';
import { Runtime } from './runtime.mjs';
import { Bot } from './bot.mjs';
import { command, sleep, voiceLimitError } from './core.mjs';
import { attachment, attachmentLimitError } from './attachments.mjs';
import { NotFoundError } from '@lizard-build/sdk';
import { LizardAccounts } from './lizard-accounts.mjs';
import { GroupMemory } from './groups.mjs';

export class TenantWorker {
  constructor(cfg, control, telegram, tenant, RuntimeClass = Runtime, accounts=null) {
    this.accounts=accounts;
    this.control = control; this.telegram = telegram; this.user = Number(tenant.user_id);
    this.cfg = { ...cfg, owner: this.user, chat: this.user, volume: tenant.volume_name,
      groupOwner:tenant.group_owner ? Number(tenant.group_owner) : null,
      groupTitle:tenant.group_title,
      project:tenant.runtime_project_id || cfg.project,
      apiKey:tenant.runtime_project_id ? cfg.provisionerKey || cfg.apiKey : cfg.apiKey,
      sizeGb: this.user === cfg.owner ? cfg.sizeGb : cfg.tenantSizeGb,
      openaiKey: this.user === cfg.owner ? cfg.openaiKey : undefined };
    this.store = new Store(cfg.database, tenant.schema_name);
    this.runtime = new RuntimeClass(this.cfg, this.store);
    this.RuntimeClass=RuntimeClass;
    this.bot = new Bot(this.cfg, this.store, telegram, this.runtime);
    if(this.cfg.groupOwner) this.bot.groupMemory=new GroupMemory(control,this.user);
    this.bot.flush = () => this.control.exported(this.store, this.user);
    this.bot.pendingTopics = async () => (await this.control.query(`SELECT DISTINCT coalesce(
      payload->'message'->>'message_thread_id',payload->'callback_query'->'message'->>'message_thread_id') AS topic
      FROM control.inbox WHERE user_id=$1 AND delivered=false`,[this.user])).rows
      .map(r=>Number(r.topic)).filter(n=>Number.isSafeInteger(n) && n>0);
    this.ready = false; this.stopping = false; this.appsDirty=false;
    this.bot.appsChanged=()=>{this.appsDirty=true;};
  }
  applySettings(tenant) {
    this.bot.settings=settingsFor(tenant,this.control.cfg);
    this.bot.models=tenant.models || [];
    this.cfg.idleMs=Math.min(this.control.cfg.idleMs,this.bot.settings.idleMinutes*60000);
    if(this.settingsVersion!==tenant.settings_version) this.bot.loadedThreads.clear();
    this.settingsVersion=tenant.settings_version;
  }
  async syncSettings() {
    if(!this.ready) return;
    const key=`${this.runtime.generation}:${this.settingsVersion}`;
    if(this.syncedSettings===key) return;
    // The editor owns this file only after the user first saves their settings.
    if(this.settingsVersion>0) await this.runtime.saveAgents(this.bot.settings.agentsMd);
    this.syncedSettings=key;
  }
  refreshApps(tenant) {
    if(this.appsRefresh || (!this.ready && !this.managedAccount) || tenant.admission!=='approved') return;
    const requested=tenant.apps_request_seq>tenant.apps_done_seq;
    if(!requested && (!this.appsDirty || Date.now()-(this.appsCheckedAt || 0)<60000)) return;
    this.appsDirty=false;this.appsCheckedAt=Date.now();
    this.appsRefresh=(async()=>{
      let result;
      try {
        let metadata=[];
        if(this.managedAccount && this.ready) try {metadata=JSON.parse(await this.runtime.sandbox.fs.read('/workspace/.telegram-codex/apps.json')).slice(0,200);} catch {}
        result=safeAppResult(this.managedAccount ? await this.accounts.apps(this.managedAccount,metadata) : await this.runtime.collectApps());
      } catch {result={state:'unavailable',items:[],partial:true};}
      const old=tenant.apps || {}, items=result.partial && result.state!=='connect'
        ? [...(result.items || []),...(old.items || []).filter(a=>!(result.items || []).some(b=>a.key===b.key))]
        : result.items || [];
      await this.control.query('UPDATE control.tenants SET apps=$2,apps_done_seq=greatest(apps_done_seq,$3) WHERE user_id=$1',
        [this.user,JSON.stringify({...result,items:items.slice(0,200),updatedAt:result.updatedAt || old.updatedAt || null}),tenant.apps_request_seq]);
    })().catch(()=>{}).finally(()=>{this.appsRefresh=null;});
  }
  async ensure(existingOnly = false, reserved = false) {
    if (this.ready) return true;
    await this.prepareAccount(await this.control.tenant(this.user));
    if (!existingOnly && !reserved && !await this.control.reserve(this.user)) return false;
    if (await this.runtime.start(!existingOnly) === false) {
      await this.store.query("UPDATE prompts SET state='interrupted' WHERE state IN ('running','starting')");
      await this.store.query('UPDATE sessions SET turn_id=NULL');
      await this.store.query("UPDATE approvals SET state='expired' WHERE state='pending'");
      await this.store.set('sandbox', null);
      await this.control.query("UPDATE control.tenants SET lifecycle='sleeping',sandbox_id=NULL WHERE user_id=$1", [this.user]);
      return false;
    }
    await this.control.query("UPDATE control.tenants SET lifecycle='running',sandbox_id=$2 WHERE user_id=$1", [this.user, this.runtime.sandbox.sandboxId]);
    this.applySettings(await this.control.tenant(this.user));
    await this.bot.recover();
    this.ready = true;
    await this.syncSettings();
    // Cached choices keep the Mini App fast without waking an idle environment.
    if(!this.modelRefresh) this.modelRefresh=(async()=>{
      try {
        const data=await this.runtime.rpc('model/list',{limit:100});
        await this.control.query('UPDATE control.tenants SET models=$2 WHERE user_id=$1',[this.user,JSON.stringify(modelCatalog(data.data))]);
      } catch { /* Model discovery must not block a user's task. */ }
    })();
    return true;
  }
  async retireIfIdle() {
    if (this.appsRefresh || await this.store.busy()) return false;
    const retire = await this.control.transaction(async db => {
      const t = (await db.query('SELECT * FROM control.tenants WHERE user_id=$1 FOR UPDATE', [this.user])).rows[0];
      const pending = (await db.query('SELECT 1 FROM control.inbox WHERE user_id=$1 AND delivered=false LIMIT 1', [this.user])).rowCount;
      if (pending || Date.now() - new Date(t.last_activity).getTime() < this.cfg.idleMs) return false;
      if (t.lifecycle === 'sleeping') return false;
      await db.query("UPDATE control.tenants SET lifecycle='stopping' WHERE user_id=$1", [this.user]);
      return true;
    });
    if (!retire) return false;
    await this.runtime.retire();
    await this.control.query("UPDATE control.tenants SET lifecycle='sleeping',sandbox_id=NULL,next_check=now() WHERE user_id=$1", [this.user]);
    this.ready = false;
    return true;
  }
  async prepareAccount(tenant) {
    if(this.cfg.provisionerKey && !this.accounts && !tenant.runtime_project_id) throw new Error('User workspace setup is paused; shared compute is disabled');
    if(this.accounts) {
      if(!this.cfg.managedAccounts && tenant.runtime_project_id) return;
      if(tenant.admission==='approved' && !this.computeAccount) {
        const account=await this.accounts.ensure(this.user,{credentials:!!this.cfg.managedAccounts});
        if(!tenant.runtime_project_id) {
          // Existing volumes must be copied and verified before switching projects.
          let legacyVolume;
          try {legacyVolume=await this.runtime.client.volumes.get(this.cfg.volume);} catch(e){if(!(e instanceof NotFoundError))throw e;}
          if(legacyVolume) throw new Error('Existing volume needs migration before managed compute can start');
          if(!legacyVolume) {
            await this.control.transaction(async db=>{
              await db.query('UPDATE control.tenants SET runtime_project_id=$2 WHERE user_id=$1',[this.user,account.serviceProjectId]);
              await db.query(`UPDATE ${this.store.schema}.bot_state SET value=jsonb_set(value,'{project}',to_jsonb($1::text)) WHERE key='identity'`,[account.serviceProjectId]);
            });
            this.cfg.project=account.serviceProjectId;
            this.cfg.apiKey=this.control.cfg.provisionerKey || this.control.cfg.apiKey;
            this.runtime=new this.RuntimeClass(this.cfg,this.store);this.bot.runtime=this.runtime;
          }
        }
        if(this.cfg.project!==account.serviceProjectId) throw new Error('Runtime project does not match the user workspace');
        this.computeAccount=account;
        if(this.cfg.managedAccounts) {
          this.managedAccount=account;
          this.cfg.managedLizard=account;
        }
        this.ready=false;
        return true;
      } else if(tenant.admission==='blocked') {
        await this.accounts.revoke(this.user);
        this.computeAccount=null;this.managedAccount=null;this.cfg.managedLizard=null;
      }
    }
  }
  async tick() {
    if(this.ready && this.runtime.bridgeUpgradePending && !await this.runtime.bridgeBusy()) this.ready=false;
    let tenant = await this.control.tenant(this.user);
    if(tenant.migrating) return false;
    this.applySettings(tenant);
    if (tenant.lifecycle === 'stopping') {
      // Finish an interrupted deletion before accepting any new work.
      await this.runtime.retire();
      await this.control.query("UPDATE control.tenants SET lifecycle='sleeping',sandbox_id=NULL WHERE user_id=$1", [this.user]);
      this.ready = false;
      tenant = await this.control.tenant(this.user);
    }
    if (tenant.admission === 'approved') {
      const incoming = (await this.control.query('SELECT * FROM control.inbox WHERE user_id=$1 AND delivered=false ORDER BY update_id LIMIT 10', [this.user])).rows;
      if (incoming.length) {
        await this.store.receive(incoming.map(r => r.payload));
        void this.pulse?.();
        await this.control.query('UPDATE control.inbox SET delivered=true WHERE user_id=$1 AND update_id=ANY($2::bigint[])', [this.user, incoming.map(r => r.update_id)]);
      }
    } else {
      if(this.accounts) await this.accounts.revoke(this.user);
      await this.control.query('UPDATE control.inbox SET delivered=true WHERE user_id=$1', [this.user]);
      await this.store.query("UPDATE inbox SET state='cancelled' WHERE state='pending'");
      await this.store.query("UPDATE prompts SET state='cancelled' WHERE state='pending'");
      await this.store.set('loginPendingUntil', 0);
    }
    // Reconnect live sandboxes after a controller restart, without waking sleepers.
    let setupError;
    if (!this.ready && (tenant.sandbox_id || await this.store.get('sandbox'))) {
      try {await this.ensure(tenant.admission !== 'approved');} catch(error) {setupError=error;}
    }
    const pending = (await this.store.query("SELECT * FROM inbox WHERE state='pending' ORDER BY update_id LIMIT 50")).rows;
    for (const row of pending) {
      const message = row.payload.message;
      const cmd = command(message?.text);
      if (cmd?.name === 'status' && !this.ready && !await this.store.get('sandbox')) {
        await this.store.enqueue(`sleep-status:${row.update_id}`, message.message_thread_id,
          'Your environment is asleep. Your files and history are saved. Use /login or send a task in a topic to start it.');
        await this.store.query("UPDATE inbox SET state='done' WHERE update_id=$1", [row.update_id]);
        continue;
      }
      const noRuntime = ['start', 'help', 'sessions', 'new', 'settings'].includes(cmd?.name)
        || /^route:\d{1,16}:(\d{1,16}|new)$/.test(row.payload.callback_query?.data || '')
        || (message?.text && !cmd && !message.message_thread_id)
        || (!row.payload.callback_query && !message?.text && !message?.voice && !attachment(message))
        || (attachment(message) && (!message.message_thread_id || attachmentLimitError(message)))
        || (message?.voice && (!message.message_thread_id || voiceLimitError(message.voice)));
      if (!noRuntime && !this.ready) {
        if(setupError) continue;
        try {
          const thinking=!cmd && !row.payload.callback_query;
          await this.store.progress(row.update_id, message?.message_thread_id || row.payload.callback_query?.message?.message_thread_id,
            thinking ? 'Thinking…' : 'Getting ready to help…', {
              ...(thinking ? {thinking:true} : {}),
              ...(message?.voice ? {reply_parameters:{message_id:message.message_id,allow_sending_without_reply:true}} : {}),
            });
          await this.control.exported(this.store, this.user);
          await this.prepareAccount(await this.control.tenant(this.user));
          if (!await this.control.reserve(this.user)) {
            await this.store.progress(row.update_id, message?.message_thread_id,
              'Your request is in line. I’ll be with you shortly.');
            await this.control.exported(this.store, this.user);
            return false;
          }
          if (!await this.ensure(false, true)) return false;
        } catch(error) {
          setupError=error;
          await this.store.progress(row.update_id,message?.message_thread_id,
            'I couldn’t get ready yet. Your request is saved and I’ll retry. You can still use /help, /new, /sessions and /settings.');
          continue;
        }
      }
      await this.store.query("UPDATE inbox SET state='working' WHERE update_id=$1", [row.update_id]);
      if ((await this.control.tenant(this.user)).admission !== 'approved') {
        await this.store.query("UPDATE inbox SET state='cancelled' WHERE update_id=$1", [row.update_id]);
        continue;
      }
      try {
        await this.bot.handle(row.payload);
        await this.store.query("UPDATE inbox SET state='done' WHERE update_id=$1", [row.update_id]);
      } catch {
        await this.store.query("UPDATE inbox SET state='failed',error='Operation outcome may be unknown' WHERE update_id=$1", [row.update_id]);
        await this.bot.say(`update:${row.update_id}`, message?.message_thread_id || row.payload.callback_query?.message?.message_thread_id,
          'Could not confirm that the command completed. Check /status before retrying.');
      }
    }
    await this.control.exported(this.store,this.user);
    if(setupError) throw setupError;
    tenant=await this.control.tenant(this.user);
    if(tenant.admission==='approved' && tenant.apps_request_seq>tenant.apps_done_seq && !this.ready && !this.managedAccount) {
      if(this.cfg.managedAccounts) await this.prepareAccount(tenant);
      if(!this.managedAccount && !await this.ensure()) return false;
    }
    tenant = await this.control.tenant(this.user);
    await this.bot.syncTitles();
    if (this.ready) {
      await this.syncSettings();
      if (Date.now() - this.runtime.renewedAt > 10 * 60000) await this.runtime.renew();
      const overdue = (await this.store.query(`SELECT s.thread_id,s.turn_id FROM sessions s WHERE s.turn_id IS NOT NULL AND
        (s.turn_started_at < now()-($1::bigint * interval '1 millisecond')
        OR EXISTS(SELECT 1 FROM approvals a WHERE a.topic=s.topic AND a.state='pending' AND a.created_at < now()-($2::bigint * interval '1 millisecond')))`,
      [this.cfg.maxTaskMs, this.cfg.approvalWaitMs])).rows;
      for (const s of overdue) {
        await this.runtime.rpc('turn/interrupt', { threadId: s.thread_id, turnId: s.turn_id }, `timeout:${s.turn_id}`);
      }
      if (tenant.admission !== 'approved') {
        for (const s of (await this.store.query('SELECT * FROM sessions WHERE turn_id IS NOT NULL')).rows) {
          await this.runtime.rpc('turn/interrupt', { threadId: s.thread_id, turnId: s.turn_id }, `blocked:${s.turn_id}`);
        }
        await this.store.query("UPDATE approvals SET state='expired' WHERE state='pending'");
      }
      const events = await this.bot.events();
      if (events) await this.control.query('UPDATE control.tenants SET last_activity=now() WHERE user_id=$1', [this.user]);
      if (tenant.admission === 'approved') {
        await this.bot.finishResets();
        await this.bot.startPrompts();
      }
    }
    this.refreshApps(tenant);
    await this.control.exported(this.store, this.user);
    await this.control.query(`UPDATE control.tenants SET has_work=$2 OR EXISTS(
      SELECT 1 FROM control.inbox WHERE user_id=$1 AND delivered=false) WHERE user_id=$1`, [this.user, await this.store.busy()]);
    if (await this.retireIfIdle()) return false;
    return this.ready || !!this.appsRefresh || await this.store.busy();
  }
  async run() {
    let typingTimer, typingBusy=false;
    try {
      await this.store.start();
      const pulse=async()=>{
        if(typingBusy || this.stopping || !this.telegram.typing) return;
        typingBusy=true;
        try {
          const {rows}=await this.store.query(`SELECT DISTINCT topic FROM (
            SELECT topic FROM sessions WHERE turn_id IS NOT NULL
            UNION SELECT (payload->'message'->>'message_thread_id')::bigint AS topic FROM inbox
              WHERE state IN ('pending','working') AND payload->'message'->>'message_thread_id' IS NOT NULL
          ) t WHERE topic IS NOT NULL AND NOT EXISTS(SELECT 1 FROM approvals a WHERE a.topic=t.topic AND a.state='pending') LIMIT 5`);
          await Promise.allSettled(rows.map(r=>this.telegram.typing(this.user,r.topic)));
        } catch {} finally { typingBusy=false; }
      };
      typingTimer=setInterval(pulse,4000);
      this.pulse=pulse;
      void pulse();
      const identity = { bot: Number(this.cfg.token.split(':')[0]), owner: this.user, chat: this.user, project: this.cfg.project, volume: this.cfg.volume };
      const old = await this.store.get('identity');
      if (old && Object.keys(identity).some(k => old[k] !== identity[k])) throw new Error('Tenant identity mismatch');
      await this.store.set('identity', identity);
      const interrupted = (await this.store.query("UPDATE inbox SET state='failed',error='Worker restarted during command' WHERE state='working' RETURNING update_id,payload")).rows;
      for (const row of interrupted) await this.bot.say(`update:${row.update_id}`, row.payload.message?.message_thread_id,
        'The bot restarted during your command. Check /status before retrying; the action may have completed.');
      let failures = 0;
      while (!this.stopping) {
        try {
          if (!await this.tick()) return;
          failures = 0;
        } catch (error) {
          this.ready = false;
          console.error(`Tenant ${this.user}: retry ${failures + 1}; stage=${this.runtime.stage || 'worker'}`);
          if (error.message?.includes('outcome unknown')) await this.control.say(this.control.pool,
            `allocation-review:${this.user}:${Math.floor(Date.now()/3600000)}`, this.control.cfg.owner,
            `User ${this.user}: environment creation has an unknown outcome. Check the volume and environment before retrying.`);
          if (++failures >= 3) {
            const pending=(await this.store.query("SELECT update_id,payload FROM inbox WHERE state='pending' ORDER BY update_id LIMIT 1")).rows[0];
            if(pending) await this.store.progress(pending.update_id,pending.payload.message?.message_thread_id,
              'I’m still getting ready. Your message is saved, and I’ll keep trying.');
            await this.control.exported(this.store, this.user);
            return;
          }
          await sleep(10000);
        }
        await sleep(this.bot.streamingActive ? 50 : 200);
      }
    } finally { clearInterval(typingTimer); this.pulse=null; await this.modelRefresh; await this.appsRefresh; await this.store.close(); }
  }
}

export class Workers {
  constructor(cfg, control, telegram) {
    Object.assign(this, { cfg, control, telegram }); this.active = new Map();
    this.accounts=(cfg.managedAccounts || cfg.provisionerKey) && cfg.role!=='gateway' ? new LizardAccounts(cfg,control) : null;
  }
  async tick() {
    const room = this.cfg.workerSlots - this.active.size;
    if (room <= 0) return;
    for (const tenant of await this.control.candidates(room)) {
      if (this.active.has(tenant.user_id)) continue;
      const worker = new TenantWorker(this.cfg, this.control, this.telegram, tenant,Runtime,this.accounts);
      this.active.set(tenant.user_id, worker);
      worker.done = worker.run().catch(() => {}).finally(() => this.active.delete(tenant.user_id));
    }
  }
  async stop() {
    for (const worker of this.active.values()) worker.stopping = true;
    await Promise.allSettled([...this.active.values()].map(w => w.done));
  }
}
