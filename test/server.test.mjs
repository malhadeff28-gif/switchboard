import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('accepted send returns the next chat immediately, rejects duplicate launches, and survives restart',async()=>{
 const data=await mkdtemp(path.join(os.tmpdir(),'switchboard-test-'));
 const port=44000+Math.floor(Math.random()*10000),url=`http://127.0.0.1:${port}`;
 let child;
 async function start(){child=spawn(process.execPath,[path.join(root,'server.mjs')],{env:{...process.env,PORT:String(port),SWITCHBOARD_DATA_DIR:data},stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',b=>error+=b);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(error||'Startup timeout')),10000);child.stdout.on('data',b=>{if(b.toString().includes('is running')){clearTimeout(timer);resolve();}});child.on('exit',()=>{clearTimeout(timer);reject(new Error(error));});});}
 async function stop(){await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});}
 try{
  await start();let bootstrap=await (await fetch(url+'/api/bootstrap')).json();let token=bootstrap.token;
  const post=async(route,body)=>{const res=await fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token},body:JSON.stringify(body)});return {status:res.status,json:await res.json()};};
  const rejected=await fetch(url+'/api/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(rejected.status,403);
  const originReject=await fetch(url+'/api/demo',{method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token,Origin:'https://attacker.example'},body:'{}'});assert.equal(originReject.status,403);
  const demo=await post('/api/demo',{});assert.equal(demo.status,200);const first=demo.json.chat;
  const time=performance.now();const sent=await post(`/api/chats/${first.id}/send`,{text:'Try this direction',requestId:'one'});assert.equal(sent.status,202);assert.ok(sent.json.nextId);assert.notEqual(sent.json.nextId,first.id);assert.ok(performance.now()-time<1000);
  const repeat=await post(`/api/chats/${first.id}/send`,{text:'Try this direction',requestId:'one'});assert.equal(repeat.json.duplicate,true);
  const conflict=await post(`/api/chats/${first.id}/send`,{text:'Second task',requestId:'two'});assert.equal(conflict.status,409);
  await post(`/api/chats/${first.id}/stop`,{});bootstrap=await (await fetch(url+'/api/bootstrap')).json();assert.equal(bootstrap.chats.find(c=>c.id===first.id).status,'ready');assert.match(bootstrap.chats.find(c=>c.id===first.id).error,/stopped/);
  const invalid=await post('/api/usage',{provider:'codex',used:101,resetAt:''});assert.equal(invalid.status,400);
  const saved=await post('/api/usage',{provider:'codex',used:65,resetAt:'2030-01-01T12:00:00.000Z'});assert.equal(saved.status,200);assert.equal(saved.json.usage.codex.used,65);
  await post('/api/ideas',{text:'A calendar that understands context'});await stop();await start();bootstrap=await (await fetch(url+'/api/bootstrap')).json();token=bootstrap.token;assert.equal(bootstrap.ideas[0].text,'A calendar that understands context');assert.equal(bootstrap.chats.length,3);assert.equal(bootstrap.usage.codex.used,65);assert.equal(bootstrap.usage.codex.resetAt,'2030-01-01T12:00:00.000Z');const cleared=await post('/api/usage',{provider:'codex',clear:true});assert.equal(cleared.json.usage.codex,undefined);
  await post('/api/demo/clear',{});bootstrap=await (await fetch(url+'/api/bootstrap')).json();assert.equal(bootstrap.chats.length,0);
 }finally{if(child?.exitCode===null)await stop();await rm(data,{recursive:true,force:true});}
});
