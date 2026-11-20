import {accessSync,constants,statSync,openSync,readSync,closeSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const macApps={
  codex:['Codex.app','ChatGPT.app'],
  claude:['Claude.app']
};

export function desktopApplication(provider,{platform=process.platform,home=os.homedir(),stat=statSync}={}) {
  const bundles=macApps[provider];
  if(platform!=='darwin' || !bundles)return null;
  for(const folder of ['/Applications',path.join(home,'Applications')]){
    for(const bundle of bundles){
      const application=path.join(folder,bundle);
      try {
        if(stat(path.join(application,'Contents','Info.plist')).isFile())return {name:path.basename(bundle,'.app'),application};
      } catch {}
    }
  }
  return null;
}

function macOpen(args,runner=spawn) {
  return new Promise((resolve,reject)=>{
    const child=runner('/usr/bin/open',args,{stdio:'ignore'});
    child.once('error',reject);
    child.once('close',code=>code===0?resolve():reject(Error('macOS could not open the sign-in app.')));
  });
}

export function openProviderDesktop(provider,{detect=desktopApplication,runner=spawn}={}) {
  const app=detect(provider);
  if(!app)throw Error('The desktop app is unavailable. Use the provider’s other sign-in option.');
  return macOpen(['-a',app.application],runner);
}

const shellQuote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
export async function openProviderTerminal(provider,binary,env) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'switchboard-sign-in-'));
  const file=path.join(dir,'Sign in.command');
  const config=provider==='claude'?'CLAUDE_CONFIG_DIR':'CODEX_HOME';
  const setup=env[config]?`export ${config}=${shellQuote(path.resolve(env[config]))}\n`:'';
  const args=provider==='claude'?'auth login':'login';
  const script=`#!/bin/sh\nrm -f -- ${shellQuote(file)}\nrmdir -- ${shellQuote(dir)} 2>/dev/null\n${setup}exec ${shellQuote(path.resolve(binary))} ${args}\n`;
  try {
    writeFileSync(file,script,{mode:0o700,flag:'wx'});
    await macOpen(['-a','Terminal',file]);
  } catch(error) {
    rmSync(dir,{recursive:true,force:true});
    throw error;
  }
}

export function findBinary(provider,env,{platform=process.platform,home=os.homedir(),stat=statSync,access=accessSync}={}) {
  const override=env['SWITCHBOARD_'+provider.toUpperCase()+'_BIN'];
  const dirs=[...String(env.PATH||env.Path||'').split(path.delimiter),path.join(home,'.local','bin')].filter(Boolean);
  if(platform==='darwin')dirs.push('/opt/homebrew/bin','/usr/local/bin');
  if(platform==='win32'&&env.APPDATA)dirs.push(path.join(env.APPDATA,'npm'));
  if(platform==='win32'&&env.LOCALAPPDATA)dirs.push(path.join(env.LOCALAPPDATA,'Programs','OpenAI','Codex','bin'));
  if(provider==='codex'&&env.CODEX_INSTALL_DIR)dirs.push(env.CODEX_INSTALL_DIR);
  const files=override?[override]:[];
  for(const dir of dirs){
    if(platform==='win32'){
      files.push(path.join(dir,provider+'.exe'));
      const js=provider==='codex'?['@openai','codex','bin','codex.js']:['@anthropic-ai','claude-code','cli.js'];
      files.push(path.join(dir,'node_modules',...js));
      if(provider==='claude')files.push(path.join(dir,'node_modules','@anthropic-ai','claude-code','bin','claude.exe'));
    }else files.push(path.join(dir,provider));
  }
  if(provider==='codex' && platform==='darwin'){
    for(const folder of ['/Applications',path.join(home,'Applications')]){
      files.push(path.join(folder,'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
        path.join(folder,'Codex.app/Contents/Resources/codex'));
    }
  }
  return files.find(p=>{
    try {
      if(!stat(p).isFile())return false;
      // spawnCli runs JS entrypoints through Node; native Unix candidates
      // must be executable by this user, not merely present on disk.
      if(platform!=='win32')access(p,/\.[cm]?js$/i.test(p)?constants.R_OK:constants.X_OK);
      return true;
    } catch {return false;}
  });
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
