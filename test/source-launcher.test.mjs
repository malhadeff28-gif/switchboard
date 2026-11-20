import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {workspaceIdentity} from '../lib/workspace.mjs';
import {createRequire} from 'node:module';
const root=fileURLToPath(new URL('../',import.meta.url));
const {version}=createRequire(import.meta.url)('../package.json');

test('source launcher checks workspace and version, preserves local defaults and explicit Node',{skip:process.platform!=='darwin',timeout:10000},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'switchboard-source-launch-'));
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/health'?health:{token:'other-workspace'}));});
 let health;
 try{
  for(const sub of ['scripts','lib','bin','.local','intended'])await mkdir(path.join(dir,sub));
  for(const file of ['Launch Switchboard.command','scripts/launch.mjs','lib/workspace.mjs','package.json'])await copyFile(path.join(root,file),path.join(dir,file));
  // An explicit Node must win over PATH. Any accidental browser launch fails.
  for(const bin of ['node','open','xdg-open'])await writeFile(path.join(dir,'bin',bin),'#!/bin/sh\necho Unexpected '+bin+' >&2\nexit 91\n',{mode:0o755});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  async function launch(data){
   const env={...process.env,PORT:String(port),SWITCHBOARD_NODE:process.execPath,SWITCHBOARD_NO_BROWSER:'1',PATH:path.join(dir,'bin')+':'+process.env.PATH};
   if(data)env.SWITCHBOARD_DATA_DIR=data;else delete env.SWITCHBOARD_DATA_DIR;
   const child=spawn('/bin/zsh',[path.join(dir,'Launch Switchboard.command')],{env});
   let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
   const [code]=await once(child,'close');return {code,output};
  }
  const intended=path.join(dir,'intended');
  health={app:'switchboard',version,workspace:'different-workspace'};
  let result=await launch(intended);assert.notEqual(result.code,0);assert.match(result.output,/Another Switchboard workspace or version/);assert.doesNotMatch(result.output,/Unexpected open|Open http/);
  health={app:'switchboard',version:'wrong-version',workspace:workspaceIdentity(intended)};
  result=await launch(intended);assert.notEqual(result.code,0);assert.match(result.output,/Another Switchboard workspace or version/);
  health={app:'switchboard',version,workspace:workspaceIdentity(intended)};
  result=await launch(intended);assert.equal(result.code,0,result.output);assert.match(result.output,/Open http/);assert.doesNotMatch(result.output,/Unexpected/);
  health.workspace=workspaceIdentity(path.join(dir,'.local'));
  result=await launch();assert.equal(result.code,0,result.output);assert.match(result.output,/Open http/);
 }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
