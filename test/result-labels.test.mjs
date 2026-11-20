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
 const target=h.replyTarget(chat);assert.match(target,/Sending to Claude about Original chat · Codex/);assert.match(target,/Should we use reserved seats/);assert.match(target,/data-action="show-draft-result"/);assert.equal(h.replyAnchor(chat),'original-1');
 assert.equal(h.replyTarget(chat),target);assert.equal(draft.turnId,'original-1');
 const legacy=harness({text:'Old draft'});assert.equal(legacy.replyAnchor(chat),null);assert.equal(legacy.replyTarget(chat),'Sending to Codex for this project');
 const reply=harness({text:'Reply',turnId:'reply-3'});assert.match(reply.replyTarget(chat),/about Switchboard reply · Codex/);
});
test('stored question previews are concise, escaped, and optional',()=>{
 const malicious=turn('a"<','watched','<script>alert("x")</script> & '+('long question '.repeat(20))),other=turn('safe','managed',null);
 const c={...chat,turns:[malicious,other]},h=harness({text:'Draft',turnId:malicious.id});
 for(const html of [h.turnView(c),h.replyTarget(c)]){assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/&amp;/);assert.match(html,/…/);}
 assert.match(h.turnView(c),/value="a&quot;&lt;"/);
 assert.ok(h.resultLabel(malicious).endsWith('…'));assert.ok(!h.resultLabel(other).endsWith(' · '));
 assert.equal(h.resultLabel({...other,card:{decision:{bad:true}}}),h.resultLabel(other));
});
