import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import {spawnCli,stopOwnedProcess} from '../lib/providers.mjs';
import {availablePort} from '../scripts/available-port.mjs';

async function fixture(dir){
 const worker=path.join(dir,'worker.cjs'),provider=path.join(dir,'provider.cjs');
 await writeFile(worker,`const fs=require('node:fs');process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[2],'WORKER-START\\n');setTimeout(()=>{fs.appendFileSync(process.argv[2],'STALE-OVERWRITE\\n');process.exit(0);},2200);`);
 await writeFile(provider,`const fs=require('node:fs'),{spawn}=require('node:child_process');if(process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}const worker=spawn(process.execPath,[${JSON.stringify(worker)},process.env.STOP_OUTPUT],{detached:true,stdio:'ignore'});worker.unref();process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));const timer=setInterval(()=>{if(fs.existsSync(process.env.STOP_OUTPUT)){clearInterval(timer);console.log(JSON.stringify({ready:true,worker:worker.pid}));}},10);setInterval(()=>{},1000);process.stdin.resume();`);
 return provider;
}
async function ready(file){for(let i=0;i<150;i++){try{if((await readFile(file,'utf8')).includes('WORKER-START'))return;}catch{}await delay(10);}throw Error('Worker did not start');}

test('owned cancellation cleans detached descendants after root exit and preserves unrelated process', {skip:process.platform==='win32'},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sb-owned-stop-'));let root,unrelated;
 try{
  const provider=await fixture(dir),output=path.join(dir,'managed'),other=path.join(dir,'unrelated');
  unrelated=spawn(process.execPath,['-e',`setTimeout(()=>{require('node:fs').writeFileSync(process.argv[1],'UNRELATED-SURVIVED');},1800);setInterval(()=>{},1000);`,other],{detached:true,stdio:'ignore'});
  root=spawnCli(provider,[],{detached:true,env:{...process.env,STOP_OUTPUT:output},stdio:['pipe','pipe','pipe']});await ready(output);
  const result=await stopOwnedProcess(root,{signal:'SIGINT',graceMs:100});assert.equal(result.complete,true);
  assert.notEqual(root.exitCode,null);await delay(2350);
  assert.equal(await readFile(output,'utf8'),'WORKER-START\n');assert.equal(await readFile(other,'utf8'),'UNRELATED-SURVIVED');assert.equal(unrelated.exitCode,null);
 }finally{if(root?.exitCode===null)root.kill('SIGKILL');if(unrelated?.exitCode===null)unrelated.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});

test('server retains Stopping and folder exclusion until orphan cleanup finishes, and shutdown awaits cleanup', {skip:process.platform==='win32'},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sb-server-stop-'));let server;
 try{
  const provider=await fixture(dir),output=path.join(dir,'managed'),data=path.join(dir,'data');
  const port=await availablePort(),base=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),SWITCHBOARD_DATA_DIR:data,SWITCHBOARD_CODEX_BIN:provider,SWITCHBOARD_CLAUDE_BIN:provider,STOP_OUTPUT:output},stdio:['ignore','pipe','pipe']});
  let errors='';server.stderr.on('data',b=>errors+=b);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors||'Startup timeout')),10000);server.stdout.on('data',b=>{if(b.toString().includes('is running')){clearTimeout(timer);resolve();}});});
  const get=async()=> (await fetch(base+'/api/bootstrap')).json();const {token}=await get();
  const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token},body:JSON.stringify(body)});return {status:r.status,json:await r.json()};};
  const create=async()=>{const r=await post('/api/chats',{title:'Managed stop',cwd:dir,provider:'codex'});await post(`/api/chats/${r.json.chat.id}/update`,{permission:'edit'});return r.json.chat.id;};
  const id=await create(),second=await create();assert.equal((await post(`/api/chats/${id}/send`,{text:'Start durable worker'})).status,202);await ready(output);
  assert.equal((await post(`/api/chats/${id}/stop`,{})).status,200);
  let c=(await get()).chats.find(c=>c.id===id);assert.equal(c.status,'stopping');
  assert.equal((await post(`/api/chats/${second}/send`,{text:'Must not overlap cleanup'})).status,409);
  for(let i=0;i<150;i++){c=(await get()).chats.find(c=>c.id===id);if(c.status==='ready')break;await delay(20);}assert.equal(c.status,'ready');assert.match(c.error,/stopped/);assert.equal(c.turns.at(-1).phase,'interrupted');
  await delay(2350);assert.equal(await readFile(output,'utf8'),'WORKER-START\n');
  // A second worker is cancelled on server shutdown; its late write cannot outlive exit.
  await rm(output);assert.equal((await post(`/api/chats/${id}/send`,{text:'Start worker for shutdown'})).status,202);await ready(output);
  await new Promise(resolve=>{server.once('exit',resolve);server.kill('SIGTERM');});assert.equal(server.exitCode,0);
  await delay(2350);assert.equal(await readFile(output,'utf8'),'WORKER-START\n');
 }finally{if(server?.exitCode===null)await new Promise(resolve=>{server.once('exit',resolve);server.kill('SIGTERM');});await rm(dir,{recursive:true,force:true});}
});

