import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import {availablePort} from '../scripts/available-port.mjs';
import {replyEvidence,agentPrompt} from '../lib/core.mjs';
import {makeCard} from '../lib/handoffs.mjs';
const failed={id:'7ec6c47badce91f8',kind:'tool',label:'Command failed · exit 1',text:'Verify checklist\nExit 1\nAssertion failed: expected six tasks'};
const passed={id:'3544d01ba804b7ed',kind:'tool',label:'Command succeeded · exit 0',text:'Verify checklist again\nExit 0\nAll assertions passed'};

test('prior citations use precisely the bounded selected prompt evidence and retain current facts',()=>{
 const extras=Array.from({length:12},(_,i)=>({id:'extra-'+i,label:'Extra',text:'Evidence '+i+' '+'.'.repeat(2000)}));
 const prior={id:'selected',provider:'claude',card:{summary:'Original',claims:[{sources:[failed.id,passed.id]}],evidence:[...extras,failed,passed]}};
 const inherited=replyEvidence(prior);assert.equal(inherited.length,10);assert.deepEqual(inherited.slice(0,2).map(e=>e.id),[failed.id,passed.id]);assert.ok(inherited.every(e=>e.text.length<=1800));
 const prompt=agentPrompt({title:'Test',messages:[]},'Verify','codex',prior);const input=JSON.parse(prompt.split('Current handoff: ')[1].split('\nOriginal user request')[0]);assert.deepEqual(input.result.evidence,inherited);
 const current=Array.from({length:24},(_,i)=>({id:'current-'+i,label:'Current',text:'Current '+i}));
 const payload={summary:'Checked',decision:null,options:[],claims:[{text:'Previous failure',sources:[failed.id]},{text:'Subsequent success',sources:[passed.id]},{text:'Current',sources:['current-0']},{text:'Unavailable',sources:['extra-11','unrelated-newer','invented']}]};
 const card=makeCard(payload,{facts:current,earlier:[]},inherited);assert.deepEqual(card.claims.map(c=>c.sources),[[failed.id],[passed.id],['current-0'],[]]);
 assert.equal(card.evidence.length,26);assert.deepEqual(card.evidence.slice(0,24),current);assert.match(card.evidence[24].label,/^Prior result · Command failed/);assert.equal(card.evidence[24].text,failed.text);assert.equal(current.length,24);
 assert.throws(()=>makeCard({...payload,decision:null,options:[{label:'Contradiction',tradeoff:'Invalid'}]},{facts:[]},inherited),/options without a decision/);
});

test('managed completion links cited selected originals across providers without importing newer project evidence',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sb-inherited-evidence-'));let child;
 try{
  const data=path.join(dir,'data');await mkdir(data);
  const original={id:'original',origin:'watched',provider:'claude',at:1,phase:'finished',facts:[failed,passed],earlier:[],analysis:'ready',card:{summary:'Checklist tests',decision:'Review verification?',options:[],claims:[],evidence:[failed,passed,{id:'uncited',label:'Uncited',text:'Not inherited'}]}};
  const newer={...original,id:'newer',at:2,card:{...original.card,evidence:[{id:'newer-secret',label:'Other work',text:'Must not be inherited'}]}};
  const chat={id:'project',title:'Checklist',cwd:dir,provider:'codex',permission:'read',status:'ready',messages:[],sessions:{},turns:[original,newer],displayTurn:'newer'};
  await writeFile(path.join(data,'workspace.json'),JSON.stringify({chats:[chat],ideas:[]}));
  const bin=path.join(dir,'fake-codex');
  const response='The earlier assertion failed, then verification passed.\n<<<SWITCHBOARD_HANDOFF>>>'+JSON.stringify({summary:'Verified earlier tests',decision:null,options:[],claims:[{text:'Failed first',sources:[failed.id]},{text:'Passed later',sources:[passed.id]},{text:'Unavailable source',sources:['newer-secret']}]});
  await writeFile(bin,`#!/usr/bin/env node
if(process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(response)}}})));
`,{mode:0o755});
  const port=await availablePort(),base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),SWITCHBOARD_DATA_DIR:data,SWITCHBOARD_CODEX_BIN:bin,SWITCHBOARD_CLAUDE_BIN:bin},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>errors+=b);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors||'Startup timeout')),10000);child.stdout.on('data',b=>{if(b.toString().includes('is running')){clearTimeout(timer);resolve();}});});
  const get=async()=> (await fetch(base+'/api/bootstrap')).json();const {token}=await get();
  const r=await fetch(base+'/api/chats/project/send',{method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token},body:JSON.stringify({text:'Verify selected result',turnId:'original',provider:'codex'})});assert.equal(r.status,202);
  let c;for(let i=0;i<100;i++){c=(await get()).chats[0];if(c.status!=='running')break;await delay(20);}
  const turn=c.turns.at(-1);assert.equal(turn.provider,'codex');assert.equal(turn.replyTo,'original');assert.equal(turn.analysis,'ready');assert.deepEqual(turn.card.claims.map(c=>c.sources),[[failed.id],[passed.id],[]]);
  const sources=turn.card.evidence;assert.equal(sources.find(e=>e.id===failed.id).text,failed.text);assert.match(sources.find(e=>e.id===failed.id).label,/Prior result/);assert.equal(sources.some(e=>['uncited','newer-secret'].includes(e.id)),false);assert.ok(sources.some(e=>e.label==='Agent response'));
  // The new turn's execution facts remain its own; inherited sources live only on its card.
  assert.equal(turn.card.evidence.filter(e=>e.label.startsWith('Prior result')).length,2);
  const stored=JSON.parse(await readFile(path.join(data,'workspace.json'),'utf8')).chats[0].turns.at(-1);
  assert.equal(stored.facts.some(e=>[failed.id,passed.id].includes(e.id)),false);
 }finally{if(child?.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});await rm(dir,{recursive:true,force:true});}
});
