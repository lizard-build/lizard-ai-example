import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createServer} from 'node:http';
import pg from 'pg';
import {Control} from '../src/control.mjs';
import {Store} from '../src/store.mjs';
import {GroupChats,groupSettingsId} from '../src/groups.mjs';
import {miniAppHandler} from '../src/miniapp.mjs';
import {defaults} from '../src/settings.mjs';

const token='123:group-settings-test';
function sign(id,start) {
  const data=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id}),...(start?{start_param:start}:{})});
  const key=createHmac('sha256','WebAppData').update(token).digest();
  data.set('hash',createHmac('sha256',key).update([...data].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));
  return data.toString();
}
test('group selectors accept only safe negative Telegram group IDs',()=>{
  assert.equal(groupSettingsId('group_1001234567890'),-1001234567890);
  for(const value of ['group_0','group_-123','group_01','group_9007199254740992','group_1;drop','123',null])assert.equal(groupSettingsId(value),null);
});
test('group Mini App verifies current admins on all routes and keeps private data separate',
 {skip:!process.env.TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});t.after(()=>admin.end());
  await admin.query('CREATE DATABASE group_settings_test');
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/group_settings_test';
  const cfg={database:url.toString(),token,owner:77001,volume:'owner',project:'test',miniAppUrl:'https://settings.example/settings',idleMs:1800000};
  const control=new Control(cfg);await control.start();t.after(()=>control.close());
  await control.query(`INSERT INTO control.tenants(user_id,admission,schema_name,volume_name,group_owner,group_title)
    VALUES(-77101,'approved','group_77101','g1',77001,'Design team'),(-77102,'approved','group_77102','g2',77001,'Other group')`);
  const admins=new Set([77001,77002]);
  const tg={call:async(method,body)=>{assert.equal(method,'getChatAdministrators');return body.chat_id===-77101?[...admins].map(id=>({status:'administrator',user:{id}})):[];}};
  const me={id:123,username:'test_bot',has_main_web_app:false};
  control.groups=new GroupChats(control,tg,me);
  const handler=miniAppHandler(cfg,control);
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(id,{method='GET',path='/api/settings',group='group_77101',start,body,auth}={})=>fetch(base+path,{
    method,headers:{Authorization:`tma ${auth || sign(id,start)}`,...(group?{'X-Lizard-Group':group}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  for(const path of ['/api/settings','/api/apps','/api/data','/api/apps/refresh']) {
    assert.equal((await request(77003,{path,method:path.endsWith('refresh')?'POST':'GET'})).status,403);
  }
  assert.equal((await request(77003,{method:'PUT',body:{version:0,settings:defaults(cfg)}})).status,403);
  assert.equal((await request(77001,{group:'group_77102'})).status,403,'a forwarded link cannot grant access to another group');
  assert.equal((await request(77001,{group:'group_0'})).status,400);
  assert.equal((await request(77001,{auth:sign(77003).replace('77003','77001')})).status,401);
  const first=await (await request(77002)).json();
  assert.deepEqual(first.scope,{kind:'group',name:'Design team'});
  assert.equal(await control.tenant(77002),undefined,'group admin needs no personal bot account');
  const settings={...first.settings,agentsMd:'# Group rules',language:'ru'};
  const saved=await (await request(77002,{method:'PUT',body:{version:0,settings,user_id:77001}})).json();
  assert.equal(saved.version,1);assert.equal(saved.settings.agentsMd,'# Group rules');
  assert.deepEqual((await control.tenant(77001)).settings,{});
  assert.equal((await request(77001,{method:'PUT',body:{version:0,settings}})).status,409);
  assert.equal((await control.tenant(-77101)).has_work,false,'editing settings never wakes compute');
  assert.equal((await (await request(77001,{group:null})).json()).scope.kind,'personal');
  assert.equal((await (await request(77002,{group:null,start:'group_77101'})).json()).settings.agentsMd,'# Group rules');
  assert.equal((await request(77002,{group:'group_77102',start:'group_77101'})).status,400);
  const store=new Store(cfg.database,'group_77101');await store.start();t.after(()=>store.close());
  await store.query("INSERT INTO sessions(topic,title,cwd) VALUES(1,'Shared work','/workspace/sessions/1')");
  await control.query('UPDATE control.tenants SET apps=$2 WHERE user_id=$1',[-77101,JSON.stringify({state:'connected',items:[{key:'team-app',name:'Team app',url:'https://team.example',status:'ready'}]})]);
  assert.equal((await (await request(77002,{path:'/api/data'})).json()).sessions[0].title,'Shared work');
  assert.equal((await (await request(77002,{path:'/api/apps'})).json()).items[0].name,'Team app');
  assert.equal((await request(77002,{path:'/api/apps/refresh',method:'POST'})).status,202);
  assert.equal((await control.tenant(-77101)).apps_request_seq,1);
  assert.equal((await control.tenant(77001)).apps_request_seq,0);
  // Group commands issue a link without creating an inbox item or a Sandbox.
  await control.receive([{update_id:1,message:{message_id:1,chat:{id:-77101,type:'group'},from:{id:77003},text:'/settings@test_bot',entities:[{type:'bot_command',offset:0,length:18}]}}]);
  const button=(await control.query("SELECT extra FROM control.outbox WHERE dedup_key='group:1'")).rows[0].extra.reply_markup.inline_keyboard[0][0];
  assert.equal(button.url,'https://t.me/test_bot?start=group_77101');assert.equal(button.web_app,undefined);
  await control.receive([{update_id:2,message:{chat:{id:77002,type:'private'},from:{id:77002},text:'/start group_77101'}}]);
  const opened=(await control.query("SELECT * FROM control.outbox WHERE dedup_key='group-settings:2'")).rows[0];
  assert.equal(opened.extra.reply_markup.inline_keyboard[0][0].web_app.url,'https://settings.example/settings?group=group_77101');
  assert.equal(await control.tenant(77002),undefined);
  assert.equal((await control.query('SELECT count(*) FROM control.inbox')).rows[0].count,'0');
  me.has_main_web_app=true;await control.groups.openSettings(control,'direct',-77101,1);
  assert.equal((await control.query("SELECT extra FROM control.outbox WHERE dedup_key='direct'")).rows[0].extra.reply_markup.inline_keyboard[0][0].url,'https://t.me/test_bot?startapp=group_77101');
  admins.delete(77002);
  assert.equal((await request(77002)).status,403);
  assert.equal((await request(77002,{method:'PUT',body:{version:1,settings}})).status,403,'revoked admin cannot reuse a valid Telegram session');
  await control.query("UPDATE control.tenants SET admission='blocked' WHERE user_id=77001");
  assert.equal((await request(77001)).status,403,'blocking the sponsor disables group settings too');
});
