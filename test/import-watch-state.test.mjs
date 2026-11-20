import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,readFile,rename} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {availablePort} from '../scripts/available-port.mjs';

test('reimport preserves watch state, serializes new imports and rolls back failed initial follow',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sb-import-watch-'));
 let child;
 try{
  const data=path.join(dir,'data'),codexHome=path.join(dir,'codex'),claude=path.join(dir,'claude');
  await Promise.all([mkdir(data),mkdir(path.join(codexHome,'sessions'),{recursive:true}),mkdir(path.join(claude,'projects','sample'),{recursive:true})]);
  for(const id of ['first','legacy'])await writeFile(path.join(codexHome,'sessions',id+'.jsonl'),JSON.stringify({type:'session_meta',payload:{id,cwd:dir}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:'A project'}})+'\n');
  await writeFile(path.join(claude,'projects','sample','chat.jsonl'),JSON.stringify({type:'user',sessionId:'claude-failure',cwd:dir,message:{content:'Test failed follow'}})+'\n');
  await writeFile(path.join(claude,'settings.json'),'{"disableAllHooks":true}');
  const bin=path.join(dir,'fake-cli');await writeFile(bin,'#!/usr/bin/env node\nprocess.exit(1);\n',{mode:0o755});
  const port=await availablePort(),base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),SWITCHBOARD_DATA_DIR:data,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:claude,SWITCHBOARD_CODEX_BIN:bin,SWITCHBOARD_CLAUDE_BIN:bin},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>errors+=b);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors||'Startup timeout')),10000);child.stdout.on('data',b=>{if(b.toString().includes('is running')){clearTimeout(timer);resolve();}});});
  const get=async()=> (await fetch(base+'/api/bootstrap')).json();
  const {token}=await get();
  const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token},body:JSON.stringify(body)});return {status:r.status,json:await r.json()};};
  await fetch(base+'/api/discover');
  const follow=(id,watch=true)=>post('/api/import',{id,watch});
  const simultaneous=await Promise.all([follow('codex:first'),follow('codex:first')]);
  assert.deepEqual(simultaneous.map(r=>r.status),[201,201]);
  const id=simultaneous[0].json.chat.id;
  assert.equal(simultaneous[1].json.chat.id,id);assert.equal((await get()).chats.length,1);
  assert.equal((await follow('codex:first',false)).json.chat.watch.enabled,true);
  // Duplicate imports are no-ops even when a redundant save would fail.
  const workspace=path.join(data,'workspace.json');
  await rename(workspace,workspace+'.saved');await mkdir(workspace);
  try{assert.equal((await follow('codex:first')).status,201);}
  finally{await rm(workspace,{recursive:true});await rename(workspace+'.saved',workspace);}
  await post(`/api/chats/${id}/pause-watch`,{});
  assert.equal((await follow('codex:first')).json.chat.watch.enabled,false);
  await post(`/api/chats/${id}/resume-watch`,{});
  assert.equal((await follow('codex:first')).json.chat.watch.enabled,true);
  const legacy=await follow('codex:legacy',false);assert.equal(legacy.json.chat.watch,undefined);
  const upgraded=await follow('codex:legacy');assert.equal(upgraded.json.chat.id,legacy.json.chat.id);assert.equal(upgraded.json.chat.watch.enabled,true);
  const failed=await follow('claude:claude-failure');assert.equal(failed.status,400);assert.match(failed.json.error,/hooks are disabled/);
  assert.equal((await get()).chats.length,2);
  assert.equal(JSON.parse(await readFile(path.join(data,'workspace.json'),'utf8')).chats.length,2);
  await writeFile(path.join(claude,'settings.json'),'{}');
  // Fail persistence after successful Claude hook setup; rollback must unwatch it.
  await rename(workspace,workspace+'.saved');await mkdir(workspace);
  try{
    const unsaved=await follow('claude:claude-failure');assert.equal(unsaved.status,503);
    assert.equal((await get()).chats.length,2);
    assert.deepEqual(JSON.parse(await readFile(path.join(data,'claude-hook','watched.json'),'utf8')),[]);
    const settings=JSON.parse(await readFile(path.join(claude,'settings.json'),'utf8'));
    assert.equal(settings.hooks?.Stop,undefined);
  }finally{await rm(workspace,{recursive:true});await rename(workspace+'.saved',workspace);}
  const retry=await follow('claude:claude-failure');assert.equal(retry.status,201);assert.equal(retry.json.chat.watch.enabled,true);assert.equal((await get()).chats.length,3);
 }finally{
  if(child?.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});
  await rm(dir,{recursive:true,force:true});
 }
});
