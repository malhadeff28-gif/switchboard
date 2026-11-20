import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {readableText} from '../public/readable.js';
import {editDraft,choiceText,sameDraft} from '../public/drafts.js';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const functions=app.slice(app.indexOf('const viewedTurns='),app.indexOf('function chatView('));
const save=app.slice(app.indexOf('function saveDraft('),app.indexOf('function choose('));
function harness(initial={text:''}){
 let draft={...initial};const renders=[],toasts=[];
 const old={id:'old-original',origin:'watched',at:1,provider:'codex',phase:'finished',analysis:'ready',card:{summary:'Old result',decision:'Which order?',claims:[],evidence:[],options:[{label:'Keep urgent cards first',tradeoff:'More scanning'}]}};
 const newer={id:'new-original',origin:'watched',at:2,provider:'codex',card:{options:[{label:'Show footer legend',tradeoff:'Uses space'}]}};
 const chat={id:'project',provider:'claude',status:'ready',displayTurn:newer.id,turns:[old,newer]};
 const nodes={composer:{dataset:{project:'project',result:old.id,provider:'codex',draft:JSON.stringify(initial)}},prompt:{value:'',focus(){this.focused=true;}},'reply-target':{innerHTML:''},'watched-result-notice':{innerHTML:''}};
 const context=vm.createContext({readableText,state:{chats:[chat]},selected:chat.id,sending:false,drafts:{read:()=>draft,write:(id,value)=>draft=value},editDraft,choiceText,sameDraft,crypto:{randomUUID:()=> 'stable-draft'},name:p=>p==='claude'?'Claude':'Codex',esc:s=>String(s??''),$:id=>nodes[id],render:()=>renders.push(true),toast:text=>toasts.push(text)});
 vm.runInContext(save+'\n'+functions,context);
 const button={dataset:{choice:'0',choiceProject:chat.id,choiceResult:old.id,choiceProvider:'codex',choiceOption:JSON.stringify([old.card.options[0].label,old.card.options[0].tradeoff])}};
 return {context,chat,old,newer,nodes,button,renders,toasts,get draft(){return draft;},set draft(value){draft=value;}};
}
test('stale displayed option binds rendered result and provider after SSE updates active state',()=>{
 const h=harness();h.context.stageRenderedChoice(h.button);
 assert.equal(h.draft.turnId,'old-original');assert.equal(h.draft.provider,'codex');assert.equal(h.draft.text,'Use option 1: Keep urgent cards first. More scanning');assert.equal(h.draft.choice.label,'Keep urgent cards first');assert.equal(h.nodes.prompt.focused,true);
});
test('first typing on stale displayed result binds rendered result/provider, while existing older and legacy drafts keep anchors',()=>{
 const h=harness();h.nodes.prompt.value='My typed answer';h.context.handlePromptInput({target:h.nodes.prompt});assert.equal(h.draft.turnId,'old-original');assert.equal(h.draft.provider,'codex');assert.equal(h.renders.length,0);
 for(const initial of [{text:'Old draft',turnId:'some-older-result',provider:'claude'},{text:'Legacy draft'}]){
  const existing=harness(initial);existing.nodes.prompt.value='Edit existing draft';existing.context.handlePromptInput({target:existing.nodes.prompt});assert.equal(existing.draft.turnId,initial.turnId);assert.equal(existing.draft.provider,initial.provider);
 }
});
test('changed or removed rendered option, wrong project or busy current state refuses staging clearly',()=>{
 for(const change of [h=>h.old.card.options[0].label='Changed',h=>h.old.card.options[0].tradeoff='Changed',h=>h.chat.turns.shift(),h=>h.button.dataset.choiceProject='other',h=>h.chat.status='running']){
  const h=harness();change(h);h.context.stageRenderedChoice(h.button);assert.equal(h.draft.text,'');assert.equal(h.renders.length,1);assert.match(h.toasts[0],/result changed/);
 }
 const occupied=harness({text:'Existing draft',turnId:'old-original',provider:'claude'});occupied.context.stageRenderedChoice(occupied.button);assert.equal(occupied.draft.text,'Existing draft');assert.match(occupied.toasts[0],/clear your current draft/);
});
test('rendered choice carries exact escaped project/result/provider and option fields',()=>{
 const h=harness();h.old.card.options[0]={label:'Use "urgent" <cards>',tradeoff:'A & B\r\nC'};
 vm.runInContext("viewedTurns.set('project','old-original')",h.context);
 h.context.esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');h.context.markdown=s=>s;
 const html=h.context.turnView(h.chat);
 assert.match(html,/data-choice-project="project" data-choice-result="old-original" data-choice-provider="claude"/);
 assert.ok(html.includes('data-choice-option="'+h.context.esc(JSON.stringify(['Use "urgent" <cards>','A & B\r\nC']))+'"'));
});

