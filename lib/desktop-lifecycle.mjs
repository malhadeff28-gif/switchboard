// State belongs to one selected transcript. Attribution roots can name the
// sending chat, so they are not themselves evidence of a nested turn.
export function nativeLifecycle(record, session, state={}) {
  const p=record?.payload || {};
  if(record?.isSidechain || record?.agentId || (record?.sessionId && record.sessionId!==session) || (p.thread_id && p.thread_id!==session))return null;
  if(p.turn_attribution?.initiating_agent_path){
    if(p.turn_id)(state.nested ||= new Set()).add(p.turn_id);
    return null;
  }
  if(state.nested?.has(p.turn_id))return null;
  if(record?.type==='turn_context' || (record?.type==='event_msg' && p.type==='item_completed')){
    if(p.turn_id && p.thread_id===session)state.context=p.turn_id;
    return null;
  }
  if(record?.type!=='event_msg')return null;
  const attributed=p.root_turn_id && p.root_turn_id!==p.turn_id;
  if(['task_started','turn_started'].includes(p.type)){
    const a=p.turn_attribution;
    const ownAppTurn=p.turn_id && a?.turn_id===p.turn_id && a?.root_turn_id===p.root_turn_id && a?.parent_turn_id && typeof a?.turn_trigger==='string' && a.turn_trigger.startsWith('app_tool_');
    if(attributed && !ownAppTurn)return null;
    state.turn=p.turn_id;state.context=undefined;state.status='working';
    return {kind:a?.turn_trigger==='composer'?'submit':'working',turnId:p.turn_id};
  }
  if(['task_complete','turn_complete','task_failed','turn_failed','turn_aborted'].includes(p.type)){
    if(attributed && (!p.turn_id || (p.turn_id!==state.turn && p.turn_id!==state.context)))return null;
    // A completion for another turn cannot release the current working turn.
    if(state.status==='working' && state.turn && p.turn_id && p.turn_id!==state.turn)return null;
    state.turn=p.turn_id;state.status='ready';
    return {kind:'complete',turnId:p.turn_id};
  }
  return null;
}
export function nativeStatus(records,session){
  const state={};for(const record of records)nativeLifecycle(record,session,state);
  return state.status || 'unknown';
}
