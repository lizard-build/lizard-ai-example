'use strict';
const tg=window.Telegram?.WebApp, $=id=>document.getElementById(id);
const launchParam=new URLSearchParams(tg?.initData || '').get('start_param');
const groupContext=launchParam?.startsWith('group_')?launchParam:new URLSearchParams(window.location.search).get('group');
let groupSpace=false;
let saved, version, models=[], busy=false, dirty=false, conflict=false;
let appsTimer, appsAttempts=0, activePanel='apps', dataBusy=false, appsBusy=false;
const scrollPositions=new Map();
const ids=['agentsMd','model','effort','language','idleMinutes','streaming'];
const form=$('settings');
function notice(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);}
function value(){return {agentsMd:$('agentsMd').value,model:$('model').value,effort:$('effort').value,language:$('language').value,idleMinutes:Number($('idleMinutes').value),streaming:$('streaming').checked};}
function changed(){
  dirty=JSON.stringify(value())!==JSON.stringify(saved);
  const size=new TextEncoder().encode($('agentsMd').value).length;
  $('bytes').textContent=`${(size/1024).toFixed(1)} / 32 KB`;
  $('save').disabled=busy || !dirty || size>32768 || conflict;
  $('save-bar').hidden=!dirty; $('dirty-dot').hidden=!dirty;
  $('save-note').textContent=conflict?'Reload to review the latest settings.':dirty?(groupSpace?'Applies to the group’s next tasks':'Applies to your next task'):'No unsaved changes';
  if(tg?.isVersionAtLeast?.('6.2')) { if(dirty)tg.enableClosingConfirmation();else tg.disableClosingConfirmation(); }
}
function efforts(selected=''){
  const options=models.find(m=>m.id===$('model').value)?.efforts || [];
  $('effort').replaceChildren(new Option('Model default',''),...options.map(e=>new Option(e==='xhigh'?'Extra high':e[0].toUpperCase()+e.slice(1),e)));
  $('effort').value=options.includes(selected)?selected:'';
  $('effort').disabled=!options.length;
}
async function api(method,body,path='/api/settings'){
  const response=await fetch(path,{method,headers:{Authorization:`tma ${tg?.initData || ''}`,...(groupContext?{'X-Lizard-Group':groupContext}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const data=await response.json();
  if(!response.ok){const e=new Error(data.error || 'Could not save settings.');e.status=response.status;throw e;}
  return data;
}
function fill(data){
  groupSpace=data.scope?.kind==='group';
  if(groupSpace) {
    $('space-label').textContent='Group space';
    $('group-context').hidden=false;
    $('group-context').textContent=`${data.scope.name} · Shared group settings. Only admins can make changes. Your personal settings stay separate.`;
    $('apps-title').textContent='Group apps';$('apps-subtitle').textContent='Created in this group. Ready to use.';
    $('data-title').textContent='Group data';$('data-subtitle').textContent='Saved conversations and instructions for this group.';
    $('settings-subtitle').textContent='Shared preferences for everyone in this group.';
    $('instructions-title').textContent='Group instructions';$('data-instructions-title').textContent='Group instructions';
    $('instructions-scope').textContent='Applies to every topic in this group';
    $('agents-help').textContent='Set shared rules for how the assistant writes and works in this group.';
    $('sessions-help').textContent='Continue a saved conversation by mentioning the bot in that group topic.';
    $('sessions-empty').textContent='No saved chats yet. Mention the bot in the group to start.';
  }
  saved=data.settings;version=data.version;models=data.models;conflict=false;
  $('model').replaceChildren(new Option('Codex default',''),...models.map(m=>new Option(m.name,m.id)));
  // A formerly available model can remain visible until the user chooses another.
  if(saved.model && !models.some(m=>m.id===saved.model)) $('model').add(new Option(`${saved.model} (unavailable)`,saved.model));
  $('model').value=saved.model; efforts(saved.effort);
  $('agentsMd').value=saved.agentsMd;$('language').value=saved.language;$('streaming').checked=saved.streaming;
  const minutes=[...new Set([1,5,10,15,30,60,120,saved.idleMinutes,data.limits.idleMinutes])].filter(n=>n<=data.limits.idleMinutes).sort((a,b)=>a-b);
  $('idleMinutes').replaceChildren(...minutes.map(n=>new Option(`${n} min`,n)));$('idleMinutes').value=saved.idleMinutes;
  $('model-hint').textContent=models.length?(groupSpace?'Available models from this group’s Codex account.':'Available models from your Codex account.'):(groupSpace?'The connecting admin can sign in with /login in the group to load models.':'Sign in with /login and send a task to load available models.');
  $('state').textContent=stateLabels[data.environment.state] || 'Saved';
  $('state').classList.toggle('neutral',data.environment.state!=='running');
  form.hidden=false;$('reload').hidden=true;changed();
}
async function load(){
  if(!tg?.initData){notice('Open Settings from the Lizard AI bot in Telegram.',true);return;}
  notice('Loading your space…');
  try {fill(await api('GET'));notice('');if(activePanel==='apps')void loadApps();if(activePanel==='data')void loadData();}
  catch(e){notice(e.message || 'Could not load settings. Try again.',true);$('reload').hidden=false;}
}
form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy || !dirty || conflict)return;
  busy=true;changed();$('save').textContent='Saving…';notice('');
  // Freeze the form so edits during the request cannot be lost on success.
  const controls=[...$('preferences').querySelectorAll('input,textarea,select,button')], disabled=controls.map(c=>c.disabled);
  controls.forEach(c=>c.disabled=true);
  try {const data=await api('PUT',{version,settings:value()});fill(data);if(activePanel==='data')void loadData();notice(groupSpace?'Saved for this group. Its next tasks will use these settings.':'Saved. Your next task will use these settings.');tg?.HapticFeedback?.notificationOccurred('success');}
  catch(e){notice(e.message || 'Could not save. Your changes are still here.',true);if(e.status===409){conflict=true;$('reload').hidden=false;}}
  finally{controls.forEach((c,i)=>c.disabled=disabled[i]);busy=false;$('save').textContent='Save changes';efforts($('effort').value);changed();}
});
for(const id of ids) $(id).addEventListener('input',()=>{if(id==='model')efforts();changed();});
$('import').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  if(file.size>32768){notice('Choose a Markdown file under 32 KB.',true);return;}
  const text=await file.text();
  if($('agentsMd').value && !window.confirm('Replace these instructions with the file contents?'))return;
  $('agentsMd').value=text;changed();notice('Imported. Save changes to apply.');event.target.value='';
});
function renderApps(data){
  $('app-list').replaceChildren();
  const labels={ready:'Ready',updating:'Updating',paused:'Paused',attention:'Needs attention',preparing:'Getting ready'};
  for(const app of data.items){
    const card=document.createElement('article');card.className='app-card';
    const icon=document.createElement('div');icon.className='app-icon';icon.setAttribute('aria-hidden','true');icon.textContent=app.name.split(/\s+/).slice(0,2).map(w=>Array.from(w)[0]).join('').toUpperCase();
    const body=document.createElement('div');body.className='app-body';const title=document.createElement('h3');title.textContent=app.name;body.append(title);
    if(app.description){const description=document.createElement('p');description.textContent=app.description;body.append(description);}
    const bottom=document.createElement('div');bottom.className='app-bottom';const status=document.createElement('span');status.className='app-status '+(Object.hasOwn(labels,app.status)?app.status:'preparing');status.textContent=labels[app.status] || 'Getting ready';
    const open=document.createElement('button');open.type='button';open.className='open-app';open.textContent='Open ↗';open.setAttribute('aria-label',`Open ${app.name}`);
    open.addEventListener('click',()=>{if(tg?.openLink)tg.openLink(app.url);else window.open(app.url,'_blank','noopener,noreferrer');});
    bottom.append(status,open);body.append(bottom);card.append(icon,body);$('app-list').append(card);
  }
  $('apps-empty').hidden=data.items.length>0 || data.refreshing || data.state==='connect';
  $('refresh-apps').disabled=data.refreshing;
  $('refresh-apps').textContent=data.refreshing?'Updating…':'Refresh';
  $('apps-note').textContent=data.refreshing?'Updating your apps. This may take a moment.':data.state==='connect'?'Your publishing space is getting ready. Tap Refresh in a moment.':data.state==='unavailable'?'Could not update your apps. Try Refresh again.':data.partial?'Some apps could not be updated. Showing the last saved list.':'';
  $('apps-updated').textContent=data.updatedAt?'Last updated '+new Date(data.updatedAt).toLocaleString('en', {dateStyle:'medium',timeStyle:'short'}):'';
}
async function loadApps(refresh=false){
  clearTimeout(appsTimer);
  if(appsBusy)return;appsBusy=true;
  if(refresh){appsAttempts=0;$('refresh-apps').disabled=true;$('apps-note').textContent='Updating your apps…';}
  try {
    const data=await api(refresh?'POST':'GET',undefined,refresh?'/api/apps/refresh':'/api/apps');renderApps(data);
    if(activePanel==='apps' && data.refreshing && appsAttempts++<30)appsTimer=setTimeout(()=>{void loadApps();},3000);
    else if(data.refreshing)$('apps-note').textContent='Still updating. You can close this screen and check back later.';
  }catch(e){$('apps-note').textContent=e.message || 'Could not load your apps. Tap Refresh to try again.';$('refresh-apps').disabled=false;}
  finally{appsBusy=false;}
}
$('refresh-apps').addEventListener('click',()=>{void loadApps(true);});
const stateLabels={sleeping:'Paused',running:'Ready',starting:'Starting',stopping:'Pausing'};
async function loadData(){
  if(dataBusy)return;dataBusy=true;$('refresh-data').disabled=true;
  $('data-note').textContent='Loading your data…';
  try{
    const data=await api('GET',undefined,'/api/data');
    $('state').textContent=stateLabels[data.workspace] || 'Saved';
    $('state').classList.toggle('neutral',data.workspace!=='running');
    $('saved-instructions').textContent=data.instructionBytes?`${(data.instructionBytes/1024).toFixed(1)} KB`:'Not set';
    $('copy-instructions').disabled=!data.instructionBytes;
    $('session-count').textContent=`${data.total} total`;
    $('session-list').replaceChildren();
    for(const session of data.sessions){
      const row=document.createElement('div');row.className='session-row';
      const body=document.createElement('div'),title=document.createElement('h3'),date=document.createElement('time');
      title.textContent=session.title;date.dateTime=session.createdAt;date.textContent=new Date(session.createdAt).toLocaleDateString('en',{dateStyle:'medium'});
      body.append(title,date);const state=document.createElement('span');state.className='badge'+(session.archived?' neutral':'');state.textContent=session.archived?'Archived':'Active';
      row.append(body,state);$('session-list').append(row);
    }
    $('sessions-empty').hidden=data.total>0;$('session-list').hidden=!data.total;
    $('sessions-note').textContent=data.total>data.sessions.length?`Showing your ${data.sessions.length} newest chats. ${data.archived} archived.`:data.archived?`${data.archived} archived. History stays saved.`:'';
    $('member-since').textContent=data.joinedAt?'Your space since '+new Date(data.joinedAt).toLocaleDateString('en',{dateStyle:'medium'}):'';
    $('data-note').textContent='';
  }catch(e){$('data-note').textContent=e.message || 'Could not load your data. Tap Refresh to try again.';}
  finally{dataBusy=false;$('refresh-data').disabled=false;}
}
$('refresh-data').addEventListener('click',()=>{void loadData();});
$('copy-instructions').addEventListener('click',async()=>{
  // Fetch the saved version, even if another device changed it since this screen opened.
  $('copy-instructions').disabled=true;
  try{
    const {settings}=await api('GET');
    if(!settings.agentsMd){$('copy-note').textContent='No saved instructions yet. Add them in Settings.';return;}
    try{await navigator.clipboard.writeText(settings.agentsMd);$('copy-note').textContent='Copied.';}
    catch{$('copy-fallback').hidden=false;$('copy-fallback').value=settings.agentsMd;$('copy-fallback').focus();$('copy-fallback').select();$('copy-note').textContent='Select and copy your instructions below.';}
  }catch(e){$('copy-note').textContent=e.message || 'Could not load your instructions. Try again.';}
  finally{$('copy-instructions').disabled=false;}
});
function selectTab(button){
  scrollPositions.set(activePanel,$('content').scrollTop);
  activePanel=button.dataset.panel;clearTimeout(appsTimer);
  for(const tab of document.querySelectorAll('.tab')){
    const active=tab===button;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;$(tab.dataset.panel).hidden=!active;
  }
  $('content').scrollTop=scrollPositions.get(activePanel) || 0;
  if(!form.hidden){if(activePanel==='apps'){appsAttempts=0;void loadApps();}if(activePanel==='data')void loadData();}
  tg?.HapticFeedback?.selectionChanged();
}
for(const button of document.querySelectorAll('.tab')){
  button.addEventListener('click',()=>selectTab(button));
  button.addEventListener('keydown',event=>{
    const tabs=[...document.querySelectorAll('.tab')],index=tabs.indexOf(button);
    const next=event.key==='ArrowRight'?(index+1)%3:event.key==='ArrowLeft'?(index+2)%3:event.key==='Home'?0:event.key==='End'?2:-1;
    if(next>=0){event.preventDefault();tabs[next].focus();selectTab(tabs[next]);}
  });
}
for(const button of document.querySelectorAll('.back-to-chat'))button.addEventListener('click',()=>{
  if(!dirty || window.confirm('Close with unsaved settings?'))tg?.close();
});
// Keep native Telegram minimize gestures separate from scrolling the page.
if(tg?.isVersionAtLeast?.('7.7'))tg.disableVerticalSwipes();
if(tg?.isVersionAtLeast?.('6.1'))tg.setBackgroundColor('#070707');
if(tg?.isVersionAtLeast?.('6.9'))tg.setHeaderColor('#070707');
if(tg?.isVersionAtLeast?.('7.10'))tg.setBottomBarColor('#141414');
function resizeViewport(){
  // visualViewport follows the keyboard; a stable Telegram height keeps the bar
  // from jumping while the WebView expands. CSS owns safe-area padding.
  const heights=[tg?.viewportStableHeight,window.visualViewport?.height,window.innerHeight].filter(n=>Number.isFinite(n)&&n>0);
  document.documentElement.style.setProperty('--app-height',`${Math.min(...heights)}px`);
}
window.addEventListener('resize',resizeViewport);window.visualViewport?.addEventListener('resize',resizeViewport);
tg?.onEvent?.('viewportChanged',resizeViewport);resizeViewport();
// Preserve single-finger scroll and text selection; block only zoom gestures.
for(const name of ['gesturestart','gesturechange'])document.addEventListener(name,event=>event.preventDefault(),{passive:false});
document.addEventListener('touchmove',event=>{if(event.touches.length>1)event.preventDefault();},{passive:false});
document.addEventListener('wheel',event=>{if(event.ctrlKey)event.preventDefault();},{passive:false});
$('reload').addEventListener('click',()=>{if(!dirty || window.confirm('Discard unsaved changes and reload?'))void load();});
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
if(groupContext)selectTab($('tab-preferences'));
tg?.ready();tg?.expand();void load();
