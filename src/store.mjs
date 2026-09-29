import pg from 'pg';

export class Store {
  constructor(url, schema = 'public') {
    if (!/^(public|(?:tenant|group)_[1-9][0-9]*)$/.test(schema)) throw new Error('Invalid tenant schema');
    this.schema = schema;
    this.pool = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 10000,
      options: `-c search_path=${schema},pg_catalog` });
  }
  query(sql, values) { return this.pool.query(sql, values); }
  async start() {
    this.lock = await this.pool.connect();
    const { rows } = this.schema === 'public'
      ? await this.lock.query('SELECT pg_try_advisory_lock(220926,7021) AS locked')
      : this.schema.startsWith('group_')
        ? await this.lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[this.schema])
        : await this.lock.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [String(-BigInt(this.schema.slice(7)))]);
    if (!rows[0].locked) throw new Error('Another bot instance holds the database lock');
    this.lock.on('error', () => process.exit(1));
    if (this.schema !== 'public') await this.lock.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await this.query(`
      CREATE TABLE IF NOT EXISTS bot_state (key text PRIMARY KEY, value jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        topic bigint PRIMARY KEY, title text NOT NULL, thread_id text UNIQUE,
        cwd text NOT NULL, model text, archived boolean NOT NULL DEFAULT false,
        turn_id text, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS inbox (
        update_id bigint PRIMARY KEY, payload jsonb NOT NULL,
        state text NOT NULL DEFAULT 'pending', error text, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS prompts (
        update_id bigint PRIMARY KEY REFERENCES inbox(update_id), topic bigint NOT NULL REFERENCES sessions(topic),
        text text NOT NULL, state text NOT NULL DEFAULT 'pending', turn_id text
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id text PRIMARY KEY, generation text NOT NULL, request_id jsonb NOT NULL,
        topic bigint NOT NULL REFERENCES sessions(topic), method text NOT NULL, params jsonb NOT NULL,
        state text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id bigserial PRIMARY KEY, dedup_key text UNIQUE NOT NULL, topic bigint,
        text text NOT NULL, extra jsonb NOT NULL DEFAULT '{}', sent boolean NOT NULL DEFAULT false,
        failed boolean NOT NULL DEFAULT false
      );
      ALTER TABLE outbox ADD COLUMN IF NOT EXISTS forwarded boolean NOT NULL DEFAULT false;
      ALTER TABLE outbox ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
      CREATE TABLE IF NOT EXISTS outgoing_files (
        outbox_id bigint PRIMARY KEY REFERENCES outbox(id), name text NOT NULL, bytes bytea
      );
      ALTER TABLE prompts ADD COLUMN IF NOT EXISTS progress_item text;
      ALTER TABLE prompts ADD COLUMN IF NOT EXISTS input jsonb;
      ALTER TABLE prompts ADD COLUMN IF NOT EXISTS started_at timestamptz;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turn_started_at timestamptz;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reset_pending boolean NOT NULL DEFAULT false;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reset_update_id bigint NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS context_after bigint NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS session_resets (
        update_id bigint PRIMARY KEY, topic bigint NOT NULL, thread_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS first_message_title text;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title_synced boolean NOT NULL DEFAULT false;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS first_message_id bigint;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title_captured boolean;
      -- Existing topics keep their names; only topics created after this migration
      -- can elect a new first message.
      UPDATE sessions SET title_captured=true,title_synced=true WHERE title_captured IS NULL;
      ALTER TABLE sessions ALTER COLUMN title_captured SET DEFAULT false;
      ALTER TABLE sessions ALTER COLUMN title_captured SET NOT NULL;
      UPDATE sessions SET turn_started_at=now() WHERE turn_id IS NOT NULL AND turn_started_at IS NULL;
      ALTER TABLE approvals ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE approvals ADD COLUMN IF NOT EXISTS answers jsonb NOT NULL DEFAULT '{}';
      CREATE TABLE IF NOT EXISTS message_streams (
        draft_id serial PRIMARY KEY, generation text NOT NULL, item_id text NOT NULL,
        topic bigint NOT NULL REFERENCES sessions(topic), turn_id text NOT NULL,
        closed boolean NOT NULL DEFAULT false,
        UNIQUE(generation,item_id)
      );
      CREATE INDEX IF NOT EXISTS inbox_pending_idx ON inbox(update_id) WHERE state='pending';
      ALTER TABLE message_streams ADD COLUMN IF NOT EXISTS wire_draft_ids integer[] NOT NULL DEFAULT '{}';
      CREATE INDEX IF NOT EXISTS prompts_queue_idx ON prompts(topic,update_id) WHERE state IN ('pending','starting','running');
    `);
  }
  async busy() {
    return (await this.query(`SELECT
      EXISTS(SELECT 1 FROM sessions WHERE reset_pending) OR
      EXISTS(SELECT 1 FROM inbox WHERE state IN ('pending','working')) OR
      EXISTS(SELECT 1 FROM prompts WHERE state IN ('pending','starting','running')) OR
      EXISTS(SELECT 1 FROM sessions WHERE turn_id IS NOT NULL) OR
      EXISTS(SELECT 1 FROM approvals WHERE state='pending') AS busy`)).rows[0].busy
      || Number(await this.get('loginPendingUntil', 0)) > Date.now();
  }
  async get(key, fallback = null) { return (await this.query('SELECT value FROM bot_state WHERE key=$1', [key])).rows[0]?.value ?? fallback; }
  async requestGroupReset(topic, updateId, messageId, chat) {
    const db=await this.pool.connect();
    try {
      await db.query('BEGIN');
      const session=(await db.query('SELECT * FROM sessions WHERE topic=$1 FOR UPDATE',[topic])).rows[0];
      if(!session || session.reset_pending || Number(session.reset_update_id)>=updateId) {await db.query('COMMIT');return false;}
      await db.query('INSERT INTO session_resets(update_id,topic,thread_id) VALUES($1,$2,$3)',[updateId,topic,session.thread_id]);
      await db.query('UPDATE sessions SET reset_pending=true,reset_update_id=$2,context_after=$3 WHERE topic=$1',[topic,updateId,messageId]);
      await db.query("UPDATE prompts SET state='cancelled' WHERE topic=$1 AND state IN ('pending','starting')",[topic]);
      await db.query("UPDATE approvals SET state='expired' WHERE topic=$1 AND state='pending'",[topic]);
      await db.query('UPDATE message_streams SET closed=true WHERE topic=$1',[topic]);
      // Cancel queued output in both stages; retain already delivered messages.
      await db.query('UPDATE outbox SET failed=true WHERE topic=$1 AND sent=false',[topic]);
      await db.query(`UPDATE control.outbox SET failed=true WHERE chat_id=$1 AND coalesce(topic,1)=$2
        AND dedup_key LIKE $3 AND sent=false`,[chat,topic,`tenant:${chat}:%`]);
      await db.query('COMMIT');return true;
    } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
  }
  async finishGroupReset(topic) {
    const db=await this.pool.connect();
    try {
      await db.query('BEGIN');
      const session=(await db.query(`UPDATE sessions SET reset_pending=false,thread_id=NULL,turn_id=NULL,
        turn_started_at=NULL WHERE topic=$1 AND reset_pending AND turn_id IS NULL RETURNING reset_update_id`,[topic])).rows[0];
      if(session) await db.query(`INSERT INTO outbox(dedup_key,topic,text,extra) VALUES($1,$2,$3,'{"progress":true}')
        ON CONFLICT(dedup_key) DO UPDATE SET text=excluded.text,extra=excluded.extra,
          revision=outbox.revision+1,forwarded=false`,
        [`reset:${session.reset_update_id}:done`,topic,'Conversation reset. Send a new task here. Earlier messages will not be used as context. Your files, apps and sign-ins are kept.']);
      await db.query('COMMIT');
    } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
  }
  async set(key, value) { await this.query('INSERT INTO bot_state VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, JSON.stringify(value)]); }
  async enqueue(key, topic, text, extra = {}) {
    await this.query('INSERT INTO outbox(dedup_key,topic,text,extra) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [key, topic || null, text, JSON.stringify(extra)]);
  }
  async document(key,topic,name,bytes) {
    await this.query(`WITH queued AS (
      INSERT INTO outbox(dedup_key,topic,text,extra) VALUES($1,$2,$3,'{"document":true}')
      ON CONFLICT DO NOTHING RETURNING id
    ) INSERT INTO outgoing_files(outbox_id,name,bytes) SELECT id,$3,$4 FROM queued`,[key,topic,name,bytes]);
  }
  async progress(updateId, topic, text, extra={}) {
    return this.preview(`progress:${updateId}`,topic,text,extra);
  }
  async voiceTranscript(updateId, topic, text, extra={}) {
    const key = `voice-transcript:${updateId}`;
    // Keep the cold-start message's delivery ID, then give the model a new
    // progress row. A replay must never replace the transcript with model text.
    await this.query(`UPDATE outbox SET dedup_key=$2 WHERE dedup_key=$1
      AND NOT EXISTS(SELECT 1 FROM outbox WHERE dedup_key=$2)`, [`progress:${updateId}`, key]);
    return this.preview(key, topic, text, extra);
  }
  async pauseThinking(topic, text='Waiting for your reply…') {
    await this.query(`UPDATE outbox SET text=$2,extra=extra-'thinking',revision=revision+1,forwarded=false
      WHERE topic=$1 AND extra->>'thinking'='true'`,[topic,text]);
  }
  async preview(key, topic, text, extra={}) {
    await this.query(`INSERT INTO outbox(dedup_key,topic,text,extra) VALUES($1,$2,$3,$4)
      ON CONFLICT(dedup_key) DO UPDATE SET text=excluded.text,extra=excluded.extra,
        revision=outbox.revision+1,forwarded=false
      WHERE outbox.text IS DISTINCT FROM excluded.text OR outbox.extra IS DISTINCT FROM excluded.extra`,
      [key,topic || null,text,JSON.stringify({...extra,progress:true})]);
  }
  async progressForTurn(turnId,topic,itemId) {
    const row=(await this.query(`UPDATE prompts p SET progress_item=coalesce(p.progress_item,$3)
      WHERE p.turn_id=$1 AND p.topic=$2 AND EXISTS(SELECT 1 FROM outbox o WHERE o.dedup_key='progress:'||p.update_id::text)
      RETURNING update_id,progress_item`,[turnId,topic,itemId])).rows[0];
    return row?.progress_item===itemId ? row.update_id : null;
  }
  async receive(updates) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const update of updates) await client.query('INSERT INTO inbox(update_id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING', [update.update_id, JSON.stringify(update)]);
      if (updates.length) await client.query("INSERT INTO bot_state VALUES('offset',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(updates.at(-1).update_id + 1)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async close() { this.lock?.release(); await this.pool.end(); }
}
