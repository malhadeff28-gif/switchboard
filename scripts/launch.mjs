import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import {workspaceIdentity} from '../lib/workspace.mjs';
const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const port=Number(process.env.PORT||4317);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('PORT must be between 1 and 65535.');
const url='http://127.0.0.1:'+port;
const appData=process.platform==='darwin'?path.join(os.homedir(),'Library','Application Support'):process.platform==='win32'?(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local')):(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local','share'));
process.env.SWITCHBOARD_DATA_DIR||=path.join(appData,'Switchboard');
await mkdir(process.env.SWITCHBOARD_DATA_DIR,{recursive:true,mode:0o700});
const workspace=workspaceIdentity(process.env.SWITCHBOARD_DATA_DIR);
async function runningWorkspace(){
  try{
    const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(800)});
    const health=await r.json();
    return health.app==='switchboard'?health:null;
  }catch{return null;}
}
function openWorkspace(){
  console.log('Open '+url+' in your browser. Keep this window open while using Switchboard.');
  if(process.env.SWITCHBOARD_NO_BROWSER==='1')return;
  const bin=process.platform==='darwin'?'/usr/bin/open':process.platform==='win32'?'rundll32.exe':'xdg-open';
  const child=spawn(bin,process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url],{stdio:'ignore',detached:true});
  child.on('error',()=>console.log('Open '+url+' to continue.'));child.unref();
}
const running=await runningWorkspace();
if(running?.version===version && running.workspace===workspace)openWorkspace();
else if(running)throw Error(`Another Switchboard workspace or version is already running at ${url}. Close its launcher before opening this one.`);
else {
  await import('../server.mjs');
  for(let i=0;i<120;i++){
    const health=await runningWorkspace();
    if(health?.version===version && health.workspace===workspace){openWorkspace();break;}
    await new Promise(r=>setTimeout(r,200));
  }
}
