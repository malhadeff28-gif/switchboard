import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import {createMonitor} from '../lib/monitor.mjs';
import {availablePort} from '../scripts/available-port.mjs';
import {pendingWatchedReply} from '../lib/core.mjs';
const a={id:'a',at:1,provider:'codex',origin:'watched',phase:'finished',analysis:'ready',facts:[],card:{summary:'Sorting',decisionFormatValid:true,decision:'Topic or priority?',options:[]}};
const b={...a,id:'b',at:2,card:{summary:'Legend',decisionFormatValid:true,decision:'Legend or count badge?',options:[]}};
const project=(id)=>({id,title:id,cwd:os.tmpdir(),provider:'codex',permission:'read',status:'ready',messages:[],sessions:{},turns:[a,b],displayTurn:'b'});

test('pending original selection respects answered/dismissed results and overlapping arrivals',()=>{
 const c=project('test');
 assert.equal(pendingWatchedReply(c,a),'b');
 assert.equal(pendingWatchedReply(c,null),'b');
 assert.equal(pendingWatchedReply({...c,status:'parked'},a),undefined);
 assert.equal(pendingWatchedReply({...c,status:'parked'},null),undefined);
 assert.equal(pendingWatchedReply({...c,messages:[{role:'user',replyTo:'b'}]},a),undefined);
 assert.equal(pendingWatchedReply(c,b),undefined);
 assert.equal(pendingWatchedReply({...c,unseenWatchedTurn:'new-during-run'},a),'new-during-run');
 assert.equal(pendingWatchedReply({...c,unseenWatchedTurn:'b'},b),undefined);
 assert.equal(pendingWatchedReply({...c,turns:[a,{...b,card:{decisionFormatValid:true,decision:null}}]},a),undefined);
});

test('a watched result arriving during a managed reply remains pending',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sb-overlap-attention-'));
 const c=project('overlap'),state={chats:[c]};
 const monitor=createMonitor({state,storage:dir,save(){},publish(){},binaries:{},env:{},isConnected:()=>false,onResponse(){}});
 try{
  const file=path.join(dir,'native.jsonl');await writeFile(file,'');
  await monitor.watch(c,{provider:'codex',sourceSession:'original',transcriptPath:file});
  c.status='running';c.unseenWatchedTurn=pendingWatchedReply(c,a);
  const rows=['task_started','task_complete'].map(type=>({type:'event_msg',timestamp:new Date().toISOString(),payload:{type,turn_id:'during',last_agent_message:'Another real decision'}}));
  await appendFile(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  await monitor.poll();assert.equal(c.unseenWatchedTurn,'during');
  assert.equal(pendingWatchedReply(c,a),'during');
  assert.equal(pendingWatchedReply(c,c.turns.find(t=>t.id==='during')),undefined);
 }finally{monitor.close();await rm(dir,{recursive:true,force:true});}
});

test('older reply with no next decision keeps newer original queued until answered or explicitly dismissed',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sb-older-attention-'));let child;
 try{
  const data=path.join(dir,'data');await mkdir(data);
  await writeFile(path.join(data,'workspace.json'),JSON.stringify({chats:['pending','dismissed','answered'].map(id=>{const c=project(id);if(id==='answered')c.messages=[{role:'user',replyTo:'b',text:'Answered B'}];return c;}),ideas:[]}));
  const bin=path.join(dir,'fake-codex');
  await writeFile(bin,`#!/usr/bin/env node
if(process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Done\\n<<<SWITCHBOARD_HANDOFF>>>'+JSON.stringify({summary:'Done',decision:null,options:[]})}})),100));
`,{mode:0o755});
  const port=await availablePort(),base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),SWITCHBOARD_DATA_DIR:data,SWITCHBOARD_CODEX_BIN:bin,SWITCHBOARD_CLAUDE_BIN:bin},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>errors+=b);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors||'Startup timeout')),10000);child.stdout.on('data',b=>{if(b.toString().includes('is running')){clearTimeout(timer);resolve();}});});
  const get=async()=> (await fetch(base+'/api/bootstrap')).json();const {token}=await get();
  const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token},body:JSON.stringify(body)});const json=await r.json();assert.ok(r.ok,JSON.stringify(json));return json;};
  const current=async(id)=>(await get()).chats.find(c=>c.id===id);
  const reply=async(id,target)=>{
   await post(`/api/chats/${id}/send`,{text:'Apply this choice',turnId:target});
   for(let i=0;i<100;i++){const c=await current(id);if(c.status!=='running')return c;await delay(20);}throw Error('Turn timed out');
  };
  let c=await reply('pending','a');assert.equal(c.status,'ready');assert.equal(c.unseenWatchedTurn,'b');assert.equal(c.turns.at(-1).card.decision,null);assert.equal(c.turns.at(-1).replyTo,'a');
  // Completing an older reply did not mark the newer original answered.
  assert.equal(c.messages.filter(m=>m.role==='user'&&m.replyTo==='b').length,0);
  c=await reply('pending','b');assert.equal(c.unseenWatchedTurn,undefined);assert.equal(c.status,'parked');
  await post('/api/chats/dismissed/park',{});c=await reply('dismissed','a');assert.equal(c.unseenWatchedTurn,undefined);assert.equal(c.status,'parked');
  c=await reply('answered','a');assert.equal(c.unseenWatchedTurn,undefined);assert.equal(c.status,'parked');
 }finally{if(child?.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});await rm(dir,{recursive:true,force:true});}
});
