import test from 'node:test';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CodexSubmitListener,desktopEvent,nextDesktop,codexChatUrl,codexBrainstormUrl} from '../lib/desktop.mjs';
const id='00000000-0000-4000-8000-000000000001',meta={id,originator:'Codex Desktop',source:'vscode'};
const started=(turn,trigger='composer')=>({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_started',turn_id:turn,root_turn_id:turn,turn_attribution:{turn_trigger:trigger,initiating_agent_path:null}}});
test('only desktop composer events cause handoffs; automations and agent messages only mark busy',()=>{
 assert.equal(desktopEvent(started('one'),meta).kind,'submit');
 for(const trigger of ['automation_heartbeat_scheduled','app_tool_send_message','goal_continuation'])assert.equal(desktopEvent(started('one',trigger),meta).kind,'working');
 assert.equal(desktopEvent(started('one'),{...meta,originator:'codex_exec'}),null);
 assert.equal(desktopEvent(started('one'),{...meta,source:'exec'}),null);
 const child=started('child');child.payload.root_turn_id='parent';assert.equal(desktopEvent(child,meta),null);
 assert.equal(desktopEvent(started('one'),{...meta,id:'../../anything'}),null);
});
test('existing-chat URL is narrowly constrained and the queue skips busy chats and the sending chat',()=>{
 assert.equal(codexChatUrl(id),`codex://threads/${id}`);assert.throws(()=>codexChatUrl('new?prompt=oops'));
 const brainstorm=new URL(codexBrainstormUrl());assert.equal(brainstorm.protocol,'codex:');assert.equal(brainstorm.host,'threads');assert.equal(brainstorm.pathname,'/new');assert.match(brainstorm.searchParams.get('prompt'),/think through an idea/);
 const queue=['codex:a','codex:b','codex:c','codex:d'],statuses=new Map([['codex:b','working'],['codex:c','unknown'],['codex:d','ready']]);assert.equal(nextDesktop(queue,statuses,'codex:a'),'codex:d');assert.equal(nextDesktop(['codex:a','codex:b','codex:c'],statuses,'codex:a'),null);assert.equal(nextDesktop(['missing'],statuses,'codex:a'),null);
});
test('live file follower ignores old submissions and detects a fragmented new prompt-start record once',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'switchboard-native-')),file=path.join(dir,'sample.jsonl');
 const listener=new CodexSubmitListener({root:dir,pollMs:30});const events=[];listener.on('event',e=>events.push(e));listener.on('listenerError',e=>{throw e;});
 try{
  await writeFile(file,JSON.stringify({type:'session_meta',payload:{...meta,base_instructions:'x'.repeat(36000)}})+'\n'+JSON.stringify(started('old'))+'\n');await listener.start();assert.equal(events.length,0);
  const record=JSON.stringify(started('new'));await appendFile(file,record.slice(0,80));await listener.poll();assert.equal(events.length,0);await appendFile(file,record.slice(80)+'\n');await listener.poll();
  for(let n=0;n<30&&events.length===0;n++)await new Promise(r=>setTimeout(r,10));assert.equal(events.length,1);assert.equal(events[0].turnId,'new');await listener.poll();assert.equal(events.length,1);
  const complete=Buffer.from(JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_complete',turn_id:'new',root_turn_id:'new',last_agent_message:'Résumé ready. ✔'}})+'\n');const split=complete.indexOf(Buffer.from('é'))+1;
  await appendFile(file,complete.subarray(0,split));await listener.poll();assert.equal(events.length,1);await appendFile(file,complete.subarray(split));await listener.poll();for(let n=0;n<30&&events.length<2;n++)await new Promise(r=>setTimeout(r,10));assert.equal(events[1].kind,'complete');assert.equal(events[1].summary,'Résumé ready. ✔');
  listener.stop();await appendFile(file,JSON.stringify(started('after-pause'))+'\n');await listener.poll();assert.equal(events.length,2);
 }finally{listener.stop();await rm(dir,{recursive:true,force:true});}
});

const appStarted=(turn='received')=>({type:'event_msg',payload:{type:'task_started',turn_id:turn,root_turn_id:'sender-root',turn_attribution:{turn_id:turn,root_turn_id:'sender-root',parent_turn_id:'sender-root',turn_trigger:'app_tool_send_message',initiating_agent_path:null}}});
const appComplete=(turn='received')=>({type:'event_msg',payload:{type:'task_complete',turn_id:turn,root_turn_id:'sender-root',last_agent_message:'Ready'}});
test('native attributed turns update readiness without triggering a composer handoff',()=>{
 const state={};assert.equal(desktopEvent(appStarted(),meta,state).kind,'working');
 assert.equal(desktopEvent({...appComplete('foreign'),payload:{...appComplete('foreign').payload,thread_id:'another-chat'}},meta,state),null);
 const nested=appStarted('nested');nested.payload.turn_attribution.initiating_agent_path='child';
 assert.equal(desktopEvent(nested,meta,state),null);assert.equal(desktopEvent(appComplete('nested'),meta,state),null);
 assert.equal(state.status,'working');assert.equal(desktopEvent(appComplete(),meta,state).kind,'complete');assert.equal(state.status,'ready');
 assert.equal(desktopEvent(appComplete(),meta,{}),null);
 const tail={};desktopEvent({type:'event_msg',payload:{type:'item_completed',turn_id:'received',thread_id:id}},meta,tail);
 assert.equal(desktopEvent(appComplete(),meta,tail).kind,'complete');
 const ambiguous={};desktopEvent({type:'turn_context',payload:{turn_id:'received'}},meta,ambiguous);assert.equal(desktopEvent(appComplete(),meta,ambiguous),null);
 const foreign={};desktopEvent({type:'turn_context',payload:{turn_id:'received',thread_id:'foreign'}},meta,foreign);
 assert.equal(desktopEvent(appComplete(),meta,foreign),null);
 const invalid=appStarted();invalid.payload.turn_attribution.turn_id='other';assert.equal(desktopEvent(invalid,meta,{}),null);
});
test('listener seeds existing attributed context without emitting a submission',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'switchboard-attributed-')),file=path.join(dir,'sample.jsonl');
 const listener=new CodexSubmitListener({root:dir,pollMs:10000}),events=[];listener.on('event',e=>events.push(e));
 try{
  await writeFile(file,[{type:'session_meta',payload:meta},appStarted()].map(JSON.stringify).join('\n')+'\n');
  await listener.start();assert.deepEqual(events,[]);
  const completed=once(listener,'event',{signal:AbortSignal.timeout(5000)});
  await appendFile(file,JSON.stringify(appComplete())+'\n');await listener.poll();
  assert.equal((await completed)[0].kind,'complete');
  assert.deepEqual(events.map(e=>e.kind),['complete']);
  const working=once(listener,'event',{signal:AbortSignal.timeout(5000)});
  await appendFile(file,JSON.stringify(appStarted('followup'))+'\n');await listener.poll();
  assert.equal((await working)[0].kind,'working');
  assert.deepEqual(events.map(e=>e.kind),['complete','working']);
 }finally{listener.stop();await rm(dir,{recursive:true,force:true});}
});
