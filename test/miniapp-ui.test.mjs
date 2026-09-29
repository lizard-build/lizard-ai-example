import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { defaults } from '../src/settings.mjs';
const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
const script=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
async function setup(t,{oldClient=false}={}){
  const dom=new JSDOM(html,{url:'https://miniapp.example/settings',runScripts:'outside-only',pretendToBeVisual:true});
  t.after(()=>dom.window.close());
  const w=dom.window,calls=[],requests=[],errors=[];
  w.addEventListener('error',e=>errors.push(e.error));
  w.TextEncoder=TextEncoder;
  w.Telegram={WebApp:{initData:'signed-test',viewportStableHeight:740,isVersionAtLeast:()=>!oldClient,
    disableVerticalSwipes:()=>calls.push('disable-swipes'),setBackgroundColor(){},setHeaderColor(){},setBottomBarColor(){},
    enableClosingConfirmation:()=>calls.push('confirm-close'),disableClosingConfirmation(){},onEvent(){},ready(){},expand(){},HapticFeedback:{selectionChanged(){},notificationOccurred(){}}}};
  const state={settings:defaults(),version:0,models:[{id:'test-model',name:'Test model',efforts:['low','high']}],limits:{idleMinutes:30},environment:{state:'sleeping'}};
  let conflict=false;
  w.fetch=async(path,options)=>{
    requests.push({path,method:options.method});
    if(path==='/api/settings' && options.method==='PUT'){
      if(conflict)return {ok:false,status:409,json:async()=>({error:'Settings changed elsewhere. Reload before saving.'})};
      const body=JSON.parse(options.body);state.settings=body.settings;state.version++;
    }
    const data=path==='/api/settings'?state:path==='/api/apps'?{state:'empty',items:[],refreshing:false}:{workspace:'sleeping',instructionBytes:Buffer.byteLength(state.settings.agentsMd),sessions:[{title:'<script>private task</script>',archived:false,createdAt:'2026-09-23T00:00:00Z'}],total:1,archived:0};
    return {ok:true,json:async()=>structuredClone(data)};
  };
  w.eval(script);await settle();
  return {w,$:id=>w.document.getElementById(id),calls,requests,errors,setConflict:()=>{conflict=true;}};
}
test('bottom tabs retain edits and scroll, save from another tab, and render private titles as text',async t=>{
  const {w,$,requests,errors}=await setup(t);
  assert.equal($('language').value,'auto');
  assert.equal($('apps').hidden,false);assert.equal($('preferences').hidden,true);
  assert.equal(w.document.querySelectorAll('[role=tab]').length,3);
  $('tab-preferences').click();
  $('content').scrollTop=250;
  $('agentsMd').value='Keep my personal rules';$('agentsMd').dispatchEvent(new w.Event('input'));
  assert.equal($('save-bar').hidden,false);
  $('tab-data').click();await settle();
  assert.equal($('save-bar').hidden,false);
  assert.equal($('session-list').querySelector('script'),null);
  assert.equal($('session-list').querySelector('h3').textContent,'<script>private task</script>');
  $('tab-preferences').click();assert.equal($('content').scrollTop,250);assert.equal($('agentsMd').value,'Keep my personal rules');
  $('tab-data').click();$('save').click();await settle();
  assert.equal($('save-bar').hidden,true);
  assert.equal(requests.filter(r=>r.path==='/api/settings'&&r.method==='PUT').length,1);
  assert.deepEqual(errors,[]);
});
test('Telegram swipe dismissal and pinch zoom are blocked without blocking one-finger scroll',async t=>{
  const {w,calls}=await setup(t);
  assert.ok(calls.includes('disable-swipes'));
  const touch=n=>{const event=new w.Event('touchmove',{cancelable:true});Object.defineProperty(event,'touches',{value:Array(n).fill({})});w.document.dispatchEvent(event);return event.defaultPrevented;};
  assert.equal(touch(1),false);assert.equal(touch(2),true);
  const gesture=new w.Event('gesturestart',{cancelable:true});w.document.dispatchEvent(gesture);assert.equal(gesture.defaultPrevented,true);
  const wheel=new w.WheelEvent('wheel',{ctrlKey:true,cancelable:true});w.document.dispatchEvent(wheel);assert.equal(wheel.defaultPrevented,true);
  const old=await setup(t,{oldClient:true});assert.equal(old.calls.includes('disable-swipes'),false);assert.deepEqual(old.errors,[]);
});
test('stale save keeps the draft and keyboard tabs switch without submitting',async t=>{
  const {w,$,setConflict}=await setup(t);
  $('tab-apps').dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
  assert.equal($('tab-preferences').getAttribute('aria-selected'),'true');
  $('agentsMd').value='Keep this draft';$('agentsMd').dispatchEvent(new w.Event('input'));
  setConflict();$('save').click();await settle();
  assert.equal($('agentsMd').value,'Keep this draft');assert.equal($('save').disabled,true);assert.equal($('reload').hidden,false);
});
