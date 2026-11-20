import {open} from 'node:fs/promises';
import {nativeLifecycle} from './desktop-lifecycle.mjs';
import {messageText,userContent} from './transcript.mjs';

// Safety-only inspection: never advance the paused watch or expose its contents.
// A bounded tail without a definitive lifecycle is deliberately inconclusive.
export async function pausedLifecycle(watch){
  let handle;
  try{
    handle=await open(watch.file,'r');
    const before=await handle.stat();
    const start=Math.max(0,before.size-1024*1024),buffer=Buffer.alloc(before.size-start);
    let count=0;
    while(count<buffer.length){const {bytesRead}=await handle.read(buffer,count,buffer.length-count,start+count);if(!bytesRead)break;count+=bytesRead;}
    const after=await handle.stat();
    if(count!==buffer.length || before.size!==after.size || before.mtimeMs!==after.mtimeMs)return 'unknown';
    let text=buffer.toString('utf8');
    if(start){const newline=text.indexOf('\n');if(newline<0)return 'unknown';text=text.slice(newline+1);}
    const state={};let claude='unknown';
    for(const line of text.split('\n')){
      if(!line.trim())continue;
      let record;try{record=JSON.parse(line);}catch{return 'unknown';}
      if(watch.provider==='codex'){
        if(record.type==='session_meta' && record.payload?.id && record.payload.id!==watch.session)return 'unknown';
        nativeLifecycle(record,watch.session,state);
        if(state.status!=='working' && record.type==='turn_context' && record.payload?.turn_id && record.payload.turn_id!==state.turn)state.status='unknown';
        if(state.status!=='working' && record.type==='event_msg' && record.payload?.type==='user_message')state.status='unknown';
      }else if(watch.provider==='claude'){
        if(record.isSidechain || record.agentId || (record.sessionId && record.sessionId!==watch.session))continue;
        if(record.type==='user' && !record.isMeta && userContent(messageText(record.message?.content))){claude='working';}
        if(record.type==='assistant'){
          const stop=record.message?.stop_reason;
          if(record.isApiErrorMessage || record.error || ['end_turn','stop_sequence','max_tokens'].includes(stop))claude='ready';
          else claude='working'; // Includes tool use and incomplete streamed responses.
        }
        // turn_duration is provisional; hooks are deliberately not enabled/read here.
      }
    }
    return watch.provider==='codex'?state.status||'unknown':claude;
  }catch{return 'unknown';}
  finally{try{await handle?.close();}catch{}}
}