test('stale tab input refuses same-text replacement with another identity or target',()=>{
 const original={id:'A',text:'Same text',provider:'codex',turnId:'old-original'};
 for(const replacement of [{...original,id:'B'},{...original,turnId:'new-original'},{...original,provider:'claude'},{...original,choice:{index:0,label:'Other',tradeoff:''}},{text:''}]){
  const h=harness(original);h.draft=replacement;h.nodes.prompt.value='Typed in stale tab';
  h.context.handlePromptInput({target:h.nodes.prompt});assert.equal(h.draft,replacement);assert.equal(h.renders.length,1);assert.match(h.toasts[0],/another tab/);
 }
});
test('send binds rendered draft metadata and refuses cross-tab replacement before hashing',async()=>{
 const original={id:'A',text:'Same text',provider:'codex',turnId:'old-original'};
 const submit=app.slice(app.indexOf('async function submitPrompt('),app.indexOf('async function saveIdea('));
 for(const replacement of [{...original,id:'B',turnId:'new-original'},{...original,provider:'claude'},{...original,choice:{index:0,label:'Other',tradeoff:''}},{text:''}]){
  const h=harness(original);h.draft=replacement;h.nodes.prompt.value=original.text;h.nodes.permission={value:'read'};
  Object.assign(h.context,{switchingProvider:new Set(),replyRequestId(){assert.fail('Must not hash stale draft');},api(){assert.fail('Must not send stale draft');}});
  vm.runInContext(submit,h.context);await h.context.submitPrompt({preventDefault(){}});assert.equal(h.draft,replacement);assert.match(h.toasts[0],/another tab/);
 }
});
test('intentional older and legacy drafts keep the rendered target through async work',async()=>{
 const submit=app.slice(app.indexOf('async function submitPrompt('),app.indexOf('async function saveIdea('));
 for(const original of [{id:'A',text:'Same text',provider:'codex',turnId:'old-original'},{text:'Legacy draft'}]){
  const h=harness(original);h.nodes.prompt.value=original.text;h.nodes.permission={value:'read'};let sent;
  h.context.drafts.clearIfUnchanged=()=>{};
  Object.assign(h.context,{switchingProvider:new Set(),autoAdvance:false,replyRequestId:async()=>{h.draft={id:'B',text:original.text,provider:'claude',turnId:'new-original'};return 'receipt';},api:async(route,payload)=>{sent=payload;return {};}});
  vm.runInContext(submit,h.context);await h.context.submitPrompt({preventDefault(){}});
  assert.equal(sent.provider,original.provider||'codex');assert.equal(sent.turnId,original.turnId??null);assert.equal(sent.text,original.text);
 }
});

test('reply label and provider use the supplied rendered snapshot despite newer storage',()=>{
 const original={id:'A',text:'Same text',provider:'codex',turnId:'old-original'};
 const h=harness(original);h.draft={...original,id:'B',provider:'claude',turnId:'new-original'};
 assert.equal(h.context.replyProvider(h.chat,original),'codex');assert.equal(h.context.replyAnchor(h.chat,original),'old-original');
 assert.equal(h.context.replyTarget(h.chat,original),'');
 vm.runInContext("viewedTurns.set('project','new-original')",h.context);
 assert.match(h.context.replyTarget(h.chat,original),/title="Original chat · Codex.*Which order/);
});
test('provider switching rejects stale rendered drafts and preserves replacements during its await',async()=>{
 const branch=app.slice(app.indexOf(' if(b.dataset.provider){'),app.indexOf(' if(b.dataset.desktopLogin)'));
 const initial={id:'A',text:'Same text',provider:'codex',turnId:'old-original'};
 for(const stale of [true,false]){
  const h=harness(initial),replacement={...initial,id:'B',turnId:'new-original'};let calls=0;
  Object.assign(h.context,{b:{dataset:{provider:'claude'}},switchingProvider:new Set(),api:async()=>{calls++;h.draft=replacement;}});
  if(stale)h.draft=replacement;
  await vm.runInContext('(async function(){'+branch+'})()',h.context);
  assert.equal(calls,stale?0:1);assert.equal(h.draft,replacement);assert.equal(h.draft.provider,'codex');
 }
});
