import {readdir, stat, open, readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function filesAt(dir, depth=5) {
  if (!depth) return [];
  const entries = await readdir(dir, {withFileTypes:true}).catch(() => []);
  const groups = await Promise.all(entries.map(e => e.isDirectory() && e.name !== 'subagents' ? filesAt(path.join(dir,e.name),depth-1) : e.isFile() && e.name.endsWith('.jsonl') ? [path.join(dir,e.name)] : []));
  return groups.flat();
}
async function boundedRecords(file) {
  const handle = await open(file,'r');
  try {
    const {size} = await handle.stat();
    const chunks = [];
    for (const [start,len] of size < 150000 ? [[0,size]] : [[0,24000],[Math.max(24000,size-126000),126000]]) {
      const buffer = Buffer.alloc(len);
      const {bytesRead} = await handle.read(buffer,0,len,start);
      chunks.push(buffer.subarray(0,bytesRead).toString('utf8'));
    }
    const parsed=chunks.map(c => c.split('\n').flatMap(line => {try{return [JSON.parse(line)];}catch{return [];}}));
    return {records:parsed.flat(),recentRecords:parsed.at(-1)||[]};
  } finally {await handle.close();}
}
function contentText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(x => ['text','input_text','output_text'].includes(x.type)).map(x => x.text || '').join('\n') : '';
}
export async function discover({home=os.homedir(), exclude=process.env.SWITCHBOARD_EXCLUDE_SESSION}={}) {
  const codexHome = process.env.CODEX_HOME || path.join(home,'.codex');
  const titles = new Map();
  for (const line of (await readFile(path.join(codexHome,'session_index.jsonl'),'utf8').catch(()=>'')).split('\n')) {
    try {const t = JSON.parse(line); titles.set(t.id,t.thread_name);} catch {}
  }
  const sources = [['codex',path.join(codexHome,'sessions')], ['claude',path.join(home,'.claude','projects')]];
  const candidates = [];
  for (const [provider,root] of sources) {
    const files = await filesAt(root);
    const timed = await Promise.all(files.map(async file => ({file,provider,mtime:(await stat(file)).mtimeMs})).map(p => p.catch(()=>null)));
    candidates.push(...timed.filter(Boolean).sort((a,b)=>b.mtime-a.mtime).slice(0,45));
  }
  const found = await Promise.all(candidates.map(async ({file,provider,mtime}) => {
    try {
      const {records,recentRecords} = await boundedRecords(file);
      const meta = records.find(r=>r.type==='session_meta')?.payload || {};
      const id = provider==='codex' ? meta.id : records.find(r=>r.sessionId)?.sessionId;
      const cwd = meta.cwd || records.find(r=>r.cwd)?.cwd;
      if (!id || !cwd || id===exclude) return null;
      const messages = [];
      let title = titles.get(id);
      for (const r of records) {
        if (r.type==='custom-title') title=r.customTitle;
        if (provider==='codex' && r.type==='response_item' && r.payload?.type==='message' && ['user','assistant'].includes(r.payload.role)) {
          const text=contentText(r.payload.content);
          if (text && !text.startsWith('<environment_context>') && !text.startsWith('<external_codex_apps_') && !text.startsWith('<send_user_message_question_reply>')) messages.push({role:r.payload.role,text:text.slice(0,14000),provider});
        }
        if (provider==='codex' && r.type==='event_msg' && r.payload?.type==='task_complete' && r.payload.last_agent_message) {
          const text=r.payload.last_agent_message;
          if(messages.at(-1)?.text!==text)messages.push({role:'assistant',text:text.slice(0,14000),provider});
        }
        if (provider==='claude' && ['user','assistant'].includes(r.type) && !r.isSidechain && r.message?.content) {
          const text=contentText(r.message.content);
          if (text && !text.startsWith('<local-command') && !text.startsWith('<command-') && !text.startsWith('<system-reminder>')) messages.push({role:r.type,text:text.slice(0,14000),provider});
        }
      }
      if (!messages.length && !title) return null;
      const first = messages.find(m=>m.role==='user')?.text || path.basename(cwd);
      title=title || first.replace(/<[^>]*>/g,'').replace(/\s+/g,' ').slice(0,85);
      const last=messages.findLast(m=>m.role==='assistant')?.text || messages.findLast(m=>m.role==='user')?.text || 'No recent conversation text is available in this excerpt. Open the original chat for its full history.';
      // Only the tail can establish current status: the head of a large file
      // may contain a completed turn from before a later, omitted start event.
      // Use unknown when the tail has no status; otherwise use record order.
      const recentStatus=recentRecords.findLast(r=>r.type==='event_msg'&&['task_started','task_complete'].includes(r.payload?.type)&&(!r.payload.root_turn_id||r.payload.root_turn_id===r.payload.turn_id));
      const desktopStatus=recentStatus?.payload.type==='task_started'?'working':recentStatus?.payload.type==='task_complete'?'ready':'unknown';
      return {id:`${provider}:${id}`,sourceSession:id,provider,title,cwd,updatedAt:mtime,summary:last.slice(0,1800),messages:messages.slice(-8),transcriptPath:file,
        desktopSupported:provider==='codex'&&meta.originator==='Codex Desktop'&&meta.source==='vscode',
        desktopStatus};
    } catch {return null;}
  }));
  return found.filter(Boolean).sort((a,b)=>b.updatedAt-a.updatedAt);
}
