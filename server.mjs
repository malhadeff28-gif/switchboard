import {revealProjectFile} from './lib/local-files.mjs';
import {choiceText,sameChoice} from './public/drafts.js';
import {desktopApplication,findBinary,openProviderDesktop,openProviderTerminal,spawnCli,stopProcess as killGroup} from './lib/providers.mjs';
import {createMonitor} from './lib/monitor.mjs';
import {makeCard,rawCard,resultPayload} from './lib/handoffs.mjs';
import {addEvidence,managedEvidence,note} from './lib/turns.mjs';
import {lockWorkspace,workspaceIdentity} from './lib/workspace.mjs';
import http from 'node:http';
import {readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, realpathSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID, randomBytes} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {attentionStatus,pendingWatchedReply,nextAttention, parseHandoff, agentPrompt, cliArgs, replyContext, decodeEvent, providers} from './lib/core.mjs';
import {discover,discoverPage,discoverySnapshot} from './lib/discovery.mjs';
const discoveredById=new Map();
const discoverySnapshots=new Map();
import {CodexSubmitListener,nextDesktop,openInCodex,openCodexBrainstorm} from './lib/desktop.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const {version}=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
const storage=process.env.SWITCHBOARD_DATA_DIR || path.join(root,'.local');
mkdirSync(storage,{recursive:true,mode:0o700});
const releaseWorkspace=lockWorkspace(storage);
process.once('exit',()=>{try{releaseWorkspace();}catch(error){console.error('Workspace lock cleanup:',error.message);}});
const workspace=workspaceIdentity(storage);
const stateFile=path.join(storage,'workspace.json');
let state={chats:[],ideas:[]};
if (existsSync(stateFile)) {
  try {
    state=JSON.parse(readFileSync(stateFile,'utf8'));
    if(!Array.isArray(state?.chats)||!Array.isArray(state?.ideas))throw Error('Invalid workspace.');
  } catch {
    throw Error(`Workspace data at ${stateFile} could not be read. Keep a copy before repairing it.`);
  }
}
state.usage ||= {};
state.desktop ||= {enabled:false,queue:state.chats.filter(c=>c.sourceId?.startsWith('codex:')).map(c=>c.sourceId),monitorAll:true,emptyBehavior:'brainstorm',history:[]};
const clients=new Set(), jobs=new Map(), authJobs=new Map(), authErrors=new Map();
const token=randomBytes(32).toString('hex');
const port=Number(process.env.PORT || 4317);
const commandEnv={...process.env,PATH:[path.dirname(process.execPath),process.env.PATH || ''].join(path.delimiter)};
const binaries={};
let connections={}, discovered=[], discoveryAt=0, persistenceTimer, storageError='';
let nativeSources=[],nativeSourcesAt=0,nativeError=null,listenerState='paused',handoffChain=Promise.resolve();
const nativeStatuses=new Map(),seenNativeEvents=new Set(),listener=new CodexSubmitListener();
function desktopState(){return {...state.desktop,listenerState,error:nativeError,statuses:Object.fromEntries(nativeStatuses),queueDetails:state.desktop.queue.map(id=>{const s=nativeSources.find(s=>s.id===id);return {id,title:s?.title||id,status:nativeStatuses.get(id)||s?.desktopStatus||'unknown',summary:s?.summary||''};}),platform:process.platform,support:{codex:process.platform==='darwin',claude:false}};}
async function nativeDiscovery(refresh=false){if(refresh||Date.now()-nativeSourcesAt>30000){nativeSources=(await discover({exclude:null})).filter(p=>p.desktopSupported);nativeSourcesAt=Date.now();for(const p of nativeSources){if(!listener.active||!nativeStatuses.has(p.id))nativeStatuses.set(p.id,p.desktopStatus);else p.desktopStatus=nativeStatuses.get(p.id);}}return nativeSources;}
function nativeHistory(event){state.desktop.history.unshift({...event,at:Date.now()});state.desktop.history=state.desktop.history.slice(0,20);update({immediate:true});}
async function enableDesktop(enabled){if(enabled){if(process.platform!=='darwin')throw new Error('Existing-app switching currently requires macOS.');await nativeDiscovery(true);if(!state.desktop.queue.length)throw new Error('Choose at least one existing Codex chat.');if(state.desktop.queue.some(id=>!nativeSources.some(s=>s.id===id)))throw new Error('A selected chat is unavailable. Refresh the existing-chat queue.');
    try{
      // Observe new events before refreshing old state, so turns started while
      // paused are reflected without overwriting a newer listener event.
      nativeStatuses.clear();await listener.start();await nativeDiscovery(true);
      if(state.desktop.queue.some(id=>!nativeSources.some(s=>s.id===id)))throw new Error('A selected chat is unavailable. Refresh the existing-chat queue.');
      listenerState='listening';nativeError=null;
    }catch(e){listener.stop();listenerState='error';throw e;}
  }else{listener.stop();listenerState='paused';}state.desktop.enabled=enabled;update({immediate:true});}
