import http from 'node:http';
import {readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID, randomBytes} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {nextAttention, parseHandoff, agentPrompt, cliArgs, decodeEvent, providers} from './lib/core.mjs';
import {discover} from './lib/discovery.mjs';
import {CodexSubmitListener,nextDesktop,openInCodex,openCodexBrainstorm} from './lib/desktop.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const storage=process.env.SWITCHBOARD_DATA_DIR || path.join(root,'.local');
mkdirSync(storage,{recursive:true,mode:0o700});
const stateFile=path.join(storage,'workspace.json');
let state={chats:[],ideas:[]};
if (existsSync(stateFile)) {try{state=JSON.parse(readFileSync(stateFile,'utf8'));}catch{throw new Error('Workspace data could not be read. Preserve .local/workspace.json before repairing it.');}}
state.usage ||= {};
state.desktop ||= {enabled:false,queue:state.chats.filter(c=>c.sourceId?.startsWith('codex:')).map(c=>c.sourceId),monitorAll:true,emptyBehavior:'brainstorm',history:[]};
const clients=new Set(), jobs=new Map(), authJobs=new Map();
const token=randomBytes(32).toString('hex');
const port=Number(process.env.PORT || 4317);
const commandEnv={...process.env,PATH:[path.dirname(process.execPath),process.env.PATH || ''].join(path.delimiter)};
const binaries={};
for (const provider of providers) {
  const override=process.env[`SWITCHBOARD_${provider.toUpperCase()}_BIN`];
  const candidates=[override, ...((commandEnv.PATH || '').split(path.delimiter).map(p=>path.join(p,provider))),
    ...(provider==='codex' ? ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex','/Applications/Codex.app/Contents/Resources/codex',path.join(os.homedir(),'.local/bin/codex')] : [path.join(os.homedir(),'.local/bin/claude')])];
  binaries[provider]=candidates.find(p=>p && existsSync(p));
}
let connections={}, discovered=[], discoveryAt=0, persistenceTimer;
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
function save(){clearTimeout(persistenceTimer);const tmp=stateFile+'.tmp';writeFileSync(tmp,JSON.stringify(state,null,2),{mode:0o600});renameSync(tmp,stateFile);}
function publish(){const data=JSON.stringify({chats:state.chats,ideas:state.ideas,usage:state.usage,connections,desktop:desktopState()});for(const res of clients)if(!res.writableEnded)res.write(`data: ${data}\n\n`);}
function update({immediate=false}={}){publish();if(immediate)save();else{clearTimeout(persistenceTimer);persistenceTimer=setTimeout(save,150);}}
for (const chat of state.chats) if (chat.status==='running' || chat.status==='stopping') {chat.status='ready';chat.error='The app closed during this turn. Review any partial output before continuing.';chat.readyAt=Date.now();}
async function checkConnections(){
  await Promise.all(providers.map(provider=>new Promise(resolve=>{
    const binary=binaries[provider];
    if(!binary){connections[provider]={installed:false,signedIn:false};return resolve();}
    const child=spawn(binary,provider==='codex'?['login','status']:['auth','status'],{env:commandEnv,stdio:['ignore','pipe','pipe']});
    let output='';const timer=setTimeout(()=>child.kill(),6000);
    child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
    child.on('error',()=>{clearTimeout(timer);connections[provider]={installed:true,signedIn:false};resolve();});
    child.on('close',code=>{clearTimeout(timer);let signedIn=false;try{signedIn=provider==='claude'?JSON.parse(output).loggedIn===true:code===0 && /logged in/i.test(output);}catch{}
      connections[provider]={installed:true,signedIn,signingIn:authJobs.has(provider),instructions:authJobs.get(provider)?.instructions || ''};resolve();});
  })));
  publish();return connections;
}
async function discovery(refresh=false){if(refresh || Date.now()-discoveryAt>60000){discovered=await discover();discoveryAt=Date.now();}return discovered;}
function requiredChat(id){const c=state.chats.find(c=>c.id===id);if(!c)throw Object.assign(new Error('Chat not found.'),{status:404});return c;}
function validProvider(p){if(!providers.includes(p))throw new Error('Choose Codex or Claude.');return p;}
function validCwd(cwd){if(typeof cwd!=='string'||!path.isAbsolute(cwd)||!existsSync(cwd)||!statSync(cwd).isDirectory())throw new Error('Choose an existing project folder using its full path.');return cwd;}
function string(value,max=2000){if(typeof value!=='string')throw new Error('Expected text.');return value.trim().slice(0,max);}
function newChat(data){return {id:randomUUID(),title:data.title,goal:data.goal||'',cwd:data.cwd||root,provider:data.provider||'codex',permission:'read',status:'ready',readyAt:Date.now(),priority:0,summary:data.summary||'Set the direction for this project. Your first prompt will start the conversation.',decisions:[],nextAction:'What would you like to work on?',messages:data.messages||[],sessions:{},...data};}
function killGroup(child, signal='SIGTERM'){try{process.kill(-child.pid,signal);}catch{child.kill(signal);}}
function run(chat,text,requestId){
  if(chat.lastRequestId===requestId)return {nextId:nextAttention(state.chats,chat.id),duplicate:true};
  if(['running','stopping'].includes(chat.status))throw Object.assign(new Error('This chat is already working.'),{status:409});
  if(jobs.size>=3)throw Object.assign(new Error('Three chats are already working. Wait for one to finish.'),{status:429});
  const provider=validProvider(chat.provider);
  if(!chat.demo && !connections[provider]?.signedIn)throw new Error(`Sign into ${provider==='codex'?'Codex':'Claude'} in Connections first.`);
  validCwd(chat.cwd);
  const prompt=agentPrompt(chat,text,provider);
  chat.messages.push({id:randomUUID(),role:'user',provider,text,at:Date.now()});
  chat.lastRequestId=requestId;chat.error=null;chat.status='running';chat.activity='Starting your agent';chat.liveText='';chat.startedAt=Date.now();update({immediate:true});
  if(chat.demo){const timer=setTimeout(()=>{jobs.delete(chat.id);complete(chat,`Here is a direction we can build on: ${text}\n\nThis is a simulated response so you can try the handoff.\n\n<<<SWITCHBOARD_HANDOFF>>>${JSON.stringify({summary:'The demo agent finished. Your project is ready for another decision.',decisions:[],next_action:'Try another prompt or mark this chat caught up.'})}`);},2800);jobs.set(chat.id,{demo:true,timer});return {nextId:nextAttention(state.chats,chat.id)};}
  const child=spawn(binaries[provider],cliArgs(provider,chat),{cwd:chat.cwd,env:commandEnv,detached:true,stdio:['pipe','pipe','pipe']});
  const job={child,stopped:false,settled:false};jobs.set(chat.id,job);
  let buffer='',stderr='',messages=[],failure='',final='',sessionCandidate='';
  const timeout=setTimeout(()=>{failure='This turn reached the 20-minute limit. Review partial output and send a continuation.';killGroup(child);},20*60*1000);
  function event(line){let raw;try{raw=JSON.parse(line);}catch{return;}const e=decodeEvent(provider,raw);
    if(e.session)sessionCandidate=e.session;
    if(e.activity)chat.activity=e.activity;
    if(e.message){messages.push(e.message);chat.liveText=messages.join('\n\n').slice(-60000);}
    if(e.delta)chat.liveText=(chat.liveText+e.delta).slice(-60000);
    if(e.final)final=e.final;
    if(e.error)failure=e.error;
    if(e.denials?.length)chat.permissionNotice='Some tools were unavailable in this project’s current access mode.';
    update();
  }
  child.stdout.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){event(buffer.slice(0,index));buffer=buffer.slice(index+1);}if(buffer.length>2000000){failure='Agent output exceeded the event size limit.';killGroup(child);}});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-10000);});
  function settle(code,error){if(job.settled)return;job.settled=true;clearTimeout(timeout);jobs.delete(chat.id);if(buffer.trim())event(buffer);
    const answer=final || messages.join('\n\n') || chat.liveText;
    if(job.stopped){complete(chat,answer,'You stopped this turn.');return;}
    if(error || code!==0 || failure){complete(chat,answer,failure || error?.message || stderr.trim() || `Agent exited with code ${code}.`);return;}
    if(!answer){complete(chat,'','The agent finished without a response.');return;}
    if(sessionCandidate)chat.sessions[provider]=sessionCandidate;
    complete(chat,answer);
  }
  child.on('error',error=>settle(null,error));child.on('close',code=>settle(code));child.stdin.on('error',()=>{});child.stdin.end(prompt);
  return {nextId:nextAttention(state.chats,chat.id)};
}
function complete(chat,answer,error){const handoff=parseHandoff(answer);if(handoff.text)chat.messages.push({id:randomUUID(),role:'assistant',provider:chat.provider,text:handoff.text,at:Date.now()});
  if(answer && !error){chat.summary=handoff.summary;chat.nextAction=handoff.nextAction;chat.decisions=[...new Set([...chat.decisions,...handoff.decisions])].slice(-30);}
  chat.status='ready';chat.readyAt=Date.now();chat.liveText='';chat.activity='';chat.error=error||null;update({immediate:true});}
