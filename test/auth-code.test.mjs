import {availablePort} from '../scripts/available-port.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {desktopApplication,openProviderDesktop} from '../lib/providers.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('desktop sign-in opens an installed provider app and leaves authentication with the provider',async()=>{
 const home=path.join(os.tmpdir(),'switchboard home');
 const application=path.join(home,'Applications','Claude.app');
 const options={platform:'darwin',home,stat:file=>({isFile:()=>file===path.join(application,'Contents','Info.plist')})};
 assert.equal(desktopApplication('codex',options),null);
 assert.equal(desktopApplication('claude',{...options,platform:'linux'}),null);
 let args;
 await openProviderDesktop('claude',{
  detect:provider=>desktopApplication(provider,options),
  runner:(command,arguments_)=>{
   args=[command,...arguments_];
   const child=new EventEmitter();
   queueMicrotask(()=>child.emit('close',0));
   return child;
  }
 });
 assert.deepEqual(args,['/usr/bin/open','-a',application]);
 assert.throws(()=>openProviderDesktop('codex',{detect:()=>null}),/unavailable/);
});

test('Codex sign-in names the installed Mac app that will open',()=>{
 const home=path.join(os.tmpdir(),'switchboard home');
 for(const name of ['Codex','ChatGPT']){
  const application=path.join(home,'Applications',name+'.app');
  const options={platform:'darwin',home,stat:file=>({isFile:()=>file===path.join(application,'Contents','Info.plist')})};
  assert.deepEqual(desktopApplication('codex',options),{name,application});
 }
});

test('authorization code reaches the waiting CLI without being saved',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'switchboard-auth-')),bin=path.join(dir,'claude-fake'),data=path.join(dir,'data');
 const fixture='#!/usr/bin/env node\n'+String.raw`
const fs=require('node:fs'),args=process.argv.slice(2),marker=process.argv[1]+'.signed-in';
if(args.includes('status')){console.log(JSON.stringify({loggedIn:fs.existsSync(marker)}));process.exit(fs.existsSync(marker)?0:1);}
if(args.includes('login')){process.stdout.write('Paste code here if prompted > ');process.stdin.setEncoding('utf8');process.stdin.once('data',text=>{if(text.trim()==='local-test-code'){fs.writeFileSync(marker,'yes');process.exit(0);}process.exit(1);});}
`;
 await writeFile(bin,fixture,{mode:0o755});
 const port=await availablePort(),base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,[path.join(root,'server.mjs')],{env:{...process.env,PORT:String(port),SWITCHBOARD_DATA_DIR:data,SWITCHBOARD_CODEX_BIN:bin,SWITCHBOARD_CLAUDE_BIN:bin},stdio:['ignore','pipe','pipe']});
 let error='';child.stderr.on('data',b=>error+=b);let token;
 async function get(){const r=await fetch(base+'/api/bootstrap');return r.json();}
 async function post(route,body){const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
 try{
  let state;for(let i=0;i<100;i++){try{state=await get();break;}catch{await delay(40);}}
  assert.ok(state,error);token=state.token;assert.equal(state.connections.claude.signedIn,false);
  assert.equal((await post('/api/connections/code',{provider:'claude',code:'local-test-code'})).status,400);
  assert.equal((await post('/api/connections/login',{provider:'claude'})).status,200);
  for(let i=0;i<100;i++){state=await get();if(state.connections.claude.instructions?.includes('Paste code'))break;await delay(40);}
  assert.match(state.connections.claude.instructions,/Paste code/);
  assert.equal((await post('/api/connections/code',{provider:'claude',code:'line1\nline2'})).status,400);
  assert.equal((await post('/api/connections/code',{provider:'claude',code:'local-test-code'})).status,200);
  for(let i=0;i<100;i++){state=await get();if(state.connections.claude.signedIn&&!state.connections.claude.signingIn)break;await delay(40);}
  assert.equal(state.connections.claude.signedIn,true);assert.doesNotMatch(JSON.stringify(state),/local-test-code/);
 }finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}const disk=await readFile(path.join(data,'workspace.json'),'utf8').catch(()=>'');assert.doesNotMatch(disk,/local-test-code/);await rm(dir,{recursive:true,force:true});}
});
