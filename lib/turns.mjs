import {createHash} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {records, messageText, userContent} from './transcript.mjs';

const clip=(s,n=3000)=>typeof s==='string'?s.slice(0,n):'';
export function note(kind, label, text) {
  if (!text) return null;
  return {id:createHash('sha256').update(kind+'\n'+label+'\n'+text).digest('hex').slice(0,16),kind,label:clip(label,180),text:clip(text,3600)};
}
export function addEvidence(list,item) {
  if (item && !list.some(e=>e.id===item.id)) {list.push(item); if(list.length>24)list.splice(1,1);}
}
export function managedEvidence(provider,r) {
  const i=r.item;
  if (provider==='codex' && r.type==='item.completed') {
    if(i?.type==='command_execution')return note('tool','Command result',String(i.command||'')+'\nExit '+(i.exit_code??'unknown')+'\n'+clip(i.aggregated_output,2400));
    if(i?.type==='file_change')return note('file','File change',JSON.stringify(i.changes||[]));
  }
  if(provider==='claude' && r.type==='user') {
    const outputs=Array.isArray(r.message?.content)?r.message.content.filter(x=>x.type==='tool_result'):[];
    if(outputs.length)return note('tool','Claude tool result',outputs.map(x=>messageText(x.content)).filter(Boolean).join('\n'));
  }
}
export function constraints(history, query) {
  const terms=new Set((query.toLowerCase().match(/[a-z0-9]{4,}/g)||[]).filter(w=>!['this','that','with','what','have','from','they','which','should','would','there','about'].includes(w)));
  return history.map((n,i)=>({n,i,score:(n.text.toLowerCase().match(/[a-z0-9]{4,}/g)||[]).filter(t=>terms.has(t)).length + (/\b(must|require|only|avoid|never|budget|deadline|keep|instead|prefer|limit|without)\b/i.test(n.text)?3:0)})).sort((a,b)=>b.score-a.score||b.i-a.i).slice(0,5).map(x=>x.n);
}
export function newWatch(source) {
  return {provider:source.provider,file:source.transcriptPath,session:source.sourceSession,offset:0,history:[],phase:'unknown',enabled:true,initialized:false};
}
function begin(w,id,at) {
  if(w.current?.id===id)return;
  if(w.current && w.provider==='claude'){
    (w.previous||=[]).push(w.current);w.previous=w.previous.slice(-24);
  }
  w.current={id,provider:w.provider,at,startedAt:at,phase:'working',facts:[],request:'',answer:''};
  w.phase='working';
}
function finish(w,phase,answer,at) {
  const t=w.current;
  if(!t)return;
  t.phase=phase; t.at=at; w.phase=phase;
  t.answer=clip(answer||t.answer,24000);
  t.earlier=constraints(w.history,t.request+' '+t.answer);
  addEvidence(t.facts,note('message','Agent response',t.answer));
  return structuredClone(t);
}
function recordPrompt(w,t,text) {
  if(!userContent(text))return;
  t.request=clip(text,5000);
  const n=note('user','Earlier project instruction',text);
  if(!w.history.some(x=>x.id===n.id)) {
    w.history.push(n);
    if(w.history.length>150) {
      const i=w.history.findIndex((x,i)=>i>0 && !/\b(must|require|only|avoid|never|budget|deadline|keep|prefer|limit)\b/i.test(x.text));
      w.history.splice(i>0?i:1,1);
    }
  }
}
export function observe(w,r,end) {
  if(!r || r.isSidechain || r.agentId || (r.sessionId && r.sessionId!==w.session))return;
  const at=Number.isFinite(Date.parse(r.timestamp))?Date.parse(r.timestamp):Date.now();
  if(w.provider==='codex') {
    const p=r.payload||{};
    if(p.root_turn_id && p.turn_id && p.root_turn_id!==p.turn_id)return;
    if(r.type==='event_msg') {
      if(['task_started','turn_started'].includes(p.type)){begin(w,p.turn_id||String(end),at);return;}
      if(p.type==='user_message' && w.current)recordPrompt(w,w.current,p.message);
      const phase=({task_complete:'finished',turn_complete:'finished',turn_aborted:'interrupted',task_failed:'failed',turn_failed:'failed'})[p.type];
      if(phase){if(!w.current || (p.turn_id && w.current.id!==p.turn_id))begin(w,p.turn_id||String(end),at);return finish(w,phase,p.last_agent_message||p.reason||p.message,at);}
      if(p.type==='exec_command_end' && w.current)addEvidence(w.current.facts,note('tool','Command result',JSON.stringify(p.command||[])+'\nExit '+(p.exit_code??'unknown')+'\n'+clip(p.aggregated_output||p.stdout,2400)));
      if(p.type==='patch_apply_end' && w.current)addEvidence(w.current.facts,note('file',p.success===false?'File change failed':'File change result',Object.keys(p.changes||{}).join('\n')));
    }
    if(r.type==='response_item' && w.current) {
      if(p.type==='message' && p.role==='user')recordPrompt(w,w.current,messageText(p.content));
      if(p.type==='message' && p.role==='assistant')w.current.answer=clip(messageText(p.content),24000);
      if(p.type==='function_call_output' && typeof p.output==='string')addEvidence(w.current.facts,note('tool','Tool result',p.output));
    }
    return;
  }
  const content=messageText(r.message?.content);
  if(r.type==='user' && !r.isMeta && userContent(content)) {
    if(/^\[Request interrupted by user/i.test(content))return finish(w,'interrupted',content,at);
    begin(w,r.uuid||String(end),at);recordPrompt(w,w.current,content);return;
  }
  if(!w.current)return;
  addEvidence(w.current.facts,managedEvidence('claude',r));
  if(r.type==='assistant') {
    if(content)w.current.answer=clip(content,24000);
    if(r.isApiErrorMessage || r.error)return finish(w,'failed',content||String(r.error),at);
    if(r.message?.stop_reason==='max_tokens')return finish(w,'interrupted',content||'Output limit reached.',at);
    if(['end_turn','stop_sequence'].includes(r.message?.stop_reason))return finish(w,'finished',content,at);
  }
  if(r.type==='system' && r.subtype==='turn_duration' && w.current.answer)return finish(w,'finished',w.current.answer,at);
}

export async function pollTranscript(w, onTurn) {
  const info=await stat(w.file);
  if(w.offset>info.size){w.offset=0;w.current=null;}
  if(w.offset===info.size && w.initialized)return false;
  let latest,changed=false;
  for await (const {record,end} of records(w.file,w.offset)) {
    const turn=observe(w,record,end);
    if(turn){if(w.initialized)onTurn(turn);else latest=turn;}
    w.offset=end;changed=true;
  }
  if(latest)onTurn(latest);
  w.initialized=true;
  return changed;
}
export function observeHook(w,h) {
  if(h.session_id!==w.session)return;
  const target=[...(w.previous||[]),w.current].filter(t=>t && t.startedAt<=h.at).at(-1);
  if(!target)return;
  const context=target===w.current?w:{...w,current:target};
  if(h.hook_event_name==='Stop')return finish(context,'finished',h.last_assistant_message,h.at);
  if(h.hook_event_name==='StopFailure')return finish(context,'failed',h.error_details||h.error||'Claude Code reported an error.',h.at);
}
