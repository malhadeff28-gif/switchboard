import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import vm from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import {availablePort} from '../scripts/available-port.mjs';
import {newWatch} from '../lib/turns.mjs';
const server=await readFile(new URL('../server.mjs',import.meta.url),'utf8'),app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const helpers=server.slice(server.indexOf('function foldersOverlap('),server.indexOf('function run(chat,'));
test('overlap warning uses captured edit job and enabled overlapping working watches, latched until job end',()=>{
 const state={chats:[{cwd:'/work/project/nested',watch:{enabled:true,phase:'working'}},{cwd:'/other',watch:{enabled:true,phase:'working'}}]},jobs=new Map(),context=vm.createContext({state,jobs,path,realpathSync:s=>s,validCwd:s=>s});vm.runInContext(helpers,context);
 const chat={id:'managed',cwd:'/work/project',status:'running',permission:'edit'},job={edit:true,folder:chat.cwd};jobs.set(chat.id,job);
 assert.equal(context.managedEditOverlap(chat),true);state.chats[0].watch.phase='finished';assert.equal(context.managedEditOverlap(chat),true);jobs.delete(chat.id);assert.equal(context.managedEditOverlap(chat),false);
 for(const original of [{cwd:'/work/project',watch:{enabled:false,phase:'working'}},{cwd:'/other',watch:{enabled:true,phase:'working'}},{cwd:'/work/project',watch:{enabled:true,phase:'ready'}}]){state.chats=[original];jobs.set(chat.id,{edit:true,folder:chat.cwd});assert.equal(context.managedEditOverlap(chat),false);}
 state.chats=[{cwd:chat.cwd,watch:{enabled:true,phase:'working'}}];jobs.set(chat.id,{edit:false,folder:chat.cwd});assert.equal(context.managedEditOverlap(chat),false);
 jobs.set(chat.id,{edit:true,folder:chat.cwd});assert.equal(context.managedEditOverlap({...chat,permission:'read'}),true);
});
test('warning uses existing Stop action only for affected active project',()=>{
 const source=app.slice(app.indexOf('function editOverlapNotice('),app.indexOf('function isUserStopped(')),context=vm.createContext({});vm.runInContext(source,context);
 const html=context.editOverlapNotice({managedEditOverlap:true,status:'running'});assert.match(html,/role="alert"/);assert.match(html,/data-action="stop"/);assert.match(html,/Stop this reply/);assert.doesNotMatch(html,/files.*changed/);
 assert.match(context.editOverlapNotice({managedEditOverlap:true,status:'stopping'}),/data-action="stop" disabled>Stopping…/);
 assert.ok(app.indexOf('${editOverlapNotice(c)}')>app.indexOf('<div class="composer-wrap">'));
 for(const c of [{status:'running'},{managedEditOverlap:true,status:'ready'}])assert.equal(context.editOverlapNotice(c),'');
});
for(const enabled of [true,false])test(`real server detects reverse overlap with a ${enabled?'watched':'paused'} original`,{timeout:15000},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sb-live-overlap-'));let child;
 try{
  const data=path.join(dir,'data'),project=path.join(dir,'project'),nested=path.join(project,'nested');await mkdir(data);await mkdir(nested,{recursive:true});const transcript=path.join(dir,'original.jsonl');
  const event=(type,id='original-turn')=>JSON.stringify({type:'event_msg',payload:{type,turn_id:id,last_agent_message:type==='task_complete'?'Original done':''}})+'\n';
  await writeFile(transcript,enabled?'':event('task_complete','earlier'));
  const watch=newWatch({provider:'codex',transcriptPath:transcript,sourceSession:'original'});
  watch.enabled=enabled;
  await writeFile(path.join(data,'workspace.json'),JSON.stringify({ideas:[],chats:[{id:'original',title:'Original',cwd:nested,provider:'codex',permission:'read',status:'ready',messages:[],sessions:{},watch}]}));
  const bin=path.join(dir,'codex-fake');await writeFile(bin,`#!/usr/bin/env node\nif(process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}if(process.argv.includes('app-server'))process.exit(1);process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'managed-session'}));setInterval(()=>{},1000);});\n`,{mode:0o755});
  const port=await availablePort(),base=`http://127.0.0.1:${port}`;child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),SWITCHBOARD_DATA_DIR:data,SWITCHBOARD_CODEX_BIN:bin,SWITCHBOARD_CLAUDE_BIN:bin},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{let error='';child.stderr.on('data',b=>error+=b);child.stdout.on('data',b=>{if(String(b).includes('is running'))resolve();});child.on('exit',()=>reject(Error(error)));});
  const get=async()=>(await fetch(base+'/api/bootstrap')).json(),{token}=await get();
  const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token},body:JSON.stringify(body)});return {status:r.status,...await r.json()};};
  const {chat}=await post('/api/chats',{title:'Managed edit',cwd:project,provider:'codex'});await post(`/api/chats/${chat.id}/update`,{permission:'edit'});assert.equal((await post(`/api/chats/${chat.id}/send`,{text:'Edit fixture',requestId:'edit-one'})).status,202);
  const current=async()=>(await get()).chats.find(c=>c.id===chat.id);assert.equal((await current()).managedEditOverlap,false);
  await appendFile(transcript,event('task_started'));
  for(let i=0;i<100&&!(await current()).managedEditOverlap;i++)await delay(30);assert.equal((await current()).managedEditOverlap,true);
  if(!enabled){
   const original=JSON.parse(await readFile(path.join(data,'workspace.json'),'utf8')).chats.find(c=>c.id==='original');
   assert.deepEqual(original.watch,watch);assert.equal(original.turns,undefined);
  }
  await appendFile(transcript,event('task_complete'));for(let i=0;i<100;i++){if((await get()).chats.find(c=>c.id==='original').watch.phase!=='working')break;await delay(30);}
  assert.equal((await current()).managedEditOverlap,true);assert.equal((await current()).status,'running');await post(`/api/chats/${chat.id}/stop`,{});
  for(let i=0;i<100&&(await current()).status!=='ready';i++)await delay(30);assert.equal((await current()).managedEditOverlap,false);
 }finally{if(child?.exitCode===null){const closed=once(child,'exit');child.kill();await closed;}await rm(dir,{recursive:true,force:true});}
});
