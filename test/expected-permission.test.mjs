import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import {availablePort} from '../scripts/available-port.mjs';

test('send rejects stale visible access without recording it and keeps accepted receipt identity across mode changes',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sb-expected-access-'));let child;
 try{
  const bin=path.join(dir,'fake-codex'),launches=path.join(dir,'launches.jsonl');
  await writeFile(bin,`#!/usr/bin/env node
if(process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
require('node:fs').appendFileSync(${JSON.stringify(launches)},JSON.stringify(process.argv.slice(2))+'\\n');process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Done'}})));
`,{mode:0o755});
  const port=await availablePort(),base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),SWITCHBOARD_DATA_DIR:path.join(dir,'data'),SWITCHBOARD_CODEX_BIN:bin,SWITCHBOARD_CLAUDE_BIN:bin},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>errors+=b);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors||'Startup timeout')),10000);child.stdout.on('data',b=>{if(b.toString().includes('is running')){clearTimeout(timer);resolve();}});});
  const get=async()=> (await fetch(base+'/api/bootstrap')).json();const {token}=await get();
  const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token},body:JSON.stringify(body)});return {status:r.status,json:await r.json()};};
  const created=await post('/api/chats',{title:'Stale visible access',cwd:dir,provider:'codex'});const id=created.json.chat.id;
  const chat=async()=>(await get()).chats.find(c=>c.id===id);
  const wait=async()=>{for(let i=0;i<100;i++){if((await chat()).status!=='running')return;await delay(20);}throw Error('Turn timed out');};
  const send=(expectedPermission,requestId='same-reply')=>post(`/api/chats/${id}/send`,{text:'Verify this folder',turnId:null,provider:'codex',requestId,...(expectedPermission===undefined?{}:{expectedPermission})});
  assert.equal((await post(`/api/chats/${id}/update`,{permission:'edit'})).status,200);
  const stale=await send('read');assert.equal(stale.status,409);assert.match(stale.json.error,/access changed to File edits/);
  assert.equal((await chat()).messages.length,0);assert.equal((await chat()).status,'ready');
  await assert.rejects(readFile(launches),{code:'ENOENT'});
  assert.equal((await send('edit')).status,202);await wait();
  let args=(await readFile(launches,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(args.length,1);assert.ok(args[0].includes('sandbox_mode="workspace-write"'));
  assert.equal((await post(`/api/chats/${id}/update`,{permission:'read'})).status,200);
  // A delivery retry is a receipt lookup even if either expectation or mode changed.
  for(const expectation of ['edit','read',undefined]){const duplicate=await send(expectation);assert.equal(duplicate.status,202);assert.equal(duplicate.json.duplicate,true);}
  assert.equal((await chat()).messages.filter(m=>m.role==='user').length,1);
  const reverse=await send('edit','second-reply');assert.equal(reverse.status,409);assert.match(reverse.json.error,/access changed to Read only/);
  assert.equal((await send(undefined,'legacy-reply')).status,202);await wait();
  args=(await readFile(launches,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(args.length,2);assert.ok(args[1].includes('sandbox_mode="read-only"'));
  const invalid=await send('unexpected','invalid');assert.equal(invalid.status,400);assert.equal((await chat()).messages.filter(m=>m.role==='user').length,2);
 }finally{if(child?.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});await rm(dir,{recursive:true,force:true});}
});


test('composer captures visible access before async identity work and keeps rejected draft',async()=>{
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const source=app.slice(app.indexOf('async function submitPrompt('),app.indexOf('async function saveIdea('));
 const draft={id:'draft',text:'Verify this folder',provider:'codex',turnId:null};
 const nodes={composer:{dataset:{project:'project',provider:'codex',draft:JSON.stringify(draft)}},prompt:{value:draft.text},permission:{value:'read'}};
 let payload,hashed,cleared=false;
 const context=vm.createContext({state:{chats:[{id:'project',provider:'codex',permission:'edit',status:'ready'}]},selected:'project',sending:false,switchingProvider:new Set(),currentRenderedDraft:()=>({...draft}),$:id=>nodes[id],drafts:{read:()=>draft,clearIfUnchanged:()=>{cleared=true;}},replyRequestId:async(d,p)=>{hashed=p;nodes.permission.value='edit';return 'receipt';},render(){},api:async(route,p)=>{payload=p;throw Error('Project access changed');},toast(){},viewedTurns:new Map(),autoAdvance:false});
 vm.runInContext(source,context);await context.submitPrompt({preventDefault(){}});
 assert.equal(payload.expectedPermission,'read');assert.equal(payload.requestId,'receipt');assert.equal(Object.hasOwn(hashed,'expectedPermission'),false);assert.equal(cleared,false);assert.equal(draft.text,'Verify this folder');
});
