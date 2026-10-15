import {watch} from 'node:fs';
import {open,stat,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {StringDecoder} from 'node:string_decoder';
import path from 'node:path';
import os from 'node:os';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function codexChatUrl(id){if(!UUID.test(id))throw new Error('Invalid existing chat ID.');return `codex://threads/${id}`;}
export function codexBrainstormUrl(){return 'codex://threads/new?prompt='+encodeURIComponent('Help me think through an idea. Ask me one useful question to get started.');}
export function desktopEvent(record,meta){
  if(meta?.originator!=='Codex Desktop'||meta.source!=='vscode'||!UUID.test(meta.id))return null;
  const p=record?.payload;
  if(record.type!=='event_msg')return null;
  if(p?.type==='task_started'){
    const a=p.turn_attribution;
    if(a?.initiating_agent_path||p.root_turn_id!==p.turn_id)return null;
    return {kind:a?.turn_trigger==='composer'?'submit':'working',id:`codex:${meta.id}`,turnId:p.turn_id,at:Date.parse(record.timestamp)||Date.now()};
  }
  if(p?.type==='task_complete'&&(!p.root_turn_id||p.root_turn_id===p.turn_id))return {kind:'complete',id:`codex:${meta.id}`,turnId:p.turn_id,summary:p.last_agent_message||'',at:Date.parse(record.timestamp)||Date.now()};
  return null;
}
export function nextDesktop(queue,statuses,source){return queue.find(id=>id!==source&&statuses.get(id)!=='working')||null;}
async function sessionFiles(root,depth=5){if(!depth)return[];const entries=await readdir(root,{withFileTypes:true}).catch(()=>[]);return(await Promise.all(entries.map(e=>e.isDirectory()?sessionFiles(path.join(root,e.name),depth-1):e.isFile()&&e.name.endsWith('.jsonl')?[path.join(root,e.name)]:[]))).flat();}
async function headMeta(file){const h=await open(file,'r');try{const b=Buffer.alloc(16384);const{bytesRead}=await h.read(b,0,b.length,0);const first=b.subarray(0,bytesRead).toString().split('\n')[0];const record=JSON.parse(first);return record.type==='session_meta'?record.payload:null;}catch{return null;}finally{await h.close();}}

// Listen to appended records only. No credentials, prompts, or whole transcripts
// are copied into the handoff event log. A composer trigger distinguishes a real
// user submission from scheduled automations and agent-to-agent messages.
export class CodexSubmitListener extends EventEmitter {
  constructor({root=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'sessions'),pollMs=750}={}){super();this.root=path.resolve(root);this.pollMs=pollMs;this.cursors=new Map();this.active=false;this.pending=new Set();this.polling=false;}
  async start(){if(this.active)return;this.active=true;const files=await sessionFiles(this.root);await Promise.all(files.map(async file=>{try{const s=await stat(file);this.cursors.set(file,{offset:s.size,buffer:'',meta:null,reading:false,decoder:new StringDecoder('utf8')});}catch{}}));
    this.watcher=watch(this.root,{recursive:true},(_,name)=>{if(name?.toString().endsWith('.jsonl'))this.read(path.resolve(this.root,name.toString())).catch(e=>this.emit('listenerError',e));});
    this.watcher.on('error',e=>this.emit('listenerError',e));
    this.timer=setInterval(()=>this.poll().catch(e=>this.emit('listenerError',e)),this.pollMs);this.timer.unref();
  }
  async poll(){if(!this.active||this.polling)return;this.polling=true;try{const files=await sessionFiles(this.root);await Promise.all(files.map(f=>this.read(f).catch(e=>this.emit('listenerError',e))));}finally{this.polling=false;}}
  async read(file){if(!this.active||!file.startsWith(this.root+path.sep))return;let c=this.cursors.get(file);if(!c){c={offset:0,buffer:'',meta:null,reading:false,decoder:new StringDecoder('utf8')};this.cursors.set(file,c);}if(c.reading){this.pending.add(file);return;}c.reading=true;
    try{const s=await stat(file).catch(()=>null);if(!s||s.size===c.offset)return;if(s.size<c.offset){c.offset=s.size;c.buffer='';c.discarding=false;c.decoder=new StringDecoder('utf8');return;}
      if(!c.meta)c.meta=await headMeta(file);if(c.meta?.originator!=='Codex Desktop'||c.meta.source!=='vscode'){c.offset=s.size;return;}
      const h=await open(file,'r');try{while(this.active&&c.offset<s.size){const b=Buffer.alloc(Math.min(262144,s.size-c.offset));const{bytesRead}=await h.read(b,0,b.length,c.offset);if(!bytesRead)break;c.offset+=bytesRead;c.buffer+=c.decoder.write(b.subarray(0,bytesRead));let n;
        while((n=c.buffer.indexOf('\n'))>=0){const line=c.buffer.slice(0,n);c.buffer=c.buffer.slice(n+1);if(c.discarding){c.discarding=false;continue;}let r;try{r=JSON.parse(line);}catch{continue;}const event=desktopEvent(r,c.meta);if(event)this.emit('event',event);}
        if(c.buffer.length>1000000){c.buffer='';c.discarding=true;}
      }}finally{await h.close();}
    }catch(error){if(error.code!=='ENOENT')throw error;}finally{c.reading=false;if(this.pending.delete(file)&&this.active)queueMicrotask(()=>this.read(file).catch(e=>this.emit('listenerError',e)));}
  }
  stop(){this.active=false;this.watcher?.close();clearInterval(this.timer);this.pending.clear();}
}

export function openInCodex(id,{runner=spawn}={}){
  const url=codexChatUrl(id);
  return dispatchCodexUrl(url,runner);
}
export function openCodexBrainstorm({runner=spawn}={}){return dispatchCodexUrl(codexBrainstormUrl(),runner);}
function dispatchCodexUrl(url,runner){
  if(process.platform!=='darwin')return Promise.reject(new Error('Native chat navigation currently requires macOS.'));
  return new Promise((resolve,reject)=>{const child=runner('/usr/bin/open',['-b','com.openai.codex',url],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',b=>error+=b);child.once('error',reject);child.once('close',code=>code===0?resolve({url,dispatched:true}):reject(new Error(error||'Codex could not open this chat.')));});
}
