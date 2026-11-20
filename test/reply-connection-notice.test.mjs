import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const functions=app.slice(app.indexOf('const viewedTurns='),app.indexOf('function savedDecisions('));
function harness(connections={codex:{installed:true,signedIn:true},claude:{installed:true,signedIn:false}}){
 const draft={text:'Use shortest route',turnId:'original',provider:'claude'},nodes={'reply-target':{innerHTML:''},'watched-result-notice':{innerHTML:''},'reply-connection-notice':{innerHTML:'',hidden:true}};
 const chat={id:'packing',title:'Packing',provider:'codex',status:'ready',permission:'read',messages:[],turns:[{id:'original',origin:'watched',provider:'codex',at:1,phase:'finished',card:{summary:'Original output',decision:null,options:[],claims:[],evidence:[]}}]};
 const context=vm.createContext({state:{chats:[chat],connections},selected:chat.id,drafts:{read:()=>draft},name:p=>p==='claude'?'Claude':'Codex',esc:s=>String(s??'').replaceAll('<','&lt;'),markdown:s=>s,$:id=>nodes[id],switchingProvider:new Set(),sending:false,autoAdvance:false,icon:()=>'',usageLabel:()=>''});
 vm.runInContext(functions,context);return {context,chat,draft,nodes};
}
test('signed-out staged draft provider gets persistent direct Connections notice without changing routing',()=>{
 const h=harness(),before=JSON.stringify(h.draft),html=h.context.chatView(h.chat);
 assert.match(html,/id="reply-connection-notice"/);assert.match(html,/role="status"/);assert.match(html,/Sign in to Claude to send/);assert.match(html,/data-action="connections">Connections/);
 assert.equal(h.context.replyAnchor(h.chat),'original');assert.equal(h.context.replyProvider(h.chat),'claude');assert.equal(JSON.stringify(h.draft),before);assert.match(html,/Use shortest route/);
 // The other project's connected provider does not inherit this draft's notice.
 h.context.drafts.read=id=>id==='packing'?h.draft:{text:'',provider:'codex'};assert.equal(h.context.replyConnectionNotice({...h.chat,id:'other'}),'');
});
test('missing CLI is distinguished; demo, connected and unknown status stay unaffected',()=>{
 const h=harness({claude:{installed:false,signedIn:false}});assert.match(h.context.replyConnectionNotice(h.chat),/Install the Claude CLI/);
 assert.equal(h.context.replyConnectionNotice({...h.chat,demo:true}),'');
 h.context.state.workspaceMismatch=true;assert.equal(h.context.replyConnectionNotice(h.chat),'');h.context.state.workspaceMismatch=false;
 for(const connection of [undefined,{}, {installed:true},{installed:true,signedIn:true},{installed:true,signedIn:false,connectionError:'Status could not be checked'}]){
  h.context.state.connections={claude:connection};assert.equal(h.context.replyConnectionNotice(h.chat),'');
 }
});
test('local draft/provider and connection updates refresh notice without replacing prompt or mutating draft',()=>{
 const h=harness(),textarea={value:h.draft.text,focused:true};h.nodes.prompt=textarea;
 h.context.updateReplyContext(h.chat);assert.equal(h.nodes['reply-connection-notice'].hidden,false);
 const destination=h.nodes['reply-target'].innerHTML;
 h.context.state.connections.claude.signedIn=true;h.context.updateReplyConnection(h.chat);assert.equal(h.nodes['reply-connection-notice'].hidden,true);
 assert.equal(h.nodes['reply-target'].innerHTML,destination);
 h.context.state.connections.codex={installed:true,signedIn:false};delete h.draft.provider;h.context.updateReplyContext(h.chat);assert.match(h.nodes['reply-connection-notice'].innerHTML,/Sign in to Codex/);assert.equal(h.nodes.prompt,textarea);assert.equal(textarea.focused,true);assert.equal(h.draft.turnId,'original');assert.equal(h.draft.text,'Use shortest route');
});
