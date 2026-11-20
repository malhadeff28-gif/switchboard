import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import {availablePort} from '../scripts/available-port.mjs';
const marker='<<<SWITCHBOARD_HANDOFF>>>';
const prose='The selected result presents two format options. No choice was made, and no files were changed.';
const invalid={summary:'Historical options',decision:null,options:[{label:'Old option',tradeoff:'Historical only'}]};
const cases={
 contradictory:prose+'\n'+marker+JSON.stringify(invalid),
 truncated:'Readable partial response.\n'+marker+'{"summary":"Broken',
 missing:'Plain response without a reserved suffix.',
 proseless:marker+JSON.stringify(invalid),
 valid:'The verification is complete.\n'+marker+JSON.stringify({summary:'Verified',decision:null,options:[]}),
 error:'Partial output before provider failure.'
};

test('invalid handoffs retain readable prose and raw evidence without accepting contradictory decisions',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sb-handoff-display-'));let child;
 try{
  const bin=path.join(dir,'fake-codex');
  await writeFile(bin,`#!/usr/bin/env node
if(process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
const answers=${JSON.stringify(cases)};let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const key=Object.keys(answers).find(k=>input.includes('CASE_'+k));console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'read-only verification',exit_code:0,aggregated_output:'Checked'}}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:answers[key]}}));if(key==='error'){console.error('Real provider failure');process.exitCode=1;}});
`,{mode:0o755});
  const port=await availablePort(),base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),SWITCHBOARD_DATA_DIR:path.join(dir,'data'),SWITCHBOARD_CODEX_BIN:bin,SWITCHBOARD_CLAUDE_BIN:bin},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>errors+=b);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors||'Startup timeout')),10000);child.stdout.on('data',b=>{if(b.toString().includes('is running')){clearTimeout(timer);resolve();}});});
  const get=async()=> (await fetch(base+'/api/bootstrap')).json();const {token}=await get();
  const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token},body:JSON.stringify(body)});const json=await r.json();assert.ok(r.ok,JSON.stringify(json));return json;};
  for(const key of Object.keys(cases)){
   const {chat}=await post('/api/chats',{title:key,cwd:dir,provider:'codex'});
   await post(`/api/chats/${chat.id}/send`,{text:'CASE_'+key,turnId:null});
   let c;for(let i=0;i<100;i++){c=(await get()).chats.find(c=>c.id===chat.id);if(c.status!=='running')break;await delay(20);}
   const t=c.turns.at(-1);assert.equal(t.replyTo,null);assert.equal(t.request,'CASE_'+key);
   const message=c.messages.findLast(m=>m.role==='assistant');assert.equal(message.text,t.answer);
   assert.ok(!t.answer.includes(marker));assert.ok(!t.card.summary.includes(marker));assert.ok(!c.summary.includes(marker));
   if(key==='valid'){assert.equal(t.analysis,'ready');assert.equal(c.status,'parked');assert.equal(t.card.summary,'Verified');continue;}
   assert.equal(t.analysis,'raw');assert.deepEqual(t.card.options,[]);assert.equal(c.status,'ready');
   if(['contradictory','truncated','proseless'].includes(key)){
    const raw=t.card.evidence.find(e=>e.label==='Unverified handoff data');assert.ok(raw);assert.equal(raw.text,cases[key].slice(cases[key].lastIndexOf(marker)));
    assert.equal(t.answer,key==='proseless'?'The agent returned a handoff without a readable response. Review the evidence.':cases[key].split(marker)[0].trim());
    assert.ok(t.analysisError);assert.equal(c.error,null);
   }else assert.equal(t.answer,cases[key]);
   if(key==='error'){assert.match(c.error,/Real provider failure/);assert.equal(t.phase,'failed');}
  }
 }finally{if(child?.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});await rm(dir,{recursive:true,force:true});}
});
