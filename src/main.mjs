import { createServer } from 'node:http';
import { config, sleep } from './core.mjs';
import { Telegram } from './telegram.mjs';
import { Control } from './control.mjs';
import { miniAppHandler } from './miniapp.mjs';
import { Workers } from './worker.mjs';
import { Delivery } from './streaming.mjs';
import { GroupChats } from './groups.mjs';

const cfg = config();
const control = new Control(cfg);
const telegram = new Telegram(cfg.token);
telegram.chunkDelayMs = 1100;
const workers = new Workers(cfg, control, telegram);
let stopping = false;
let started = false;
let lastPoll = Date.now();
let lastWorker = Date.now();
const isGateway = cfg.role !== 'worker';
const isWorker = cfg.role !== 'gateway';
const miniapp = miniAppHandler(cfg,control);
const health = createServer(async (req, res) => {
  if(isGateway && await miniapp(req,res)) return;
  if(req.url!=='/healthz') { res.writeHead(404);res.end();return; }
  const ok = started && !stopping && (!isGateway || Date.now() - lastPoll < 120000)
    && (!isWorker || Date.now() - lastWorker < 120000);
  res.writeHead(req.url === '/healthz' && ok ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ready: ok, role: cfg.role, usersOnWorker: workers.active.size }));
}).listen(cfg.port, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  stopping = true; health.close();
  // Only controller processes exit; user Sandboxes retain their leased lifetime.
  setTimeout(() => process.exit(0), 8000).unref();
});

async function poll() {
  while (!stopping) {
    try {
      const updates = await telegram.call('getUpdates', { offset: await control.offset(), timeout: 25, allowed_updates: ['message', 'edited_message', 'my_chat_member', 'callback_query', 'stopped_message_generation'] });
      await control.receive(updates);
      await control.groups.cleanup();
      lastPoll = Date.now();
    } catch { console.error('Telegram receive failed; retrying'); await sleep(3000); }
  }
}
async function delivery() {
  const sender=new Delivery(control,telegram);
  while (!stopping) {
    try {
      await sender.tick();
    } catch { console.error('Telegram delivery failed; messages remain queued'); }
    await sleep(50);
  }
  await sender.drain();
}
async function work() {
  while (!stopping) {
    try { await workers.tick(); lastWorker = Date.now(); }
    catch { console.error('Worker scheduler failed; retrying'); }
    await sleep(200);
  }
  await workers.stop();
}

try {
  await control.start();
  if (isGateway) {
    await control.gatewayLock({waitMs:120000});
    const webhook = await telegram.call('getWebhookInfo');
    if (webhook.url) throw new Error('Existing Telegram webhook found');
    control.groups=new GroupChats(control,telegram,await telegram.call('getMe'));
    await telegram.call('setMyCommands', { commands: [
      { command: 'new', description: 'Create a session' }, { command: 'sessions', description: 'My sessions' },
      { command: 'status', description: 'Environment status' }, { command: 'login', description: 'Sign in to ChatGPT' },
      { command: 'stop', description: 'Stop the task' }, { command: 'models', description: 'Models' },
      { command: 'settings', description: 'Instructions and preferences' },
      { command: 'help', description: 'All commands' },
    ] });
    await telegram.call('setMyCommands', {scope:{type:'all_group_chats'},commands:[
      {command:'connect',description:'Connect this group (approved admin)'},
      {command:'login',description:'Sign in for this group (connecting admin)'},
      {command:'status',description:'Check this group session'},
      {command:'stop',description:'Stop this task'},
      {command:'reset',description:'Start a fresh conversation (admin)'},
      {command:'models',description:'Available models'},
      {command:'model',description:'Choose this session’s model'},
      {command:'help',description:'How to use the group assistant'},
      {command:'settings',description:'Shared group settings (admins)'},
      {command:'disconnect',description:'Disconnect this group (admin)'},
    ]});
  }
  if(isGateway && cfg.miniAppUrl) await telegram.call('setChatMenuButton',{menu_button:{type:'web_app',text:'Settings',web_app:{url:cfg.miniAppUrl}}});
  started = true;
  console.log(`Multi-user Telegram bot ready (${cfg.role})`);
  const tasks = [];
  if (isGateway) tasks.push(poll(), delivery());
  if (isWorker) tasks.push(work());
  await Promise.all(tasks);
} catch { console.error('Bot startup failed; check configuration, database and gateway ownership'); process.exitCode = 1; }
finally { health.close(); await control.close().catch(() => {}); }
