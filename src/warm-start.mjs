// Restore a prepared volume locally, without repeated controller/SDK round trips.
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
const started = performance.now();
const root = dirname(fileURLToPath(import.meta.url));
mkdirSync('/opt/telegram-codex', {recursive:true});
for (const name of ['bridge.mjs','bridge-client.mjs','setup-tools.mjs','persistent-gh.mjs','managed-lizard.mjs','setup-browser.sh','install-lizard-skill.mjs','lizard-SKILL.md','agent-browser-SKILL.md']) copyFileSync(join(root,name), `/opt/telegram-codex/${name}`);
execFileSync('node',['/opt/telegram-codex/setup-tools.mjs','--restore'],{stdio:'pipe',timeout:5000});
execFileSync('sh',['/opt/telegram-codex/setup-browser.sh','--restore'],{stdio:'pipe',timeout:5000});
execFileSync('node',['/opt/telegram-codex/install-lizard-skill.mjs'],{stdio:'pipe',timeout:5000});
const restoredMs = Math.round(performance.now()-started);
const health = async () => {
  try {
    const response = await fetch('http://127.0.0.1:43127/', {method:'POST',headers:{authorization:`Bearer ${readFileSync('/workspace/.telegram-codex/bridge.key','utf8')}`},body:JSON.stringify({action:'health'}),signal:AbortSignal.timeout(250)});
    return (await response.json()).result;
  } catch { return null; }
};
let state = await health();
if (state?.dead) throw new Error('Existing bridge is dead; use full recovery');
if (!state) spawn('node',['/opt/telegram-codex/bridge.mjs'],{detached:true,stdio:'ignore'}).unref();
for (let i=0;i<200;i++) {
  state = await health();
  if (state?.ready) { console.log(JSON.stringify({...state,restoredMs,localReadyMs:Math.round(performance.now()-started)})); process.exit(0); }
  await new Promise(resolve=>setTimeout(resolve,25));
}
throw new Error('Bridge not ready; use full recovery');
