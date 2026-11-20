import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,appendFile,readFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import {availablePort} from '../scripts/available-port.mjs';
import {newWatch,pollTranscript} from '../lib/turns.mjs';
import {pausedLifecycle} from '../lib/paused-lifecycle.mjs';
import {choiceText} from '../public/drafts.js';
const event=(type,id='native')=>JSON.stringify({type:'event_msg',payload:{type,turn_id:id}})+'\n';

test('paused inspection is bounded, non-mutating, and requires definitive completion',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sb-paused-probe-'));
 try{
  const file=path.join(dir,'native.jsonl');const watch={provider:'codex',session:'native',file,enabled:false,offset:33,phase:'finished'};const before=JSON.stringify(watch);
  await writeFile(file,event('task_started'));assert.equal(await pausedLifecycle(watch),'working');
  await appendFile(file,event('task_complete','unrelated'));assert.equal(await pausedLifecycle(watch),'working');
  await appendFile(file,event('task_complete'));assert.equal(await pausedLifecycle(watch),'ready');
  // A recent receiving-chat app-tool turn is active despite the sender root,
  // and neither a stale completion nor a nested child may release it.
  const appTurn={type:'event_msg',payload:{type:'task_started',turn_id:'received',root_turn_id:'sender',turn_attribution:{turn_id:'received',root_turn_id:'sender',parent_turn_id:'sender',turn_trigger:'app_tool_create_thread'}}};
  await writeFile(file,event('task_complete','old')+JSON.stringify(appTurn)+'\n'+event('task_complete','stale'));
  assert.equal(await pausedLifecycle(watch),'working');
  await appendFile(file,JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:'child',turn_attribution:{initiating_agent_path:'child'}}})+'\n'+event('task_complete','child'));
  assert.equal(await pausedLifecycle(watch),'working');
  await appendFile(file,JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'received',root_turn_id:'sender'}})+'\n');assert.equal(await pausedLifecycle(watch),'ready');
  await appendFile(file,'{"type":');assert.equal(await pausedLifecycle(watch),'unknown');
  await writeFile(file,event('task_complete')+JSON.stringify({type:'response_item',payload:{output:'x'.repeat(2*1024*1024)}})+'\n');assert.equal(await pausedLifecycle(watch),'unknown');
  assert.equal(await pausedLifecycle({...watch,file:path.join(dir,'missing')}),'unknown');assert.equal(JSON.stringify(watch),before);
  const claude={...watch,provider:'claude',session:'c'};
  const row=x=>JSON.stringify({sessionId:'c',...x})+'\n';
  await writeFile(file,row({type:'user',message:{content:'Check this'}})+row({type:'assistant',message:{content:'Thinking',stop_reason:'tool_use'}}));assert.equal(await pausedLifecycle(claude),'working');
  await appendFile(file,row({type:'system',subtype:'turn_duration'}));assert.equal(await pausedLifecycle(claude),'working');
  await appendFile(file,row({type:'assistant',message:{content:'Done',stop_reason:'end_turn'}}));assert.equal(await pausedLifecycle(claude),'ready');
  await appendFile(file,row({type:'user',message:{content:'Another check'}}));assert.equal(await pausedLifecycle(claude),'working');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('server blocks overlapping paused native writer without moving its watch, then permits reviewed retry',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sb-paused-server-'));let server,native;
 try{
  const data=path.join(dir,'data'),project=path.join(dir,'project'),nested=path.join(project,'nested'),other=path.join(dir,'other');
  await Promise.all([mkdir(data),mkdir(nested,{recursive:true}),mkdir(other)]);
  const transcript=path.join(dir,'native.jsonl'),output=path.join(nested,'overlap.txt');await writeFile(transcript,event('task_complete','earlier'));
  const watch=newWatch({provider:'codex',transcriptPath:transcript,sourceSession:'native'});await pollTranscript(watch,()=>{});watch.enabled=false;
  const original={id:'original',title:'Paused original',cwd:nested,provider:'codex',status:'ready',permission:'read',messages:[],sessions:{},turns:[],watch};
  const option={label:'OVERWRITE approved snapshot',tradeoff:'Use approved text.'},anchor={id:'approved',provider:'codex',origin:'watched',phase:'finished',at:1,analysis:'ready',facts:[],card:{summary:'Approved earlier',decisionFormatValid:true,decision:'Which snapshot?',options:[option],evidence:[]}};
  const companion={id:'companion',title:'Companion',cwd:project,provider:'codex',permission:'edit',status:'ready',messages:[],sessions:{},confirmedDecisions:[],turns:[anchor],displayTurn:anchor.id};
  await writeFile(path.join(data,'workspace.json'),JSON.stringify({chats:[original,companion],ideas:[]}));
  const bin=path.join(dir,'fake-codex'),launches=path.join(dir,'launches');
  await writeFile(bin,`#!/usr/bin/env node
if(process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(launches)},'launch\\n');if(input.includes('OVERWRITE approved snapshot'))fs.writeFileSync(${JSON.stringify(output)},'approved snapshot');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Done'}}));});
`,{mode:0o755});
  const port=await availablePort(),base=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),SWITCHBOARD_DATA_DIR:data,SWITCHBOARD_CODEX_BIN:bin,SWITCHBOARD_CLAUDE_BIN:bin},stdio:['ignore','pipe','pipe']});
  let errors='';server.stderr.on('data',b=>errors+=b);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors||'Startup timeout')),10000);server.stdout.on('data',b=>{if(b.toString().includes('is running')){clearTimeout(timer);resolve();}});});
  const get=async()=> (await fetch(base+'/api/bootstrap')).json();const {token}=await get();
  const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token},body:JSON.stringify(body)});return {status:r.status,json:await r.json()};};
  const stored=async()=>JSON.parse(await readFile(path.join(data,'workspace.json'),'utf8'));
  const before=(await stored()).chats.find(c=>c.id==='original');
  native=spawn(process.execPath,['-e',`const fs=require('node:fs');fs.writeFileSync(process.argv[1],'NATIVE-START\\n');fs.appendFileSync(process.argv[2],${JSON.stringify(event('task_started'))});console.log('started');process.stdin.once('data',()=>{fs.appendFileSync(process.argv[1],'NATIVE-FINISH\\n');fs.appendFileSync(process.argv[2],${JSON.stringify(event('task_complete'))});process.exit(0);});`,output,transcript],{stdio:['pipe','pipe','pipe']});
  await new Promise(resolve=>native.stdout.once('data',resolve));
  const payload={text:choiceText(0,option),provider:'codex',turnId:anchor.id,choice:{index:0,...option},requestId:'preserved',expectedPermission:'edit'};
  const send=()=>post('/api/chats/companion/send',payload);
  const blocked=await send();assert.equal(blocked.status,409);assert.match(blocked.json.error,/paused chat is working/);
  assert.equal(await readFile(output,'utf8'),'NATIVE-START\n');await assert.rejects(readFile(launches),{code:'ENOENT'});
  const transcriptBytes=await readFile(transcript);await rm(transcript);
  const unknown=await send();assert.equal(unknown.status,409);assert.match(unknown.json.error,/Could not confirm/);assert.match(unknown.json.error,/read-only/);
  let saved=await stored();assert.deepEqual(saved.chats.find(c=>c.id==='original'),before);assert.deepEqual(saved.chats.find(c=>c.id==='companion').messages,[]);assert.deepEqual(saved.chats.find(c=>c.id==='companion').confirmedDecisions,[]);
  const make=async(cwd,permission)=>{const r=await post('/api/chats',{title:'Independent',cwd,provider:'codex'});await post(`/api/chats/${r.json.chat.id}/update`,{permission});return r.json.chat.id;};
  const read=await make(project,'read'),unrelated=await make(other,'edit');
  for(const id of [read,unrelated])assert.equal((await post(`/api/chats/${id}/send`,{text:'Inspect safely',expectedPermission:id===read?'read':'edit'})).status,202);
  for(let i=0;i<100;i++){if(!(await get()).chats.some(c=>c.status==='running'))break;await delay(20);}
  // Let the periodic monitor tick with an unreadable paused source: it must not
  // read/import it, set a read error, or move any checkpoint. Read-only and
  // independent-folder sends above succeeded without a lifecycle probe.
  await delay(1100);
  assert.equal(await readFile(output,'utf8'),'NATIVE-START\n');assert.deepEqual((await stored()).chats.find(c=>c.id==='original'),before);
  await writeFile(transcript,transcriptBytes);
  await new Promise(resolve=>{native.once('exit',resolve);native.stdin.write('finish\n');});assert.equal(await readFile(output,'utf8'),'NATIVE-START\nNATIVE-FINISH\n');
  assert.equal((await send()).status,202);
  for(let i=0;i<100;i++){if(!(await get()).chats.some(c=>c.status==='running'))break;await delay(20);}
  assert.equal(await readFile(output,'utf8'),'approved snapshot');saved=await stored();assert.deepEqual(saved.chats.find(c=>c.id==='original'),before);assert.equal(saved.chats.find(c=>c.id==='companion').confirmedDecisions.length,1);
  // A now-active original must not turn an accepted delivery retry into a new run.
  await appendFile(transcript,event('task_started','later'));const duplicate=await send();assert.equal(duplicate.status,202);assert.equal(duplicate.json.duplicate,true);
  assert.equal((await readFile(launches,'utf8')).trim().split('\n').length,3);
  // Explicit resume still catches up the paused transcript through the normal monitor.
  await appendFile(transcript,event('task_complete','later'));assert.equal((await post('/api/chats/original/resume-watch',{})).status,200);
  const resumed=(await get()).chats.find(c=>c.id==='original');assert.equal(resumed.watch.enabled,true);assert.equal(resumed.watch.phase,'finished');assert.equal(resumed.turns.filter(t=>t.id==='native').length,1);
  await post('/api/chats/original/resume-watch',{});await delay(1100);
  const repeated=(await get()).chats.find(c=>c.id==='original');assert.equal(repeated.turns.filter(t=>t.id==='native').length,1);assert.equal(repeated.turns.filter(t=>t.id==='later').length,1);
 }finally{
  if(native?.exitCode===null)native.kill();
  if(server?.exitCode===null)await new Promise(resolve=>{server.once('exit',resolve);server.kill('SIGTERM');});await rm(dir,{recursive:true,force:true});
 }
});
