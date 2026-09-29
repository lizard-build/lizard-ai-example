import { Lizard, Volume, NotFoundError } from '@lizard-build/sdk';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { sleep } from './core.mjs';
import { ATTACHMENT_MAX_BYTES, attachmentName, imageExtension } from './attachments.mjs';
import { readOutputChunk, OUTPUT_MAX_BYTES } from './artifacts.mjs';
import { transcribeVoice } from './transcription.mjs';

let bundlePromise;
function runtimeBundle() {
  return bundlePromise ||= (async () => {
    const files = {};
    for (const name of ['bridge.mjs','bridge-client.mjs','install-lizard-skill.mjs','setup-browser.sh','setup-tools.mjs','persistent-gh.mjs','managed-lizard.mjs','warm-start.mjs']) files[name] = await readFile(new URL(name, import.meta.url),'utf8');
    for (const name of ['lizard','agent-browser']) files[`${name}-SKILL.md`] = await readFile(new URL(`../skills/${name}/SKILL.md`,import.meta.url),'utf8');
    const content = JSON.stringify(files);
    return {content,path:`/workspace/.telegram-codex/runtime-${createHash('sha256').update(content).digest('hex').slice(0,20)}`};
  })();
}

export class Runtime {
  constructor(cfg, store, client, volumeHandle = opts => new Volume(opts)) {
    this.cfg = cfg; this.store = store;
    this.client = client || new Lizard({ project: cfg.project, apiKey: cfg.apiKey, apiUrl: cfg.apiUrl });
    this.volumeHandle = volumeHandle;
  }
  async start(allowCreate = true) {
    const startupAt = performance.now();
    let created = false;
    const bundle = await runtimeBundle();
    this.stage = 'volume';
    this.sandbox = null;
    this.appsCollectorReady=false;
    // Volume handles accept names. Read its attachment once; only provision on 404.
    let volume = this.volumeHandle({volumeId:this.cfg.volume, apiKey:this.cfg.apiKey, apiUrl:this.cfg.apiUrl});
    let info;
    try { info = await volume.getInfo(this.cfg.project); }
    catch (error) {
      if (!(error instanceof NotFoundError) || !allowCreate) throw error;
      volume = await this.client.volumes.getOrCreate(this.cfg.volume, {sizeGb:this.cfg.sizeGb});
      info = await volume.getInfo(this.cfg.project);
    }
    const volumeMs = Math.round(performance.now()-startupAt);
    let createMs = 0;
    const attachedTo = info.attachedSandboxId ?? info.attachedTo;
    const saved = await this.store.get('sandbox');
    this.stage = 'connect';
    if (saved) {
      try { this.sandbox = await this.client.connect(saved); }
      catch (error) { if (!(error instanceof NotFoundError)) throw error; }
    }
    if (this.sandbox && attachedTo !== this.sandbox.sandboxId) throw new Error('Sandbox volume ownership mismatch');
    if (!this.sandbox) {
      // Recover by the tenant's own volume, even when sandbox-list metadata is absent.
      if (attachedTo) this.sandbox = await this.client.connect(attachedTo);
      else {
        if (!allowCreate) return false;
        if (await this.store.get('creationAttempt')) throw new Error('Sandbox creation outcome unknown; needs reconciliation');
        await this.store.set('creationAttempt', { at: Date.now(), volume: this.cfg.volume });
        this.stage = 'create';
        created = true;
        const createAt = performance.now();
        this.sandbox = await this.client.create(this.cfg.template, {
          volumeName: this.cfg.volume, timeoutMs: this.cfg.sandboxLifetimeMs || 7200000,
          metadata: { botProject: this.cfg.project, botVolume: this.cfg.volume, telegramUser: String(this.cfg.owner) },
        });
        createMs = Math.round(performance.now()-createAt);
      }
      await this.store.set('sandbox', this.sandbox.sandboxId);
    }
    await this.store.set('creationAttempt', null);
    if (created) this.renewedAt = Date.now(); else await this.renew();
    const connectedMs = Math.round(performance.now()-startupAt);
    this.stage = 'restore';
    if(this.cfg.managedLizard) await this.sandbox.fs.write('/workspace/.telegram-codex/lizard-account-input.json',JSON.stringify(this.cfg.managedLizard));
    let healthRestored;
    try {
      const restored = await this.sandbox.process.exec(`if test -f ${bundle.path}/ready; then node ${bundle.path}/warm-start.mjs; else exit 42; fi`);
      if (!restored.exitCode) healthRestored = JSON.parse(restored.stdout);
    } catch { /* An incomplete cache falls back to the checked setup below. */ }
    if (healthRestored) {
      const health = healthRestored;
      if (health.ready && !health.dead && health.version===2) {
        this.bridgeVersion=health.version; this.bridgeUpgradePending=false;
        this.generation = health.generation;
        if (this.cfg.openaiKey) await this.rpc('account/login/start', {type:'apiKey',apiKey:this.cfg.openaiKey});
        this.startup = {volumeMs,createMs,connectedMs,restoredMs:health.restoredMs,localReadyMs:health.localReadyMs,totalMs:Math.round(performance.now()-startupAt),cached:true};
        this.stage = 'ready';
        console.log(JSON.stringify({event:'environment-ready',user:this.cfg.owner,...this.startup}));
        return true;
      }
    }
    this.stage = 'bootstrap';
    // A created sandbox may not accept exec immediately. This probe is safe to retry.
    let setup;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        setup = await this.sandbox.process.exec('mkdir -p /opt/telegram-codex /workspace/.telegram-codex/codex /workspace/sessions && command -v codex && node --version');
        break;
      } catch (error) {
        if (attempt === 19) throw error;
        await sleep(1000);
      }
    }
    if (setup.exitCode) throw new Error('Sandbox template must include Codex and Node.js with node:sqlite');
    await Promise.all([
      ...['bridge.mjs', 'bridge-client.mjs', 'install-lizard-skill.mjs', 'setup-browser.sh', 'setup-tools.mjs', 'persistent-gh.mjs', 'managed-lizard.mjs'].map(async name =>
        this.sandbox.fs.write(`/opt/telegram-codex/${name}`, await readFile(new URL(name, import.meta.url), 'utf8'))),
      ...['lizard', 'agent-browser'].map(async name =>
        this.sandbox.fs.write(`/opt/telegram-codex/${name}-SKILL.md`, await readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8'))),
    ]);
    await this.ensureTools();
    if(this.cfg.managedLizard && (await this.sandbox.process.exec('node /opt/telegram-codex/managed-lizard.mjs')).exitCode) throw new Error('Could not configure deployment access');
    this.stage = 'skills';
    const skills = await this.sandbox.process.exec('node /opt/telegram-codex/install-lizard-skill.mjs && lizard skills get core --json >/dev/null');
    if (skills.exitCode) throw new Error('Lizard Skill setup failed');
    this.stage = 'browser';
    await this.sandbox.process.exec('nohup sh /opt/telegram-codex/setup-browser.sh </dev/null >/tmp/browser-install.log 2>&1 &');
    let browserReady = false;
    for (let attempt = 0; attempt < 180; attempt++) {
      const probe = await this.sandbox.process.exec('test -f /opt/telegram-codex/browser-ready-v3');
      if (!probe.exitCode) { browserReady = true; break; }
      await sleep(3000);
    }
    if (!browserReady) throw new Error('Browser installation did not finish');
    this.stage = 'bridge';
    let health;
    try { health = await this.send({ action: 'health' }); } catch {}
    if(health?.ready && health.version!==2) {
      if(!await this.bridgeBusy()) {
        const stopped=await this.sandbox.process.exec(`node -e 'const f=require("fs");for(const p of f.readdirSync("/proc")){if(!/^\\d+$/.test(p))continue;try{if(f.readFileSync("/proc/"+p+"/cmdline","utf8").split("\\0").includes("/opt/telegram-codex/bridge.mjs"))process.kill(Number(p),"SIGTERM")}catch{}}'`);
        if(stopped.exitCode) throw new Error('Could not update idle Codex bridge');
        await sleep(1200);
        health=null;
      } else this.bridgeUpgradePending=true;
    }
    if (health?.dead) {
      await this.send({ action: 'stopDeadBridge' });
      await sleep(500);
      health = null;
    }
    if (!health) {
      const launched = await this.sandbox.process.exec('nohup node /opt/telegram-codex/bridge.mjs </dev/null >/tmp/telegram-codex-bridge.log 2>&1 &');
      if (launched.exitCode) throw new Error('Bridge launch failed');
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      try { health = await this.send({ action: 'health' }); if (health.ready) break; } catch {}
      await sleep(1000);
    }
    if (!health?.ready) throw new Error('Codex bridge did not become ready');
    this.generation = health.generation;
    this.bridgeVersion=health.version;
    this.bridgeUpgradePending=health.version!==2;
    if (this.cfg.openaiKey) await this.rpc('account/login/start', { type: 'apiKey', apiKey: this.cfg.openaiKey });
    // Cache trusted application files once per revision, alongside the user's tools.
    await this.sandbox.fs.write(`${bundle.path}/bundle.json`, bundle.content);
    const cachedFiles = await this.sandbox.process.exec(`node -e 'const f=require("fs"),p="${bundle.path}";for(const [n,s] of Object.entries(JSON.parse(f.readFileSync(p+"/bundle.json","utf8"))))f.writeFileSync(p+"/"+n,s);f.writeFileSync(p+"/ready","")'`);
    if (cachedFiles.exitCode) throw new Error('Could not cache runtime files');
    this.startup = {volumeMs,createMs,connectedMs,totalMs:Math.round(performance.now()-startupAt),cached:false};
    this.stage = 'ready';
    console.log(JSON.stringify({event:'environment-ready',user:this.cfg.owner,...this.startup}));
    return true;
  }
  async ensureTools() {
    this.stage = 'tools';
    const check = 'test -f /opt/telegram-codex/tools-ready-v3 && lizard --version && gh --version && agent-browser --version';
    if (!(await this.sandbox.process.exec(check)).exitCode) return;
    const status = `/opt/telegram-codex/tools-status-${randomUUID()}`;
    // Installation can outlast an exec request. The lock survives worker reconnects.
    await this.sandbox.process.exec(`nohup sh -c 'flock 9; if node /opt/telegram-codex/setup-tools.mjs >/tmp/tools-install.log 2>&1; then printf ready; else printf failed; fi >${status}' 9>/opt/telegram-codex/tools-install.lock </dev/null >/tmp/tools-install.log 2>&1 &`);
    for (let attempt = 0; attempt < 240; attempt++) {
      const result = await this.sandbox.process.exec(`if test -f ${status}; then cat ${status}; fi`);
      if (result.stdout.trim() === 'failed') throw new Error('CLI installation failed');
      if (result.stdout.trim() === 'ready') {
        if ((await this.sandbox.process.exec(check)).exitCode) throw new Error('CLI verification failed');
        return;
      }
      await sleep(3000);
    }
    throw new Error('CLI installation timed out');
  }
  async collectApps() {
    if(!this.appsCollectorReady) {
      for(const name of ['apps.mjs','collect-apps.mjs']) await this.sandbox.fs.write(`/opt/telegram-codex/${name}`,await readFile(new URL(name,import.meta.url),'utf8'));
      this.appsCollectorReady=true;
    }
    const result=await this.sandbox.process.exec('node /opt/telegram-codex/collect-apps.mjs',{timeoutMs:70000});
    if(result.exitCode) throw new Error('Could not update apps');
    return JSON.parse(result.stdout);
  }
  async saveAgents(text) {
    // Preserve a pre-existing global file once; write new instructions atomically.
    const input='/workspace/.telegram-codex/agents-settings.json';
    await this.sandbox.fs.write(input,JSON.stringify({text}));
    const saved=await this.sandbox.process.exec(`node -e 'const f=require("fs"),p="/workspace/.telegram-codex/codex/AGENTS.md";if(f.existsSync(p)&&!f.existsSync(p+".before-miniapp"))f.copyFileSync(p,p+".before-miniapp");const v=JSON.parse(f.readFileSync("${input}","utf8"));f.writeFileSync(p+".pending",v.text,{mode:384});f.renameSync(p+".pending",p)'`);
    if(saved.exitCode) throw new Error('Could not save AGENTS.md');
  }
  async bridgeBusy() {
    return (await this.store.query(`SELECT EXISTS(SELECT 1 FROM sessions WHERE turn_id IS NOT NULL)
      OR EXISTS(SELECT 1 FROM prompts WHERE state IN ('starting','running'))
      OR EXISTS(SELECT 1 FROM approvals WHERE state='pending') AS busy`)).rows[0].busy;
  }
  async renew() {
    await this.sandbox.setTimeout(this.cfg.sandboxLifetimeMs || 7200000);
    this.renewedAt = Date.now();
  }
  async readOutput(cwd,file) {
    const parts=[];let offset=0,size,version;
    do {
      const script=`const read=${readOutputChunk.toString()};console.log(JSON.stringify(await read(${JSON.stringify({cwd,file,offset})})))`;
      const encoded=Buffer.from(script).toString('base64');
      const result=await this.sandbox.process.exec(`node --input-type=module -e 'await import("data:text/javascript;base64,${encoded}")'`,{timeoutMs:30000});
      if(result.exitCode) throw new Error('Could not read output file');
      const chunk=JSON.parse(result.stdout);
      if(!Number.isSafeInteger(chunk.size) || chunk.size<1 || chunk.size>OUTPUT_MAX_BYTES
        || offset && (chunk.size!==size || chunk.version!==version)) throw new Error('Output file changed');
      size=chunk.size;version=chunk.version;
      const bytes=Buffer.from(chunk.data,'base64');
      if(!bytes.length || bytes.length>192*1024 || offset+bytes.length>size) throw new Error('Invalid output chunk');
      parts.push(bytes);offset+=bytes.length;
    } while(offset<size);
    return Buffer.concat(parts);
  }
  async saveAttachment(bytes, topic, updateId, file) {
    if (!Number.isSafeInteger(topic) || topic<1 || !Number.isSafeInteger(updateId) || updateId<0
      || !bytes.length || bytes.length>ATTACHMENT_MAX_BYTES) throw new Error('Invalid attachment');
    const image = imageExtension(bytes);
    if(file.kind==='photo' && !image) throw new Error('Invalid photo');
    const name=image ? `image.${image}` : `file-${attachmentName(file.file_name).slice(-75)}`;
    const root=`/workspace/sessions/${topic}/attachments/${updateId}`;
    const encoded=bytes.toString('base64'), parts=[];
    for(let offset=0;offset<encoded.length;offset+=262144) parts.push(encoded.slice(offset,offset+262144));
    await this.sandbox.fs.write('/opt/telegram-codex/save-attachment.mjs',await readFile(new URL('save-attachment.mjs',import.meta.url),'utf8'));
    for(let i=0;i<parts.length;i+=4) {
      const results=await Promise.allSettled(parts.slice(i,i+4).map((part,n)=>this.sandbox.fs.write(`${root}/part-${i+n}.b64`,part)));
      const failed=results.find(r=>r.status==='rejected');if(failed) throw failed.reason;
    }
    await this.sandbox.fs.write(`${root}/input.json`,JSON.stringify({name,chunks:parts.length,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));
    const result=await this.sandbox.process.exec(`node /opt/telegram-codex/save-attachment.mjs ${root}`,{timeoutMs:30000});
    if(result.exitCode) throw new Error('Could not save attachment');
    return {path:`${root}/${name}`,image:Boolean(image),name:file.file_name || name};
  }
  async transcribe(audio, updateId, mimeType) {
    if (!Number.isSafeInteger(updateId) || updateId < 0) throw new Error('Invalid voice job');
    return transcribeVoice(audio, this.cfg.openrouterKey, mimeType);
  }
  async retire() {
    let saved = await this.store.get('sandbox');
    if (!saved && !(await this.store.get('creationAttempt'))) return;
    const volume = await this.client.volumes.get(this.cfg.volume);
    const info = await volume.getInfo(this.cfg.project);
    if (!saved) {
      saved = info.attachedSandboxId ?? info.attachedTo;
      if (!saved) throw new Error('Sandbox creation outcome unknown; needs reconciliation before retirement');
      await this.store.set('sandbox', saved);
    }
    let sandbox;
    try { sandbox = await this.client.connect(saved); }
    catch (error) { if (!(error instanceof NotFoundError)) throw error; }
    if (sandbox) {
      if ((info.attachedSandboxId ?? info.attachedTo) !== saved) throw new Error('Refusing to retire a sandbox with a different volume');
      // Close only this user's browsers so their on-volume profiles flush to disk.
      const closed = await sandbox.process.exec('if command -v agent-browser >/dev/null; then agent-browser close --all || exit $?; fi; sync', { timeoutMs: 30000 });
      if (closed.exitCode) throw new Error('Could not flush sandbox files');
      await sandbox.kill();
    }
    let detached = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = await volume.getInfo(this.cfg.project);
      if (!(current.attachedSandboxId ?? current.attachedTo)) { detached = true; break; }
      await sleep(1000);
    }
    if (!detached) throw new Error('Volume detach is still pending');
    await this.store.set('sandbox', null);
    await this.store.set('creationAttempt', null);
    this.sandbox = null;
  }
  async send(payload) {
    // The current sandbox runtime ignores exec envs. Keep payloads out of shell
    // arguments and send them through a one-use request file instead.
    const requestPath = `/opt/telegram-codex/request-${randomUUID()}.json`;
    await this.sandbox.fs.write(requestPath, JSON.stringify(payload));
    const result = await this.sandbox.process.exec(`node /opt/telegram-codex/bridge-client.mjs ${requestPath}`, { timeoutMs: 70000 });
    let data;
    try { data = JSON.parse(result.stdout); } catch { throw new Error('Invalid bridge response'); }
    if (data.error || result.exitCode) throw new Error(data.error || 'Bridge request failed');
    return data.result;
  }
  rpc(method, params = {}, key = randomUUID()) { return this.send({ action: 'rpc', method, params, key }); }
  reply(approval, result, key, error) { return this.send({ action: 'reply', generation: approval.generation, id: approval.request_id, result, key, error }); }
  async events(after) {
    if(!Number.isSafeInteger(Number(after)) || Number(after)<0) throw new Error('Invalid event cursor');
    // This read-only payload contains just an action and numeric cursor. Avoid
    // a separate SDK file upload on every poll; never put user text here.
    const request=Buffer.from(JSON.stringify({action:'events',after:Number(after)})).toString('base64');
    const result=await this.sandbox.process.exec(`BRIDGE_REQUEST=${request} node /opt/telegram-codex/bridge-client.mjs`,{timeoutMs:70000});
    let data;
    try {data=JSON.parse(result.stdout);} catch {throw new Error('Invalid bridge response');}
    if(data.error || result.exitCode) throw new Error(data.error || 'Bridge request failed');
    return data.result;
  }
}
