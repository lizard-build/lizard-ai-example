import test from 'node:test';import assert from 'node:assert/strict';
import {appCards,publicAppUrl,safeAppResult,appView} from '../src/apps.mjs';
test('app gallery groups a project into a friendly app and excludes other owners and workers',()=>{
  const service={userId:'me',status:'running',containerPort:3000,domain:'generated.eu.onlizard.com,shop.example.com',envVars:'SECRET',name:'web'};
  const cards=appCards({id:'p',name:'handmade-store'},[{...service,name:'api',domain:'api.example.com'},service,{...service,userId:'other',domain:'secret.example.com'}],'me',[{url:'https://shop.example.com',name:'Gift Shop',description:'Handmade gifts for every occasion.'}]);
  assert.equal(cards.length,1);assert.equal(cards[0].name,'Gift Shop');assert.equal(cards[0].url,'https://shop.example.com');assert.equal(cards[0].status,'ready');assert.equal(cards[0].envVars,undefined);
  assert.deepEqual(appCards({id:'p',name:'x'},[{...service,userId:'other'},{...service,containerPort:0}],'me'),[]);
  assert.equal(appCards({id:'p',name:'weather-app'},[{...service,deployStatus:'building'}],'me')[0].status,'updating');
});
test('gallery URLs cannot execute scripts or expose private addresses; API omits technical identifiers',()=>{
  for(const url of ['javascript:alert(1)','http://example.com','https://token:secret@example.com','https://127.0.0.1','https://10.0.0.1','https://localhost','https://host.internal','https://example.com:43127'])assert.equal(publicAppUrl(url),null);
  const data=safeAppResult({state:'connected',items:[{key:'project-id',name:'Hello',url:'https://hello.example.com?token=SECRET',description:'A simple app',status:'ready',envVars:'SECRET'},{key:'bad',name:'Bad',url:'javascript:alert(1)'}]});
  assert.equal(data.items.length,1);assert.equal(data.items[0].url,'https://hello.example.com');assert.equal(JSON.stringify(data).includes('SECRET'),false);
  assert.equal(appView({apps:{}}).state,'empty');
  const view=appView({apps:data,apps_request_seq:3,apps_done_seq:2});assert.equal(view.refreshing,true);assert.equal(view.items[0].key,undefined);
});
