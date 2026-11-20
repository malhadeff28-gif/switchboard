import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const apiSource=app.slice(app.indexOf('const workspaceMismatchMessage='),app.indexOf('function saveDraft('));
const eventsSource=app.slice(app.indexOf('events.onmessage='));
function harness(responses=[]){
 const calls=[],renders=[],closed=[],toasts=[];
 const state={workspace:'old-workspace',chats:[{id:'same-project'}]},draft={text:'Saved read-only draft',provider:'codex',turnId:'old-result'};
 const context=vm.createContext({state,selected:'same-project',token:'old-token',draft,renderTimer:null,render:()=>renders.push(true),fetch:async(route,options)=>{calls.push({route,options});const response=responses.shift();if(!response)throw Error('Unexpected request');return {status:response.status,ok:response.status>=200&&response.status<300,json:async()=>response.body};},events:{close:()=>closed.push(true)},toast:text=>toasts.push(text),clearTimeout(){},setTimeout:fn=>{fn();return 1;},updateConnectionCards(){}});
 vm.runInContext(apiSource+'\n'+eventsSource,context);return {context,calls,renders,closed,toasts,state,draft};
}
test('SSE workspace swap leaves old selection/draft intact with persistent accessible recovery and mutation block',async()=>{
 const h=harness(),before=JSON.stringify(h.draft);
 h.context.events.onmessage({data:JSON.stringify({workspace:'different-workspace',chats:[{id:'same-project',title:'Different clone'}]})});
 assert.equal(h.context.state.workspace,'old-workspace');assert.equal(h.context.selected,'same-project');assert.equal(JSON.stringify(h.draft),before);assert.equal(h.closed.length,1);assert.equal(h.renders.length,1);
 const html=h.context.workspaceStatus();assert.match(html,/role="alert"/);assert.match(html,/different workspace/);assert.match(html,/data-action="reload-workspace"/);assert.equal(h.context.workspaceStatus(),html);
 await assert.rejects(h.context.api('/api/chats/same-project/send',{text:'Saved read-only draft'}),/different Switchboard workspace/);assert.equal(h.calls.length,0);
 h.context.events.onerror();assert.deepEqual(h.toasts,[]);
 h.context.markWorkspaceMismatch();assert.equal(h.renders.length,1);
});
test('mutation token refresh uses same persistent mismatch state and never retries in foreign workspace',async()=>{
 const h=harness([{status:403,body:{error:'Refresh Switchboard before continuing.'}},{status:200,body:{workspace:'foreign',token:'foreign-token'}}]);
 await assert.rejects(h.context.api('/api/chats/same-project/send',{text:'Draft'}),/different Switchboard workspace/);
 assert.equal(h.context.state.workspaceMismatch,true);assert.equal(h.calls.length,2);assert.equal(vm.runInContext('token',h.context),'old-token');assert.equal(h.renders.length,1);assert.match(h.context.workspaceStatus(),/Reload workspace/);
});
test('ordinary same-workspace refresh and reconnect retain prior behavior without warning',async()=>{
 const h=harness([{status:403,body:{error:'Refresh Switchboard before continuing.'}},{status:200,body:{workspace:'old-workspace',token:'refreshed-token'}},{status:202,body:{accepted:true}}]);
 const response=await h.context.api('/api/chats/same-project/send',{text:'Draft'});assert.equal(response.accepted,true);assert.equal(h.calls.length,3);assert.equal(h.calls[2].options.headers['X-Switchboard-Token'],'refreshed-token');assert.equal(h.context.workspaceStatus(),'');
 h.context.events.onerror();assert.match(h.context.workspaceStatus(),/Reconnecting to local Switchboard/);assert.deepEqual(h.toasts,[]);
 h.context.events.onmessage({data:JSON.stringify({workspace:'old-workspace',chats:[{id:'same-project',title:'Updated'}]})});assert.equal(h.closed.length,0);assert.equal(h.context.state.chats[0].title,'Updated');assert.equal(h.context.workspaceStatus(),'');
});
test('known mismatch disables Send while preserving editable draft and blocks programmatic composer submission',async()=>{
 const h=harness(),c={id:'same-project',title:'Trail',provider:'codex',status:'ready',permission:'read',messages:[]};
 Object.assign(h.context,{switchingProvider:new Set(),sending:false,autoAdvance:false,name:()=> 'Codex',esc:s=>String(s??''),icon:()=>'',visibleTurn:()=>null,replyProvider:()=> 'codex',replyConnectionNotice:()=>'',usageLabel:()=>'',turnStatus:()=>'',editOverlapNotice:()=>'',watchedResultToReview:()=>null,watchedResultNotice:()=>'',turnView:()=>'',replyTarget:()=> 'Original result',drafts:{read:()=>h.draft}});
 const chatView=app.slice(app.indexOf('function chatView('),app.indexOf('function savedDecisions('));vm.runInContext(chatView,h.context);
 h.context.state.workspaceReconnecting=true;assert.doesNotMatch(h.context.chatView(c),/class="send-button"[^>]*disabled/);h.context.state.workspaceMismatch=true;
 const html=h.context.chatView(c);assert.match(html,/class="send-button"[^>]*disabled/);assert.match(html,/Saved read-only draft/);assert.doesNotMatch(html,/<textarea id="prompt"[^>]*disabled/);
 const submit=app.slice(app.indexOf('async function submitPrompt('),app.indexOf('async function saveIdea('));vm.runInContext(submit,h.context);await h.context.submitPrompt({preventDefault(){}});assert.equal(h.calls.length,0);
});
test('repeated outage errors show one persistent reconnect state; same-workspace SSE recovers without resend',async()=>{
 const h=harness(),before=JSON.stringify(h.draft);
 h.context.events.onerror();h.context.events.onerror();assert.equal(h.renders.length,1);assert.match(h.context.workspaceStatus(),/role="status"/);assert.match(h.context.workspaceStatus(),/Reconnecting to local Switchboard/);assert.deepEqual(h.toasts,[]);
 h.context.fetch=async()=>{h.calls.push('failed');throw TypeError('Failed to fetch');};
 await assert.rejects(h.context.api('/api/chats/same-project/send',{text:h.draft.text}),/Could not reach local Switchboard.*Your draft is saved/);
 assert.equal(h.renders.length,1);assert.equal(h.calls.length,1);assert.equal(JSON.stringify(h.draft),before);assert.equal(h.context.selected,'same-project');
 h.context.events.onmessage({data:JSON.stringify({workspace:'old-workspace',chats:[{id:'same-project'}]})});assert.equal(h.context.workspaceStatus(),'');assert.equal(h.calls.length,1);assert.equal(JSON.stringify(h.draft),before);
});
test('fetch-only outage gets app feedback and mismatch takes precedence over reconnect status',async()=>{
 const h=harness();h.context.fetch=async()=>{throw TypeError('Load failed');};
 await assert.rejects(h.context.api('/api/chats/same-project/send',{text:h.draft.text}),/Could not reach local Switchboard/);assert.match(h.context.workspaceStatus(),/Reconnecting/);assert.equal(h.renders.length,1);
 h.context.markWorkspaceMismatch();const warning=h.context.workspaceStatus();assert.match(warning,/different workspace/);assert.doesNotMatch(warning,/Reconnecting/);h.context.events.onerror();assert.equal(h.renders.length,2);assert.equal(h.context.workspaceStatus(),warning);
});
test('an SSE interruption does not block a deliberate HTTP retry that still works',async()=>{
 const h=harness([{status:202,body:{accepted:true}}]);h.context.events.onerror();
 const response=await h.context.api('/api/chats/same-project/send',{text:h.draft.text});assert.equal(response.accepted,true);assert.equal(h.calls.length,1);assert.match(h.context.workspaceStatus(),/Reconnecting/);
});
