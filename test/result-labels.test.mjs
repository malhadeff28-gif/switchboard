import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const functions=app.slice(app.indexOf('const viewedTurns='),app.indexOf('function chatView('));
function harness(draft){
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const context=vm.createContext({drafts:{read:()=>draft},name:p=>p==='claude'?'Claude':'Codex',esc,markdown:esc});vm.runInContext(functions,context);return context;
}
const card=decision=>({decision,summary:'Ready',options:[],claims:[],evidence:[]});
const turn=(id,origin,decision)=>({id,origin,provider:'codex',at:Date.UTC(2026,10,20,10),phase:'finished',analysis:'ready',card:card(decision)});
const chat={id:'event-seats',provider:'codex',status:'ready',turns:[turn('original-1','watched','Should we use reserved seats?'),turn('original-2','watched','How many tickets should we allow?'),turn('reply-3','managed',null)]};
test('result picker distinguishes original questions and Switchboard replies without changing IDs or order',()=>{
 const h=harness({text:''}),html=h.turnView(chat);
 assert.match(html,/Original chat · Codex/);assert.match(html,/Switchboard reply · Codex/);
 assert.match(html,/Should we use reserved seats\?/);assert.match(html,/How many tickets should we allow\?/);
 assert.ok(html.indexOf('value="reply-3"')<html.indexOf('value="original-2"'));assert.ok(html.indexOf('value="original-2"')<html.indexOf('value="original-1"'));
 assert.match(html,/value="reply-3" selected/);
 for(const t of chat.turns){const label=h.resultLabel(t);assert.ok(label.includes(new Date(t.at).toLocaleString()));assert.ok(label.includes('finished'));}
});
test('composer labels its actual draft result and preserves Show draft’s result and legacy anchors',()=>{
 const draft={text:'My decision',turnId:'original-1',provider:'claude'},h=harness(draft);
 vm.runInContext("viewedTurns.set('event-seats','reply-3')",h);
 const target=h.replyTarget(chat);assert.match(target,/Draft is for a different result/);assert.match(target,/title="Original chat · Codex.*Should we use reserved seats/);assert.match(target,/data-action="show-draft-result"/);assert.equal(h.replyAnchor(chat),'original-1');assert.equal(h.replyProvider(chat),'claude');
 assert.equal(h.replyTarget(chat),target);assert.equal(draft.turnId,'original-1');
 const legacy=harness({text:'Old draft'});assert.equal(legacy.replyAnchor(chat),null);assert.equal(legacy.replyTarget(chat),'Replying to the project.');
 const reply=harness({text:'Reply',turnId:'reply-3'});assert.equal(reply.replyTarget(chat),'');
});
test('stored question previews are concise, escaped, and optional',()=>{
 const malicious=turn('a"<','watched','<script>alert("x")</script> & '+('long question '.repeat(20))),other=turn('safe','managed',null);
 const c={...chat,turns:[malicious,other]},h=harness({text:'Draft',turnId:malicious.id});
 vm.runInContext("viewedTurns.set('event-seats','safe')",h);
 for(const html of [h.turnView(c),h.replyTarget(c)]){assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/&amp;/);assert.match(html,/…/);}
 assert.match(h.turnView(c),/value="a&quot;&lt;"/);
 assert.ok(h.resultLabel(malicious).endsWith('…'));assert.ok(!h.resultLabel(other).endsWith(' · '));
 assert.equal(h.resultLabel({...other,card:{decision:{bad:true}}}),h.resultLabel(other));
});
test('the report replaces its own conversation message and preserves both surrounding messages and full output',()=>{
 const report={...chat.turns[2],answer:'The full response',card:{...card(null),summary:'A shorter report'}};
 const messages=[
  {role:'user',text:'Question before the report',at:report.at-1},
  {role:'assistant',provider:'codex',text:report.answer,at:report.at+1},
  {role:'assistant',provider:'codex',text:report.answer,at:report.at+2000},
  {role:'user',text:'Question after the report',at:report.at+3000},
 ];
 const h=harness({text:''});
 for(const match of [{},{turnId:report.id}]){
   const c={...chat,turns:[report],messages:messages.map((m,i)=>i===1?{...m,...match}:m)};
   const html=h.conversation(c,report,'');
   assert.ok(html.indexOf('Question before the report')<html.indexOf('id="current-report"'));
   assert.ok(html.indexOf('Full response')<html.indexOf('Question after the report'));
   assert.equal(html.match(/The full response/g)?.length,2);
   assert.equal(html.match(/id="current-report"/g)?.length,1);
 }
 const watched={...chat.turns[0],answer:'Old original output',card:{...card(null),summary:'Old original output'}};
 const html=h.conversation({...chat,turns:[watched],messages:[{role:'assistant',provider:'codex',text:watched.answer,id:'source-'+watched.id,imported:true,at:watched.at}]},watched,'');
 assert.equal(html.match(/Old original output/g)?.length,1);
 assert.doesNotMatch(html,/Full response/);
});
