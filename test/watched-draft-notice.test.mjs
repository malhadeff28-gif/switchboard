import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {sameDraft} from '../public/drafts.js';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const functions=app.slice(app.indexOf('const viewedTurns='),app.indexOf('function savedDecisions('));
function harness({text='Choose scenic',turnId='original',provider='claude'}={}){
 const draft={text,turnId,provider},card={summary:'Route result',decision:null,options:[],claims:[],evidence:[]};
 const turns=[{id:'original',at:1,origin:'watched'},{id:'second',at:2,origin:'watched'},{id:'latest',at:3,origin:'watched'}].map(t=>({...t,provider:'codex',phase:'finished',card}));
 const chat={id:'routes',title:'Trail Routes',cwd:'/tmp/routes',status:'ready',provider:'codex',permission:'read',displayTurn:'latest',turns,messages:[]};
 const renders=[],nodes={'composer':{dataset:{project:'routes',result:'original',provider:'claude',draft:JSON.stringify(draft)}},'reply-target':{innerHTML:''},'watched-result-notice':{innerHTML:'',hidden:true}};
 const context=vm.createContext({state:{chats:[chat]},selected:chat.id,sameDraft,drafts:{read:()=>draft},name:p=>p==='claude'?'Claude':'Codex',esc:s=>String(s??''),markdown:s=>s,switchingProvider:new Set(),sending:false,autoAdvance:false,icon:()=>'',usageLabel:()=>'',render:()=>renders.push(true),$:id=>nodes[id]});
 vm.runInContext(functions,context);return {context,chat,draft,renders,nodes};
}
test('restored older draft exposes active original result once and opens exact ID without retargeting reply',()=>{
 const h=harness(),before=JSON.stringify(h.draft);
 assert.equal(h.context.visibleTurn(h.chat).id,'original');assert.equal(h.context.watchedResultToReview(h.chat),'latest');
 const html=h.context.chatView(h.chat);assert.equal((html.match(/data-action="show-watched-result"/g)||[]).length,1);assert.match(html,/Your original chat has another result to review/);
 h.context.showWatchedResult(h.chat);assert.equal(h.context.visibleTurn(h.chat).id,'latest');assert.equal(h.context.replyAnchor(h.chat),'original');assert.equal(h.context.replyProvider(h.chat),'claude');assert.equal(JSON.stringify(h.draft),before);assert.equal(h.renders.length,1);
 assert.equal(h.context.watchedResultToReview(h.chat),null);assert.match(h.context.replyTarget(h.chat),/show-draft-result/);
});
test('pending unseen path stays first and cannot produce duplicate banners',()=>{
 const h=harness();h.chat.unseenWatchedTurn='second';assert.equal(h.context.watchedResultToReview(h.chat),'second');assert.equal((h.context.chatView(h.chat).match(/show-watched-result/g)||[]).length,1);
 h.context.showWatchedResult(h.chat);assert.equal(h.context.visibleTurn(h.chat).id,'second');assert.equal(h.context.watchedResultToReview(h.chat),null);assert.equal(h.context.replyAnchor(h.chat),'original');
});
test('no draft history browsing, legacy drafts and inactive/older managed results do not trigger new fallback',()=>{
 for(const draft of [{text:''},{text:'   '},{turnId:null}]){
  const h=harness(draft);vm.runInContext("viewedTurns.set('routes','original')",h.context);assert.equal(h.context.watchedResultToReview(h.chat),null);
 }
 const h=harness();vm.runInContext("viewedTurns.set('routes','second')",h.context);assert.equal(h.context.watchedResultToReview(h.chat),null);
 const managed=harness();managed.chat.turns.at(-1).origin='managed';assert.equal(managed.context.watchedResultToReview(managed.chat),null);
 const older=harness();older.chat.turns.at(-1).at=0;assert.equal(older.context.watchedResultToReview(older.chat),null);
 const same=harness();same.chat.displayTurn='original';assert.equal(same.context.watchedResultToReview(same.chat),null);
});
test('manual typing and clearing refresh notice locally without re-rendering or replacing the textarea',()=>{
 const h=harness({text:''});vm.runInContext("viewedTurns.set('routes','original')",h.context);
 const textarea={value:'',focused:true,selectionStart:0};h.nodes.prompt=textarea;
 h.context.chat=h.chat;h.context.e={target:textarea};h.context.saveDraft=(id,text)=>{h.draft.text=text;h.draft.turnId='original';};
 const input=app.match(/\$\('prompt'\)\?\.addEventListener\('input',e=>\{([\s\S]*?)\n \}\);/)[1];
 textarea.value='Choose scenic';vm.runInContext('(function(){'+input+'})()',h.context);
 assert.match(h.nodes['watched-result-notice'].innerHTML,/show-watched-result/);assert.equal(h.nodes['watched-result-notice'].hidden,false);assert.equal(h.context.watchedResultToReview(h.chat),'latest');
 textarea.value='';vm.runInContext('(function(){'+input+'})()',h.context);assert.equal(h.nodes['watched-result-notice'].innerHTML,'');assert.equal(h.nodes['watched-result-notice'].hidden,true);
 assert.equal(h.nodes.prompt,textarea);assert.equal(textarea.focused,true);assert.equal(h.renders.length,0);
 h.chat.unseenWatchedTurn='second';vm.runInContext('(function(){'+input+'})()',h.context);assert.equal(h.nodes['watched-result-notice'].hidden,false);assert.equal(h.context.watchedResultToReview(h.chat),'second');
});
test('staged choice immediately updates notice and reply target without a full render',()=>{
 const h=harness({text:''});vm.runInContext("viewedTurns.set('routes','original')",h.context);
 const textarea={value:'',focus(){this.focused=true;}};h.nodes.prompt=textarea;
 Object.assign(h.context,{c:h.chat,t:h.chat.turns[0],b:{dataset:{choice:'0'}},option:{label:'Shortest',tradeoff:'Less scenic'},choiceText:()=> 'Use option 1: Shortest. Less scenic',saveDraft:(id,text,target)=>Object.assign(h.draft,{text,turnId:target.turnId,provider:target.provider,choice:target.choice})});
 h.chat.turns[0].card.options=[h.context.option];h.context.b.dataset={choice:'0',choiceProject:'routes',choiceResult:'original',choiceProvider:'codex',choiceOption:JSON.stringify(['Shortest','Less scenic'])};
 h.context.stageRenderedChoice(h.context.b);
 assert.equal(h.nodes['watched-result-notice'].hidden,false);assert.match(h.nodes['watched-result-notice'].innerHTML,/show-watched-result/);assert.match(h.nodes['reply-target'].innerHTML,/Original chat/);assert.equal(h.draft.turnId,'original');assert.equal(textarea.focused,true);assert.equal(h.renders.length,0);
});
test('clearing a restored anchor renders the changed visible result once before the next typed reply binds',()=>{
 const h=harness(),textarea={value:'',focused:true,selectionStart:0};h.nodes.prompt=textarea;
 let current={...h.draft};
 Object.assign(h.context,{chat:h.chat,e:{target:textarea},drafts:{read:()=>current,write:(id,value)=>current=value},editDraft:(draft,text)=>({...draft,text}),crypto:{randomUUID:()=> 'draft-id'}});
 const save=app.slice(app.indexOf('function saveDraft('),app.indexOf('\nfunction choose('));vm.runInContext(save,h.context);
 const input=app.match(/\$\('prompt'\)\?\.addEventListener\('input',e=>\{([\s\S]*?)\n \}\);/)[1];
 let shown='original';h.context.render=()=>{h.renders.push(true);shown=h.context.visibleTurn(h.chat).id;h.nodes.composer.dataset.result=shown;h.nodes.composer.dataset.draft=JSON.stringify(current);};
 assert.equal(h.context.visibleTurn(h.chat).id,'original');
 vm.runInContext('(function(){'+input+'})()',h.context);assert.equal(shown,'latest');assert.equal(h.context.visibleTurn(h.chat).id,shown);assert.equal(h.renders.length,1);assert.equal(h.context.replyAnchor(h.chat),'latest');assert.equal(current.text,'');
 textarea.value='Reply to latest';vm.runInContext('(function(){'+input+'})()',h.context);assert.equal(current.turnId,shown);assert.equal(h.renders.length,1);assert.equal(textarea.focused,true);
 // Explicit history selection remains selected when its draft is cleared.
 vm.runInContext("viewedTurns.set('routes','original')",h.context);current={text:'Old result draft',turnId:'original',provider:'claude'};shown='original';h.nodes.composer.dataset.result='original';h.nodes.composer.dataset.draft=JSON.stringify(current);textarea.value='';vm.runInContext('(function(){'+input+'})()',h.context);
 assert.equal(h.context.visibleTurn(h.chat).id,'original');assert.equal(h.renders.length,1);
 textarea.value='Reply to original';vm.runInContext('(function(){'+input+'})()',h.context);assert.equal(current.turnId,'original');assert.equal(h.renders.length,1);
});
