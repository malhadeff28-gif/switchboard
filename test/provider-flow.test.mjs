import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('provider process flow carries context, resumes sessions, and discards failed new sessions',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'switchboard-provider-'));
 const data=path.join(dir,'data'), project=path.join(dir,'project');
 await mkdir(project);
 const fixture='#!/usr/bin/env node\n'+String.raw`
const provider=process.argv[1].includes('codex')?'codex':'claude';
const args=process.argv.slice(2);
if(args.includes('status')) {if(provider==='codex') console.log('Logged in using ChatGPT');else {console.error('Harmless status warning');console.log(JSON.stringify({loggedIn:true}));}process.exit(0);}
if(provider==='claude'&&args.includes('auth')&&args.includes('login')){const fs=require('node:fs');const marker=process.argv[1]+'.login';if(!fs.existsSync(marker)){fs.writeFileSync(marker,'retry');console.error('sensitive temporary code');process.exit(1);}process.exit(0);}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
 const emit=o=>console.log(JSON.stringify(o));
 const bad=input.includes('FORCE_AUTH_FAILURE');
 const session=bad?'unusable-session':provider+'-session';
 if(provider==='codex')emit({type:'thread.started',thread_id:session});else emit({type:'system',subtype:'init',session_id:session});
 if(bad){emit({type:'result',is_error:true,errors:['OAuth session expired']});return;}
 const resumed=provider==='codex'?args.includes('resume')&&args.includes(session):args.includes('--resume')&&args.includes(session);
 const hasContext=input.includes('blue-otter-147');
 const answer=(hasContext?'blue-otter-147':'missing-context')+(resumed?' resumed':' new')+'\n<<<SWITCHBOARD_HANDOFF>>>'+JSON.stringify({summary:'Remember blue-otter-147',decisions:['Use the blue plan'],next_action:'Choose the next step'});
 if(provider==='codex')emit({type:'item.completed',item:{type:'agent_message',text:answer}});else emit({type:'result',is_error:false,result:answer,session_id:session});
});`;
 const codex=path.join(dir,'codex-fake'),claude=path.join(dir,'claude-fake');
 await Promise.all([writeFile(codex,fixture,{mode:0o755}),writeFile(claude,fixture,{mode:0o755})]);
 const port=45000+Math.floor(Math.random()*10000),base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,[path.join(root,'server.mjs')],{env:{...process.env,PORT:String(port),SWITCHBOARD_DATA_DIR:data,SWITCHBOARD_CODEX_BIN:codex,SWITCHBOARD_CLAUDE_BIN:claude},stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',b=>errors+=b);
 let token;
 async function get(){const r=await fetch(base+'/api/bootstrap');return r.json();}
 async function post(route,body){const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token},body:JSON.stringify(body)});const json=await r.json();assert.ok(r.ok,JSON.stringify(json));return json;}
 async function turn(id,text){await post(`/api/chats/${id}/send`,{text});for(let i=0;i<100;i++){await delay(40);const c=(await get()).chats.find(x=>x.id===id);if(c.status==='ready')return c;}throw Error('Turn timed out');}
 try{
  let initial;for(let i=0;i<100;i++){try{initial=await get();break;}catch{await delay(40);}}
  assert.ok(initial,errors);token=initial.token;assert.equal(initial.connections.codex.signedIn,true);assert.equal(initial.connections.claude.signedIn,true);
  await post('/api/connections/login',{provider:'claude'});let connection;
  for(let i=0;i<100;i++){await delay(40);connection=(await get()).connections.claude;if(!connection.signingIn&&connection.loginError)break;}
  assert.match(connection.loginError,/Sign-in did not finish/);assert.doesNotMatch(connection.loginError,/sensitive temporary code/);assert.equal(connection.signedIn,true);
  await post('/api/connections/login',{provider:'claude'});
  for(let i=0;i<100;i++){await delay(40);connection=(await get()).connections.claude;if(!connection.signingIn&&!connection.loginError)break;}
  assert.equal(connection.loginError,'');assert.equal(connection.signedIn,true);

  const {chat}=await post('/api/chats',{title:'Test',goal:'test',cwd:project,provider:'codex'});
  let c=await turn(chat.id,'Remember blue-otter-147');assert.match(c.messages.at(-1).text,/blue-otter-147 new/);assert.equal(c.nextAction,'Choose the next step');assert.deepEqual(c.decisions,['Use the blue plan']);assert.equal(c.sessions.codex,'codex-session');
  await post(`/api/chats/${chat.id}/update`,{provider:'claude'});c=await turn(chat.id,'Recall the code');assert.match(c.messages.at(-1).text,/blue-otter-147 new/);assert.equal(c.sessions.claude,'claude-session');
  await post(`/api/chats/${chat.id}/update`,{provider:'codex'});c=await turn(chat.id,'Recall the code');assert.match(c.messages.at(-1).text,/blue-otter-147 resumed/);
  await post(`/api/chats/${chat.id}/update`,{provider:'claude'});c=await turn(chat.id,'Recall the code');assert.match(c.messages.at(-1).text,/blue-otter-147 resumed/);
  const second=(await post('/api/chats',{title:'Auth error',cwd:project,provider:'claude'})).chat;c=await turn(second.id,'FORCE_AUTH_FAILURE');assert.match(c.error,/OAuth session expired/);assert.equal(c.sessions.claude,undefined);
  await post(`/api/chats/${chat.id}/reset-session`,{});c=(await get()).chats.find(x=>x.id===chat.id);assert.equal(c.sessions.claude,undefined);assert.equal(c.sessions.codex,'codex-session');assert.ok(c.messages.length>0);c=await turn(chat.id,'Recall the code');assert.match(c.messages.at(-1).text,/blue-otter-147 new/);
  // A broken native binary must not crash the whole local workspace.
  await writeFile(claude,'not an executable program',{mode:0o755});
  const refreshed=await post('/api/connections/refresh',{});assert.equal(refreshed.claude.signedIn,false);assert.match(refreshed.claude.connectionError,/Could not start Claude Code/);assert.ok((await get()).chats.length);
 }finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}await rm(dir,{recursive:true,force:true});}
});
