import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const finder=app.slice(app.indexOf('function discoveryRows('),app.indexOf('function editText('));
function harness(chats){
 const calls=[],chosen=[],closed=[];
 const context=vm.createContext({state:{chats},discoverySnapshotId:'snapshot-1',discoveryBatch:{enabled:false,selected:new Set(),errors:new Map(),busy:false,followed:0,skipped:0},esc:s=>String(s).replaceAll('"','&quot;'),name:p=>p==='claude'?'Claude':'Codex',
  $:()=>({close(){closed.push(true);}}),choose:id=>chosen.push(id),toast(){},
  api:async(route,body)=>{calls.push({route,body});return {chat:{id:'new-project',sourceId:body.id}};}});
 vm.runInContext(finder,context);
 return {context,calls,chosen,closed};
}
const source=(provider,id='native')=>({id:provider+':'+id,provider,title:'Trial project',cwd:'/work/Trial folder',summary:'Completed answer'});

test('finder identifies followed Codex and paused Claude chats and opens without importing',async()=>{
 const codex=source('codex'),claude=source('claude');
 const chats=[{id:'project-codex',sourceId:codex.id,watch:{enabled:true}},
  {id:'project-claude',sourceId:claude.id,watch:{enabled:false}}];
 const before=JSON.stringify(chats);
 const h=harness(chats);
 for(const p of [codex,claude]){
  const html=h.context.discoveryRows([p]);
  assert.match(html,/Already in workspace/);
  assert.match(html,/Open project/);
  assert.match(html,/Trial project/);
  assert.match(html,/Trial folder/);
  assert.doesNotMatch(html,/<i>＋<\/i>/);
  if(p===claude)assert.match(html,/Watching paused/);
  await h.context.selectDiscoveredProject(p.id);
 }
 assert.deepEqual(h.chosen,['project-codex','project-claude']);
 assert.equal(h.closed.length,2);
 assert.deepEqual(h.calls,[]);
 assert.equal(JSON.stringify(chats),before);
});

test('finder follows a new chat and rechecks current workspace when a row is selected',async()=>{
 const p=source('claude','new'),h=harness([]);
 assert.match(h.context.discoveryRows([p]),/<i>＋<\/i>/);
 await h.context.selectDiscoveredProject(p.id);
 assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].route,'/api/import');
 assert.equal(h.calls[0].body.id,p.id);
 assert.equal(h.calls[0].body.watch,true);
 assert.deepEqual(h.chosen,['new-project']);
 // A stale add row must still open the now-existing project without a second import.
 await h.context.selectDiscoveredProject(p.id);
 assert.equal(h.calls.length,1);
 assert.deepEqual(h.chosen,['new-project','new-project']);
});
