import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {discover} from '../lib/discovery.mjs';
test('bounded discovery finds the final desktop handoff and excludes the current session',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'switchboard-history-'));
 const previous=process.env.CODEX_HOME;delete process.env.CODEX_HOME;
 try{
  const dir=path.join(home,'.codex','sessions','2026','10','13');await mkdir(dir,{recursive:true});
  const rows=[{type:'session_meta',payload:{id:'sample',cwd:home}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Build a useful calendar'}]}},{type:'response_item',payload:{type:'function_call_output',output:'x'.repeat(220000)}},{type:'event_msg',payload:{type:'task_complete',last_agent_message:'The calendar draft is ready. Choose the default view.'}}];
  await writeFile(path.join(dir,'sample.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n'));
  const activeId='00000000-0000-4000-8000-000000000001';
  await writeFile(path.join(home,'.codex','session_index.jsonl'),[JSON.stringify({id:'sample',thread_name:'Calendar project'}),JSON.stringify({id:activeId,thread_name:'Active chat'})].join('\n'));
  await writeFile(path.join(dir,'active.jsonl'),[{type:'session_meta',payload:{id:activeId,cwd:home,originator:'Codex Desktop',source:'vscode'}},{type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'x'.repeat(220000)}]}},{type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_started',turn_id:'one',root_turn_id:'one'}}].map(r=>JSON.stringify(r)).join('\n'));
  const unknownId='00000000-0000-4000-8000-000000000002';
  await appendFile(path.join(home,'.codex','session_index.jsonl'),'\n'+JSON.stringify({id:unknownId,thread_name:'Uncertain chat'}));
  await writeFile(path.join(dir,'unknown.jsonl'),[{type:'session_meta',payload:{id:unknownId,cwd:home,originator:'Codex Desktop',source:'vscode'}},{type:'event_msg',payload:{type:'task_complete',turn_id:'old',root_turn_id:'old'}},{type:'response_item',payload:{type:'function_call_output',output:'x'.repeat(220000)}}].map(r=>JSON.stringify(r)).join('\n'));
  const claudeDir=path.join(home,'.claude','projects','sample');await mkdir(claudeDir,{recursive:true});
  await writeFile(path.join(claudeDir,'claude.jsonl'),[{type:'user',sessionId:'claude-sample',cwd:home,message:{content:'Draft an outline'}},{type:'assistant',sessionId:'claude-sample',message:{content:[{type:'text',text:'The outline is ready.'}]}},{type:'custom-title',customTitle:'Outline project'}].map(r=>JSON.stringify(r)).join('\n'));
  const found=await discover({home,exclude:'unrelated'});assert.equal(found.length,4);
  const codex=found.find(x=>x.sourceSession==='sample');assert.equal(codex.title,'Calendar project');assert.equal(codex.summary,'The calendar draft is ready. Choose the default view.');assert.equal(codex.messages.length,2);
  const active=found.find(x=>x.sourceSession===activeId);assert.equal(active.title,'Active chat');assert.equal(active.desktopSupported,true);assert.equal(active.desktopStatus,'working');assert.equal(active.messages.length,0);
  assert.equal(found.find(x=>x.provider==='claude').title,'Outline project');
  assert.equal(found.find(x=>x.sourceSession===unknownId).desktopStatus,'unknown');
  await appendFile(path.join(dir,'active.jsonl'),'\n'+JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'one',root_turn_id:'one'}})+'\n');
  assert.equal((await discover({home,exclude:'unrelated'})).find(x=>x.sourceSession===activeId).desktopStatus,'ready');
  assert.equal((await discover({home,exclude:'sample'})).length,3);
 }finally{if(previous!==undefined)process.env.CODEX_HOME=previous;await rm(home,{recursive:true,force:true});}
});
