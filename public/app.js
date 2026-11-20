import {renderMarkdown} from './local-files.js';
import {draftStore,replyRequestId,choiceText,editDraft} from './drafts.js';
let state={chats:[],ideas:[],connections:{}}, token='', selected=null, modalType=null, found=[], nextOffset=null, query='', sending=false, renderTimer;
let discoverySnapshotId=null;
let discoveryBatch={enabled:false,selected:new Set(),errors:new Map(),busy:false,followed:0,skipped:0};
let discoverySearch='';
let drafts;
const switchingProvider=new Set();
const signInSteps=new Map();
const signInBusy=new Set();
let autoAdvance=localStorage.getItem('switchboard-auto')!=='false';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const name=p=>p==='claude'?'Claude':'Codex';
const icon=(kind)=>({next:'↗',add:'＋',ideas:'✧',check:'✓',arrow:'→',close:'×',settings:'⚙',discover:'⌘',pause:'Ⅱ'}[kind]||'•');
function ready(){return state.chats.filter(c=>c.status==='ready').sort((a,b)=>(b.priority||0)-(a.priority||0)||a.readyAt-b.readyAt);}
function next(exclude){return ready().find(c=>c.id!==exclude)?.id||null;}
function toast(text){$('toast').textContent=text;$('toast').classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('visible'),4200);}
async function api(route,data,retry=true) {
  const response=await fetch(route,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-Switchboard-Token':token},body:data===undefined?undefined:JSON.stringify(data)});
  const json=await response.json();
  if(response.status===403 && retry && data!==undefined && json.error==='Refresh Switchboard before continuing.') {
    const connection=await api('/api/bootstrap');
    if(connection.workspace!==state.workspace)throw Error('A different Switchboard workspace is open. Reload this tab before sending.');
    token=connection.token;
    return api(route,data,false);
  }
  if(!response.ok)throw new Error(json.error||'Something went wrong.');
  return json;
}
function saveDraft(id,text,choiceTarget) {
  if (!text.trim()) return drafts.write(id,{text:''});
  const old=drafts.read(id);
  const chat=state.chats.find(c=>c.id===id);
  const target=choiceTarget || (old.text.trim() ? old : {turnId:chat?visibleTurn(chat)?.id??null:null,provider:chat?.provider});
  return drafts.write(id,{...editDraft(target,text),...(choiceTarget?{choice:choiceTarget.choice}:{}),id:target.id||crypto.randomUUID()});
}
function choose(id){selected=id;localStorage.setItem('switchboard-selected',id||'');render();}
function markdown(text,project){return renderMarkdown(text,{project,canReveal:state.canRevealFiles===true});}
function row(c){const active=c.id===selected;return `<button class="project-row ${active?'selected':''}" data-select="${c.id}"><span class="state-dot ${c.status}"></span><span class="project-copy"><span class="project-name">${esc(c.title)}</span><span class="project-sub">${c.demo?'Demo · ':''}${name(c.provider)} · ${c.status==='watching'?'Working in original chat':c.status==='running'?'Working':c.status==='stopping'?'Stopping':c.status==='parked'?'Caught up':isUserStopped(c)?'Reply stopped':c.error?'Needs attention':'Ready for you'}</span></span>${c.priority?' <span class="star">★</span>':''}</button>`;}
function render(){
 const focus=document.activeElement?.id, start=document.activeElement?.selectionStart, end=document.activeElement?.selectionEnd;
 const previousThread=$('thread'), previousChat=$('workspace')?.dataset.chat;
 const scroll=previousThread?.scrollTop;
 const openEvidence=[...(previousThread?.querySelectorAll('.handoff-card details[open][id]')??[])].map(item=>item.id);
 const chat=state.chats.find(c=>c.id===selected);
 const running=state.chats.filter(c=>['running','stopping','watching'].includes(c.status));const parked=state.chats.filter(c=>c.status==='parked');
 const filtered=c=>!query||c.title.toLowerCase().includes(query.toLowerCase());
 $('app').innerHTML=`<aside class="rail"><a class="brand" href="/" aria-label="Switchboard home"><span class="brand-mark">s<span>↗</span></span><span>switchboard<span class="brand-caption">A little less switching.</span></span></a>
 <button class="new-project" data-action="new">${icon('add')} New project</button>
 <label class="search-box"><span>⌕</span><input id="search" placeholder="Find a project" value="${esc(query)}" aria-label="Find a project"></label>
 <div class="project-lists"><div class="list-label">READY FOR YOU <span>${ready().length}</span></div>${ready().filter(filtered).map(row).join('')||'<p class="rail-empty">Your attention queue is clear.</p>'}
 ${running.length?`<div class="list-label">WORKING <span>${running.length}</span></div>${running.filter(filtered).map(row).join('')}`:''}
 ${parked.length?`<div class="list-label">CAUGHT UP <span>${parked.length}</span></div>${parked.filter(filtered).map(row).join('')}`:''}
 <button class="rail-link discover" data-action="discover">${icon('discover')} Find existing projects <span>↗</span></button></div>
 <div class="rail-bottom"><button class="rail-link ${!chat?'active-link':''}" data-action="ideas">${icon('ideas')} Ideas for later <span>${state.ideas.length}</span></button><button class="rail-link" data-action="usage">◷ Usage limits <span>↗</span></button><button class="rail-link" data-action="connections">${icon('settings')} Connections <span class="connection-dot ${Object.values(state.connections).some(c=>c.signedIn)?'connected':''}"></span></button><div class="local-label"><span class="small-dot"></span> Your local workspace <span class="version">v0.3</span></div></div></aside>
 <div class="shell"><header class="topbar"><div><span class="top-eyebrow">YOUR WORKSPACE</span><span class="top-title">Project handoffs</span></div><div class="top-controls"><a class="native-link" href="/desktop">Inside Codex ${state.desktop?.enabled?'●':'↗'}</a><label class="auto-toggle"><input id="auto" type="checkbox" ${autoAdvance?'checked':''}><span class="toggle-track"></span><span>Send & move on</span></label><button class="icon-button" data-action="next" title="Next ready chat (Alt+N)" aria-label="Next ready chat">${icon('next')}</button></div></header><nav class="mobile-nav" aria-label="Workspace tools"><button data-action="ideas">✧ Ideas</button><button data-action="discover">⌘ Find chats</button><button data-action="usage">◷ Usage</button><button data-action="connections">⚙ Connections</button><button data-action="demo">Try demo ↗</button></nav>
 <div class="workspace-grid ${chat?'':'ideas-grid'}"><main id="workspace" data-chat="${chat?.id||''}">${chat?chatView(chat):!state.chats.length&&location.hash!=='#ideas'?firstRun():ideaView(running)}</main>${chat?contextView(chat):ideaAside()}</div>
 <footer class="bottom-status"><span>${running.length?`<span class="pulse-dot"></span> ${running.length} ${running.length===1?'agent is':'agents are'} working in the background`:'<span class="small-dot"></span> Room to think'}</span><span>⌘ Enter to send <i>·</i> Alt N for next <i>·</i> Saved on this computer</span></footer></div>`;
 $('search').addEventListener('input',e=>{query=e.target.value;render();});
 $('auto').addEventListener('change',e=>{autoAdvance=e.target.checked;localStorage.setItem('switchboard-auto',String(autoAdvance));toast(autoAdvance?'Sending a prompt will take you to the next ready chat.':'You’ll stay in the chat after sending.');});
 $('prompt')?.addEventListener('input',e=>{
   const shown=visibleTurn(chat)?.id;
   saveDraft(selected,e.target.value);
   if(shown!==visibleTurn(chat)?.id){render();return;}
   updateReplyContext(chat);
 });
 $('idea-text')?.addEventListener('input',e=>saveDraft('ideas',e.target.value));
 $('composer')?.addEventListener('submit',submitPrompt);
 $('idea-form')?.addEventListener('submit',saveIdea);
 if(focus && $(focus) && previousChat===($('workspace')?.dataset.chat)){
   $(focus).focus({preventScroll:true});if(typeof start==='number' && $(focus).setSelectionRange)$(focus).setSelectionRange(start,end);
 }
 const thread=$('thread');
 if(thread && previousChat===selected){
   for(const id of openEvidence){
     const item=$(id);
     if(item)item.open=true;
   }
   if(scroll!==undefined)thread.scrollTop=scroll;
 }
}
function firstRun(){
 const connected=Object.values(state.connections).some(p=>p.signedIn);
 return `<div class="idea-workspace setup"><h1>Bring your chats into Switchboard.</h1><p class="idea-intro">See what your agents finished, review the evidence, and send your next decision from here.</p><ol><li><strong>Connect Codex or Claude Code</strong><p>${connected?'A provider sign-in was found on this computer.':'Use either provider with your own account.'}</p><button class="secondary-button" data-action="connections">Connections</button></li><li><strong>Choose your chats</strong><p>Pick the conversations you want Switchboard to follow.</p><button class="primary-button" data-action="discover">Choose chats →</button></li><li><strong>Open the latest result</strong><p>Read the handoff and send a choice or your own reply.</p></li></ol><button class="text-button" data-action="demo">Try a simulated project</button> · <button class="text-button" data-action="ideas">Open ideas</button></div>`;
}
const viewedTurns=new Map();
function visibleTurn(c) {
  const id=viewedTurns.get(c.id)??drafts.read(c.id).turnId??c.displayTurn;
  return c.turns?.find(t=>t.id===id) || c.turns?.at(-1);
}
function watchedResultToReview(c){
 const visible=visibleTurn(c);
 if(c.unseenWatchedTurn){
  const pending=c.turns?.find(t=>t.id===c.unseenWatchedTurn&&t.origin==='watched');
  return pending&&pending.id!==visible?.id?pending.id:null;
 }
 const draft=drafts.read(c.id);
 if(!draft.text.trim()||!draft.turnId||visible?.id!==draft.turnId)return null;
 const anchor=c.turns?.find(t=>t.id===draft.turnId);
 const active=c.turns?.find(t=>t.id===c.displayTurn&&t.origin==='watched');
 return active&&anchor&&active.id!==anchor.id&&active.at>anchor.at?active.id:null;
}
function watchedResultNotice(c){
 return watchedResultToReview(c)?'<div class="notice">Your original chat has another result to review. <button type="button" class="text-button" data-action="show-watched-result">Open its result ↗</button></div>':'';
}
function updateReplyContext(c){
 const target=$('reply-target'),notice=$('watched-result-notice');
 const targetHtml=replyTarget(c),noticeHtml=watchedResultNotice(c);
 if(target&&target.innerHTML!==targetHtml)target.innerHTML=targetHtml;
 if(notice){if(notice.innerHTML!==noticeHtml)notice.innerHTML=noticeHtml;notice.hidden=!noticeHtml;}
}
function showWatchedResult(c){
 const id=watchedResultToReview(c);if(!id)return;
 viewedTurns.set(c.id,id);render();
}
function replyProvider(c) { return drafts.read(c.id).provider || c.provider; }
function replyAnchor(c) {
  const draft=drafts.read(c.id);
  if (!draft.text.trim()) return visibleTurn(c)?.id??null;
  // Older drafts without a recorded result must not be attached to a newer result.
  return draft.turnId??null;
}
function resultLabel(turn) {
 const origin=turn.origin==='watched'?'Original chat':turn.origin==='managed'?'Switchboard reply':'Project result';
 const question=typeof turn.card?.decision==='string'?turn.card.decision.replace(/\s+/g,' ').trim():'';
 const preview=question.length>90?question.slice(0,89)+'…':question;
 return `${origin} · ${name(turn.provider)} · ${new Date(turn.at).toLocaleString()} · ${turn.phase}${preview?' · '+preview:''}`;
}
function replyTarget(c) {
  const id=replyAnchor(c);
  const provider=name(replyProvider(c));
  if (id===null) return 'Sending to '+provider+' for this project';
  const turn=c.turns?.find(t=>t.id===id);
  if (!turn) return 'This draft’s result is unavailable. Clear the draft to start again.';
  const show=visibleTurn(c)?.id!==id ? ' <button type="button" class="text-button" data-action="show-draft-result">Show draft’s result ↗</button>' : '';
  return `Sending to ${provider} about ${esc(resultLabel(turn))}${show}`;
}
function turnView(c){
 const t=visibleTurn(c);
 if(!t)return `<section class="handoff-card"><div class="card-kicker">Project context</div><div class="handoff-summary">${markdown(c.summary,c)}</div><p>${esc(c.nextAction)}</p></section>`;
 const card=t.card, evidence=card.evidence||[];
 const evidenceId=e=>'e-'+c.id+'-'+e.id;
 const refs=ids=>ids.map(id=>evidence.findIndex(e=>e.id===id)).filter(i=>i>=0).map(i=>`<button type="button" data-evidence="${esc(evidenceId(evidence[i]))}" aria-label="Open evidence ${i+1}">[${i+1}]</button>`).join(' ');
 const prev=c.turns.length>1?`<label class="turn-picker">Result <select id="which-turn">${c.turns.slice().reverse().map(x=>`<option value="${esc(x.id)}" ${x.id===t.id?'selected':''}>${esc(resultLabel(x))}</option>`).join('')}</select></label>`:'';
 const options=card.options.map((o,i)=>`<button class="decision-option" data-choice="${i}" ${['running','stopping'].includes(c.status)?'disabled':''}><strong>${i+1}. ${esc(o.label)}</strong><span>${esc(o.tradeoff)}</span></button>`).join('');
 const unknownDecision=t.analysis==='ready' && card.decision===null && !card.decisionFormatValid;
 const sourceOnly=t.analysis==='source';
 const hasDecision=(t.analysis==='ready'&&!unknownDecision)||(sourceOnly&&card.decision);
 const actualDecision=hasDecision && typeof card.decision==='string' && card.decision.trim();
 const decisionId='decision-'+c.id+'-'+t.id;
 const status=t.analysis==='analyzing'||t.analysis==='queued'?'Preparing the handoff…':unknownDecision?'Review the original response to confirm whether a decision is needed.':sourceOnly?'Showing the original response and recorded evidence.':t.analysisError;
 const retry=t.origin==='watched' && c.watch?.enabled && (t.analysis==='error'||sourceOnly||unknownDecision);
 return `<section class="handoff-card">${prev}<div class="card-kicker">${esc(name(t.provider))} · ${esc(t.phase)} · ${t.origin==='watched'?'Watched chat':'Switchboard turn'}</div>${actualDecision?`<button type="button" class="text-button decision-jump" data-jump-decision="${esc(t.id)}" data-jump-project="${esc(c.id)}" aria-controls="${esc(decisionId)}">Jump to decision ↓</button>`:''}<h2>What happened</h2><div class="handoff-summary">${markdown(card.summary,c)}</div>${card.claims.map(x=>`<p class="claim">${esc(x.text)} ${x.sources.length?refs(x.sources):'<small>Agent reported</small>'}</p>`).join('')}
 ${status?`<div class="analysis-status" role="status">${esc(status)} ${retry?'<button class="text-button" data-action="analyze">Retry analysis</button>':''}</div>`:''}
 ${hasDecision?`<h3 ${actualDecision?`id="${esc(decisionId)}" tabindex="-1" data-decision-result="${esc(t.id)}" data-decision-project="${esc(c.id)}"`:''}>${card.decision?(sourceOnly?'Question from the original response':'Decision'):'No decision needed'}</h3>${card.decision?`<p>${esc(card.decision)}</p><div class="decision-options">${options}</div>`:''}`:''}
 ${evidence.length?`<h3>Evidence</h3><div class="source-list">${evidence.map((e,i)=>`<details id="${esc(evidenceId(e))}"><summary>[${i+1}] ${esc(e.label)}</summary><pre>${esc(e.text)}</pre></details>`).join('')}</div>`:''}</section>`;
}
function jumpToDecision(button){
 const c=state.chats.find(chat=>chat.id===selected),turn=c&&visibleTurn(c);
 if(!turn||button.dataset.jumpProject!==c.id||button.dataset.jumpDecision!==turn.id)return;
 const pane=$('thread');
 const heading=pane&&[...pane.querySelectorAll('[data-decision-result]')].find(h=>h.dataset.decisionProject===c.id&&h.dataset.decisionResult===turn.id);
 if(!heading)return;
 const top=pane.scrollTop+heading.getBoundingClientRect().top-pane.getBoundingClientRect().top-12;
 pane.scrollTo({top:Math.max(0,top),behavior:'auto'});
 heading.focus({preventScroll:true});
}
function isUserStopped(c){
 return ['You stopped this turn.','You stopped this demo turn.'].includes(c.error)
  && c.turns?.findLast(turn=>turn.origin==='managed')?.phase==='interrupted';
}
function turnStatus(c){
 if(!c.error)return '';
 if(isUserStopped(c))return '<div class="notice" role="status"><strong>Turn stopped.</strong> Review any partial output, then send a new prompt to continue.</div>';
 return `<div class="error-card"><strong>This turn needs attention</strong><p>${esc(c.error)}</p>${/auth|oauth|sign.?in|log.?in|credential/i.test(c.error)?'<p>Your provider session may need to be refreshed.</p><button class="secondary-button" data-action="connections">Open connections ↗</button>':''}<p>If the conversation can’t be resumed, start a new provider session using the saved project context. The original provider conversation is not deleted.</p><button class="text-button" data-action="reset-session">Start a fresh ${name(c.provider)} session ↗</button></div>`;
}
function chatView(c){const busy=['running','stopping'].includes(c.status);const provider=replyProvider(c);const changing=switchingProvider.has(c.id);return `<div class="focus-heading"><div class="breadcrumb">${c.demo?'<span class="demo-tag">SIMULATED DEMO</span>':'PROJECT'} <span>/</span> ${busy?'Working in the background':c.status==='parked'?'Caught up':'Your next move'}</div><div class="title-line"><h1>${esc(c.title)}</h1><button class="icon-button ${c.priority?'pinned':''}" data-action="pin" title="Prioritize this project" aria-label="Prioritize this project">☆</button></div>
 <div class="project-meta"><div class="provider-picker"><button data-provider="codex" ${busy||changing||sending?'disabled':''} class="${provider==='codex'?'chosen':''}"><span class="provider-glyph codex">◎</span> Codex</button><button data-provider="claude" ${busy||changing||sending?'disabled':''} class="${provider==='claude'?'chosen':''}"><span class="provider-glyph claude">✳</span> Claude</button></div><button class="usage-shortcut" data-action="usage">${usageLabel(provider)}</button><span class="context-note">${c.sourceId?(c.sessions?.[provider]?'Continue Switchboard session':'Reply starts a separate '+name(provider)+' session'):'Context stays with your project'}</span><select id="permission" aria-label="Agent file access" ${busy?'disabled':''}><option value="read" ${c.permission==='read'?'selected':''}>Read only</option><option value="edit" ${c.permission==='edit'?'selected':''}>File edits</option></select></div></div>
 <div id="thread" class="thread">${state.storageError?`<div class="error-card" role="alert">${esc(state.storageError)}</div>`:''}${c.watch?`<div class="watch-status">${c.watch.enabled?`Watching ${name(c.watch.provider)} · ${esc(c.watch.phase)}`:'Watching paused'} ${c.watch.enabled?'<button class="text-button" data-action="pause-watch">Pause</button>':'<button class="text-button" data-action="resume-watch">Resume</button>'}${c.watch.error?`<p>${esc(c.watch.error)}</p>`:''}</div>`:''}${turnStatus(c)}
 ${c.permissionNotice?`<div class="notice">${esc(c.permissionNotice)}</div>`:''}
 <div id="watched-result-notice" ${watchedResultToReview(c)?'':'hidden'}>${watchedResultNotice(c)}</div>
 ${turnView(c)}
 ${c.messages.length?`<details class="conversation" ${c.messages.some(m=>!m.imported)?'open':''}><summary>Conversation <span>${c.messages.length} messages${c.messages.every(m=>m.imported)?' · imported excerpt':''}</span></summary>${c.messages.map(m=>`<article class="message ${m.role}"><div class="message-label">${m.role==='user'?'YOU':name(m.provider)}${m.imported?' <span>Imported context</span>':''}</div><div class="message-body">${markdown(m.text,c)}</div></article>`).join('')}</details>`:''}
 ${busy?`<section class="working-card"><span class="pulse-dot"></span><strong>${esc(c.activity||'Working on your request')}</strong><button data-action="stop" class="text-button" ${c.status==='stopping'?'disabled':''}>${c.status==='stopping'?'Stopping…':'Stop'}</button>${c.liveText?`<div class="live-response">${markdown(c.liveText.split('<<<SWITCHBOARD_HANDOFF>>>')[0],c)}</div>`:''}</section>`:''}</div>
 <div class="composer-wrap">${c.status==='parked'?'<div class="composer-note">This chat is caught up. Send a prompt whenever you want to continue.</div>':''}<form id="composer"><div id="reply-target" class="composer-note">${replyTarget(c)}</div><label class="sr-only" for="prompt">Your prompt for ${name(provider)}</label><textarea id="prompt" placeholder="Give ${name(provider)} a direction…" ${busy||sending?'disabled':''}>${esc(drafts.read(c.id).text)}</textarea><div class="composer-footer"><span>${busy?'This agent is working. Your next chat is ready when you are.':autoAdvance?'Your agent keeps going. You move to the next chat.':'You’ll stay here after sending.'}</span><button class="send-button" type="submit" ${busy||sending||changing?'disabled':''}>${busy?'Working…':'Send'} <span>↗</span></button></div></form><div class="below-composer"><button class="text-button" data-action="park" ${busy?'disabled':''}>✓ I’m caught up</button><button class="text-button mobile-memory" data-action="memory">Project memory</button><button class="text-button" data-action="next">Next ready chat →</button></div></div>`;}
function savedDecisions(c) {
  return [...(c.confirmedDecisions||[]).map(d=>`<li><span>✓</span>${esc(d)}</li>`),
    ...(c.decisions||[]).map(d=>`<li>${esc(d)} <small>(unverified)</small></li>`)].join('');
}
function pinnedRequirements(c) {
  return `<div class="context-kicker memory-label">PINNED REQUIREMENTS</div><p class="goal">${esc(c.requirements||'Keep instructions that should carry across replies.')}</p><button class="text-button" data-action="requirements" ${['running','stopping'].includes(c.status)?'disabled':''}>${c.requirements?'Edit requirements':'Pin requirements'} ↗</button>`;
}
function contextView(c){return `<aside class="context-pane"><div class="context-header"><span class="small-dot"></span> PROJECT MEMORY</div><section><div class="context-kicker">THE DIRECTION</div><p class="goal">${esc(c.goal||'Give this project a clear goal so every handoff has a direction.')}</p><button class="text-button" data-action="goal" ${['running','stopping'].includes(c.status)?'disabled':''}>${c.goal?'Edit goal':'Set a goal'} ↗</button>${pinnedRequirements(c)}</section><section><div class="context-kicker">DECISIONS SO FAR <span>${(c.confirmedDecisions?.length||0)+(c.decisions?.length||0)}</span></div>${savedDecisions(c)?`<ul class="decision-list">${savedDecisions(c)}</ul>`:'<p class="context-muted">Keep the choices you’ve made here. You won’t have to remember them when you come back.</p>'}<button class="text-button" data-action="decision" ${['running','stopping'].includes(c.status)?'disabled':''}>＋ Save a decision</button></section><section><div class="context-kicker">NEXT IN LINE</div>${ready().filter(x=>x.id!==c.id).slice(0,3).map(x=>`<button class="next-project" data-select="${x.id}"><span>${esc(x.title)}</span><small>${name(x.provider)} · Ready for you</small><i>↗</i></button>`).join('')||'<p class="context-muted">Nothing needs your attention yet. Ideas are next.</p>'}</section><div class="context-foot"><span class="folder-icon">▱</span><span title="${esc(c.cwd)}">${esc(c.cwd.split('/').slice(-2).join('/'))}</span></div></aside>`;}
function ideaView(running){return `<div class="idea-workspace"><div class="breadcrumb">THE SPACE BETWEEN</div><div class="idea-symbol">✧</div><h1>${running.length?'While things move,<br>make room for an idea.':'A clear queue.<br>A little room to think.'}</h1><p class="idea-intro">${running.length?'Your agents are working. Catch a thought, explore what’s next, or just let it breathe.':'Keep the things you want to work on close. When the moment comes, turn one into a conversation.'}</p><form id="idea-form"><label class="sr-only" for="idea-text">An idea for later</label><textarea id="idea-text" placeholder="Something I’ve been wanting to work on…">${esc(drafts.read('ideas').text)}</textarea><div class="idea-form-footer"><span>It doesn’t need to be a plan yet.</span><button class="primary-button" type="submit">Save idea <span>＋</span></button></div></form><div class="ideas-heading"><span>ON YOUR MIND</span><span>${state.ideas.length} ${state.ideas.length===1?'idea':'ideas'}</span></div><div class="idea-list">${state.ideas.length?state.ideas.map(i=>`<div class="idea-item"><span>✧</span><p>${esc(i.text)}</p><button class="text-button" data-explore="${i.id}">Explore ↗</button></div>`).join(''):'<p class="empty-ideas">Your next project can start as a sentence.</p>'}</div><div class="idea-actions"><button class="text-button" data-action="new">＋ Start a project</button><button class="text-button" data-action="discover">Find your existing chats ↗</button></div></div>`;}
function ideaAside(){return `<aside class="context-pane quiet-pane"><div class="context-header">BUILT FOR MOMENTUM</div><div class="flow-art"><div><span>01</span><strong>Give a direction</strong><p>Prompt the project in front of you.</p></div><i>↓</i><div><span>02</span><strong>Move to the next</strong><p>The context is already waiting.</p></div><i>↓</i><div><span>03</span><strong>Keep the thread</strong><p>Decisions and ideas stay with you.</p></div></div><div class="demo-callout"><span>FEEL THE FLOW</span><p>Try three sample chats to see how send & move on works.</p><button class="secondary-button" data-action="demo">Try the demo ↗</button>${state.chats.some(c=>c.demo)?'<button class="text-button" data-action="clear-demo">Remove demo chats</button>':''}<small>Simulated replies. No agent usage.</small></div></aside>`;}
async function submitPrompt(e) {
  e.preventDefault();
  const c=state.chats.find(c=>c.id===selected);
  if (!c || sending || switchingProvider.has(c.id) || ['running','stopping'].includes(c.status)) return;
  const text=$('prompt').value.trim();
  if (!text) return;
  if (text.length>50000) {toast('Your reply is over 50,000 characters. Shorten it and try again.');return;}
  sending=true;
  try {
    let draft=drafts.read(c.id);
    if(draft.text.trim() && draft.text.trim()!==text){
      toast('Your draft changed in another tab. Review the latest draft before sending.');
      return;
    }
    if(!draft.text.trim())draft=saveDraft(c.id,text);
    const provider=draft.provider||c.provider, turnId=draft.turnId??null;
    if(!draft.id || !draft.provider)draft=drafts.write(c.id,{...draft,id:draft.id||crypto.randomUUID(),provider,turnId});
    const payload={text,provider,turnId,...(draft.choice?{choice:draft.choice}:{})};
    // Persist the draft identity before any request. An identical retry after
    // reload generates the same receipt even if no response reached this tab.
    const requestId=await replyRequestId(draft,payload);
    render();
    const result=await api(`/api/chats/${c.id}/send`,{...payload,requestId});
    drafts.clearIfUnchanged(c.id,draft);
    viewedTurns.delete(c.id);
    if (autoAdvance && selected===c.id) choose(result.nextId);
    toast(result.duplicate?`This reply was already sent to ${name(provider)}.`:`Sent to ${name(provider)}.`);
  } catch(error) {
    toast(error.message);
  } finally {
    sending=false;
    render();
  }
}
async function saveIdea(e){e.preventDefault();const text=$('idea-text').value.trim();if(!text)return;try{await api('/api/ideas',{text});saveDraft('ideas','');render();toast('Saved for the moment you want to explore it.');}catch(error){toast(error.message);}}
function openModal(type,html){modalType=type;$('modal').innerHTML=`<div class="modal-head"><span class="modal-label">SWITCHBOARD</span><button data-close class="icon-button" aria-label="Close dialog">×</button></div>${html}`;$('modal').showModal();$('modal').querySelector('input,textarea,button:not([data-close])')?.focus();}
function newProject(idea=null){
 const provider=state.connections.codex?.signedIn?'codex':state.connections.claude?.signedIn?'claude':'codex';
 openModal('new',`<h2>Give it a place to start.</h2><p class="modal-intro">Choose the folder this project will use. File edits, if enabled later, apply in this folder.</p><form id="new-form"><label>Project name<input name="title" required value="${esc(idea?.text.replace(/\s+/g,' ').slice(0,100)||'')}" placeholder="What are you working on?" maxlength="200"></label><label>The goal<textarea name="goal" placeholder="What would a useful result look like?">${esc(idea?.text||'')}</textarea></label><label>Project folder<input name="cwd" required placeholder="/full/path/to/your/project" autocomplete="off"></label><p class="form-hint">Enter the full path to an existing folder. This is the target for this project.</p><div class="form-pair"><label>Start with<select name="provider"><option value="codex">Codex</option><option value="claude" ${provider==='claude'?'selected':''}>Claude Code</option></select></label><p class="form-hint">Starts with read-only access. You can enable file edits in the chat.</p></div><button class="primary-button">Create project →</button></form>`);
 const form=$('new-form');let creating=false;
 form.onsubmit=async e=>{
  e.preventDefault();if(creating)return;creating=true;const button=form.querySelector('button');button.disabled=true;
  try{
   const data=Object.fromEntries(new FormData(form));if(idea)data.id=idea.id;
   const {chat,duplicate}=await api(idea?'/api/ideas/start':'/api/chats',data);
   if(!state.chats.some(c=>c.id===chat.id))state.chats.push(chat);
   if(idea){state.ideas=state.ideas.filter(i=>i.id!==idea.id);if(!duplicate && !drafts.read(chat.id).text)saveDraft(chat.id,`Help me think through this idea: ${chat.goal}\nAsk me a useful question and suggest a small first step.`);}
   $('modal').close();choose(chat.id);$('prompt').focus();
  }catch(error){toast(error.message);}finally{creating=false;button.disabled=false;}
 };
}

function usageLabel(provider){const u=state.usage?.[provider];if(!u)return 'Usage: add snapshot';const expired=u.resetAt&&Date.now()>=Date.parse(u.resetAt);return `${name(provider)}: ${u.used}% used${expired?' · reset passed':''} · manual`;}
function localDateTime(iso){if(!iso)return '';const d=new Date(iso);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function usage(){openModal('usage',`<h2>Usage limits</h2><p class="modal-intro">Record a snapshot from each provider’s usage page. Values are manual, can become stale, and do not update or reset automatically. Check your provider for the current limit.</p><div class="usage-grid">${['codex','claude'].map(p=>{const u=state.usage?.[p];return `<form class="usage-form" data-usage="${p}"><strong>${name(p)}</strong><p>${u?`Last saved ${esc(new Date(u.updatedAt).toLocaleString())}${u.resetAt&&Date.now()>=Date.parse(u.resetAt)?' · reset time passed; update this snapshot':''}`:'No snapshot saved.'}</p><label>Percentage used<input name="used" type="number" min="0" max="100" step="any" required value="${u?esc(u.used):''}" placeholder="e.g. 65"></label><label>Reset time (optional)<input name="resetAt" type="datetime-local" value="${esc(localDateTime(u?.resetAt))}"></label><div class="usage-actions"><button class="primary-button" type="submit">Save snapshot</button>${u?`<button class="text-button" type="button" data-clear-usage="${p}">Clear</button>`:''}</div></form>`;}).join('')}</div><p class="fine-print">These notes are stored on this computer. Switchboard does not enforce provider limits or track usage outside this app.</p>`);
 $('modal').querySelectorAll('.usage-form').forEach(form=>{form.onsubmit=async e=>{e.preventDefault();const data=new FormData(form);try{const result=await api('/api/usage',{provider:form.dataset.usage,used:Number(data.get('used')),resetAt:data.get('resetAt')?new Date(data.get('resetAt')).toISOString():''});state.usage=result.usage;usage();render();toast('Usage snapshot saved.');}catch(error){toast(error.message);}};});}
async function connections(){
  openModal('connections',`<h2>Connect an agent</h2>
    <p class="modal-intro">Switchboard checks for an existing Codex or Claude Code sign-in on this computer.</p>
    <div id="connections-list">${providersHTML()}</div>`);
  try {
    state.connections=await api('/api/connections/refresh',{});
    updateConnectionCards();
  } catch(error) {
    toast(error.message);
  }
}
function updateConnectionCards(){
  for(const provider of signInSteps.keys()){
    if(state.connections[provider]?.signedIn)signInSteps.delete(provider);
  }
  const activeAuth=document.activeElement?.closest?.('.auth-code-form');
  if(activeAuth && state.connections[activeAuth.dataset.authCode]?.signingIn)return;
  if(modalType==='connections' && $('connections-list'))$('connections-list').innerHTML=providersHTML();
}
function providersHTML(){
  return ['codex','claude'].map(provider=>{
    const c=state.connections[provider]||{};
    const step=signInSteps.get(provider), busy=signInBusy.has(provider);
    const app=c.desktopApp;
    const fallback=c.terminalSignIn
      ? `<button class="secondary-button" data-terminal-login="${provider}" ${busy?'disabled':''}>${provider==='codex'?'Sign in with ChatGPT':'Sign in to Claude Code'}</button>`
      : `<button class="secondary-button" data-login="${provider}" ${busy||c.signingIn?'disabled':''}>Sign in</button>`;
    const install=provider==='codex'?'https://developers.openai.com/codex/cli':'https://code.claude.com/docs/en/setup';
    const open=app?`<button class="secondary-button" data-desktop-login="${provider}" ${busy?'disabled':''}>Open ${esc(app)} ↗</button>`:'';
    const authCode=/(?:paste|enter|input|provide)\s+(?:the\s+)?(?:authorization\s+)?code/i.test(c.instructions||'');
    let actions='';
    if(step&&!c.signedIn){
      const instruction=step==='terminal'
        ? 'Complete the provider sign-in, then return here and click OK.'
        : 'If the desktop app asks you to sign in, finish there. Then return here and click OK.';
      const missing=c.installed
        ? (c.connectionError?'Check the CLI error below, then click OK to try again.':'The coding CLI still needs authorization. Use the sign-in button below, then click OK.')
        : 'Install the coding CLI, then click OK again.';
      actions=`<div class="connection-next"><p role="status">${esc(step==='retry'?missing:instruction)}</p>
        <button class="primary-button" data-confirm-login="${provider}" ${busy?'disabled':''}>${busy?'Checking…':'OK'}</button>
        ${step==='retry'&&c.installed?fallback:''}</div>`;
    }else if(c.signingIn&&!c.signedIn){
      actions=`<pre class="auth-instructions">${esc(c.instructions)}</pre>${authCode?`<form class="auth-code-form" data-auth-code="${provider}">
        <label>Authorization code<input name="code" type="password" autocomplete="off" required maxlength="2048"></label>
        <button class="secondary-button" type="submit">Submit code</button></form>`:''}`;
    }else if(!c.signedIn){
      actions=open||(c.installed?fallback:'');
    }
    const status=c.signedIn?'Connected':c.connectionError?'CLI needs attention':c.installed?'Sign in to connect':'Coding CLI needed';
    return `<section class="connection-card"><span class="provider-glyph ${provider}">${provider==='codex'?'◎':'✳'}</span>
      <div><strong>${name(provider)}</strong><p>${status}</p></div>
      ${actions}
      ${c.connectionError?`<p class="connection-error" role="alert">${esc(c.connectionError)}</p>`:''}
      ${c.loginError?`<p class="connection-error" role="alert">${esc(c.loginError)}</p>`:''}
      ${!c.installed?`<a class="message-link install-help" href="${install}" target="_blank" rel="noopener noreferrer">Install the coding CLI ↗</a>`:''}</section>`;
  }).join('');
}
async function signInAction(provider,mode){
  if(signInBusy.has(provider))return;
  signInBusy.add(provider);
  updateConnectionCards();
  try {
    if(mode==='confirm'){
      state.connections=await api('/api/connections/refresh',{});
      if(state.connections[provider]?.signedIn){
        signInSteps.delete(provider);
        render();
        toast(`${name(provider)} connected.`);
      }else {
        signInSteps.set(provider,'retry');
      }
    }else{
      await api('/api/connections/'+mode,{provider});
      signInSteps.set(provider,mode);
    }
  }finally{
    signInBusy.delete(provider);
    updateConnectionCards();
  }
}

async function discoverProjects(){discoveryBatch={enabled:false,selected:new Set(),errors:new Map(),busy:false,followed:0,skipped:0};discoverySearch='';openModal('discover','<h2>Pick up an existing thread.</h2><p class="modal-intro">Looking for recent local Codex and Claude projects…</p><div class="discovery-loading">Reading project history…</div>');try{const response=await api('/api/discover?refresh=1');if(modalType!=='discover'||!$('modal').open)return;found=response.projects;nextOffset=response.nextOffset;discoverySnapshotId=response.snapshotId;renderDiscovery();}catch(error){toast(error.message);}}
function filteredDiscovery(){return found.filter(p=>(p.title+' '+p.cwd).toLowerCase().includes(discoverySearch.toLowerCase()));}
function renderDiscovery(focusSource=null){
 const dialog=$('modal'),list=$('discovery-list');
 const scroll=focusSource?{dialogTop:dialog.scrollTop,dialogLeft:dialog.scrollLeft,listTop:list?.scrollTop,listLeft:list?.scrollLeft}:null;
 const batch=discoveryBatch;
 const status=[batch.followed?`${batch.followed} followed`:'',batch.skipped?`${batch.skipped} already in workspace`:'',batch.errors.size?`${batch.errors.size} failed`:''].filter(Boolean).join(' · ');
 openModal('discover',`<h2>Pick up an existing thread.</h2><p class="modal-intro">Select a chat to follow. Switchboard uses that provider on your account to summarize its completed turns with tools disabled. Replies here start a separate provider session in the same folder.</p><button class="secondary-button" data-action="finder-multiple" ${batch.busy?'disabled':''}>${batch.enabled?'Use single-chat mode':'Follow several chats'}</button>${batch.enabled?`<p class="form-hint">Choose new chats, then follow your selection. Existing projects keep their current watch settings.</p><button class="primary-button" data-action="finder-follow" ${batch.busy||!batch.selected.size?'disabled':''}>${batch.busy?'Following…':`Follow selected (${batch.selected.size})`}</button> ${batch.errors.size?`<button class="secondary-button" data-action="finder-retry" ${batch.busy?'disabled':''}>Retry failed (${batch.errors.size})</button>`:''} <button class="text-button" data-close ${batch.busy?'disabled':''}>Done</button>`:''}${status?`<p role="status">${esc(status)}</p>`:''}<input id="discover-search" class="discover-search" aria-label="Search discovered projects" placeholder="Find a project or chat" value="${esc(discoverySearch)}"><div class="discovery-list" id="discovery-list">${discoveryRows(filteredDiscovery())}</div>${nextOffset!==null?'<button class="secondary-button" data-action="older-chats">Show older chats</button>':''}<p class="fine-print">Following Claude adds completion hooks to your Claude settings. Reopen an existing Claude session if it asks to reload hooks. You can pause watching from the project.</p>`);
 $('discover-search').oninput=e=>{discoverySearch=e.target.value;$('discovery-list').innerHTML=discoveryRows(filteredDiscovery());};
 if(scroll){
  const button=[...dialog.querySelectorAll('[data-finder-select]')].find(b=>b.dataset.finderSelect===focusSource);
  button?.focus({preventScroll:true});
  dialog.scrollTop=scroll.dialogTop;dialog.scrollLeft=scroll.dialogLeft;
  const currentList=$('discovery-list');if(currentList){currentList.scrollTop=scroll.listTop;currentList.scrollLeft=scroll.listLeft;}
 }
}

function discoveryRows(items){return items.length?items.map(p=>{
 const existing=state.chats.find(c=>c.sourceId===p.id);
 const status=existing?'Already in workspace'+(existing.watch?.enabled===false?' · Watching paused':''):'';
 const folder=p.cwd.split('/').slice(-2).join('/');
 const batch=discoveryBatch, picked=batch.selected.has(p.id),error=batch.errors.get(p.id);
 const label=(batch.enabled?(existing?'Already followed ':picked?'Deselect ':'Select '):(existing?'Open ':'Follow '))+p.title+' · '+folder;
 const control=batch.enabled?`data-finder-select="${esc(p.id)}" aria-pressed="${picked}" ${batch.busy||existing?'disabled':''}`:`data-import="${esc(p.id)}"`;
 return `<button class="discovery-row" ${control} aria-label="${esc(label)}"><span class="provider-glyph ${p.provider}">${p.provider==='codex'?'◎':'✳'}</span><span><strong>${esc(p.title)}</strong><small>${name(p.provider)} · ${esc(folder)}</small>${status?`<small>${status}${batch.enabled?'':' · Open project'}</small>`:''}<p>${esc(p.summary.replace(/\s+/g,' ').slice(0,160))}</p>${picked?'<small>Selected</small>':''}${error?`<small role="alert">Could not follow: ${esc(error)}</small>`:''}</span><i>${batch.enabled?(existing?'✓':picked?'☑':'☐'):existing?'↗':'＋'}</i></button>`;
}).join(''):'<p class="context-muted">No recent chats found. Start a new project to connect an agent.</p>';}
async function selectDiscoveredProject(sourceId){
 const existing=state.chats.find(c=>c.sourceId===sourceId);
 if(existing){$('modal').close();choose(existing.id);return;}
 const {chat}=await api('/api/import',{id:sourceId,watch:true});
 $('modal').close();
 if(!state.chats.some(c=>c.id===chat.id))state.chats.push(chat);
 choose(chat.id);toast('Following this chat. Its results appear here.');
}
function toggleDiscoveredProject(sourceId){
 const batch=discoveryBatch;
 if(!batch.enabled||batch.busy||!found.some(p=>p.id===sourceId)||state.chats.some(c=>c.sourceId===sourceId))return;
 if(batch.selected.has(sourceId)){batch.selected.delete(sourceId);batch.errors.delete(sourceId);}
 else batch.selected.add(sourceId);
 renderDiscovery(sourceId);
}
async function followDiscoveredProjects(retryOnly=false){
 const batch=discoveryBatch;if(!batch.enabled||batch.busy)return;
 const pending=[...batch.selected].filter(id=>!retryOnly||batch.errors.has(id));
 if(!pending.length)return;
 batch.busy=true;renderDiscovery();
 try{
  for(const id of pending){
   if(state.chats.some(c=>c.sourceId===id)){batch.selected.delete(id);batch.errors.delete(id);batch.skipped++;continue;}
   try{
    const {chat}=await api('/api/import',{id,watch:true});
    if(!state.chats.some(c=>c.id===chat.id||c.sourceId===id))state.chats.push(chat);
    batch.selected.delete(id);batch.errors.delete(id);batch.followed++;
   }catch(error){batch.errors.set(id,error.message);}
  }
 }finally{batch.busy=false;if(discoveryBatch===batch&&modalType==='discover'&&$('modal').open)renderDiscovery();}
}
function editText(type){const c=state.chats.find(c=>c.id===selected);if(!c)return;const label={decision:'Your decision',goal:'Project goal',requirements:'Pinned requirements'}[type];openModal(type,`<h2>${label}</h2><p class="modal-intro">This stays with the project and travels between agents.</p><form id="memory-form"><label>${label}<textarea name="text" ${type==='requirements'?'maxlength="6000"':'required'}>${type==='decision'?'':esc(c[type])}</textarea></label><button class="primary-button">Save →</button></form>`);$('memory-form').onsubmit=async e=>{e.preventDefault();try{await api(`/api/chats/${c.id}/update`,{[type]:new FormData(e.target).get('text')});$('modal').close();}catch(error){toast(error.message);}};}
async function action(kind){const c=state.chats.find(c=>c.id===selected);try{
 if(c&&kind==='show-draft-result'){viewedTurns.set(c.id,replyAnchor(c));render();return;}
 if(c&&kind==='show-watched-result'){showWatchedResult(c);return;}
 if(c&&kind==='analyze'){await api(`/api/chats/${c.id}/analyze`,{turnId:visibleTurn(c)?.id});return;}
 if(c&&['pause-watch','resume-watch'].includes(kind)){await api(`/api/chats/${c.id}/${kind}`,{});return;}
 if(kind==='older-chats'&&nextOffset!==null){
   const snapshot=discoverySnapshotId, offset=nextOffset;
   const page=await api('/api/discover?'+new URLSearchParams({offset,snapshot}));
   if(modalType!=='discover'||discoverySnapshotId!==snapshot||nextOffset!==offset)return;
   found=[...new Map([...found,...page.projects].map(p=>[p.id,p])).values()];
   nextOffset=page.nextOffset;
   renderDiscovery();
   return;
 }
 if(kind==='finder-multiple'){if(discoveryBatch.busy)return;discoveryBatch.enabled=!discoveryBatch.enabled;renderDiscovery();return;}
 if(kind==='finder-follow')return followDiscoveredProjects();
 if(kind==='finder-retry')return followDiscoveredProjects(true);
 if(kind==='usage')return usage();if(kind==='new')return newProject();if(kind==='discover')return discoverProjects();if(kind==='connections')return connections();
 if(kind==='memory'&&c){openModal('memory',`<h2>Project memory</h2><p class="modal-intro">${esc(c.title)}</p><div class="context-kicker">THE DIRECTION</div><p class="goal">${esc(c.goal||'Set a goal for this project.')}</p><button class="text-button" data-action="goal">Edit goal ↗</button>${pinnedRequirements(c)}<div class="context-kicker memory-label">DECISIONS SO FAR</div><ul class="decision-list">${savedDecisions(c)||'<li>No decisions saved yet.</li>'}</ul><button class="text-button" data-action="decision">＋ Save a decision</button>`);return;}
 if(kind==='ideas'){location.hash='ideas';return choose(null);}if(kind==='next'){choose(next(selected));return;}
 if(['goal','decision','requirements'].includes(kind))return editText(kind);
 if(kind==='demo'){const {chat}=await api('/api/demo',{});choose(chat.id);toast('Demo mode: replies are simulated.');}
 if(kind==='clear-demo'){await api('/api/demo/clear',{});choose(null);toast('Demo chats removed.');}
 if(c&&kind==='park'){const result=await api(`/api/chats/${c.id}/park`,{});choose(result.nextId);}
 if(c&&kind==='stop')await api(`/api/chats/${c.id}/stop`,{});
 if(c&&kind==='reset-session'){await api(`/api/chats/${c.id}/reset-session`,{});toast(`The next prompt starts a fresh ${name(c.provider)} session with saved context.`);}
 if(c&&kind==='pin')await api(`/api/chats/${c.id}/update`,{priority:c.priority?0:1});
 }catch(error){toast(error.message);}}
document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b||b.disabled)return;if(b.hasAttribute('data-close')){$('modal').close();return;}if(b.dataset.action){action(b.dataset.action);return;}if(b.dataset.select){choose(b.dataset.select);return;}try{
 if(b.dataset.clearUsage){const result=await api('/api/usage',{provider:b.dataset.clearUsage,clear:true});state.usage=result.usage;usage();render();toast('Usage snapshot cleared.');return;}
 if(b.dataset.jumpDecision){jumpToDecision(b);return;}
 if(b.dataset.evidence){const item=$(b.dataset.evidence);if(item){item.open=true;item.scrollIntoView({block:'nearest'});}return;}
 if(b.dataset.choice!==undefined){
   const c=state.chats.find(x=>x.id===selected), t=visibleTurn(c), option=t?.card.options[Number(b.dataset.choice)];
   if (!option || sending) return;
   if (drafts.read(c.id).text.trim()) {toast('Send or clear your current draft before choosing an option.');return;}
   const index=Number(b.dataset.choice), value=choiceText(index,option);
   saveDraft(c.id,value,{turnId:t.id,provider:c.provider,choice:{index,label:option.label,tradeoff:option.tradeoff}});
   $('prompt').value=value;
   updateReplyContext(c);
   $('prompt').focus();
   return;
 }
 if(b.dataset.provider){
   const id=selected, provider=b.dataset.provider;
   if(sending||switchingProvider.has(id))return;
   switchingProvider.add(id);
   render();
   try {
     await api(`/api/chats/${id}/update`,{provider});
     const c=state.chats.find(chat=>chat.id===id);
     if(!c)return;
     c.provider=provider;
     const draft=drafts.read(id);
     if(draft.text.trim())drafts.write(id,{...draft,provider});
     toast(`Replies will go to ${name(provider)}.`);
   } finally {
     switchingProvider.delete(id);
     render();
   }
   return;
 }
 if(b.dataset.desktopLogin){await signInAction(b.dataset.desktopLogin,'desktop');return;}
 if(b.dataset.terminalLogin){await signInAction(b.dataset.terminalLogin,'terminal');return;}
 if(b.dataset.confirmLogin){await signInAction(b.dataset.confirmLogin,'confirm');return;}
 if(b.dataset.login){await api('/api/connections/login',{provider:b.dataset.login});return;}
 if(b.dataset.revealFile){b.disabled=true;await api(`/api/chats/${b.dataset.revealProject}/reveal-file`,{path:b.dataset.revealFile});b.disabled=false;toast('Selected the file in Finder.');return;}
 if(b.dataset.finderSelect){toggleDiscoveredProject(b.dataset.finderSelect);return;}
 if(b.dataset.import){b.disabled=true;await selectDiscoveredProject(b.dataset.import);return;}
 if(b.dataset.explore){const idea=state.ideas.find(i=>i.id===b.dataset.explore);if(idea)newProject(idea);}
 }catch(error){b.disabled=false;toast(error.message);}});
