// Optional integration check: the installed Claude CLI talks to a local mock,
// while Codex is simulated. No provider account or real API key is required.
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const candidates=[process.env.SWITCHBOARD_CLAUDE_BIN,...(process.env.PATH||'').split(path.delimiter).map(p=>path.join(p,'claude')),path.join(os.homedir(),'.local/bin/claude')];
const claude=candidates.find(p=>p&&existsSync(p));
if(!claude){console.error('Claude Code was not found. Install it or set SWITCHBOARD_CLAUDE_BIN.');process.exit(1);}
const dir=await mkdtemp(path.join(os.tmpdir(),'switchboard-claude-smoke-'));
const code='blue-otter-147';
const answer=code+'\n<<<SWITCHBOARD_HANDOFF>>>'+JSON.stringify({summary:`Remember ${code}`,decisions:[],next_action:'Continue the integration test.'});
const requests=[];
const mock=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 if(req.url?.includes('/v1/messages/count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({input_tokens:10}));return;}
 if(!req.url?.includes('/v1/messages')){res.writeHead(404);res.end();return;}
 let input;try{input=JSON.parse(raw);}catch{res.writeHead(400);res.end();return;}
 requests.push({containsCode:raw.includes(code),messageCount:input.messages?.length||0});
 const message={id:'msg_local_test',type:'message',role:'assistant',model:input.model||'mock-claude',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}};
 const events=[{type:'message_start',message},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:answer}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:20}},{type:'message_stop'}];
 if(input.stream){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});for(const e of events)res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);res.end();}
 else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({...message,content:[{type:'text',text:answer}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:20}}));}
});
let child;
try{
 await mkdir(path.join(dir,'project'));await mkdir(path.join(dir,'config'));
 const codex=path.join(dir,'codex-fake');
 await writeFile(codex,`#!/usr/bin/env node\nconst args=process.argv.slice(2);if(args.includes('status')){console.log('Logged in using local mock');process.exit(0)}let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000001'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(answer)}}}));});\n`,{mode:0o755});
 await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
 const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const env={...process.env};
 for(const key of Object.keys(env))if(/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|CLAUDECODE$)/.test(key))delete env[key];
 Object.assign(env,{PORT:String(port),SWITCHBOARD_DATA_DIR:path.join(dir,'data'),SWITCHBOARD_CODEX_BIN:codex,SWITCHBOARD_CLAUDE_BIN:claude,CLAUDE_CONFIG_DIR:path.join(dir,'config'),ANTHROPIC_API_KEY:'not-a-real-key',ANTHROPIC_BASE_URL:`http://127.0.0.1:${mock.address().port}`,ANTHROPIC_MODEL:'claude-sonnet-4-5',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'});
 child=spawn(process.execPath,[path.join(root,'server.mjs')],{env,stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr+=b);
 const base=`http://127.0.0.1:${port}`;
 async function get(){const r=await fetch(base+'/api/bootstrap');if(!r.ok)throw Error(`Bootstrap returned ${r.status}`);return r.json();}
 let state;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(stderr||'Switchboard exited');try{state=await get();break;}catch{await delay(100);}}
 if(!state)throw Error(stderr||'Switchboard did not start');
 const token=state.token;
 if(!state.connections.claude?.signedIn)throw Error(state.connections.claude?.connectionError||'Claude CLI did not recognize the local dummy API key.');
 async function post(route,body){const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error(value.error||`HTTP ${r.status}`);return value;}
 async function turn(id,text){await post(`/api/chats/${id}/send`,{text});for(let i=0;i<225;i++){await delay(200);const c=(await get()).chats.find(x=>x.id===id);if(c.status==='ready'){if(c.error)throw Error(c.error);if(!c.messages.at(-1)?.text.includes(code))throw Error('Unexpected response.');return c;}}throw Error('Provider response timed out.');}
 const {chat}=await post('/api/chats',{title:'Local CLI smoke test',cwd:path.join(dir,'project'),provider:'codex'});
 await turn(chat.id,`Remember ${code}`);
 await post(`/api/chats/${chat.id}/update`,{provider:'claude'});let c=await turn(chat.id,'Recall the project code.');const firstSession=c.sessions.claude;
 if(!firstSession||!requests[0]?.containsCode)throw Error('Claude CLI did not receive the cross-provider context.');
 await post(`/api/chats/${chat.id}/update`,{provider:'codex'});await turn(chat.id,'Continue the project.');
 await post(`/api/chats/${chat.id}/update`,{provider:'claude'});c=await turn(chat.id,'Recall the project code again.');
 if(c.sessions.claude!==firstSession||requests.length<2||!requests[1].containsCode||requests[1].messageCount<=requests[0].messageCount)throw Error('Claude CLI did not resume its session with context.');
 console.log('Passed: installed Claude CLI, local mock responses, cross-provider context, handoff, and Claude session resume.');
 console.log('This does not test live Anthropic authentication or service access.');
}catch(error){console.error(`Smoke test failed: ${error.message}`);process.exitCode=1;}
finally{
 if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 if(mock.listening)await new Promise(resolve=>mock.close(resolve));
 await rm(dir,{recursive:true,force:true});
}
