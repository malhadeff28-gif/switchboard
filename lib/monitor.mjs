import {newWatch,pollTranscript,observeHook} from './turns.mjs';
import {rawCard,sourceCard,makeCard,analyzeTurn} from './handoffs.mjs';
import {drainHooks,setClaudeHooks} from './hooks.mjs';

// Excerpts predate watch hydration. Match only the same source turn's time
// window, never text alone: later real turns may repeat the same response.
function snapshotMessage(chat,turn) {
  if(chat.sourceSession!==chat.watch?.session || chat.watch?.provider!==turn.provider)return;
  const candidates=chat.messages.filter(m=>m.imported && m.role==='assistant' && m.provider===turn.provider
    && !m.id?.startsWith('source-') && (!m.sourceSession || m.sourceSession===chat.watch.session)
    && Number.isFinite(m.at) && Number.isFinite(turn.startedAt) && m.at>=turn.startedAt && m.at<=turn.at
    && m.text===(turn.answer||turn.phase).slice(0,14000));
  return candidates.length===1?candidates[0]:undefined;
}

export function createMonitor({state,storage,save,publish,binaries,env,isConnected,onResponse}) {
  let polling=false,closed=false;
  const analyses=new Map(), reads=new Map();
  function changed(){save();publish();}
  function accept(chat,turn){
    chat.turns||=[];
    const existing=chat.turns.find(t=>t.id===turn.id && t.provider===turn.provider);
    if(existing){
      if(existing.phase===turn.phase && existing.answer===turn.answer)return;
      if(existing.origin!=='watched')return;
      if(analyses.get(chat.id)?.turnId===turn.id)analyses.get(chat.id).abort();
      const message=chat.messages.find(m=>m.id==='source-'+turn.id && m.provider===turn.provider);
      if(message){message.text=turn.answer||turn.phase;message.at=turn.at;}
      delete existing.analysisError;
      Object.assign(existing,turn,{card:rawCard(turn),analysis:turn.phase==='finished'?'queued':'raw'});
      return;
    }
    const item={...turn,origin:'watched',card:rawCard(turn),analysis:turn.phase==='finished'?'queued':'raw'};
    const latest=chat.turns.find(t=>t.id===(chat.unseenWatchedTurn||chat.displayTurn));
    const historyIndex=chat.turns.findIndex(t=>t.at>item.at);
    chat.turns.splice(historyIndex<0?chat.turns.length:historyIndex,0,item);
    const message={id:'source-'+item.id,role:'assistant',imported:true,provider:item.provider,text:item.answer||item.phase,at:item.at};
    const excerpt=snapshotMessage(chat,item);
    if(excerpt)Object.assign(excerpt,message);
    else {
      const messageIndex=chat.messages.findIndex(m=>m.at>item.at);
      chat.messages.splice(messageIndex<0?chat.messages.length:messageIndex,0,message);
    }
    if(latest && latest.at>item.at)return;
    if(!['running','stopping'].includes(chat.status)){
      chat.displayTurn=item.id;chat.status='ready';chat.readyAt=Date.now();
      delete chat.unseenWatchedTurn;
    }else{
      chat.unseenWatchedTurn=item.id;
    }
  }
  function read(chat){
    if(!chat.watch?.enabled)return;
    if(reads.has(chat.id))return reads.get(chat.id);
    const pending=readTranscript(chat).finally(()=>reads.delete(chat.id));
    reads.set(chat.id,pending);
    return pending;
  }
  async function readTranscript(chat){
    try{
      const changedFile=await pollTranscript(chat.watch,t=>accept(chat,t));
      if(chat.watch.error || changedFile){delete chat.watch.error;changed();}
    }catch(e){if(chat.watch.error!==e.message){chat.watch.error=e.message;changed();}}
  }
  async function watch(chat,source) {
    const selected=chat.watch?.file===source.transcriptPath?chat.watch:newWatch(source);
    if(source.provider==='claude')setClaudeHooks(storage,[...new Set([...state.chats.filter(c=>c.watch?.enabled && c.watch.provider==='claude').map(c=>c.watch.session),source.sourceSession])]);
    chat.watch=selected;chat.watch.enabled=true;changed();await read(chat);schedule();
  }
  function pause(chat) {
    if(!chat.watch)return;
    if(chat.watch.provider==='claude')setClaudeHooks(storage,state.chats.filter(c=>c!==chat&&c.watch?.enabled&&c.watch.provider==='claude').map(c=>c.watch.session));
    chat.watch.enabled=false;analyses.get(chat.id)?.abort();changed();
  }
  function schedule(){
    if(closed)return;
    for(const chat of state.chats){
      if(analyses.size>=2)break;
      if(!chat.watch?.enabled || analyses.has(chat.id))continue;
      const turn=chat.turns?.find(t=>t.analysis==='queued');
      if(!turn)continue;
      if(!isConnected(turn.provider)){turn.analysis='error';turn.analysisError='Connect '+turn.provider+' and retry the handoff.';changed();continue;}
      const controller=new AbortController();controller.turnId=turn.id;analyses.set(chat.id,controller);
      const timer=setTimeout(()=>controller.abort(),90000);
      turn.analysis='analyzing';changed();
      analyzeTurn(binaries[turn.provider],env,turn,chat,controller.signal).then(payload=>{
        if(closed||controller.signal.aborted)return;
        turn.card=makeCard(payload,turn);turn.analysis='ready';delete turn.analysisError;onResponse(turn.provider);
      }).catch(error=>{
        if(closed || turn.analysis!=='analyzing')return;
        if(error.code==='CODEX_WRITER_ACTIVE' || error.code==='STALE_TURN'){
          turn.card=sourceCard(turn);
          turn.analysis='source';
          delete turn.analysisError;
          return;
        }
        turn.analysis='error';
        turn.analysisError=String(error.message||error).slice(0,500);
      }).finally(()=>{clearTimeout(timer);analyses.delete(chat.id);if(!closed){changed();schedule();}});
    }
  }
  function readHooks(){
    drainHooks(storage,h=>{
      const chat=state.chats.find(c=>c.watch?.enabled && c.watch.provider==='claude' && c.watch.session===h.session_id);
      if(chat){const turn=observeHook(chat.watch,h);if(turn){accept(chat,turn);changed();}}
    });
  }
  async function refresh(chats){
    await Promise.all(chats.map(read));
    readHooks();
  }
  async function poll(){
    if(closed || polling)return;
    polling=true;
    try{
      for(const chat of state.chats)await read(chat);
      readHooks();
      schedule();
    }catch(e){console.error('Monitor:',e.message);}finally{polling=false;}
  }
  for(const chat of state.chats)for(const t of chat.turns||[]){
    if(t.analysis==='analyzing')t.analysis='queued';
    if(t.origin!=='watched')continue;
    const excerpt=snapshotMessage(chat,t);
    if(excerpt && chat.messages.some(m=>m.id==='source-'+t.id && m.provider===t.provider)){
      chat.messages.splice(chat.messages.indexOf(excerpt),1);
    }
  }
  const timer=setInterval(poll,1000);timer.unref();
  return {watch,pause,poll,refresh,schedule,close(){closed=true;clearInterval(timer);for(const c of analyses.values())c.abort();}};
}
