import { createHmac, timingSafeEqual } from 'node:crypto';

export function defaults(cfg={}) {
  return { agentsMd:'', model:'', effort:'', language:'auto', idleMinutes:Math.min(120,Math.max(1,Math.round((cfg.idleMs || 1800000)/60000))), streaming:true };
}
export function settingsFor(tenant, cfg) { return {...defaults(cfg),...tenant.settings}; }
export function validateInitData(raw,token,now=Math.floor(Date.now()/1000)) {
  if(typeof raw!=='string' || !raw || raw.length>16000) throw new Error('Open Settings from Telegram.');
  const data=new URLSearchParams(raw), seen=new Set();
  for(const [key] of data) { if(seen.has(key)) throw new Error('Invalid Telegram sign-in.'); seen.add(key); }
  const hash=data.get('hash'); data.delete('hash');
  if(!/^[a-f0-9]{64}$/i.test(hash || '')) throw new Error('Invalid Telegram sign-in.');
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  const check=[...data].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  const expected=createHmac('sha256',secret).update(check).digest();
  if(!timingSafeEqual(expected,Buffer.from(hash,'hex'))) throw new Error('Invalid Telegram sign-in.');
  const date=Number(data.get('auth_date'));
  if(!Number.isSafeInteger(date) || date>now+30 || now-date>3600) throw new Error('Your session expired. Close and reopen Settings.');
  let user; try {user=JSON.parse(data.get('user'));} catch {}
  if(!Number.isSafeInteger(user?.id) || user.id<=0 || user.is_bot) throw new Error('Invalid Telegram user.');
  return user;
}
export function validateSettings(value,cfg,models=[]) {
  const base=defaults(cfg);
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!Object.hasOwn(base,k))) throw new Error('Invalid settings.');
  if(typeof value.agentsMd!=='string' || Buffer.byteLength(value.agentsMd)>32768 || value.agentsMd.includes('\0')) throw new Error('AGENTS.md must be under 32 KB.');
  if(typeof value.model!=='string' || value.model && !models.some(m=>m.id===value.model)) throw new Error('Choose an available model.');
  if(!['','low','medium','high','xhigh'].includes(value.effort)) throw new Error('Choose a valid reasoning effort.');
  const selected=models.find(m=>m.id===value.model);
  if(value.effort && (!selected || !selected.efforts.includes(value.effort))) throw new Error('Choose a model that supports this reasoning effort.');
  if(!['en','ru','auto'].includes(value.language)) throw new Error('Choose a reply language.');
  if(!Number.isSafeInteger(value.idleMinutes) || value.idleMinutes<1 || value.idleMinutes>base.idleMinutes) throw new Error(`Idle time must be between 1 and ${base.idleMinutes} minutes.`);
  if(typeof value.streaming!=='boolean') throw new Error('Invalid streaming setting.');
  return Object.fromEntries(Object.keys(base).map(k=>[k,value[k]]));
}
export function modelCatalog(data=[]) {
  return data.filter(m=>!m.hidden && typeof m.model==='string').slice(0,100).map(m=>({id:m.model,name:m.displayName || m.model,isDefault:!!m.isDefault,defaultEffort:m.defaultReasoningEffort || '',
    efforts:(m.supportedReasoningEfforts || []).map(e=>e.reasoningEffort).filter(e=>['low','medium','high','xhigh'].includes(e))}));
}
