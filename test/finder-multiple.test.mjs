import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {readableText} from '../public/readable.js';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const finder=app.slice(app.indexOf('function filteredDiscovery('),app.indexOf('function editText('));
const source=id=>({id,provider:'codex',title:id,cwd:'/tmp/'+id,summary:'Completed result'});
function harness(){
 const calls=[],chosen=[],fail=new Set(),rendered=[],nodes={'modal':{open:true,querySelectorAll(){return [];},close(){throw Error('Batch must stay open');}},'discover-search':{},'discovery-list':{}};
 const context=vm.createContext({readableText,selected:null,state:{chats:[{id:'paused-project',sourceId:'paused',watch:{enabled:false}}]},found:[source('one'),source('two'),source('paused')],discoverySnapshotId:'snapshot-1',discoverySearch:'',nextOffset:1,modalType:'discover',discoveryBatch:{enabled:true,selected:new Set(),errors:new Map(),busy:false,followed:0,skipped:0},esc:s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),name:()=> 'Codex',$:id=>nodes[id],openModal:(type,html)=>rendered.push(html),choose:id=>chosen.push(id),toast(){},api:async(route,body)=>{calls.push({route,body});if(fail.has(body.id))throw Error('<bad folder>');return {chat:{id:'project-'+body.id,sourceId:body.id,watch:{enabled:true}}};}});
 vm.runInContext(finder,context);
 return {context,calls,chosen,fail,rendered,nodes};
}
test('multi finder keeps intentional unique selections through search and paging and skips paused projects',async()=>{
 const h=harness(),c=h.context;
 c.toggleDiscoveredProject('one');c.toggleDiscoveredProject('paused');c.toggleDiscoveredProject('unknown');assert.equal(c.discoveryBatch.selected.size,1);
 c.discoverySearch='two';c.renderDiscovery();assert.ok(c.discoveryBatch.selected.has('one'));assert.match(h.rendered.at(-1),/value="two"/);
 c.found.push(source('three'));c.discoverySnapshotId='snapshot-2';c.toggleDiscoveredProject('three');
 assert.ok(c.discoveryBatch.selected.has('one'));assert.ok(c.discoveryBatch.selected.has('three'));
 // Toggling twice returns to the same selection rather than adding duplicates.
 c.toggleDiscoveredProject('three');c.toggleDiscoveredProject('three');assert.equal(c.discoveryBatch.selected.size,2);
 await c.followDiscoveredProjects();assert.deepEqual(h.calls.map(x=>x.body.id),['one','three']);assert.ok(h.calls.every(x=>!('snapshot' in x.body)));
 assert.ok(h.calls.every(x=>x.route==='/api/import'&&x.body.watch===true));assert.equal(c.state.chats.find(x=>x.sourceId==='paused').watch.enabled,false);assert.deepEqual(h.chosen,[]);assert.equal(c.discoverySearch,'two');assert.equal(c.discoveryBatch.followed,2);assert.match(h.rendered.at(-1),/2 followed/);
});
test('partial successes are retained and retry imports only failed items with escaped errors',async()=>{
 const h=harness(),c=h.context;c.toggleDiscoveredProject('one');c.toggleDiscoveredProject('two');h.fail.add('two');
 await c.followDiscoveredProjects();assert.equal(c.discoveryBatch.followed,1);assert.deepEqual([...c.discoveryBatch.selected.keys()],['two']);assert.equal(c.discoveryBatch.errors.size,1);assert.match(h.rendered.at(-1),/1 followed · 1 failed/);assert.match(h.rendered.at(-1),/&lt;bad folder&gt;/);assert.doesNotMatch(h.rendered.at(-1),/<bad folder>/);
 // A newly selected item is untouched by Retry failed.
 c.found.push(source('three'));c.toggleDiscoveredProject('three');h.fail.clear();await c.followDiscoveredProjects(true);
 assert.deepEqual(h.calls.map(x=>x.body.id),['one','two','two']);assert.deepEqual([...c.discoveryBatch.selected.keys()],['three']);assert.equal(c.discoveryBatch.errors.size,0);assert.equal(c.state.chats.filter(x=>x.sourceId==='one').length,1);
});
test('batch rechecks current workspace and blocks duplicate batch launches while pending',async()=>{
 const h=harness(),c=h.context;c.toggleDiscoveredProject('one');c.toggleDiscoveredProject('two');
 c.state.chats.push({id:'now-followed',sourceId:'two',watch:{enabled:false}});
 let finish;c.api=async(route,body)=>{h.calls.push({route,body});await new Promise(r=>finish=r);return {chat:{id:'project-one',sourceId:'one'}};};
 const first=c.followDiscoveredProjects();await c.followDiscoveredProjects();c.toggleDiscoveredProject('one');assert.equal(h.calls.length,1);finish();await first;
 assert.equal(c.discoveryBatch.skipped,1);assert.equal(c.state.chats.find(x=>x.sourceId==='two').watch.enabled,false);assert.equal(c.discoveryBatch.selected.size,0);
});
test('selection and keyboard deselection restore the same row focus and dialog/list scroll',()=>{
 const h=harness(),c=h.context,dialog=h.nodes.modal,list=h.nodes['discovery-list'];
 const focused=[];
 dialog.scrollTop=230;dialog.scrollLeft=3;list.scrollTop=120;list.scrollLeft=7;
 dialog.querySelectorAll=()=>[{dataset:{finderSelect:'one'},focus:options=>focused.push({id:'one',options})}];
 // Rebuilding the dialog normally focuses its first control and can scroll it.
 c.openModal=(type,html)=>{h.rendered.push(html);dialog.scrollTop=0;list.scrollTop=0;};
 c.toggleDiscoveredProject('one');
 assert.equal(focused.at(-1).id,'one');assert.equal(focused.at(-1).options.preventScroll,true);
 assert.equal(dialog.scrollTop,230);assert.equal(dialog.scrollLeft,3);assert.equal(list.scrollTop,120);assert.equal(list.scrollLeft,7);
 c.toggleDiscoveredProject('one');
 assert.equal(focused.length,2);assert.equal(c.discoveryBatch.selected.size,0);assert.equal(dialog.scrollTop,230);assert.equal(list.scrollTop,120);
});

