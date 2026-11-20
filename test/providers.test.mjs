import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {findBinary,spawnCli} from '../lib/providers.mjs';

test('Unix provider discovery skips nonexecutable PATH files and symlink targets', {skip:process.platform==='win32'},async()=>{
 const tmp=await mkdtemp(path.join(os.tmpdir(),'sb-binary-'));
 try{
  const first=path.join(tmp,'first'),second=path.join(tmp,'second');
  await mkdir(first);await mkdir(second);
  for(const provider of ['codex','claude']){
   const unusable=path.join(first,provider),usable=path.join(second,provider);
   await writeFile(unusable,'#!/bin/sh\necho unusable\n',{mode:0o600});
   await writeFile(usable,'#!/bin/sh\nprintf "%s\\n" "$*"\n',{mode:0o700});
   assert.equal(spawnSync(unusable,['login','status']).error?.code,'EACCES');
   const env={PATH:[first,second].join(path.delimiter)};
   assert.equal(findBinary(provider,env),usable);
   assert.equal(spawnSync(findBinary(provider,env),['login','status'],{encoding:'utf8'}).stdout,'login status\n');
   const override='SWITCHBOARD_'+provider.toUpperCase()+'_BIN';
   assert.equal(findBinary(provider,{...env,[override]:unusable}),usable);
   await chmod(unusable,0o700);
   assert.equal(findBinary(provider,{...env,[override]:usable}),usable);
   assert.equal(findBinary(provider,env),unusable);
   await chmod(unusable,0o600);
   const linked=path.join(tmp,provider+'-link');await symlink(unusable,linked);
   assert.equal(findBinary(provider,{...env,[override]:linked}),usable);
  }
 }finally{await rm(tmp,{recursive:true,force:true});}
});

test('readable explicit JS settings remain usable through the Node launcher',async()=>{
 const tmp=await mkdtemp(path.join(os.tmpdir(),'sb-binary-js-'));
 try{
  const file=path.join(tmp,'provider.mjs');
  await writeFile(file,'console.log(process.argv.slice(2).join(" "));',{mode:0o600});
  const binary=findBinary('codex',{PATH:'',SWITCHBOARD_CODEX_BIN:file});
  assert.equal(binary,file);
  const child=spawnCli(binary,['login','status'],{stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',data=>output+=data);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,0);assert.equal(output,'login status\n');
 }finally{await rm(tmp,{recursive:true,force:true});}
});

test('Windows exe and npm JS discovery preserves file-based checks and override priority',()=>{
 const home=path.join(os.tmpdir(),'sb-windows-home'),dir=path.join(home,'bin');
 const exe=path.join(dir,'codex.exe'),js=path.join(dir,'node_modules','@openai','codex','bin','codex.js');
 const options={platform:'win32',home,access(){assert.fail('Unix permissions must not gate Windows files');},stat:p=>({isFile:()=>p===exe||p===js})};
 assert.equal(findBinary('codex',{PATH:dir},options),exe);
 assert.equal(findBinary('codex',{PATH:dir,SWITCHBOARD_CODEX_BIN:js},options),js);
 assert.equal(findBinary('codex',{PATH:dir},{...options,stat:p=>({isFile:()=>p===js})}),js);
});

test('Unix JS entries require readability while native entries require executability',()=>{
 const home=path.join(os.tmpdir(),'sb-access-home'),js=path.join(home,'fixture.js');
 const checks=[];
 const options={platform:'linux',home,stat:p=>({isFile:()=>p===js}),access:(p,mode)=>checks.push({p,mode})};
 assert.equal(findBinary('codex',{SWITCHBOARD_CODEX_BIN:js},options),js);
 assert.deepEqual(checks,[{p:js,mode:constants.R_OK}]);
 assert.equal(findBinary('codex',{SWITCHBOARD_CODEX_BIN:js},{...options,access(){throw Error('denied');}}),undefined);
});
