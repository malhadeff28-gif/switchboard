import {realpath,stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {localReferences} from '../public/local-files.js';

export async function revealProjectFile(chat,target,{platform=process.platform,run=spawn}={}){
 if(platform!=='darwin')throw new Error('Reveal in Finder is available on macOS.');
 if(typeof target!=='string' || !path.isAbsolute(target) || target.includes('\0') || target.split(path.sep).includes('..'))throw new Error('Choose a referenced project file.');
 const texts=[chat.summary,...(chat.messages||[]).map(m=>m.text),...(chat.turns||[]).flatMap(t=>[t.answer,t.card?.summary,t.card?.decision,...(t.card?.claims||[]).map(c=>c.text)])];
 if(!texts.some(text=>localReferences(text).some(link=>link.path===target)))throw new Error('This file is not referenced in this project.');
 let folder,file,info;
 try{folder=await realpath(chat.cwd);file=await realpath(target);info=await stat(file);}catch{throw new Error('The referenced project file is unavailable.');}
 const relative=path.relative(folder,file);
 if(!relative || relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative) || !info.isFile())throw new Error('Choose a regular file inside this project folder.');
 await new Promise((resolve,reject)=>{
  const child=run('/usr/bin/open',['-R',file],{stdio:'ignore'});
  child.once('error',()=>reject(new Error('Could not reveal this file in Finder.')));
  child.once('close',code=>code===0?resolve():reject(new Error('Could not reveal this file in Finder.')));
 });
}