test('detached tool shell and its sleep are cancelled before the stale follow-up command', {skip:process.platform==='win32'},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sb-shell-stop-'));let root;
 try{
  const file=path.join(dir,'marker'),provider=path.join(dir,'shell-provider.cjs');
  await writeFile(provider,`const {spawn}=require('node:child_process');const worker=spawn('/bin/sh',['-c','printf "SHELL-START\\\\n" >> "$1"; sleep 2; printf "STALE-SNAPSHOT\\\\n" >> "$1"','owned-tool',process.argv[2]],{detached:true,stdio:'ignore'});worker.unref();process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000);`);
  root=spawnCli(provider,[file],{detached:true,stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await readFile(file,'utf8')).includes('SHELL-START'))break;}catch{}await delay(10);}
  const pending=stopOwnedProcess(root,{signal:'SIGINT',graceMs:100});assert.equal(stopOwnedProcess(root,{signal:'SIGINT'}),pending);assert.equal((await pending).complete,true);
  await delay(2100);assert.equal((await readFile(file,'utf8')).includes('STALE-SNAPSHOT'),false);
 }finally{if(root?.exitCode===null)root.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});


test('ambiguous macOS identity transitions are re-observed without targeting that PID',async()=>{
 const source=(await readFile(new URL('../lib/providers.mjs',import.meta.url),'utf8')).split('\n').filter(line=>!line.startsWith('import ')).join('\n').replaceAll('export ','');
 const row=(pid,ppid,pgid,command,start='Fri Nov 20 12:00:00 2026')=>`${pid} ${ppid} ${pgid} 501 S ${start} ${command}\n`;
 const root=row(100,42,100,'/managed'),worker=row(200,100,200,'/tool-shell'),transition=row(200,1,200,'/tool-cleanup');
 async function run(polls,graceMs=10){
  const signals=[];let captures=0;
  const context=vm.createContext({process:{platform:'darwin',pid:42,getuid:()=>501,env:{},kill:(pid,signal)=>signals.push([pid,signal])},spawnSync:()=>({status:0,stdout:captures++===0?root+worker:polls[Math.min(captures-2,polls.length-1)]}),setTimeout:(callback)=>setTimeout(callback,1)});
  vm.runInContext(source+'\nglobalThis.stop=stopOwnedProcess;',context);
  const result=await context.stop({pid:100,exitCode:null,kill(){}},{signal:'SIGINT',graceMs});return {result,signals,captures};
 }
 const transitioned=await run([transition,transition,'']);assert.equal(transitioned.result.complete,true);assert.ok(transitioned.captures>=4);assert.deepEqual(transitioned.signals,[[-100,'SIGINT']]);
 const reused=await run([row(200,1,200,'/unrelated','Fri Nov 20 12:00:01 2026')]);assert.equal(reused.result.complete,true);assert.deepEqual(reused.signals,[[-100,'SIGINT']]);
 const unresolved=await run([transition],0);assert.equal(unresolved.result.complete,false);assert.match(unresolved.result.error,/identities remain unresolved/);assert.deepEqual(unresolved.signals,[[-100,'SIGINT']]);
});
