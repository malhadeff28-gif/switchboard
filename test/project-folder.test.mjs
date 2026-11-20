import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,rename,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {availablePort} from '../scripts/available-port.mjs';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const modal=app.slice(app.indexOf('function newProject('),app.indexOf('\nfunction ',app.indexOf('function newProject(')+1));
function harness(idea,{fail=false,duplicate=false,draft=''}={}){
 let html='',resolve;
 const calls=[],chosen=[],saved=[],errors=[],button={disabled:false},form={querySelector:()=>button},dialog={close(){}};
 const state={chats:[],ideas:idea?[idea]:[],connections:{codex:{signedIn:true}}};
 const fields={title:'Seed inventory',goal:idea?.text||'Inventory',cwd:'/tmp/chosen-project',provider:'codex'};
 const context=vm.createContext({state,esc:s=>String(s??''),openModal:(type,content)=>html=content,$:id=>id==='new-form'?form:id==='modal'?dialog:{focus(){}},FormData:class{constructor(){return Object.entries(fields);}},api:async(route,body)=>{calls.push({route,body});if(fail)throw Error('Invalid folder');await new Promise(r=>resolve=r);return {chat:{id:'new',goal:body.goal},duplicate};},drafts:{read:()=>({text:draft})},saveDraft:(...args)=>saved.push(args),choose:id=>chosen.push(id),toast:error=>errors.push(error)});
 vm.runInContext(modal,context);context.newProject(idea);
 return {state,form,fields,calls,chosen,saved,errors,get html(){return html;},finish:()=>resolve(),submit:()=>form.onsubmit({preventDefault(){}})};
}
test('new projects and idea exploration require a visibly unselected folder; cancel leaves idea saved',()=>{
 const idea={id:'idea',text:'Build an offline seed inventory'};
 for(const seed of [null,idea]){
  const h=harness(seed);assert.match(h.html,/name="cwd" required placeholder="\/full\/path\/to\/your\/project"/);assert.match(h.html,/This is the target for this project/);assert.doesNotMatch(h.html,/name="cwd"[^>]*value=/);assert.equal(h.calls.length,0);
  if(seed){assert.match(h.html,/Build an offline seed inventory/);assert.equal(h.state.ideas.length,1);}
 }
});
test('idea modal preserves failed ideas, prevents duplicate starts, and opens its draft in the same chat',async()=>{
 const idea={id:'idea',text:'Build an offline seed inventory'};
 const failed=harness(idea,{fail:true});await failed.submit();assert.equal(failed.state.ideas.length,1);assert.equal(failed.chosen.length,0);
 const h=harness(idea);const pending=h.submit();await h.submit();assert.equal(h.calls.length,1);assert.equal(h.calls[0].route,'/api/ideas/start');assert.equal(h.calls[0].body.id,idea.id);assert.equal(h.calls[0].body.cwd,h.fields.cwd);h.finish();await pending;
 for(const options of [{duplicate:true,draft:'My revised prompt'},{duplicate:true},{draft:'Existing draft'}]){const retry=harness(idea,options),request=retry.submit();retry.finish();await request;assert.deepEqual(retry.saved,[]);assert.deepEqual(retry.chosen,['new']);}
 assert.equal(h.state.ideas.length,0);assert.deepEqual(h.chosen,['new']);assert.equal(h.saved[0][0],'new');assert.match(h.saved[0][1],/Help me think through this idea/);
});
test('create routes require explicit folders and idea starts are durable and idempotent',{timeout:15000},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'switchboard-folder-')),port=await availablePort(),url=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{env:{...process.env,PORT:String(port),SWITCHBOARD_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
 try{
  await Promise.race([new Promise(resolve=>child.stdout.on('data',b=>{if(String(b).includes('is running'))resolve();})),once(child,'exit').then(()=>{throw Error('Server exited');})]);
  const boot=async()=>(await fetch(url+'/api/bootstrap')).json(),{token}=await boot();
  const post=async(route,body)=>{const r=await fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token},body:JSON.stringify(body)});return {status:r.status,...await r.json()};};
  assert.equal((await post('/api/chats',{title:'Missing folder',provider:'codex'})).status,400);
  const {idea}=await post('/api/ideas',{text:'Offline seed inventory'});
  for(const cwd of [undefined,'',path.join(dir,'missing')]){assert.equal((await post('/api/ideas/start',{id:idea.id,cwd})).status,400);assert.equal((await boot()).ideas.length,1);assert.equal((await boot()).chats.length,0);}
  for(const title of ['', '   ']){assert.equal((await post('/api/ideas/start',{id:idea.id,cwd:dir,title})).status,400);assert.equal((await post('/api/chats',{cwd:dir,title,provider:'codex'})).status,400);}
  const workspace=path.join(dir,'workspace.json');await rename(workspace,workspace+'.saved');await mkdir(workspace);
  try{
   assert.equal((await post('/api/chats',{title:'No phantom project',cwd:dir,provider:'codex'})).status,503);
   assert.equal((await post('/api/ideas/start',{id:idea.id,cwd:dir})).status,503);
   assert.equal((await boot()).ideas.length,1);assert.equal((await boot()).chats.length,0);
  }finally{await rm(workspace,{recursive:true});await rename(workspace+'.saved',workspace);}
  const [first,retry]=await Promise.all([post('/api/ideas/start',{id:idea.id,cwd:dir,provider:'codex'}),post('/api/ideas/start',{id:idea.id,cwd:dir,provider:'codex'})]);
  assert.equal(first.chat.id,retry.chat.id);assert.equal(first.chat.cwd,dir);assert.equal(first.chat.permission,'read');assert.equal((await boot()).chats.length,1);assert.equal((await boot()).ideas.length,0);
  assert.equal((await post('/api/ideas/start',{id:idea.id,cwd:os.tmpdir()})).status,409);
  const same=await post('/api/ideas/start',{id:idea.id,cwd:dir});assert.equal(same.duplicate,true);assert.equal(same.chat.id,first.chat.id);
  const explicit=await post('/api/chats',{title:'Explicit app folder',cwd:(await boot()).root,provider:'codex'});assert.equal(explicit.status,201);
  const persisted=JSON.parse(await readFile(path.join(dir,'workspace.json'),'utf8'));assert.equal(persisted.chats.filter(c=>c.ideaId===idea.id).length,1);
 }finally{if(child.exitCode===null){const closed=once(child,'exit');child.kill();await closed;}await rm(dir,{recursive:true,force:true});}
});