async function login(provider){validProvider(provider);if(!binaries[provider])throw new Error(`Install ${provider==='codex'?'Codex CLI':'Claude Code'} first.`);if(authJobs.has(provider))return;
  const child=spawn(binaries[provider],provider==='codex'?['login','--device-auth']:['auth','login'],{env:commandEnv,stdio:['ignore','pipe','pipe'],detached:true});
  const job={child,instructions:'Opening the provider’s secure sign-in flow…'};authJobs.set(provider,job);
  const timer=setTimeout(()=>killGroup(child),10*60*1000);
  const output=chunk=>{job.instructions=(job.instructions+'\n'+chunk.toString().replace(/\x1b\[[0-9;]*m/g,'')).slice(-6000);connections[provider]={...connections[provider],signingIn:true,instructions:job.instructions};publish();};
  child.stdout.on('data',output);child.stderr.on('data',output);
  const finish=()=>{clearTimeout(timer);authJobs.delete(provider);checkConnections();};child.on('error',finish);child.on('close',finish);await checkConnections();
}
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let data='';for await(const b of req){data+=b;if(data.length>100000)throw new Error('Request is too large.');}try{return JSON.parse(data||'{}');}catch{throw new Error('Invalid JSON.');}}
const server=http.createServer(async(req,res)=>{
  try{
    const host=req.headers.host;
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host)){send(res,403,{error:'Local access only.'});return;}
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const url=new URL(req.url,`http://${host}`), route=url.pathname;
    if(req.method!=='GET' && (req.headers['x-switchboard-token']!==token || (req.headers.origin && ![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin)))){send(res,403,{error:'Refresh Switchboard before continuing.'});return;}
    if(route==='/api/bootstrap' && req.method==='GET'){send(res,200,{...state,connections,desktop:desktopState(),token,root});return;}
    if(route==='/api/desktop' && req.method==='GET'){await nativeDiscovery(url.searchParams.has('refresh'));send(res,200,{...desktopState(),sources:nativeSources});return;}
    if(route==='/api/discover' && req.method==='GET'){send(res,200,{projects:await discovery(url.searchParams.has('refresh'))});return;}
    if(route==='/api/events' && req.method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});clients.add(res);res.write(`data: ${JSON.stringify({...state,connections,desktop:desktopState()})}\n\n`);const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);req.on('close',()=>{clients.delete(res);clearInterval(heartbeat);});return;}
    if(req.method==='POST'){
      const data=await body(req);
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
      if(route==='/api/connections/login'){await login(data.provider);send(res,200,{ok:true});return;}
      if(route==='/api/chats'){
        const title=string(data.title,200);if(!title)throw new Error('Give your project a name.');
        const chat=newChat({title,goal:string(data.goal||''),cwd:validCwd(data.cwd||root),provider:validProvider(data.provider)});state.chats.push(chat);update({immediate:true});send(res,201,{chat});return;
      }
      if(route==='/api/import'){
        const source=(await discovery()).find(p=>p.id===data.id);if(!source)throw new Error('This project is no longer available. Refresh discovery.');
        const existing=state.chats.find(c=>c.sourceId===source.id);if(existing){send(res,200,{chat:existing});return;}
        const chat=newChat({title:source.title,cwd:validCwd(source.cwd),provider:source.provider,summary:source.summary,messages:source.messages.map(m=>({...m,id:randomUUID(),imported:true})),sourceId:source.id,sourceSession:source.sourceSession,nextAction:'Read the imported context and tell the agent what to do next.'});state.chats.push(chat);update({immediate:true});send(res,201,{chat});return;
      }
      if(route==='/api/demo'){
        let demo=state.chats.filter(c=>c.demo);if(!demo.length){demo=[['Portfolio site','The first draft is ready. Choose whether to lead with your work or your story.','Which direction should the homepage take?'],['Research notes','Three themes emerged from the reading. We can turn them into a concise outline.','Would you like an outline or a deeper comparison?'],['Launch plan','A small pilot would let us test the idea with a clear success measure.','What would make the pilot worth doing?']].map(([title,summary,nextAction])=>newChat({title,summary,nextAction,demo:true,provider:'codex'}));state.chats.push(...demo);}update({immediate:true});send(res,200,{chat:demo[0]});return;
      }
      if(route==='/api/demo/clear'){for(const c of state.chats.filter(c=>c.demo)){const job=jobs.get(c.id);if(job?.timer)clearTimeout(job.timer);jobs.delete(c.id);}state.chats=state.chats.filter(c=>!c.demo);update({immediate:true});send(res,200,{ok:true});return;}
      if(route==='/api/ideas'){const text=string(data.text,5000);if(!text)throw new Error('Write an idea first.');const idea={id:randomUUID(),text,at:Date.now()};state.ideas.unshift(idea);update({immediate:true});send(res,201,{idea});return;}
      if(route==='/api/ideas/start'){const idea=state.ideas.find(i=>i.id===data.id);if(!idea)throw new Error('Idea not found.');const chat=newChat({title:idea.text.replace(/\s+/g,' ').slice(0,100),goal:idea.text,cwd:validCwd(data.cwd||root),provider:validProvider(data.provider||'codex')});state.chats.push(chat);state.ideas=state.ideas.filter(i=>i.id!==idea.id);update({immediate:true});send(res,201,{chat});return;}
      const match=route.match(/^\/api\/chats\/([^/]+)\/(send|update|park|stop|delete|reset-session)$/);
      if(match){const chat=requiredChat(match[1]);const action=match[2];
        if(action==='send'){const text=string(data.text,50000);if(!text)throw new Error('Write a prompt first.');send(res,202,run(chat,text,string(data.requestId||randomUUID(),100)));return;}
        if(action==='stop'){const job=jobs.get(chat.id);if(job?.demo){clearTimeout(job.timer);jobs.delete(chat.id);complete(chat,'','You stopped this demo turn.');}else if(job){job.stopped=true;chat.status='stopping';killGroup(job.child);const timer=setTimeout(()=>{if(jobs.has(chat.id))killGroup(job.child,'SIGKILL');},3000);timer.unref();update();}send(res,200,{ok:true});return;}
        if(['running','stopping'].includes(chat.status))throw new Error('Stop this turn before changing the project.');
        if(action==='update'){if(data.provider)chat.provider=validProvider(data.provider);if(data.permission){if(!['read','edit'].includes(data.permission))throw new Error('Unknown access mode.');chat.permission=data.permission;}if(data.decision){chat.decisions.push(string(data.decision));}if(data.goal!==undefined)chat.goal=string(data.goal);if(data.priority!==undefined)chat.priority=data.priority===1?1:0;if(data.status==='ready'){chat.status='ready';chat.readyAt=Date.now();}}
        if(action==='reset-session'){delete chat.sessions[validProvider(chat.provider)];chat.error=null;}
        if(action==='park')chat.status='parked';
        if(action==='delete')state.chats=state.chats.filter(c=>c.id!==chat.id);
        update({immediate:true});send(res,200,{nextId:nextAttention(state.chats,chat.id)});return;
      }
      send(res,404,{error:'Unknown action.'});return;
    }
    const assets={'/':'index.html','/app.js':'app.js','/styles.css':'styles.css','/desktop':'desktop.html','/desktop.js':'desktop.js','/desktop.css':'desktop.css'};
    if(req.method==='GET' && assets[route]){const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};res.writeHead(200,{'Content-Type':types[path.extname(assets[route])],'Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"});res.end(await readFile(path.join(root,'public',assets[route])));return;}
    send(res,404,{error:'Not found.'});
  }catch(error){send(res,error.status||400,{error:error.message});}
});
await checkConnections();
if(state.desktop.enabled)try{await enableDesktop(true);}catch(e){state.desktop.enabled=false;nativeError=e.message;listenerState='error';save();}
server.listen(port,'127.0.0.1',()=>console.log(`Switchboard is running at http://127.0.0.1:${port}\nWorkspace data: ${storage}`));
server.on('error',error=>{console.error(error.message);process.exit(1);});
let closing=false;
function shutdown(){if(closing)return;closing=true;listener.stop();for(const job of jobs.values()){if(job.child)killGroup(job.child);if(job.timer)clearTimeout(job.timer);}for(const job of authJobs.values())killGroup(job.child);save();for(const res of clients)res.end();server.close();setTimeout(()=>process.exit(0),1000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
