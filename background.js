const DEFAULTS={minutes:60,endAt:0,startedAt:0,tabId:null,url:'',title:'',videoLock:true,hardLock:false};
let queue=Promise.resolve(),switching=false;
async function inject(tabId){try{await chrome.scripting.executeScript({target:{tabId,allFrames:true},files:['content.js']});await chrome.scripting.executeScript({target:{tabId,allFrames:true},world:'MAIN',func:()=>{if(window.__focusPauseGuard)return;window.__focusPauseGuard=true;const native=HTMLMediaElement.prototype.pause;HTMLMediaElement.prototype.pause=function(){const until=Number(document.documentElement?.getAttribute('data-focus-until'));if(this instanceof HTMLVideoElement&&this.dataset.focusStarted==='1'&&until>Date.now()&&!this.ended)return;return native.call(this);};}});}catch{}}
function serial(fn){const next=queue.then(fn,fn);queue=next.catch(()=>{});return next;}
async function readState(){const s={...DEFAULTS,...await chrome.storage.local.get(Object.keys(DEFAULTS))};s.hardLock=false;if(![60,120].includes(s.minutes)){s.minutes=60;await chrome.storage.local.set({minutes:60});}return s;}
function minutesValue(v){const n=Number(v);if(![60,120].includes(n))throw new Error('Choose 1 hour or 2 hours.');return n;}
function escapeRegex(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
async function rulesFor(state){
 const old=await chrome.declarativeNetRequest.getDynamicRules();
 const rules=state.endAt>Date.now()?[
 {id:1,priority:1,action:{type:'redirect',redirect:{extensionPath:'/blocked.html'}},condition:{urlFilter:'*',resourceTypes:['main_frame']}},
 {id:2,priority:2,action:{type:'allow'},condition:{regexFilter:'^'+escapeRegex(state.url.split('#')[0])+'$',isUrlFilterCaseSensitive:true,resourceTypes:['main_frame']}}
 ]:[];
 if(JSON.stringify(old)!==JSON.stringify(rules))await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:old.map(r=>r.id),addRules:rules});
}
async function stop(force=false){const current=await readState();if(!force&&current.endAt>Date.now())throw new Error('No early end. Focus ends with the video or timer.');await rulesFor(DEFAULTS);await chrome.storage.local.set({endAt:0,startedAt:0,tabId:null,url:'',title:''});await chrome.alarms.clear('focus-end');await chrome.action.setBadgeText({text:''});await chrome.action.setPopup({popup:''});return readState();}
async function reconcile(){let s=await readState();if(s.endAt){let tab;try{tab=await chrome.tabs.get(s.tabId);}catch{}if(s.endAt<=Date.now())return stop(true);if(!tab){if(s.hardLock){tab=await chrome.tabs.create({url:s.url,active:true});s.tabId=tab.id;await chrome.storage.local.set({tabId:tab.id});}else return stop(true);}}await rulesFor(s);await chrome.action.setPopup({popup:s.endAt>Date.now()?'popup.html':''});await chrome.action.setBadgeBackgroundColor({color:'#b58cff'});await chrome.action.setBadgeText({text:s.endAt>Date.now()?'ON':''});if(s.endAt>Date.now())await chrome.alarms.create('focus-end',{when:s.endAt});return s;}
async function start(tab,minutes){let s=await reconcile();if(s.endAt>Date.now())return s;if(!tab?.id||!/^https?:\/\//.test(tab.url||''))throw new Error('Open the study webpage, then click Focus Timer.');if(tab.url.length>1500)throw new Error('This page URL is too long to lock. Open a shorter study link.');
 const url=new URL(tab.url);if(url.username||url.password)throw new Error('Open a webpage without credentials in its URL.');
 s={...s,minutes:minutesValue(minutes||s.minutes),startedAt:Date.now(),endAt:Date.now()+minutesValue(minutes||s.minutes)*60000,tabId:tab.id,url:tab.url,title:tab.title||url.hostname};
 const support=await chrome.declarativeNetRequest.isRegexSupported({regex:'^'+escapeRegex(s.url.split('#')[0])+'$',isCaseSensitive:true});if(!support.isSupported)throw new Error('Chrome cannot lock this URL. Try another study page.');
 await rulesFor(s);await chrome.storage.local.set(s);await chrome.alarms.create('focus-end',{when:s.endAt});await chrome.action.setPopup({popup:'popup.html'});await chrome.action.setBadgeText({text:'ON'});await chrome.action.setBadgeBackgroundColor({color:'#b58cff'});
 await inject(tab.id);try{await chrome.tabs.sendMessage(tab.id,{type:'REFRESH'});}catch{}
 return s;
}
function escapePage(url){return /^chrome:\/\/extensions(?:\/|$)/.test(url||'');}
async function enforce(){const s=await readState();if(!s.endAt)return;if(s.endAt<=Date.now()){await stop(true);return;}let target;try{target=await chrome.tabs.get(s.tabId);}catch{await reconcile();return;}if(target.splitViewId!==undefined&&target.splitViewId!==chrome.tabs.SPLIT_VIEW_ID_NONE&&chrome.tabs.unsplit){try{await chrome.tabs.unsplit(target.splitViewId);}catch{}}const focused=await chrome.windows.getLastFocused();const selected=await chrome.tabs.query({active:true,windowId:focused.id});if(selected[0]?.id!==s.tabId&&!(escapePage(selected[0]?.url)||escapePage(selected[0]?.pendingUrl))){await chrome.tabs.update(s.tabId,{active:true});await chrome.windows.update(target.windowId,{focused:true});}}
async function returnToStudy(){const s=await reconcile();if(!s.endAt)return s;try{const tab=await chrome.tabs.get(s.tabId);await chrome.tabs.update(s.tabId,{active:true});await chrome.windows.update(tab.windowId,{focused:true});}catch{/* A transient tab/window error must not clear a running session. */}return s;}
chrome.action.onClicked.addListener(tab=>serial(async()=>{try{const s=await readState();await start(tab);await chrome.action.openPopup();}catch(e){await chrome.action.setPopup({popup:'popup.html'});await chrome.storage.local.set({lastError:e.message});try{await chrome.action.openPopup();}catch{}}}));
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
 if(sender.id!==chrome.runtime.id)return false;
 serial(async()=>{
  switch(m.type){
   case 'GET':{const state=await reconcile();return {state,isTarget:sender.tab?.id===state.tabId};}
   case 'STOP':return {state:await stop()};
   case 'VIDEO_ENDED':{const s=await readState();if(sender.tab?.id===s.tabId&&!m.isAd)return {state:await stop(true)};return {state:s};}
   case 'ENFORCE':await enforce();return {state:await readState()};
   case 'RETURN':return {state:await returnToStudy()};
   case 'SAVE':{const s=await reconcile();if(s.endAt)throw new Error('End focus before changing the duration.');await chrome.storage.local.set({minutes:minutesValue(m.minutes),hardLock:false});return {state:await readState()};}
   case 'CONFIRM_START':{const p=await chrome.storage.local.get('pendingTab');const tab=await chrome.tabs.get(p.pendingTab);return {state:await start(tab)};}
   case 'START':{const tabs=await chrome.tabs.query({active:true,currentWindow:true});return {state:await start(tabs[0],m.minutes)};}
   default:throw new Error('Unknown action.');
  }
 }).then(r=>respond({ok:true,...r}),e=>respond({ok:false,error:e.message}));return true;
});
// Selection enforcement takes a fast independent path, never waiting behind injection/rule updates.
async function fastReturn(info){try{const s=await readState();if(!s.endAt||s.endAt<=Date.now()||info.tabId===s.tabId)return;const selected=await chrome.tabs.get(info.tabId);if(escapePage(selected.url)||escapePage(selected.pendingUrl))return;const target=await chrome.tabs.get(s.tabId);await chrome.tabs.update(s.tabId,{active:true});await chrome.windows.update(target.windowId,{focused:true});}catch{/* Keep durable lock on transient browser errors. */}}
chrome.tabs.onActivated.addListener(info=>{fastReturn(info);});
chrome.tabs.onUpdated.addListener((id,change)=>{if(!change.url&&change.status!=='complete'&&change.splitViewId===undefined)return;serial(async()=>{const s=await readState();if(!s.endAt)return;if(s.endAt<=Date.now()){await stop();return;}if(change.splitViewId!==undefined)await enforce();if(id===s.tabId&&change.status==='complete')await inject(id);if(id===s.tabId&&change.url&&change.url!==s.url)try{await chrome.tabs.update(id,{url:s.url});}catch{/* Keep lock state on navigation errors. */}});});
chrome.tabs.onRemoved.addListener(id=>serial(async()=>{const s=await readState();if(s.tabId===id){if(s.hardLock&&s.endAt>Date.now()){const tab=await chrome.tabs.create({url:s.url,active:true});await chrome.storage.local.set({tabId:tab.id});}else await stop(true);}}));
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='focus-end')serial(reconcile);});
chrome.runtime.onStartup.addListener(()=>serial(reconcile));chrome.runtime.onInstalled.addListener(()=>serial(reconcile));serial(reconcile);

chrome.windows.onFocusChanged.addListener(id=>{if(id!==chrome.windows.WINDOW_ID_NONE)chrome.tabs.query({active:true,windowId:id}).then(t=>t[0]&&fastReturn({tabId:t[0].id})).catch(()=>{});});
chrome.tabs.onHighlighted.addListener(info=>{if(info.tabIds[0])fastReturn({tabId:info.tabIds[0]});});
chrome.tabs.onAttached.addListener(()=>serial(enforce));
