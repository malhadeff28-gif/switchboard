import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import {availablePort} from '../scripts/available-port.mjs';
import {newWatch} from '../lib/turns.mjs';

test('send refreshes overlapping native watches, preserves rejected request, and allows read/unrelated/retry',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sb-native-guard-'));
 let child;
 try{
  const data=path.join(dir,'data'),project=path.join(dir,'project'),nested=path.join(project,'nested'),other=path.join(dir,'other');
  await Promise.all([mkdir(data),mkdir(nested,{recursive:true}),mkdir(other)]);
  const transcript=path.join(dir,'native.jsonl');
  await writeFile(transcript,'');
  const watched={id:'native',title:'Original',cwd:nested,provider:'codex',permission:'read',status:'ready',messages:[],sessions:{},watch:newWatch({provider:'codex',transcriptPath:transcript,sourceSession:'native'})};
  await writeFile(path.join(data,'workspace.json'),JSON.stringify({chats:[watched],ideas:[]}));
  const bin=path.join(dir,'codex-fake');
  await writeFile(bin,`#!/usr/bin/env node
if(process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Done'}}));});
`,{mode:0o755});
  const port=await availablePort(),base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),SWITCHBOARD_DATA_DIR:data,SWITCHBOARD_CODEX_BIN:bin,SWITCHBOARD_CLAUDE_BIN:bin},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>errors+=b);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors||'Startup timeout')),10000);child.stdout.on('data',b=>{if(b.toString().includes('is running')){clearTimeout(timer);resolve();}});});
  const get=async()=> (await fetch(base+'/api/bootstrap')).json();
  const {token}=await get();
  const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token},body:JSON.stringify(body)});return {status:r.status,json:await r.json()};};
  const create=async(cwd,permission='edit')=>{const c=await post('/api/chats',{title:'Companion',cwd,provider:'codex'});assert.equal(c.status,201);const id=c.json.chat.id;await post(`/api/chats/${id}/update`,{permission});return id;};
  const edit=await create(project),read=await create(project,'read'),unrelated=await create(other),same=await create(nested);
  const event=(type)=>JSON.stringify({type:'event_msg',payload:{type,turn_id:'native-turn'}})+'\n';
  await appendFile(transcript,event('task_started'));
  const send=(id)=>post(`/api/chats/${id}/send`,{text:'My unchanged draft',requestId:'retry'});
  for(const id of [edit,same]){const denied=await send(id);assert.equal(denied.status,409);assert.match(denied.json.error,/original watched chat/);const c=(await get()).chats.find(c=>c.id===id);assert.equal(c.messages.length,0);assert.equal(c.status,'ready');}
  assert.equal((await send(read)).status,202);
  assert.equal((await send(unrelated)).status,202);
  for(let i=0;i<100;i++){if(!(await get()).chats.some(c=>c.status==='running'))break;await delay(20);}
  await appendFile(transcript,event('task_complete'));
  // Retry the same request ID immediately: refresh must observe completion.
  const accepted=await Promise.all([send(edit),send(edit)]);
  assert.deepEqual(accepted.map(r=>r.status),[202,202]);
  assert.equal(accepted.filter(r=>r.json.duplicate).length,1);
  for(let i=0;i<100;i++){if(!(await get()).chats.some(c=>c.status==='running'))break;await delay(20);}
 }finally{
  if(child?.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});
  await rm(dir,{recursive:true,force:true});
 }
});
