import { isIP } from 'node:net';
export function publicAppUrl(value) {
  try {
    const u=new URL(value.includes('://')?value:`https://${value}`);
    if(u.protocol!=='https:' || u.username || u.password || u.port || !u.hostname.includes('.') || isIP(u.hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname)) return null;
    return u.origin;
  } catch { return null; }
}
const clean=(s,n)=>typeof s==='string'?Array.from(s.replace(/[\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim()).slice(0,n).join(''):'';
export function appCards(project,services,userId,metadata=[],{projectScoped=false}={}) {
  const apps=(services || []).filter(a=>(projectScoped ? a.projectId===project.id : a.userId===userId) && !a.deletedAt && Number(a.containerPort)>0 && a.domain);
  const score=a=>/^(web|frontend|client|website|app)$/i.test(a.name)?3:/api|backend|worker|cron/i.test(a.name)?0:1;
  apps.sort((a,b)=>score(b)-score(a));
  for(const a of apps) {
    const urls=a.domain.split(',').map(s=>publicAppUrl(s.trim())).filter(Boolean);
    if(!urls.length) continue;
    const url=urls.find(u=>!u.endsWith('.onlizard.com')) || urls[0];
    const meta=metadata.find(m=>urls.includes(publicAppUrl(typeof m?.url==='string'?m.url:'')));
    const name=clean(meta?.name,60) || clean(project.name,60).replace(/[-_]+/g,' ').replace(/^./,c=>c.toUpperCase()) || 'Untitled app';
    const updating=['building','deploying','queued','cloning'].includes(a.deployStatus);
    const status=updating?'updating':a.status==='running'?'ready':['stopped','paused','sleeping'].includes(a.status)?'paused':['crashed','failed','error'].includes(a.status)?'attention':'preparing';
    return [{key:project.id,name,description:clean(meta?.description,180),url,status}];
  }
  return [];
}
export function safeAppResult(result) {
  const status=['ready','updating','paused','attention','preparing'];
  const items=(Array.isArray(result?.items)?result.items:[]).slice(0,200).flatMap(a=>{
    const url=publicAppUrl(typeof a?.url==='string'?a.url:'');
    const key=clean(a?.key,100),name=clean(a?.name,60);
    return url && key && name?[{key,name,description:clean(a.description,180),url,status:status.includes(a.status)?a.status:'preparing'}]:[];
  });
  return {items,state:['empty','connect','connected','unavailable'].includes(result?.state)?result.state:'unavailable',partial:!!result?.partial,
    updatedAt:typeof result?.updatedAt==='string' && Number.isFinite(Date.parse(result.updatedAt))?new Date(result.updatedAt).toISOString():null};
}
export function appView(tenant) {
  const saved=safeAppResult(tenant.apps?.state?tenant.apps:{state:'empty',items:[]});
  return {items:(saved.items || []).map(({name,description,url,status})=>({name,description,url,status})),
    state:saved.state || 'empty',updatedAt:saved.updatedAt || null,partial:!!saved.partial,
    refreshing:tenant.apps_request_seq>tenant.apps_done_seq};
}
