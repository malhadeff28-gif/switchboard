import test from 'node:test';
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
  await writeFile(file,JSON.stringify({type:'session_meta',payload:meta})+'\n'+JSON.stringify(started('old'))+'\n');await listener.start();assert.equal(events.length,0);
  const record=JSON.stringify(started('new'));await appendFile(file,record.slice(0,80));await listener.poll();assert.equal(events.length,0);await appendFile(file,record.slice(80)+'\n');await listener.poll();
  for(let n=0;n<30&&events.length===0;n++)await new Promise(r=>setTimeout(r,10));assert.equal(events.length,1);assert.equal(events[0].turnId,'new');await listener.poll();assert.equal(events.length,1);
  const complete=Buffer.from(JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_complete',turn_id:'new',root_turn_id:'new',last_agent_message:'Résumé ready. ✔'}})+'\n');const split=complete.indexOf(Buffer.from('é'))+1;
  await appendFile(file,complete.subarray(0,split));await listener.poll();assert.equal(events.length,1);await appendFile(file,complete.subarray(split));await listener.poll();for(let n=0;n<30&&events.length<2;n++)await new Promise(r=>setTimeout(r,10));assert.equal(events[1].kind,'complete');assert.equal(events[1].summary,'Résumé ready. ✔');
  listener.stop();await appendFile(file,JSON.stringify(started('after-pause'))+'\n');await listener.poll();assert.equal(events.length,2);
 }finally{listener.stop();await rm(dir,{recursive:true,force:true});}
});
