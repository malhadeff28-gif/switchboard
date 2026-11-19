import {statSync,openSync,readSync,closeSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

export function findBinary(provider,env) {
  const override=env['SWITCHBOARD_'+provider.toUpperCase()+'_BIN'];
  const dirs=[...String(env.PATH||env.Path||'').split(path.delimiter),path.join(os.homedir(),'.local','bin')].filter(Boolean);
  if(process.platform==='darwin')dirs.push('/opt/homebrew/bin','/usr/local/bin');
  if(process.platform==='win32'&&env.APPDATA)dirs.push(path.join(env.APPDATA,'npm'));
  const files=override?[override]:[];
  for(const dir of dirs){
    if(process.platform==='win32'){
      files.push(path.join(dir,provider+'.exe'));
      const js=provider==='codex'?['@openai','codex','bin','codex.js']:['@anthropic-ai','claude-code','cli.js'];
      files.push(path.join(dir,'node_modules',...js));
    }else files.push(path.join(dir,provider));
  }
  if(provider==='codex' && process.platform==='darwin')files.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex','/Applications/Codex.app/Contents/Resources/codex');
  return files.find(p=>{try{return statSync(p).isFile();}catch{return false;}});
}
export function spawnCli(bin,args,opts) {
  // npm entrypoints and test fixtures can run without a shell on native Windows.
  let js=/\.[cm]?js$/i.test(bin);
  if(process.platform==='win32' && !js && !bin.toLowerCase().endsWith('.exe')){
    let fd;try{fd=openSync(bin,'r');const b=Buffer.alloc(80);readSync(fd,b);js=/^#![^\n]*\bnode\b/.test(b.toString());}catch{}finally{if(fd!==undefined)closeSync(fd);}
  }
  return spawn(js?process.execPath:bin,js?[bin,...args]:args,{...opts,windowsHide:true,detached:process.platform==='win32'?false:opts.detached});
}
export function stopProcess(child,signal='SIGTERM') {
  if(!child?.pid || child.exitCode!==null)return;
  if(process.platform==='win32'){spawnSync('taskkill.exe',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});return;}
  try{process.kill(-child.pid,signal);}catch{child.kill(signal);}
}
