import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const functions=app.slice(app.indexOf('const viewedTurns='),app.indexOf('function chatView('));
function harness({decision='Use a waitlist?',analysis='ready',status='ready'}={}){
 const focused=[],scrolled=[];
 const heading={dataset:{decisionResult:'shown',decisionProject:'project'},getBoundingClientRect:()=>({top:680}),focus:options=>focused.push(options)};
 const pane={scrollTop:60,getBoundingClientRect:()=>({top:300}),scrollTo:options=>scrolled.push(options),querySelectorAll:()=>[heading]};
 const evidence={id:'stable-evidence',label:'Verified source',text:'Full evidence'};
 const card={summary:'Full outcome with a link',decision,decisionFormatValid:decision===null,options:[{label:'Waitlist',tradeoff:'Requires tracking'}],claims:[{text:'Full claim',sources:['stable-evidence']}],evidence:[evidence]};
 const chat={id:'project',provider:'codex',status,turns:[{id:'shown',origin:'watched',provider:'codex',at:1,phase:'finished',analysis,card}]};
 const context=vm.createContext({state:{chats:[chat]},selected:'project',drafts:{read:()=>({text:''})},name:()=> 'Codex',esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),markdown:s=>s,$:id=>id==='thread'?pane:null});
 vm.runInContext(functions,context);
 return {context,chat,pane,heading,focused,scrolled};
}
test('actual decision has a keyboard jump above outcome and choices before evidence, preserving evidence IDs and tradeoffs',()=>{
 const h=harness(),html=h.context.turnView(h.chat);
 assert.match(html,/<button type="button"[^>]*data-jump-decision="shown"[^>]*aria-controls="decision-project-shown"[^>]*>Jump to decision/);
 assert.match(html,/id="decision-project-shown" tabindex="-1" data-decision-result="shown"/);
 assert.ok(html.indexOf('Jump to decision')<html.indexOf('What happened'));
 assert.ok(html.indexOf('Full outcome')<html.indexOf('Use a waitlist?'));
 assert.ok(html.indexOf('Full claim')<html.indexOf('Use a waitlist?'));
 assert.ok(html.indexOf('data-choice="0"')<html.indexOf('<h3>Evidence'));
 assert.match(html,/Requires tracking/);assert.match(html,/data-evidence="e-project-stable-evidence"/);assert.match(html,/details id="e-project-stable-evidence"/);assert.match(html,/Full evidence/);
 const busy=harness({status:'running'});assert.match(busy.context.turnView(busy.chat),/data-choice="0"[^>]*disabled/);
});
test('no jump for absent/unverified decisions; original source questions still have a jump',()=>{
 for(const options of [{decision:null},{decision:''},{analysis:'queued'},{analysis:'error'}]){const h=harness(options);assert.doesNotMatch(h.context.turnView(h.chat),/data-jump-decision/);}
 const h=harness({analysis:'source'});assert.match(h.context.turnView(h.chat),/Jump to decision/);assert.match(h.context.turnView(h.chat),/Decision from the original response/);
});
test('jump targets shown result only, scrolls existing pane and focuses heading without touching drafts',()=>{
 const h=harness(),before=JSON.stringify(h.chat),button={dataset:{jumpProject:'project',jumpDecision:'shown'}};
 h.context.jumpToDecision(button);assert.equal(h.scrolled.length,1);assert.equal(h.scrolled[0].top,428);assert.equal(h.scrolled[0].behavior,'auto');assert.equal(h.focused[0].preventScroll,true);assert.equal(JSON.stringify(h.chat),before);
 h.context.jumpToDecision({dataset:{jumpProject:'other-project',jumpDecision:'shown'}});h.context.jumpToDecision({dataset:{jumpProject:'project',jumpDecision:'old-result'}});assert.equal(h.scrolled.length,1);
 h.heading.dataset.decisionResult='stale';h.context.jumpToDecision(button);assert.equal(h.scrolled.length,1);
});