test('finder distinguishes unloaded results from exhausted no-match search and updates older action while typing',()=>{
 const h=harness(),c=h.context;
 c.discoverySearch='Coffee Chat Organizer';c.renderDiscovery();
 assert.match(h.rendered.at(-1),/No matches in the chats loaded so far/);
 assert.match(h.rendered.at(-1),/>Search older chats<\/button>/);
 assert.match(h.rendered.at(-1),/value="Coffee Chat Organizer"/);
 assert.doesNotMatch(h.rendered.at(-1),/Start a new project/);
 const older={};h.nodes['discover-older']=older;
 h.nodes['discover-search'].oninput({target:{value:''}});assert.equal(older.textContent,'Show older chats');
 h.nodes['discover-search'].oninput({target:{value:'Coffee Chat Organizer'}});assert.equal(older.textContent,'Search older chats');
 c.nextOffset=null;c.renderDiscovery();assert.match(h.rendered.at(-1),/No matching chats found/);assert.doesNotMatch(h.rendered.at(-1),/data-action="older-chats"/);
 c.discoverySearch='';c.found=[];c.renderDiscovery();assert.match(h.rendered.at(-1),/No local chats found/);
});
test('older-page focus prefers an actionable matching row, then older action, then search',()=>{
 const h=harness(),c=h.context,focused=[];
 let row={focus:()=>focused.push('match')};h.nodes.modal.querySelector=()=>row;
 h.nodes['discover-older']={focus:()=>focused.push('older')};h.nodes['discover-search'].focus=()=>focused.push('search');
 c.focusDiscoveryNext();row=null;c.focusDiscoveryNext();delete h.nodes['discover-older'];c.focusDiscoveryNext();
 assert.deepEqual(focused,['match','older','search']);
});

test('explicit batch Done opens first newly followed ready project in follow order',async()=>{
 const h=harness(),c=h.context;let closed=0;h.nodes.modal.close=()=>closed++;
 c.state.chats.push({id:'unrelated',status:'ready'});
 c.found.push(source('three'));
 c.toggleDiscoveredProject('one');c.toggleDiscoveredProject('two');c.toggleDiscoveredProject('three');
 await c.followDiscoveredProjects();assert.deepEqual(h.chosen,[]);
 c.state.chats.find(x=>x.sourceId==='one').status='watching';c.state.chats.find(x=>x.sourceId==='two').status='ready';c.state.chats.find(x=>x.sourceId==='three').status='ready';
 assert.match(h.rendered.at(-1),/data-action="finder-done"/);
 c.finishDiscoveredProjects();assert.equal(closed,1);assert.deepEqual(h.chosen,['project-two']);
});
test('Done falls back only to an accessible newly followed project and preserves active projects',()=>{
 for(const kind of ['working','removed','active','initial-active','busy','empty']){
  const h=harness(),c=h.context;let closed=0;h.nodes.modal.close=()=>closed++;
  c.state.chats.push({id:'unrelated',status:'ready'},{id:'first',status:'watching'},{id:'second',status:'running'});
  c.discoveryBatch.followedIds=kind==='empty'?[]:['first','second'];
  if(kind==='removed')c.state.chats=c.state.chats.filter(x=>x.id!=='first');
  if(kind==='active')c.selected='unrelated';
  if(kind==='initial-active')c.discoveryBatch.hadActiveProject=true;
  if(kind==='busy')c.discoveryBatch.busy=true;
  c.finishDiscoveredProjects();
  assert.deepEqual(h.chosen,kind==='working'?['first']:kind==='removed'?['second']:[]);
  assert.equal(closed,kind==='busy'?0:1);
 }
});
test('closing batch without explicit Done does not navigate and retry records only successful new projects',async()=>{
 const h=harness(),c=h.context;
 c.toggleDiscoveredProject('one');c.toggleDiscoveredProject('two');h.fail.add('one');await c.followDiscoveredProjects();
 assert.deepEqual([...c.discoveryBatch.followedIds],['project-two']);assert.deepEqual(h.chosen,[]);
 h.fail.clear();await c.followDiscoveredProjects(true);
 assert.deepEqual([...c.discoveryBatch.followedIds],['project-two','project-one']);assert.deepEqual(h.chosen,[]);
 // The ordinary Close button remains separate from the explicit Done action.
 assert.doesNotMatch(h.rendered.at(-1),/data-close[^>]*>Done/);
});