listener.on('listenerError',error=>{nativeError=error.message;listenerState='error';listener.stop();state.desktop.enabled=false;update({immediate:true});});
listener.on('event',event=>{
  if(event.kind==='complete'){nativeStatuses.set(event.id,'ready');const source=nativeSources.find(s=>s.id===event.id);if(source){source.desktopStatus='ready';if(event.summary)source.summary=event.summary.slice(0,1800);}publish();return;}
  nativeStatuses.set(event.id,'working');const source=nativeSources.find(s=>s.id===event.id);if(source)source.desktopStatus='working';publish();
  if(event.kind!=='submit'||!state.desktop.enabled||(!state.desktop.monitorAll&&!state.desktop.queue.includes(event.id)))return;
  const key=event.id+':'+event.turnId;if(seenNativeEvents.has(key))return;seenNativeEvents.add(key);if(seenNativeEvents.size>1000)seenNativeEvents.delete(seenNativeEvents.values().next().value);
  handoffChain=handoffChain.then(async()=>{if(!state.desktop.enabled)return;const targetId=nextDesktop(state.desktop.queue,nativeStatuses,event.id);
    if(targetId){const target=nativeSources.find(s=>s.id===targetId);if(!target)throw new Error('The next chat is unavailable. Refresh your existing-chat queue.');await openInCodex(target.sourceSession);nativeHistory({kind:'switched',sourceId:event.id,targetId,title:target.title,turnId:event.turnId,detectedAt:event.at});}
    else if(state.desktop.emptyBehavior==='brainstorm'){await openCodexBrainstorm();nativeHistory({kind:'brainstorm',sourceId:event.id,turnId:event.turnId,detectedAt:event.at});}
    else if(state.desktop.emptyBehavior==='ideas'){await new Promise((resolve,reject)=>{const child=spawn('/usr/bin/open',[`http://127.0.0.1:${port}/#ideas`],{stdio:'ignore'});child.once('error',reject);child.once('close',c=>c===0?resolve():reject(new Error('Could not open the ideas workspace.')));});nativeHistory({kind:'ideas',sourceId:event.id,turnId:event.turnId,detectedAt:event.at});}
    else nativeHistory({kind:'no-ready-chat',sourceId:event.id,turnId:event.turnId,detectedAt:event.at});
  }).catch(error=>{nativeError=error.message;nativeHistory({kind:'error',sourceId:event.id,message:error.message});});
});
function save(snapshot=state){
  const tmp=stateFile+'.tmp';
  try {
    writeFileSync(tmp,JSON.stringify(snapshot,null,2),{mode:0o600});
    renameSync(tmp,stateFile);
    clearTimeout(persistenceTimer);
    storageError='';
  } catch (error) {
    storageError='Could not save this workspace. Check the data folder and available disk space.';
    console.error('Workspace save:',error.message);
    throw Object.assign(Error(storageError),{status:503});
  }
}
function saveBackground(){
  try{save();}catch{publish();}
}
function persistChat(chat,next){
  try{save({...state,chats:state.chats.map(c=>c===chat?next:c)});}
  catch(error){publish();throw error;}
  Object.assign(chat,next);
  publish();
}
function publicChats(){return state.chats.map(({watch,turns,sendReceipts,lastRequestId,messages,...chat})=>({...chat,messages:messages.map(({requestId,...message})=>message),status:attentionStatus({...chat,watch,turns}),watch:watch?{enabled:watch.enabled,provider:watch.provider,phase:watch.phase,error:watch.error}:undefined,turns:turns?.map(({facts,earlier,requirements,...t})=>t)}));}
function recordResponse(provider){(state.lastResponses||={})[provider]=Date.now();if(connections[provider])connections[provider].lastResponse=state.lastResponses[provider];}
function publish(){const data=JSON.stringify({chats:publicChats(),ideas:state.ideas,usage:state.usage,connections,desktop:desktopState(),storageError,workspace});for(const res of clients)if(!res.writableEnded)res.write(`data: ${data}\n\n`);}
function update({immediate=false,background=false}={}){
  if(immediate){
    try{save();}catch(error){publish();if(!background)throw error;return;}
  }else{
    clearTimeout(persistenceTimer);
    persistenceTimer=setTimeout(saveBackground,150);
  }
  publish();
}
for (const chat of state.chats) if (chat.status==='running' || chat.status==='stopping') {chat.status='ready';chat.error='The app closed during this turn. Review any partial output before continuing.';chat.readyAt=Date.now();}
async function checkConnections(){
  await Promise.all(providers.map(provider=>new Promise(resolve=>{
    const binary=binaries[provider]=findBinary(provider,commandEnv);
    const desktop=desktopApplication(provider);
    const defaults={installed:!!binary,desktopApp:desktop?.name,terminalSignIn:process.platform==='darwin'};
    if(!binary){connections[provider]={...defaults,signedIn:false};return resolve();}
    const connectionError=`Could not start ${provider==='codex'?'Codex CLI':'Claude Code'}. Check its installation and refresh Connections.`;
    let child;try{child=spawnCli(binary,provider==='codex'?['login','status']:['auth','status'],{env:commandEnv,stdio:['ignore','pipe','pipe']});}catch{connections[provider]={...defaults,signedIn:false,connectionError};return resolve();}
    let stdout='',stderr='',failed=false;const timer=setTimeout(()=>child.kill(),6000);
    child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});
    child.on('error',()=>{failed=true;clearTimeout(timer);connections[provider]={...defaults,signedIn:false,connectionError,loginError:authErrors.get(provider)||''};resolve();});
    child.on('close',code=>{if(failed)return;clearTimeout(timer);let signedIn=false,statusKnown=false;
      if(provider==='claude'){try{const status=JSON.parse(stdout || stderr);statusKnown=typeof status.loggedIn==='boolean';signedIn=status.loggedIn===true;}catch{}}
      else{const output=stdout+'\n'+stderr;statusKnown=/logged in/i.test(output);signedIn=code===0 && /logged in/i.test(output) && !/not logged in/i.test(output);}
      connections[provider]={...defaults,signedIn,lastResponse:state.lastResponses?.[provider],signingIn:authJobs.has(provider),instructions:authJobs.get(provider)?.instructions || '',loginError:authErrors.get(provider)||'',...(!statusKnown?{connectionError}: {})};resolve();});
  })));
  publish();return connections;
}
async function discovery(refresh=false){if(refresh || Date.now()-discoveryAt>60000){discovered=await discover();discoveryAt=Date.now();}return discovered;}
function requiredChat(id){const c=state.chats.find(c=>c.id===id);if(!c)throw Object.assign(new Error('Chat not found.'),{status:404});return c;}
function validProvider(p){if(!providers.includes(p))throw new Error('Choose Codex or Claude.');return p;}
function validCwd(cwd){if(typeof cwd!=='string'||!path.isAbsolute(cwd)||!existsSync(cwd)||!statSync(cwd).isDirectory())throw new Error('Choose an existing project folder using its full path.');return cwd;}
function string(value,max=2000){if(typeof value!=='string')throw new Error('Expected text.');return value.trim().slice(0,max);}
function updatedProject(chat,data){
  const next={...chat};
  if(data.provider!==undefined)next.provider=validProvider(data.provider);
  if(data.permission!==undefined){
    if(!['read','edit'].includes(data.permission))throw Error('Unknown access mode.');
    next.permission=data.permission;
  }
  if(data.decision)next.confirmedDecisions=[...(chat.confirmedDecisions||[]),string(data.decision)];
  if(data.requirements!==undefined)next.requirements=string(data.requirements,6000);
  if(data.goal!==undefined)next.goal=string(data.goal);
  if(data.priority!==undefined)next.priority=data.priority===1?1:0;
  if(data.status==='ready'){next.status='ready';next.readyAt=Date.now();}
  return next;
}
function newChat(data){return {id:randomUUID(),title:data.title,goal:data.goal||'',cwd:data.cwd||root,provider:data.provider||'codex',permission:'read',status:'ready',readyAt:Date.now(),priority:0,summary:data.summary||'Set the direction for this project. Your first prompt will start the conversation.',decisions:[],nextAction:'What would you like to work on?',messages:data.messages||[],sessions:{},...data};}
// Serialize imports per original so retries share one project and never resume a paused watch.
const importJobs=new Map();
function importSource(source,follow){
  const previous=importJobs.get(source.id);
  const pending=(previous?previous.catch(()=>{}):Promise.resolve()).then(async()=>{
    let chat=state.chats.find(c=>c.sourceId===source.id);
    const created=!chat;
    if(chat && (!follow || chat.watch))return chat;
    if(created){
      chat=newChat({title:source.title,cwd:source.cwd,provider:source.provider,summary:source.summary,messages:source.messages.map(m=>({...m,id:randomUUID(),imported:true,sourceSession:source.sourceSession})),sourceId:source.id,sourceSession:source.sourceSession,nextAction:'Review the original response.'});
      state.chats.push(chat);
    }
    try{
      // Existing watch state belongs to the explicit pause/resume controls.
      if(follow && !chat.watch)await monitor.watch(chat,source);
      update({immediate:true});
      return chat;
    }catch(error){
      if(created){
        try{monitor.discard(chat,source);}catch{} // Preserve the initiating error if hook cleanup also fails.
        state.chats=state.chats.filter(c=>c!==chat);
        try{update({immediate:true});}catch{}
      }
      throw error;
    }
  });
  importJobs.set(source.id,pending);
  return pending.finally(()=>{if(importJobs.get(source.id)===pending)importJobs.delete(source.id);});
}
function stopJob(chatId,job) {
  killGroup(job.child);
  const timer=setTimeout(()=>{if(jobs.get(chatId)===job)killGroup(job.child,'SIGKILL');},3000);
  timer.unref();
}
function foldersOverlap(first,second){
  const within=(parent,child)=>{
    const relative=path.relative(parent,child);
    return relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);
  };
  return within(first,second)||within(second,first);
}
function overlappingWatches(chat){
  const folder=realpathSync(validCwd(chat.cwd));
  return state.chats.filter(c=>{
    if(!c.watch?.enabled)return false;
    try{return foldersOverlap(realpathSync(validCwd(c.cwd)),folder);}
    catch{return false;} // A removed folder cannot share writable files.
  });
}
function run(chat,text,requestId,turnId,routeProvider,choice){
  const previous=chat.messages.find(m=>m.requestId===requestId);
  if(previous){
    if(previous.text!==text || (routeProvider!==undefined && previous.provider!==routeProvider) || (turnId!==undefined && previous.replyTo!==turnId) || !sameChoice(previous.choice,choice)) {
      throw Object.assign(Error('This send ID belongs to a different reply.'),{status:409});
    }
    return {nextId:nextAttention(state.chats,chat.id),duplicate:true};
  }
  if(chat.lastRequestId===requestId||chat.sendReceipts?.includes(requestId))return {nextId:nextAttention(state.chats,chat.id),duplicate:true};
  if(!chat.demo && chat.permission==='edit'){
    const watched=overlappingWatches(chat);
    if(watched.some(c=>c.watch?.enabled && c.watch.phase==='working')){
      throw Object.assign(new Error('An original watched chat is working in this folder or an overlapping folder. Wait for it to finish, then retry your reply with file edits.'),{status:409});
    }
  }
  if(['running','stopping'].includes(chat.status))throw Object.assign(new Error('This chat is already working.'),{status:409});
  if(jobs.size>=3)throw Object.assign(new Error('Three chats are already working. Wait for one to finish.'),{status:429});
  const provider=validProvider(routeProvider||chat.provider);
  if(!chat.demo && !connections[provider]?.signedIn)throw new Error(`Sign into ${provider==='codex'?'Codex':'Claude'} in Connections first.`);
  const folder=realpathSync(validCwd(chat.cwd));
  if(!chat.demo && [...jobs.values()].some(job=>job.folder && foldersOverlap(job.folder,folder) && (job.edit || chat.permission==='edit'))){
    throw Object.assign(new Error('A Switchboard turn is already using this folder or an overlapping folder. Wait before running turns with file edits.'),{status:409});
  }
  const anchor=turnId===undefined?chat.displayTurn:turnId;
  const turn=anchor == null ? null : chat.turns?.find(t=>t.id===anchor);
  if(anchor != null && !turn)throw new Error('The result this draft answers is unavailable. Clear the draft to start a new reply.');
  let decision;
  if(choice!==undefined){
    const option=Number.isInteger(choice?.index) && choice.index>=0 ? turn?.card?.options?.[choice.index] : null;
    if(turnId==null || !option || typeof turn.card.decision!=='string' ||
      !['ready','source'].includes(turn.analysis) || choice.label!==option.label || choice.tradeoff!==option.tradeoff ||
      text!==choiceText(choice.index,option))throw Error('This choice no longer matches its result. Clear the draft and choose again.');
    decision=`Chose “${option.label}” for “${turn.card.decision}”`;
  }
  const project=decision?{...chat,confirmedDecisions:[...(chat.confirmedDecisions||[]),decision]}:chat;
  const context=replyContext(project,provider,turn);
  const prompt=agentPrompt(context,text,provider,turn);
  const at=Date.now();
  // Save the accepted request before starting a process. If saving fails,
  // leave this project unchanged so the exact same request can be retried.
  const nextMessages=[...chat.messages,{id:randomUUID(),role:'user',provider,text,at,replyTo:turn?.id??null,requestId,...(choice!==undefined?{choice}:{})}];
  persistChat(chat,{
    ...project,messages:nextMessages,provider,error:null,permissionNotice:undefined,status:'running',
    activity:'Starting your agent',liveText:'',startedAt:at,
    unseenWatchedTurn:pendingWatchedReply(chat,turn)
  });
  if(chat.demo){const timer=setTimeout(()=>{jobs.delete(chat.id);complete(chat,`Here is a direction we can build on: ${text}\n\nThis is a simulated response so you can try the handoff.\n\n<<<SWITCHBOARD_HANDOFF>>>${JSON.stringify({summary:'The demo agent finished. Your project is ready for another decision.',decisions:[],next_action:'Try another prompt or mark this chat caught up.'})}`);},2800);jobs.set(chat.id,{demo:true,timer});return {nextId:nextAttention(state.chats,chat.id)};}
  let child;
  try{child=spawnCli(binaries[provider],cliArgs(provider,context),{cwd:chat.cwd,env:commandEnv,detached:true,stdio:['pipe','pipe','pipe']});}
  catch{
    complete(chat,'',`Could not start ${provider==='codex'?'Codex CLI':'Claude Code'}. Check its installation and refresh Connections.`);
    return {nextId:nextAttention(state.chats,chat.id)};
  }
  const job={child,folder,edit:chat.permission==='edit',stopped:false,settled:false,facts:[]};jobs.set(chat.id,job);
  let buffer='',stderr='',messages=[],failure='',final='',sessionCandidate='';
  const timeout=setTimeout(()=>{failure='This turn reached the 20-minute limit. Review partial output and send a continuation.';stopJob(chat.id,job);},20*60*1000);
  function event(line){let raw;try{raw=JSON.parse(line);}catch{return;}addEvidence(job.facts,managedEvidence(provider,raw));const e=decodeEvent(provider,raw);
    if(e.session)sessionCandidate=e.session;
    if(e.activity)chat.activity=e.activity;
    if(e.message){messages.push(e.message);chat.liveText=messages.join('\n\n').slice(-60000);}
    if(e.delta)chat.liveText=(chat.liveText+e.delta).slice(-60000);
    if(e.final)final=e.final;
    if(e.error)failure=e.error;
    if(e.denials?.length)chat.permissionNotice='Some tools were unavailable in this project’s current access mode.';
    update();
  }
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){event(buffer.slice(0,index));buffer=buffer.slice(index+1);}if(buffer.length>2000000){failure='Agent output exceeded the event size limit.';killGroup(child);}});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-10000);});
  function settle(code,error){if(job.settled)return;job.settled=true;clearTimeout(timeout);jobs.delete(chat.id);if(buffer.trim())event(buffer);
    const answer=final || messages.join('\n\n') || chat.liveText;
    if(job.stopped){complete(chat,answer,'You stopped this turn.',job.facts,'interrupted');return;}
    if(error || code!==0 || failure){complete(chat,answer,failure || error?.message || stderr.trim() || `Agent exited with code ${code}.`,job.facts);return;}
    if(!answer){complete(chat,'','The agent finished without a response.');return;}
    if(sessionCandidate)chat.sessions[provider]=sessionCandidate;
    complete(chat,answer,null,job.facts);
  }
  child.on('error',error=>settle(null,error));child.on('close',code=>settle(code));child.stdin.on('error',()=>{});child.stdin.end(prompt);
  return {nextId:nextAttention(state.chats,chat.id)};
}
function complete(chat,answer,error,facts=[],phase=error?'failed':'finished'){
  const handoff=parseHandoff(answer);
  const request=chat.messages.findLast(m=>m.role==='user');
  const turn={id:randomUUID(),origin:'managed',provider:chat.provider,at:Date.now(),phase,answer:handoff.text,request:request?.text||'',replyTo:request?.replyTo??null,facts,earlier:[]};
  addEvidence(facts,note('message','Agent response',turn.answer));
  try{if(error)throw Error();turn.card=makeCard(resultPayload(answer),turn);turn.analysis='ready';}
  catch{
    turn.answer=answer;
    turn.card=rawCard(turn);
    turn.analysis='raw';
    if(!error)turn.analysisError='The decision could not be verified from this handoff. Review the original response.';
  }
  (chat.turns||=[]).push(turn);chat.displayTurn=turn.id;
  if(!error && !chat.demo)recordResponse(chat.provider);
  if(turn.answer)chat.messages.push({id:randomUUID(),role:'assistant',provider:chat.provider,text:turn.answer,at:Date.now()});
  if(answer && !error){chat.summary=handoff.summary;chat.nextAction=handoff.nextAction;}
  chat.status='ready';chat.readyAt=Date.now();chat.liveText='';chat.activity='';chat.error=error||null;update({immediate:true,background:true});}
