// Runs only inside the personal Lizard sandbox. No public listener.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = process.env.BRIDGE_ROOT || '/workspace/.telegram-codex';
const port = Number(process.env.BRIDGE_PORT || 43127);
mkdirSync(root, { recursive: true, mode: 0o700 });
mkdirSync(`${root}/codex`, { recursive: true, mode: 0o700 });
const keyPath = `${root}/bridge.key`;
if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 });
const key = readFileSync(keyPath, 'utf8');
const db = new DatabaseSync(`${root}/bridge.sqlite`);
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, generation TEXT, data TEXT);
  CREATE TABLE IF NOT EXISTS calls(key TEXT PRIMARY KEY, generation TEXT, state TEXT, response TEXT);
`);
const generation = randomUUID();
const waiting = new Map();
const inflight = new Map();
const requests = new Map();
// Live text is coalesced in memory. Only complete messages enter the durable journal.
const streams = new Map();
let nextId = 1;
let ready = false;
let dead = false;
const child = spawn(process.env.CODEX_BIN || 'codex', ['--enable','default_mode_request_user_input','app-server', '--listen', 'stdio://'], {
  env: { ...process.env, CODEX_HOME: `${root}/codex`, AGENT_BROWSER_ARGS: '--no-sandbox,--disable-dev-shm-usage',
    AGENT_BROWSER_IDLE_TIMEOUT_MS: '600000', AGENT_BROWSER_CONTENT_BOUNDARIES: 'true' }, stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', () => {}); // Authentication errors can contain tokens.
const send = data => child.stdin.write(`${JSON.stringify(data)}\n`);
const record = data => db.prepare('INSERT INTO events(generation,data) VALUES (?,?)').run(generation, JSON.stringify(data));
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('Codex response timeout; outcome unknown')); }, 55000);
    waiting.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}
function fail() {
  dead = true; ready = false;
  for (const item of waiting.values()) { clearTimeout(item.timer); item.reject(new Error('Codex stopped')); }
  waiting.clear();
}
child.on('error', fail);
child.on('exit', fail);
child.stdin.on('error', fail);
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && !message.method) {
    const pending = waiting.get(message.id);
    if (pending) {
      clearTimeout(pending.timer); waiting.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    }
    return;
  }
  if (message.id !== undefined) requests.set(JSON.stringify(message.id), message.params?.turnId);
  if (message.method === 'serverRequest/resolved') requests.delete(JSON.stringify(message.params?.requestId));
  if (message.method === 'turn/completed') for (const [request, turn] of requests) {
    if (turn === message.params?.turn?.id) requests.delete(request);
  }
  if (message.method === 'item/agentMessage/delta') {
    const p = message.params;
    if (p?.itemId && p.threadId && p.turnId && typeof p.delta === 'string') {
      const id = `${p.threadId}:${p.itemId}`;
      const old = streams.get(id);
      streams.set(id,{generation,threadId:p.threadId,turnId:p.turnId,itemId:p.itemId,text:((old?.text || '')+p.delta).slice(0,120000)});
      if(streams.size>32) streams.delete(streams.keys().next().value);
    }
    return;
  }
  if (message.method === 'item/completed') streams.delete(`${message.params?.threadId}:${message.params?.item?.id}`);
  if (message.method === 'turn/completed') for (const [id,s] of streams) if (s.turnId === message.params?.turn?.id) streams.delete(id);
  // Never stream reasoning or command output into the chat.
  if (message.method?.endsWith('/delta') || message.method?.endsWith('Delta')) return;
  record(message);
});

const allowed = new Set(['account/read', 'account/login/start', 'account/rateLimits/read', 'model/list',
  'thread/start', 'thread/resume', 'thread/read', 'thread/archive', 'thread/unarchive', 'thread/name/set',
  'turn/start', 'turn/interrupt']);

async function dispatch(body) {
  if (body.action === 'health') return { ready, dead, generation, version:2 };
  if (body.action === 'stopDeadBridge' && dead) {
    setTimeout(() => process.exit(0), 100).unref();
    return { stopped: true };
  }
  if (!ready) throw new Error('Codex is not ready');
  if (body.action === 'events') {
    const events = db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT 100').all(body.after || 0).map(row => ({ ...row, data: JSON.parse(row.data) }));
    return { generation, events, streams: events.length < 100 ? [...streams.values()] : [] };
  }
  if (!body.key || typeof body.key !== 'string') throw new Error('Request key required');
  const old = db.prepare('SELECT * FROM calls WHERE key=?').get(body.key);
  if (old?.state === 'done') return JSON.parse(old.response);
  if (inflight.has(body.key)) return inflight.get(body.key);
  // A crash between submitting a command and recording its result must not replay it.
  if (old) throw new Error('Previous operation outcome unknown. Check /status before trying again.');
  db.prepare('INSERT INTO calls(key,generation,state) VALUES (?,?,?)').run(body.key, generation, 'running');
  const promise = (async () => {
    let result;
    if (body.action === 'reply') {
      if (body.generation !== generation || !requests.has(JSON.stringify(body.id))) throw new Error('Approval expired');
      send({ id: body.id, ...(body.error ? { error: body.error } : { result: body.result }) });
      requests.delete(JSON.stringify(body.id)); result = {};
    } else if (body.action === 'rpc' && allowed.has(body.method)) {
      if (body.method === 'thread/start') {
        if (!/^\/workspace\/sessions\/\d+$/.test(body.params?.cwd)) throw new Error('Invalid session directory');
        mkdirSync(body.params.cwd, { recursive: true });
      }
      result = await rpc(body.method, body.params);
    } else throw new Error('Unknown action');
    db.prepare("UPDATE calls SET state='done',response=? WHERE key=?").run(JSON.stringify(result), body.key);
    return result;
  })();
  inflight.set(body.key, promise);
  try { return await promise; } finally { inflight.delete(body.key); }
}

const server = createServer(async (req, res) => {
  const received = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${key}`);
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST' || req.url !== '/' || received.length !== expected.length || !timingSafeEqual(received, expected)) { res.writeHead(403); res.end('{}'); return; }
  try {
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 1024 * 1024) throw new Error('Request too large'); }
    res.end(JSON.stringify({ result: await dispatch(JSON.parse(text)) }));
  } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
});
server.on('error', () => { child.kill(); process.exit(1); });
server.listen(port, '127.0.0.1', async () => {
  try {
    await rpc('initialize', { clientInfo: { name: 'personal_telegram', title: 'Personal Telegram', version: '0.2.0' }, capabilities:{experimentalApi:true} });
    send({ method: 'initialized', params: {} });
    ready = true;
    record({ method: 'bridge/started', params: { generation } });
  } catch { fail(); }
});
process.on('SIGTERM', () => { child.kill('SIGTERM'); server.close(); setTimeout(() => process.exit(0), 1000).unref(); });