document.addEventListener('submit',async e=>{const form=e.target.closest('form[data-auth-code]');if(!form)return;e.preventDefault();const input=form.elements.code,button=form.querySelector('button');button.disabled=true;try{await api('/api/connections/code',{provider:form.dataset.authCode,code:input.value});input.value='';toast('Code submitted. Waiting for the provider…');}catch(error){toast(error.message);button.disabled=false;}});
document.addEventListener('change',async e=>{if(e.target.id==='which-turn'){viewedTurns.set(selected,e.target.value);render();return;}if(e.target.id==='permission')try{await api(`/api/chats/${selected}/update`,{permission:e.target.value});toast(e.target.value==='edit'?'File edits enabled for this project.':'Read-only access enabled.');}catch(error){toast(error.message);}});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&$('composer')&&!$('modal').open){e.preventDefault();$('composer').requestSubmit();}if(e.altKey&&e.key.toLowerCase()==='n'&&!$('modal').open){e.preventDefault();choose(next(selected));}});
$('modal').addEventListener('close',()=>modalType=null);
$('modal').addEventListener('click',e=>{if(e.target===$('modal')){const r=$('modal').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('modal').close();}});
const initial=await api('/api/bootstrap');drafts=draftStore(localStorage,initial.workspace);state=initial;token=initial.token;selected=location.hash==='#ideas'?null:localStorage.getItem('switchboard-selected')||next(null);if(selected&&!state.chats.some(c=>c.id===selected))selected=next(null);render();
if(location.hash==='#connections')connections();
window.addEventListener('hashchange',()=>{
  if(location.hash==='#ideas')choose(null);
  if(location.hash==='#connections'&&!$('modal').open)connections();
});
window.addEventListener('storage',e=>{if(drafts.owns(e.key))render();});
const events=new EventSource('/api/events');
events.onmessage=e=>{
  const snapshot=JSON.parse(e.data);
  if(snapshot.workspace!==state.workspace){
    events.close();
    toast('A different Switchboard workspace is open. Reload this tab.');
    return;
  }
  state={...state,...snapshot};
  if(selected&&!state.chats.some(c=>c.id===selected))selected=null;
  clearTimeout(renderTimer);
  renderTimer=setTimeout(render,60);
  updateConnectionCards();
};
events.onerror=()=>toast('Reconnecting to your local workspace…');
