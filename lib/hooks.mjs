import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

function atomic(file,text){const tmp=file+'.switchboard-'+process.pid;fs.writeFileSync(tmp,text,{mode:0o600});fs.renameSync(tmp,file);}
function quoted(s){return process.platform==='win32'?"'"+s.replaceAll("'","''")+"'":"'"+s.replaceAll("'","'\\''")+"'";}
export function setClaudeHooks(storage,ids) {
  const dir=path.join(storage,'claude-hook'), dest=path.join(dir,'record.cjs');
  if(!ids.length && !fs.existsSync(dir))return;
  fs.mkdirSync(path.join(dir,'events'),{recursive:true,mode:0o700});
  const runtime=path.join(dir,process.platform==='win32'?'node.exe':'node');
  if(ids.length){
    if(!fs.existsSync(runtime)||fs.statSync(runtime).size!==fs.statSync(process.execPath).size){
      fs.copyFileSync(process.execPath,runtime+'.tmp');fs.chmodSync(runtime+'.tmp',0o700);fs.renameSync(runtime+'.tmp',runtime);
    }
    atomic(dest,fs.readFileSync(fileURLToPath(new URL('../scripts/claude-hook.cjs',import.meta.url))));
  }
  const command=(process.platform==='win32'?'& ':'')+quoted(runtime)+' '+quoted(dest);
  const configDir=process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude');
  const file=path.join(configDir,'settings.json');
  fs.mkdirSync(configDir,{recursive:true,mode:0o700});
  const original=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'{}';
  let settings;try{settings=JSON.parse(original.replace(/^\uFEFF/,''));}catch{throw Error('Claude settings.json is unreadable. Your settings were preserved.');}
  if(!settings || Array.isArray(settings) || typeof settings!=='object')throw Error('Invalid Claude settings file.');
  settings.hooks||={};
  if(ids.length && settings.disableAllHooks)throw Error('Claude hooks are disabled in your settings. Enable them to watch this chat.');
  for(const event of ['Stop','StopFailure']){
    const groups=settings.hooks[event]||[];
    const kept=groups.map(g=>({...g,hooks:g.hooks.filter(h=>h.command!==command)})).filter(g=>g.hooks.length);
    if(ids.length)kept.push({hooks:[{type:'command',command,timeout:5,...(process.platform==='win32'?{shell:'powershell'}:{})}]});
    if(kept.length)settings.hooks[event]=kept;else delete settings.hooks[event];
  }
  const next=JSON.stringify(settings,null,2)+'\n';
  if(next!==original){
    if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')!==original)throw Error('Claude settings changed. Retry following the chat.');
    atomic(file,next);
  }
  atomic(path.join(dir,'watched.json'),JSON.stringify(ids));
}
export function drainHooks(storage,accept) {
  const dir=path.join(storage,'claude-hook','events');
  if(!fs.existsSync(dir))return;
  for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.json')).sort()){
    const file=path.join(dir,name);
    const event=JSON.parse(fs.readFileSync(file,'utf8'));
    accept(event);fs.unlinkSync(file);
  }
}
