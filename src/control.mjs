import pg from 'pg';
import { privateUser, command, sleep } from './core.mjs';

export class Control {
  constructor(cfg) {
    this.cfg = cfg;
    this.pool = new pg.Pool({ connectionString: cfg.database, max: 8, connectionTimeoutMillis: 10000 });
  }
  query(sql, values) { return this.pool.query(sql, values); }
  async transaction(fn) {
    const db = await this.pool.connect();
    try { await db.query('BEGIN'); const result = await fn(db); await db.query('COMMIT'); return result; }
    catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  async start() {
    await this.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(220927,1)');
      await db.query(`CREATE SCHEMA IF NOT EXISTS control;
        CREATE TABLE IF NOT EXISTS control.state(key text PRIMARY KEY,value jsonb);
        CREATE TABLE IF NOT EXISTS control.tenants(
          user_id bigint PRIMARY KEY, admission text NOT NULL DEFAULT 'pending',
          schema_name text NOT NULL UNIQUE, volume_name text NOT NULL UNIQUE,
          lifecycle text NOT NULL DEFAULT 'sleeping', sandbox_id text, has_work boolean NOT NULL DEFAULT false,
          last_activity timestamptz NOT NULL DEFAULT now(), next_check timestamptz NOT NULL DEFAULT now(),
          rate_window timestamptz NOT NULL DEFAULT now(), rate_count integer NOT NULL DEFAULT 0,
          created_at timestamptz NOT NULL DEFAULT now());
        ALTER TABLE control.tenants ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}';
        ALTER TABLE control.tenants ADD COLUMN IF NOT EXISTS settings_version integer NOT NULL DEFAULT 0;
        ALTER TABLE control.tenants ADD COLUMN IF NOT EXISTS apps jsonb NOT NULL DEFAULT '{}';
        ALTER TABLE control.tenants ADD COLUMN IF NOT EXISTS apps_request_seq integer NOT NULL DEFAULT 0;
        ALTER TABLE control.tenants ADD COLUMN IF NOT EXISTS apps_done_seq integer NOT NULL DEFAULT 0;
        ALTER TABLE control.tenants ADD COLUMN IF NOT EXISTS models jsonb NOT NULL DEFAULT '[]';
        ALTER TABLE control.tenants ADD COLUMN IF NOT EXISTS runtime_project_id text;
        ALTER TABLE control.tenants ADD COLUMN IF NOT EXISTS migrating boolean NOT NULL DEFAULT false;
        ALTER TABLE control.tenants ADD COLUMN IF NOT EXISTS group_owner bigint REFERENCES control.tenants(user_id);
        ALTER TABLE control.tenants ADD COLUMN IF NOT EXISTS group_title text;
        CREATE TABLE IF NOT EXISTS control.group_messages (
          chat_id bigint NOT NULL REFERENCES control.tenants(user_id),message_id bigint NOT NULL,
          topic bigint NOT NULL,sender jsonb NOT NULL,text text NOT NULL,reply_to bigint,date timestamptz NOT NULL,
          search tsvector GENERATED ALWAYS AS (to_tsvector('simple',text)) STORED,
          PRIMARY KEY(chat_id,message_id)
        );
        CREATE INDEX IF NOT EXISTS group_messages_search ON control.group_messages USING gin(search);
        CREATE TABLE IF NOT EXISTS control.lizard_accounts (
          user_id bigint PRIMARY KEY REFERENCES control.tenants(user_id),
          workspace_name text UNIQUE NOT NULL,workspace_id text UNIQUE,workspace_attempt boolean NOT NULL DEFAULT false,
          service_project_id text UNIQUE,project_attempt boolean NOT NULL DEFAULT false,
          key_name text,key_id text,key_cipher text,state text NOT NULL DEFAULT 'pending',updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS control.inbox(update_id bigint PRIMARY KEY,user_id bigint NOT NULL,
          payload jsonb NOT NULL, delivered boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS control.outbox(id bigserial PRIMARY KEY,dedup_key text UNIQUE NOT NULL,
          chat_id bigint NOT NULL,topic bigint,text text NOT NULL,extra jsonb NOT NULL DEFAULT '{}',
          sent boolean NOT NULL DEFAULT false,failed boolean NOT NULL DEFAULT false,
          next_attempt timestamptz NOT NULL DEFAULT now());
        ALTER TABLE control.outbox ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
        ALTER TABLE control.outbox ADD COLUMN IF NOT EXISTS message_ids jsonb NOT NULL DEFAULT '[]';
        ALTER TABLE control.outbox ADD COLUMN IF NOT EXISTS thinking_refreshed_at timestamptz;
        CREATE TABLE IF NOT EXISTS control.outgoing_files (
          outbox_id bigint PRIMARY KEY REFERENCES control.outbox(id),name text NOT NULL,bytes bytea,file_id text
        );
        CREATE INDEX IF NOT EXISTS control_inbox_pending ON control.inbox(user_id,update_id) WHERE delivered=false;
        CREATE INDEX IF NOT EXISTS control_outbox_pending ON control.outbox(chat_id,id) WHERE sent=false AND failed=false;`);
      const identity = { bot: this.cfg.token.split(':')[0], owner: this.cfg.owner, project: this.cfg.project };
      const old = (await db.query("SELECT value FROM control.state WHERE key='identity'")).rows[0]?.value;
      if (old && Object.keys(identity).some(k => identity[k] !== old[k])) throw new Error('Database belongs to another bot');
      await db.query("INSERT INTO control.state VALUES('identity',$1) ON CONFLICT DO NOTHING", [JSON.stringify(identity)]);
      const legacy = (await db.query("SELECT to_regclass('public.bot_state') AS table_name")).rows[0].table_name;
      let sandbox = null, offset = 0;
      if (legacy) {
        const rows = (await db.query("SELECT key,value FROM public.bot_state WHERE key IN ('sandbox','offset')")).rows;
        sandbox = rows.find(r => r.key === 'sandbox')?.value || null;
        offset = rows.find(r => r.key === 'offset')?.value || 0;
      }
      await db.query("INSERT INTO control.state VALUES('offset',$1) ON CONFLICT DO NOTHING", [JSON.stringify(offset)]);
      await db.query(`INSERT INTO control.tenants(user_id,admission,schema_name,volume_name,lifecycle,sandbox_id)
        VALUES($1,'approved','public',$2,$3,$4) ON CONFLICT DO NOTHING`,
      [this.cfg.owner, this.cfg.volume, sandbox ? 'running' : 'sleeping', sandbox]);
    });
  }
  async gatewayLock({waitMs=0}={}) {
    this.gateway = await this.pool.connect();
    const until=Date.now()+waitMs;
    while(true) {
      const { rows } = await this.gateway.query('SELECT pg_try_advisory_lock(220927,2) AS locked');
      if(rows[0].locked) break;
      if(Date.now()>=until) throw new Error('Another Telegram gateway is running');
      // Keep the HTTP listener available while a rolling deploy drains the old gateway.
      await sleep(Math.min(1000,until-Date.now()));
    }
    this.gateway.on('error', () => process.exit(1));
  }
  async offset() { return (await this.query("SELECT value FROM control.state WHERE key='offset'")).rows[0].value; }
  async say(db, key, chat, text) {
    await db.query('INSERT INTO control.outbox(dedup_key,chat_id,text) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [key, chat, text]);
  }
  async receive(updates) {
    await this.transaction(async db => {
      const offset = Number((await db.query("SELECT value FROM control.state WHERE key='offset' FOR UPDATE")).rows[0].value);
      for (const update of updates) {
        if (update.update_id < offset) continue;
        if (await this.groups?.receive(db,update)) continue;
        const user = privateUser(update);
        if (!user) continue;
        const cmd = command(update.message?.text);
        const key = `gateway:${update.update_id}`;
        if(await this.groups?.privateSettings(db,update,user,cmd)) continue;
        if (user === this.cfg.owner && ['allow', 'block', 'users'].includes(cmd?.name)) {
          if (cmd.name === 'users') {
            const rows = (await db.query('SELECT user_id,admission,lifecycle FROM control.tenants ORDER BY created_at DESC LIMIT 50')).rows;
            const admission = { pending:'pending approval', approved:'approved', blocked:'blocked' };
            const lifecycle = { sleeping:'environment asleep', starting:'environment starting', running:'environment running', stopping:'environment stopping' };
            await this.say(db, key, user, rows.map(r => `${r.user_id}: ${admission[r.admission]}, ${lifecycle[r.lifecycle] || r.lifecycle}`).join('\n'));
            continue;
          }
          const id = Number(cmd.argument);
          if (!Number.isSafeInteger(id) || id <= 0 || id === this.cfg.owner) {
            await this.say(db, key, user, 'Enter another user’s ID: /allow ID or /block ID'); continue;
          }
          if (cmd.name === 'allow') {
            await db.query('SELECT pg_advisory_xact_lock(220927,3)');
            const approved = Number((await db.query("SELECT count(*) FROM control.tenants WHERE admission='approved'")).rows[0].count);
            if (approved >= this.cfg.maxUsers) { await this.say(db, key, user, 'The user limit has been reached.'); continue; }
          }
          const result = await db.query('UPDATE control.tenants SET admission=$2,next_check=now() WHERE user_id=$1 RETURNING user_id',
            [id, cmd.name === 'allow' ? 'approved' : 'blocked']);
          if(cmd.name==='block') await db.query("UPDATE control.tenants SET admission='blocked',next_check=now() WHERE group_owner=$1",[id]);
          await this.say(db, key, user, result.rowCount ? 'Access updated.' : 'The user must send /start to the bot first.');
          if (result.rowCount) await this.say(db, `${key}:user`, id, cmd.name === 'allow' ? 'Access approved. Use /login to sign in to your ChatGPT, then /new Name to create a session.' : 'Your access to this bot is blocked.');
          continue;
        }
        let tenant = (await db.query('SELECT * FROM control.tenants WHERE user_id=$1 FOR UPDATE', [user])).rows[0];
        if (!tenant && cmd?.name === 'start') {
          if (Number((await db.query('SELECT count(*) FROM control.tenants')).rows[0].count) >= this.cfg.maxUsers + 1000) continue;
          tenant = (await db.query(`INSERT INTO control.tenants(user_id,schema_name,volume_name) VALUES($1,$2,$3)
            ON CONFLICT(user_id) DO UPDATE SET user_id=excluded.user_id RETURNING *`, [user, `tenant_${user}`, `tg-user-${user}`])).rows[0];
          await this.say(db, `${key}:request`, this.cfg.owner, `Access request from user ${user}.\n/allow ${user} — approve\n/block ${user} — decline`);
        }
        if (tenant?.admission !== 'approved') {
          // Avoid allocating databases, disks or Sandboxes for strangers.
          if (cmd?.name === 'start') await this.say(db, `admission:${user}:${new Date().toISOString().slice(0,10)}`, user,
            tenant?.admission === 'blocked' ? 'Access blocked.' : 'Your access request has been sent to the owner. Please wait for approval.');
          continue;
        }
        if(cmd?.name==='settings' && this.cfg.miniAppUrl) {
          await db.query(`INSERT INTO control.outbox(dedup_key,chat_id,topic,text,extra) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [key,user,update.message.message_thread_id || null,'Your instructions and preferences, across all sessions.',JSON.stringify({reply_markup:{inline_keyboard:[[{text:'Open Settings',web_app:{url:this.cfg.miniAppUrl}}]]}})]);
          continue;
        }
        const text = update.message?.text || update.message?.caption || '';
        const count = Date.now() - new Date(tenant.rate_window).getTime() >= 60000 ? 0 : tenant.rate_count;
        let backlog = Number((await db.query('SELECT count(*) FROM control.inbox WHERE user_id=$1 AND delivered=false', [user])).rows[0].count);
        if (!/^(public|tenant_[1-9][0-9]*)$/.test(tenant.schema_name)) throw new Error('Invalid tenant schema');
        const existing = (await db.query('SELECT to_regclass($1) AS name', [`${tenant.schema_name}.prompts`])).rows[0].name;
        if (existing) backlog += Number((await db.query(`SELECT
          (SELECT count(*) FROM ${tenant.schema_name}.inbox WHERE state IN ('pending','working')) +
          (SELECT count(*) FROM ${tenant.schema_name}.prompts WHERE state IN ('pending','starting')) AS count`)).rows[0].count);
        const controlAction=update.stopped_message_generation || update.callback_query || cmd?.name==='stop';
        if (text.length > 16000 || !controlAction && (count >= this.cfg.ratePerMinute || backlog >= this.cfg.maxQueued)) {
          await this.say(db, `rate:${user}:${Math.floor(Date.now()/60000)}`, user, 'Too many messages, or the message is too long. Please wait a minute.'); continue;
        }
        await db.query(`UPDATE control.tenants SET last_activity=now(),next_check=now(),has_work=true,rate_count=$2,
          rate_window=CASE WHEN $2=1 THEN now() ELSE rate_window END WHERE user_id=$1`, [user, count + 1]);
        await db.query('INSERT INTO control.inbox(update_id,user_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [update.update_id, user, JSON.stringify(update)]);
      }
      if (updates.length) await db.query("UPDATE control.state SET value=$1 WHERE key='offset'", [JSON.stringify(Math.max(offset, updates.at(-1).update_id + 1))]);
    });
  }
  async candidates(limit) {
    return this.transaction(async db => {
      const { rows } = await db.query(`SELECT * FROM control.tenants t WHERE next_check<=now() AND migrating=false AND
        (lifecycle<>'sleeping' OR (admission='approved' AND (has_work OR apps_request_seq>apps_done_seq OR EXISTS(SELECT 1 FROM control.inbox i WHERE i.user_id=t.user_id AND delivered=false)))
          OR ($2 AND admission='approved' AND NOT EXISTS(SELECT 1 FROM control.lizard_accounts a WHERE a.user_id=t.user_id AND a.state='ready'))
          OR ($2 AND admission='blocked' AND EXISTS(SELECT 1 FROM control.lizard_accounts a WHERE a.user_id=t.user_id AND a.state<>'revoked')))
        ORDER BY next_check,user_id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit,!!this.cfg.managedAccounts]);
      for (const row of rows) await db.query("UPDATE control.tenants SET next_check=now()+interval '30 seconds' WHERE user_id=$1", [row.user_id]);
      return rows;
    });
  }
  async tenant(id) { return (await this.query('SELECT * FROM control.tenants WHERE user_id=$1', [id])).rows[0]; }
  async reserve(id) {
    return this.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(220927,4)');
      const tenant = (await db.query('SELECT * FROM control.tenants WHERE user_id=$1 FOR UPDATE', [id])).rows[0];
      if (tenant.admission !== 'approved') throw new Error('Access closed');
      if (tenant.lifecycle !== 'sleeping') return true;
      const count = Number((await db.query("SELECT count(*) FROM control.tenants WHERE lifecycle<>'sleeping'")).rows[0].count);
      if (count >= this.cfg.maxSandboxes) return false;
      await db.query("UPDATE control.tenants SET lifecycle='starting' WHERE user_id=$1", [id]);
      return true;
    });
  }
  async exported(store, user) {
    // The only variable SQL identifier comes from Store's strict schema validation.
    await this.transaction(async db => {
      const groupOwner=user<0 ? (await db.query('SELECT group_owner FROM control.tenants WHERE user_id=$1',[user])).rows[0]?.group_owner : null;
      const rows=(await db.query(`SELECT * FROM ${store.schema}.outbox WHERE sent=false AND failed=false AND forwarded=false ORDER BY id FOR UPDATE`)).rows;
      for(const row of rows) {
        const privateReply=groupOwner && Number(row.extra.privateChat)===Number(groupOwner);
        const {privateChat,...extra}=row.extra;
        const chat=privateReply ? Number(groupOwner) : user;
        const topic=privateReply || user<0 && Number(row.topic)===1 ? null : row.topic;
        await db.query(`INSERT INTO control.outbox(dedup_key,chat_id,topic,text,extra,revision)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(dedup_key) DO UPDATE SET
          text=excluded.text,extra=excluded.extra,revision=excluded.revision,sent=false,failed=false
          WHERE control.outbox.revision<excluded.revision`,[`tenant:${user}:${row.id}`,chat,topic,row.text,extra,row.revision]);
        if(row.extra.document) {
          await db.query(`INSERT INTO control.outgoing_files(outbox_id,name,bytes)
            SELECT o.id,f.name,f.bytes FROM ${store.schema}.outgoing_files f
            JOIN control.outbox o ON o.dedup_key=$1 WHERE f.outbox_id=$2
            ON CONFLICT DO NOTHING`,[`tenant:${user}:${row.id}`,row.id]);
          await db.query(`UPDATE ${store.schema}.outgoing_files SET bytes=NULL WHERE outbox_id=$1`,[row.id]);
        }
        await db.query(`UPDATE ${store.schema}.outbox SET forwarded=true WHERE id=$1`,[row.id]);
      }
    });
  }
  async deliver(telegram,row) {
    if((await this.query('SELECT failed FROM control.outbox WHERE id=$1',[row.id])).rows[0]?.failed) return;
    const {groupNotice,thinking,...extra}=row.extra;
    let recordGroup=false;
    if(Number(row.chat_id)<0) {
      const allowed=(await this.query(`SELECT 1 FROM control.tenants g JOIN control.tenants u ON u.user_id=g.group_owner
        WHERE g.user_id=$1 AND g.admission='approved' AND u.admission='approved'`,[row.chat_id])).rowCount;
      if(!allowed && !groupNotice) {await this.query('UPDATE control.outbox SET failed=true WHERE id=$1',[row.id]);return;}
      recordGroup=Boolean(allowed);
    }
    let sent;
    if(thinking && !row.message_ids.length && await telegram.thinking?.(Number(row.chat_id),row.topic,row.id)) {
      // An ephemeral placeholder leaves no permanent message to edit. The first
      // real reply clears it; subsequent words edit that one durable reply.
    } else if(row.extra.document) {
      const file=(await this.query('SELECT * FROM control.outgoing_files WHERE outbox_id=$1',[row.id])).rows[0];
      if(!file?.file_id) {
        if(!file?.bytes) throw new Error('Missing queued document');
        const result=await telegram.document(row.chat_id,row.topic,file.name,file.bytes);
        await this.query('UPDATE control.outgoing_files SET file_id=$2,bytes=NULL WHERE outbox_id=$1',[row.id,result.document.file_id]);
      }
    } else if(row.extra.progress) {
      const ids=await telegram.update(row.chat_id,row.topic,row.text,extra,row.message_ids,async ids=>{
        await this.query('UPDATE control.outbox SET message_ids=$2 WHERE id=$1',[row.id,JSON.stringify(ids)]);
      });
      sent={message_id:ids?.at(-1)};
    } else {
      sent=await telegram.send(row.chat_id,row.topic,row.text,extra);
      if(sent?.message_id) await this.query('UPDATE control.outbox SET message_ids=$2 WHERE id=$1',[row.id,JSON.stringify([sent.message_id])]);
    }
    // An edit may arrive while Telegram is handling the previous revision.
    await this.query(`UPDATE control.outbox SET sent=(revision=$2),
      thinking_refreshed_at=CASE WHEN $3 THEN now() ELSE thinking_refreshed_at END WHERE id=$1`,[row.id,row.revision,!!thinking]);
    if(recordGroup && !thinking && sent?.message_id) try {await this.groups?.record(this.pool,Number(row.chat_id),{
      message_id:sent.message_id,text:row.text,date:Math.floor(Date.now()/1000),from:this.groups.me,
      is_topic_message:!!row.topic,message_thread_id:Number(row.topic),
    });} catch { /* A memory write must not resend an already delivered reply. */ }
  }
  async close() { this.gateway?.release(); await this.pool.end(); }
}