async function login(provider){validProvider(provider);if(!binaries[provider])throw new Error(`Install ${provider==='codex'?'Codex CLI':'Claude Code'} first.`);if(authJobs.has(provider))return;
  authErrors.delete(provider);
  const child=spawnCli(binaries[provider],provider==='codex'?['login','--device-auth']:['auth','login'],{env:commandEnv,stdio:['pipe','pipe','pipe'],detached:true});
  const job={child,instructions:'Opening the provider’s secure sign-in flow…',settled:false,timedOut:false};authJobs.set(provider,job);
  const timer=setTimeout(()=>{job.timedOut=true;killGroup(child);},10*60*1000);
  const output=chunk=>{job.instructions=(job.instructions+'\n'+chunk.toString().replace(/\x1b\[[0-9;]*m/g,'')).slice(-6000);connections[provider]={...connections[provider],signingIn:true,instructions:job.instructions,loginError:''};publish();};
  child.stdout.on('data',output);child.stderr.on('data',output);child.stdin.on('error',()=>{});
  const finish=(code,error)=>{if(job.settled)return;job.settled=true;clearTimeout(timer);authJobs.delete(provider);
    if(error || code!==0){const command=provider==='codex'?'codex login':'claude auth login';authErrors.set(provider,`${job.timedOut?'Sign-in timed out':'Sign-in did not finish'}. Try again here, or run ${command} in a terminal.`);}
    checkConnections();};
  child.on('error',error=>finish(null,error));child.on('close',code=>finish(code));await checkConnections();
}
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){
  req.setEncoding('utf8');
  let data='',size=0;
  for await(const chunk of req){
    size+=Buffer.byteLength(chunk);
    if(size>400000)throw Object.assign(Error('Request is too large.'),{status:413});
    data+=chunk;
  }
  try {
    const value=JSON.parse(data||'{}');
    if(!value || typeof value!=='object' || Array.isArray(value))throw Error();
    return value;
  } catch {throw Error('Expected a JSON object.');}
}
const server=http.createServer(async(req,res)=>{
  try{
    const host=req.headers.host;
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host)){send(res,403,{error:'Local access only.'});return;}
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const url=new URL(req.url,`http://${host}`), route=url.pathname;
    if(req.method!=='GET' && (req.headers['x-switchboard-token']!==token || (req.headers.origin && ![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin)))){send(res,403,{error:'Refresh Switchboard before continuing.'});return;}
    if(route==='/api/health' && req.method==='GET'){send(res,200,{app:'switchboard',version,workspace});return;}
    if(route==='/api/bootstrap' && req.method==='GET'){send(res,200,{...state,chats:publicChats(),connections,desktop:desktopState(),token,root,workspace,storageError,canRevealFiles:process.platform==='darwin'});return;}
    if(route==='/api/desktop' && req.method==='GET'){await nativeDiscovery(url.searchParams.has('refresh'));send(res,200,{...desktopState(),sources:nativeSources});return;}
    if(route==='/api/discover' && req.method==='GET'){
      const offset=Number(url.searchParams.get('offset')||0);
      if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid history offset.');
      const requested=url.searchParams.get('snapshot');
      const snapshotId=requested||randomUUID();
      let snapshot=discoverySnapshots.get(snapshotId);
      if(requested&&!snapshot)throw Object.assign(Error('This chat list expired. Close it and reopen Find existing projects.'),{status:410});
      if(!snapshot){
        snapshot=await discoverySnapshot();
        discoverySnapshots.set(snapshotId,snapshot);
        if(discoverySnapshots.size>16)discoverySnapshots.delete(discoverySnapshots.keys().next().value);
      }
      const page=await discoverPage({offset,snapshot});
      for(const p of page.projects)discoveredById.set(p.id,p);
      send(res,200,{snapshotId,nextOffset:page.nextOffset,projects:page.projects.filter(p=>!state.chats.some(c=>Object.values(c.sessions||{}).includes(p.sourceSession))).map(({messages,transcriptPath,...p})=>p)});return;
    }
    if(route==='/api/events' && req.method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});clients.add(res);res.write(`data: ${JSON.stringify({...state,chats:publicChats(),connections,desktop:desktopState(),storageError,workspace})}\n\n`);const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);req.on('close',()=>{clients.delete(res);clearInterval(heartbeat);});return;}
    if(req.method==='POST'){
      const data=await body(req);
      const reveal=route.match(/^\/api\/chats\/([^/]+)\/reveal-file$/);
      if(reveal){await revealProjectFile(requiredChat(reveal[1]),data.path);send(res,200,{ok:true});return;}
      if(route==='/api/desktop/config'){
        await nativeDiscovery(true);if(data.queue!==undefined){if(!Array.isArray(data.queue)||data.queue.length>20||new Set(data.queue).size!==data.queue.length||data.queue.some(id=>!nativeSources.some(s=>s.id===id)))throw new Error('Choose up to 20 distinct existing Codex chats.');state.desktop.queue=data.queue;}
        if(data.monitorAll!==undefined)state.desktop.monitorAll=data.monitorAll===true;
        if(data.emptyBehavior!==undefined){if(!['brainstorm','ideas','stay'].includes(data.emptyBehavior))throw new Error('Unknown empty-queue behavior.');state.desktop.emptyBehavior=data.emptyBehavior;}
        if(data.enabled!==undefined)await enableDesktop(data.enabled===true);else update({immediate:true});send(res,200,desktopState());return;
      }
      if(route==='/api/desktop/open'){const source=(await nativeDiscovery()).find(s=>s.id===data.id);if(!source)throw new Error('Existing Codex chat not found.');const result=await openInCodex(source.sourceSession);send(res,200,result);return;}
      if(route==='/api/usage'){
        const provider=validProvider(data.provider);
        if(data.clear===true){delete state.usage[provider];}
        else {
          if(typeof data.used!=='number'||!Number.isFinite(data.used)||data.used<0||data.used>100)throw new Error('Enter a percentage between 0 and 100.');
          if(typeof data.resetAt!=='string'||(data.resetAt && (!Number.isFinite(Date.parse(data.resetAt))||!/^\d{4}-\d{2}-\d{2}T/.test(data.resetAt))))throw new Error('Enter a valid reset time.');
          state.usage[provider]={used:data.used,resetAt:data.resetAt?new Date(data.resetAt).toISOString():null,updatedAt:new Date().toISOString()};
        }
        update({immediate:true});send(res,200,{usage:state.usage});return;
      }
      if(route==='/api/connections/refresh'){await checkConnections();send(res,200,connections);return;}
      if(route==='/api/connections/desktop'){
        await openProviderDesktop(validProvider(data.provider));
        send(res,200,{ok:true});return;
      }
      if(route==='/api/connections/terminal'){
        const provider=validProvider(data.provider);
        if(process.platform!=='darwin')throw Error('Terminal sign-in is available on macOS.');
        const binary=findBinary(provider,commandEnv);
        if(!binary)throw Error('Install the provider CLI to sign in.');
        await openProviderTerminal(provider,binary,commandEnv);
        send(res,200,{ok:true});return;
      }
      if(route==='/api/connections/login'){await login(data.provider);send(res,200,{ok:true});return;}
      if(route==='/api/connections/code'){
        const provider=validProvider(data.provider),job=authJobs.get(provider);
        if(!job || job.settled || job.child.stdin.destroyed)throw new Error('No sign-in is waiting for a code. Start sign-in again.');
        if(typeof data.code!=='string'||!data.code.trim()||data.code.length>2048||/[\r\n]/.test(data.code))throw new Error('Enter a single authorization code.');
        await new Promise((resolve,reject)=>job.child.stdin.write(data.code.trim()+'\n',error=>error?reject(new Error('Could not send the code. Start sign-in again.')):resolve()));
        send(res,200,{ok:true});return;
      }

      if(route==='/api/chats'){
        const title=string(data.title,200);if(!title)throw new Error('Give your project a name.');
        const chat=newChat({title,goal:string(data.goal||''),cwd:validCwd(data.cwd),provider:validProvider(data.provider)});
        const chats=[...state.chats,chat];save({...state,chats});state.chats=chats;publish();send(res,201,{chat});return;
      }
      if(route==='/api/import'){
        const source=discoveredById.get(data.id)||(await discovery()).find(p=>p.id===data.id);if(!source)throw new Error('This project is no longer available. Refresh discovery.');
        const chat=await importSource(source,data.watch===true);
        send(res,201,{chat:publicChats().find(c=>c.id===chat.id)});return;
      }
      if(route==='/api/demo'){
        let demo=state.chats.filter(c=>c.demo);if(!demo.length){demo=[['Portfolio site','The first draft is ready. Choose whether to lead with your work or your story.','Which direction should the homepage take?'],['Research notes','Three themes emerged from the reading. We can turn them into a concise outline.','Would you like an outline or a deeper comparison?'],['Launch plan','A small pilot would let us test the idea with a clear success measure.','What would make the pilot worth doing?']].map(([title,summary,nextAction])=>newChat({title,summary,nextAction,demo:true,provider:'codex'}));state.chats.push(...demo);}update({immediate:true});send(res,200,{chat:demo[0]});return;
      }
      if(route==='/api/demo/clear'){for(const c of state.chats.filter(c=>c.demo)){const job=jobs.get(c.id);if(job?.timer)clearTimeout(job.timer);jobs.delete(c.id);}state.chats=state.chats.filter(c=>!c.demo);update({immediate:true});send(res,200,{ok:true});return;}
      if(route==='/api/ideas'){const text=string(data.text,5000);if(!text)throw new Error('Write an idea first.');const idea={id:randomUUID(),text,at:Date.now()};state.ideas.unshift(idea);update({immediate:true});send(res,201,{idea});return;}
      if(route==='/api/ideas/start'){
        const cwd=validCwd(data.cwd),provider=validProvider(data.provider||'codex');
        if(typeof data.id!=='string'||!data.id)throw new Error('Idea not found.');
        if(data.title!==undefined && !string(data.title,200))throw new Error('Give your project a name.');
        const existing=state.chats.find(c=>c.ideaId===data.id);
        if(existing){
          if(realpathSync(existing.cwd)!==realpathSync(cwd))throw Object.assign(new Error('This idea already started in a different project folder. Open that project or save a new idea.'),{status:409});
          send(res,200,{chat:existing,duplicate:true});return;
        }
        const idea=state.ideas.find(i=>i.id===data.id);if(!idea)throw new Error('Idea not found.');
        const title=string(data.title??idea.text.replace(/\s+/g,' ').slice(0,100),200);
        if(!title)throw new Error('Give your project a name.');
        const goal=string(data.goal??idea.text);
        const chat=newChat({title,goal,cwd,provider,ideaId:idea.id});
        const next={...state,chats:[...state.chats,chat],ideas:state.ideas.filter(i=>i.id!==idea.id)};
        save(next);state.chats=next.chats;state.ideas=next.ideas;publish();send(res,201,{chat});return;
      }
      const match=route.match(/^\/api\/chats\/([^/]+)\/(send|update|park|stop|delete|reset-session|pause-watch|resume-watch|analyze)$/);
      if(match){const chat=requiredChat(match[1]);const action=match[2];
        if(action==='pause-watch'){monitor.pause(chat);send(res,200,{ok:true});return;}
        if(action==='resume-watch'){
          if(!chat.watch)throw new Error('This project does not have a chat to resume watching.');
          if(!chat.watch.enabled){
            const {provider,file,session}=chat.watch;
            await monitor.watch(chat,{provider,transcriptPath:file,sourceSession:session});
          }
          send(res,200,{ok:true});return;
        }
        if(action==='analyze'){const t=chat.turns?.find(t=>t.id===data.turnId);if(!chat.watch?.enabled||t?.origin!=='watched'||t.phase!=='finished')throw new Error('Follow this chat to analyze its completed turn.');if(t.analysis!=='analyzing'){t.analysis='queued';monitor.schedule();update({immediate:true});}send(res,202,{ok:true});return;}
        if(action==='send'){
          if(typeof data.text!=='string' || !data.text.trim())throw Error('Write a prompt first.');
          const text=data.text.trim();
          if(text.length>50000)throw Object.assign(Error('Your reply is over 50,000 characters. Shorten it and try again.'),{status:413});
          if(!chat.demo && chat.permission==='edit')await monitor.refresh(overlappingWatches(chat));
          send(res,202,run(requiredChat(match[1]),text,string(data.requestId||randomUUID(),100),data.turnId,data.provider,data.choice));return;
        }
        if(action==='stop'){const job=jobs.get(chat.id);if(job?.demo){clearTimeout(job.timer);jobs.delete(chat.id);complete(chat,'','You stopped this demo turn.',[],'interrupted');}else if(job){job.stopped=true;chat.status='stopping';stopJob(chat.id,job);update();}send(res,200,{ok:true});return;}
        if(['running','stopping'].includes(chat.status))throw new Error('Stop this turn before changing the project.');
        if(action==='update'){
          persistChat(chat,updatedProject(chat,data));
          send(res,200,{nextId:nextAttention(state.chats,chat.id)});return;
        }
        if(action==='reset-session'){delete chat.sessions[validProvider(chat.provider)];chat.error=null;}
        if(action==='park'){chat.status='parked';delete chat.unseenWatchedTurn;}
        if(action==='delete'){monitor.pause(chat);state.chats=state.chats.filter(c=>c.id!==chat.id);}
        update({immediate:true});send(res,200,{nextId:nextAttention(state.chats,chat.id)});return;
      }
      send(res,404,{error:'Unknown action.'});return;
    }
    const assets={'/':'index.html','/app.js':'app.js','/drafts.js':'drafts.js','/local-files.js':'local-files.js','/styles.css':'styles.css','/desktop':'desktop.html','/desktop.js':'desktop.js','/desktop.css':'desktop.css'};
    if(req.method==='GET' && assets[route]){const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};res.writeHead(200,{'Content-Type':types[path.extname(assets[route])],'Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"});res.end(await readFile(path.join(root,'public',assets[route])));return;}
    send(res,404,{error:'Not found.'});
  }catch(error){send(res,error.status||400,{error:error.message});}
});
const monitor=createMonitor({state,storage,save:saveBackground,publish,binaries,env:commandEnv,isConnected:p=>connections[p]?.signedIn,onResponse:recordResponse});
await checkConnections();
if(state.desktop.enabled)try{await enableDesktop(true);}catch(e){state.desktop.enabled=false;nativeError=e.message;listenerState='error';save();}
server.listen(port,'127.0.0.1',()=>console.log(`Switchboard is running at http://127.0.0.1:${port}\nWorkspace data: ${storage}`));
server.on('error',error=>{console.error(error.message);process.exit(1);});
let closing=false;
function shutdown(){if(closing)return;closing=true;monitor.close();listener.stop();for(const job of jobs.values()){if(job.child)killGroup(job.child);if(job.timer)clearTimeout(job.timer);}for(const job of authJobs.values())killGroup(job.child);saveBackground();for(const res of clients)res.end();server.close();setTimeout(()=>process.exit(0),1000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
