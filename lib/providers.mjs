import {accessSync,constants,readFileSync,statSync,openSync,readSync,closeSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
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


function processSnapshot(pids){
  const args=pids?['-p',pids.join(','),'-o','pid=,ppid=,pgid=,uid=,stat=,lstart=,comm=']:['-axo','pid=,ppid=,pgid=,uid=,stat=,lstart=,comm='];
  const result=spawnSync('/bin/ps',args,{encoding:'utf8',env:{...process.env,LC_ALL:'C'},timeout:1000,maxBuffer:4*1024*1024});
  if(result.error || (result.status!==0 && result.status!==1))throw Error('Could not verify managed child processes.');
  const found=new Map();
  for(const line of result.stdout.split('\n')){
    const m=line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/);
    if(m)found.set(Number(m[1]),{pid:Number(m[1]),ppid:Number(m[2]),pgid:Number(m[3]),uid:Number(m[4]),status:m[5],started:m[6],command:m[7]});
  }
  return found;
}
function startTicks(pid){
  if(process.platform!=='linux')return undefined;
  try{const text=readFileSync('/proc/'+pid+'/stat','utf8');return text.slice(text.lastIndexOf(')')+2).split(' ')[19];}catch{return undefined;}
}
const ownedStops=new WeakMap();
// A Stop snapshots ownership before the provider can exit and orphan tool sessions.
// No process enumeration occurs on normal successful completion.
export function stopOwnedProcess(child,{signal='SIGTERM',graceMs=600}={}){
  if(process.platform==='win32'){stopProcess(child,signal);return Promise.resolve({complete:true});}
  if(ownedStops.has(child))return ownedStops.get(child);
  if(!child?.pid || child.exitCode!==null)return Promise.resolve({complete:true});
  let owned;
  try{
    const all=processSnapshot(),root=all.get(child.pid);
    if(!root || root.ppid!==process.pid || root.uid!==process.getuid())throw Error('Managed process ownership could not be verified.');
    owned=[{...root,depth:0,ticks:startTicks(root.pid)}];
    for(let depth=1;depth<=32;depth++){
      const parents=new Set(owned.filter(p=>p.depth===depth-1).map(p=>p.pid));
      const next=[...all.values()].filter(p=>parents.has(p.ppid) && p.uid===root.uid && !owned.some(o=>o.pid===p.pid));
      if(!next.length)break;
      if(owned.length+next.length>128 || depth===32)throw Error('Managed process tree exceeds the cleanup limit.');
      owned.push(...next.map(p=>({...p,depth,ticks:startTicks(p.pid)})));
    }
    // Codex cooperatively cancels its separate tool groups on SIGINT.
    // Root is still verified here; later fallback never signals a negative PID.
    if(root.pgid===root.pid)process.kill(-root.pid,signal);else child.kill(signal);
  }catch(error){
    // Keep the existing root cancellation available, but do not invent ownership
    // for orphaned/unrelated PIDs when enumeration was inconclusive.
    try{child.kill(signal);}catch{}
    return Promise.resolve({complete:false,error:error.message});
  }
  graceMs=Math.min(1000,Math.max(0,graceMs));
  const pending=(async()=>{
    const surviving=()=>{
      const verified=[],ambiguous=[];
      let current;
      try{current=processSnapshot(owned.map(p=>p.pid));}
      catch{return {verified,ambiguous:owned};}
      for(const old of owned){
        const now=current.get(old.pid);
        if(!now || now.status.startsWith('Z'))continue;
        if(now.uid!==old.uid || now.started!==old.started)continue;
        if(old.ticks!==undefined){
          const ticks=startTicks(old.pid);
          if(ticks===undefined)ambiguous.push(old);
          else if(ticks===old.ticks)verified.push(old); // exec/setsid preserve kernel birth identity.
        }else if(now.pgid!==old.pgid || now.command!==old.command)ambiguous.push(old);
        else verified.push(old);
      }
      return {verified,ambiguous};
    };
    const outstanding=live=>live.verified.length || live.ambiguous.length;
    const wait=async(ms)=>{
      const until=Date.now()+ms;
      do{const live=surviving();if(!outstanding(live))return live;await new Promise(resolve=>setTimeout(resolve,Math.min(60,Math.max(1,until-Date.now()))));}while(Date.now()<until);
      return surviving();
    };
    try{
      let live=await wait(graceMs);
      for(const nextSignal of ['SIGTERM','SIGKILL']){
        if(!outstanding(live))return {complete:true};
        // Identity transitions during cooperative exit are pending, not proof of
        // failure or permission to signal. Re-observe them within the deadline.
        live=surviving();
        // Signal shell parents before sleeps: killing a sleep first can release
        // a waiting shell into its next (possibly destructive) command.
        for(const p of live.verified.sort((a,b)=>a.depth-b.depth))try{process.kill(p.pid,nextSignal);}catch(error){if(error.code!=='ESRCH')throw error;}
        live=await wait(300);
      }
      // Give cooperative exit transitions a final bounded observation window.
      // No ambiguous PID is targeted during this wait.
      if(live.ambiguous.length)live=await wait(1500);
      return outstanding(live)?{complete:false,error:live.ambiguous.length?'Some managed tool identities remain unresolved after cleanup.':'Some verified managed child processes are still stopping.'}:{complete:true};
    }catch(error){return {complete:false,error:error.message};}
  })();
  ownedStops.set(child,pending);
  return pending;
}
