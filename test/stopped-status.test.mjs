import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const functions=app.slice(app.indexOf('const viewedTurns='),app.indexOf('function savedDecisions('));
const row=app.slice(app.indexOf('function projectStatus('),app.indexOf('function projectPicker('));
function harness(error){
 const draft={text:'Keep my draft',turnId:'partial',provider:'codex'};
 const card={summary:'Partial watering schedule',decision:null,options:[],claims:[],evidence:[]};
 const chat={id:'watering',title:'Watering Schedule',cwd:'/tmp/watering',provider:'codex',status:'ready',permission:'read',error,messages:[{role:'assistant',text:'Partial output retained',provider:'codex'}],turns:[{id:'old',provider:'codex',origin:'managed',phase:'finished',at:1,card},{id:'partial',provider:'codex',origin:'managed',phase:'interrupted',at:2,card}]};
 const context=vm.createContext({state:{chats:[chat]},selected:chat.id,drafts:{read:()=>draft},name:()=> 'Codex',esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;'),markdown:s=>s,switchingProvider:new Set(),sending:false,autoAdvance:false,icon:()=>'',usageLabel:()=>''});
 vm.runInContext(functions+'\n'+row,context);
 return {context,chat,draft};
}
test('explicit user stop renders a neutral next step and preserves partial results, picker and draft',()=>{
 for(const error of ['You stopped this turn.','You stopped this demo turn.']){
  const h=harness(error),before=JSON.stringify(h.chat),html=h.context.chatView(h.chat);
  assert.match(html,/class="notice" role="status"/);assert.match(html,/Turn stopped/);assert.match(html,/send a new prompt to continue/);
  assert.doesNotMatch(html,/This turn needs attention|Start a fresh|data-action="reset-session"|class="error-card"/);
  assert.match(html,/id="which-turn"/);assert.match(html,/value="partial" selected/);assert.match(html,/Partial output retained/);assert.match(html,/Partial watering schedule/);assert.match(html,/Keep my draft/);
  assert.doesNotMatch(html,/<textarea id="prompt"[^>]*disabled/);assert.match(h.context.row(h.chat),/Reply stopped/);assert.doesNotMatch(h.context.row(h.chat),/Needs attention/);
  assert.equal(JSON.stringify(h.chat),before);assert.equal(h.draft.turnId,'partial');assert.equal(h.context.replyAnchor(h.chat),'partial');
 }
});
test('auth and genuine failures retain existing recovery actions and escaped details',()=>{
 for(const error of ['OAuth token expired','Provider failed <unsafe>','Process stopped unexpectedly']){
  const h=harness(error),html=h.context.chatView(h.chat);
  assert.match(html,/class="error-card"/);assert.match(html,/This turn needs attention/);assert.match(html,/data-action="reset-session"/);assert.match(h.context.row(h.chat),/Needs attention/);assert.doesNotMatch(html,/Turn stopped\./);
  if(error.startsWith('OAuth'))assert.match(html,/data-action="connections"/);else assert.doesNotMatch(html,/data-action="connections"/);
  assert.doesNotMatch(html,/<unsafe>/);
 }
 const sameText=harness('You stopped this turn.');
 sameText.chat.turns.at(-1).phase='failed';
 assert.match(sameText.context.chatView(sameText.chat),/This turn needs attention/);
 const h=harness(null);assert.equal(h.context.turnStatus(h.chat),'');assert.match(h.context.row(h.chat),/· Ready/);
});
