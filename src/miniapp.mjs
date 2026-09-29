import { appView } from './apps.mjs';
import { readFile } from 'node:fs/promises';
import { validateInitData, validateSettings, settingsFor, defaults } from './settings.mjs';
import { groupSettingsId } from './groups.mjs';

const assets=new Map([
  ['/settings',['index.html','text/html; charset=utf-8']],
  ['/settings/',['index.html','text/html; charset=utf-8']],
  ['/settings/app.js',['app.js','text/javascript; charset=utf-8']],
  ['/settings/style.css',['style.css','text/css; charset=utf-8']],
  ['/settings/Geist-Regular.woff2',['fonts/Geist-Regular.woff2','font/woff2']],
  ['/settings/Geist-SemiBold.woff2',['fonts/Geist-SemiBold.woff2','font/woff2']],
]);
const files=new Map();
async function jsonBody(req) {
  if(!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('Send JSON settings.'),{status:415});
  const parts=[];let bytes=0;
  for await(const part of req) { bytes+=part.length; if(bytes>70000) throw Object.assign(new Error('Settings are too large.'),{status:413}); parts.push(part); }
  try {return JSON.parse(Buffer.concat(parts).toString('utf8'));} catch {throw Object.assign(new Error('Invalid JSON.'),{status:400});}
}
export function miniAppHandler(cfg,control) {
  const limits=new Map();
  return async(req,res)=>{
    const path=req.url?.split('?')[0];
    if(!assets.has(path) && !['/api/settings','/api/apps','/api/apps/refresh','/api/data'].includes(path)) return false;
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org");
    const reply=(code,data)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    try {
      if(assets.has(path)) {
        if(req.method!=='GET' && req.method!=='HEAD') { reply(405,{error:'Method not allowed.'});return true; }
        const [file,type]=assets.get(path);
        if(!files.has(file)) files.set(file,await readFile(new URL(`../web/${file}`,import.meta.url)));
        res.writeHead(200,{'content-type':type});res.end(req.method==='HEAD'?undefined:files.get(file));return true;
      }
      const apps=path.startsWith('/api/apps');
      const methods=path==='/api/apps/refresh'?['POST']:path==='/api/apps' || path==='/api/data'?['GET']:['GET','PUT'];
      if(!methods.includes(req.method)) {reply(405,{error:'Method not allowed.'});return true;}
      // Use only Telegram's signed identity, never a user ID supplied in the URL/body.
      let user;
      try { user=validateInitData(req.headers.authorization?.replace(/^tma /,''),cfg.token); }
      catch(error) {reply(401,{error:error.message});return true;}
      const now=Date.now(), old=limits.get(user.id), limit=old && old.until>now?old:{until:now+60000,count:0};
      if(limits.size>10000) for(const [id,v] of limits) if(v.until<=now) limits.delete(id);
      limits.set(user.id,limit);
      if(++limit.count>60) {reply(429,{error:'Please wait a minute before trying again.'});return true;}
      if(req.method!=='GET' && req.headers.origin && cfg.miniAppUrl && req.headers.origin!==new URL(cfg.miniAppUrl).origin) {reply(403,{error:'Invalid request origin.'});return true;}
      // A link selects a group, never grants access. Verify the signed Telegram
      // user and their current admin role for every read and write, including apps.
      const launch=new URLSearchParams(req.headers.authorization.replace(/^tma /,'')).get('start_param');
      const selected=req.headers['x-lizard-group'] || (launch?.startsWith('group_')?launch:null);
      let accountId=user.id, scope={kind:'personal',name:'Your space'};
      if(selected) {
        const groupId=groupSettingsId(selected);
        if(!groupId || launch?.startsWith('group_') && launch!==selected) {reply(400,{error:'Invalid group settings link.'});return true;}
        const group=await control.groups?.settingsTenant(control,groupId,user.id);
        if(!group) {reply(403,{error:'Only current admins of a connected group can open its settings.'});return true;}
        accountId=groupId;scope={kind:'group',name:group.group_title || 'Group'};
      }
      if(path==='/api/data') {
        const tenant=await control.tenant(accountId);
        if(tenant?.admission!=='approved') {reply(403,{error:'Access requires approval from the bot owner.'});return true;}
        const schema=tenant.schema_name;
        // Identifiers come only from the approved tenant, with the same guard as Store.
        if(!/^(public|tenant_[1-9][0-9]*|group_[1-9][0-9]*)$/.test(schema)) throw new Error('Invalid tenant schema');
        const exists=(await control.query('SELECT to_regclass($1) AS name',[`${schema}.sessions`])).rows[0].name;
        let sessions=[],total=0,archived=0;
        if(exists) {
          const counts=(await control.query(`SELECT count(*)::int AS total,count(*) FILTER (WHERE archived)::int AS archived FROM ${schema}.sessions`)).rows[0];
          total=counts.total;archived=counts.archived;
          sessions=(await control.query(`SELECT title,archived,created_at FROM ${schema}.sessions ORDER BY created_at DESC,topic DESC LIMIT 40`)).rows.map(s=>({title:s.title,archived:s.archived,createdAt:s.created_at}));
        }
        reply(200,{scope,sessions,total,archived,joinedAt:tenant.created_at,workspace:tenant.lifecycle,instructionBytes:Buffer.byteLength(settingsFor(tenant,cfg).agentsMd)});return true;
      }
      if(apps) {
        let tenant;
        if(req.method==='POST') tenant=await control.transaction(async db=>{
          const t=(await db.query('SELECT * FROM control.tenants WHERE user_id=$1 FOR UPDATE',[accountId])).rows[0];
          if(t?.admission!=='approved') throw Object.assign(new Error('Access requires approval from the bot owner.'),{status:403});
          if(t.apps_request_seq>t.apps_done_seq) return t;
          return (await db.query('UPDATE control.tenants SET apps_request_seq=apps_request_seq+1,next_check=now(),has_work=true,last_activity=now() WHERE user_id=$1 RETURNING *',[accountId])).rows[0];
        });
        else tenant=await control.tenant(accountId);
        if(tenant?.admission!=='approved') {reply(403,{error:'Access requires approval from the bot owner.'});return true;}
        reply(req.method==='POST'?202:200,{...appView(tenant),scope});return true;
      }
      let tenant;
      if(req.method==='PUT') {
        const body=await jsonBody(req);
        if(!Number.isSafeInteger(body.version) || body.version<0) {reply(400,{error:'Invalid settings version.'});return true;}
        tenant=await control.transaction(async db=>{
          const t=(await db.query('SELECT * FROM control.tenants WHERE user_id=$1 FOR UPDATE',[accountId])).rows[0];
          if(t?.admission!=='approved') throw Object.assign(new Error('Access requires approval from the bot owner.'),{status:403});
          if(t.settings_version!==body.version) throw Object.assign(new Error('Settings changed elsewhere. Reload before saving.'),{status:409});
          let value;try {value=validateSettings(body.settings,cfg,t.models || []);} catch(e){throw Object.assign(e,{status:400});}
          return (await db.query(`UPDATE control.tenants SET settings=$2,settings_version=settings_version+1,next_check=now() WHERE user_id=$1 RETURNING *`,[accountId,JSON.stringify(value)])).rows[0];
        });
      } else {
        tenant=await control.tenant(accountId);
        if(tenant?.admission!=='approved') {reply(403,{error:'Access requires approval from the bot owner.'});return true;}
      }
      reply(200,{scope,settings:settingsFor(tenant,cfg),version:tenant.settings_version,models:tenant.models || [],limits:{idleMinutes:defaults(cfg).idleMinutes,agentsBytes:32768},
        environment:{state:tenant.lifecycle,access:'Full access',tools:['Lizard CLI','GitHub CLI','agent-browser'],skills:['Lizard Skill','agent-browser']}});
    } catch(error) {reply(error.status || 503,{error:error.status?error.message:'Could not load or save settings. Please try again.'});}
    return true;
  };
}
