import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {setTimeout as wait} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import {availablePort} from '../scripts/available-port.mjs';
import {hostedAccess,webOrigin} from '../lib/hosted-access.mjs';

const secretFrom=url=>new URLSearchParams(new URL(url).hash.slice(1)).get('pair');

test('website pairing only accepts the HTTPS origin and expires and revokes credentials',()=>{
  let time=0;
  const web=hostedAccess(true,{now:()=>time});
  assert.equal(hostedAccess(false).accepts(webOrigin),false);
  assert.equal(web.accepts(webOrigin),true);
  for(const other of [webOrigin.replace('https:','http:'),'https://switchboard.us.com',webOrigin+'.example',undefined])assert.equal(web.accepts(other),false);
  const link=new URL(web.link());
  assert.equal(link.origin,webOrigin);
  assert.equal(link.pathname,'/app/');
  const expired=secretFrom(link);time=300_000;assert.equal(web.redeem(expired),null);
  const first=secretFrom(web.link()),latest=secretFrom(web.link());
  assert.equal(web.redeem(first),null);
  const session=web.redeem(latest);assert.ok(web.authorized(session));assert.equal(web.redeem(latest),null);
  time+=12*60*60_000;assert.equal(web.authorized(session),false);
  const pending=secretFrom(web.link());web.disconnect();assert.equal(web.redeem(pending),null);
});

test('the website can use a paired loopback workspace and cannot enroll, expose local credentials, or replay after disconnect',{timeout:20000},async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'switchboard-web-'));
  const fake=path.join(data,'provider.mjs');
  await writeFile(fake,`
    import {readFileSync} from 'node:fs';
    if(process.argv.includes('status')){
      console.log(process.argv.includes('login')?'Logged in using ChatGPT':'{"loggedIn":true}');
    }else{
      const input=readFileSync(0,'utf8');
      const codex=process.argv.includes('exec');
      const answer=(codex?'Codex saw ':'Claude saw ')+(input.includes('check-claude')?'check-claude':'check-codex');
      console.log(JSON.stringify(codex?{type:'item.completed',item:{type:'agent_message',text:answer}}:{type:'result',result:answer}));
    }
  `);
  const port=await availablePort();
  const base='http://127.0.0.1:'+port;
  const server=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),SWITCHBOARD_DATA_DIR:data,SWITCHBOARD_WEB_ENABLED:'1',SWITCHBOARD_CODEX_BIN:fake,SWITCHBOARD_CLAUDE_BIN:fake},stdio:'ignore'});
  const request=(route,{origin,session,token,data,method}={})=>fetch(base+route,{
    method:method||(data===undefined?'GET':'POST'),
    headers:{...(origin?{Origin:origin}:{}),...(session?{'X-Switchboard-Web-Session':session}:{}),...(token?{'X-Switchboard-Token':token}:{}),...(data===undefined?{}:{'Content-Type':'application/json'}),...(method==='OPTIONS'?{'Access-Control-Request-Method':'GET'}:{})},
    body:data===undefined?undefined:JSON.stringify(data)
  });
  try{
    let local;
    for(let i=0;i<100&&!local;i++){
      try{local=await (await request('/api/bootstrap')).json();}
      catch{await wait(60);}
    }
    assert.ok(local?.token,'Local app started');
    let preflight=await request('/api/bootstrap',{origin:webOrigin,method:'OPTIONS'});
    assert.equal(preflight.status,204);
    assert.equal(preflight.headers.get('access-control-allow-origin'),webOrigin);
    assert.match(preflight.headers.get('access-control-allow-headers'),/X-Switchboard-Web-Session/);
    assert.equal((await request('/api/bootstrap',{origin:webOrigin})).status,401);
    assert.equal((await request('/api/web/link',{origin:webOrigin,token:local.token,data:{}})).status,403);
    assert.equal((await request('/api/web/link',{data:{}})).status,403);
    const enrollment=await request('/api/web/link',{origin:base,token:local.token,data:{}});
    assert.equal(enrollment.status,200);
    assert.equal(enrollment.headers.get('cache-control'),'no-store');
    const pair=secretFrom((await enrollment.json()).url);
    let paired=await request('/api/web/pair',{origin:'https://other.example',data:{pair}});
    assert.equal(paired.status,403);
    assert.equal(paired.headers.get('access-control-allow-origin'),null);
    paired=await request('/api/web/pair',{origin:webOrigin,data:{pair}});
    assert.equal(paired.status,200);
    const {session}=await paired.json();
    assert.equal((await request('/api/web/pair',{origin:webOrigin,data:{pair}})).status,401);
    const web={origin:webOrigin,session};
    const boot=await (await request('/api/bootstrap',web)).json();
    assert.equal(boot.workspace,local.workspace);
    assert.ok(boot.connections.codex.signedIn&&boot.connections.claude.signedIn);
    for(const field of ['token','root','desktop'])assert.ok(!(field in boot));
    for(const field of ['desktopApp','instructions','terminalSignIn'])assert.ok(!(field in boot.connections.claude));
    assert.equal((await request('/api/connections/code',{...web,data:{provider:'claude',code:'dummy'}})).status,403);
    assert.equal((await request('/api/events',web)).status,403);
    const created=await request('/api/chats',{...web,data:{title:'Web project',cwd:data,provider:'codex'}});
    assert.equal(created.status,201);
    const {chat}=await created.json();
    let previous=null;
    for(const provider of ['codex','claude']){
      const reply=await request('/api/chats/'+chat.id+'/send',{...web,data:{text:'check-'+provider,turnId:previous,provider,requestId:'web-'+provider,expectedPermission:'read'}});
      assert.equal(reply.status,202);
      let completed;
      for(let attempt=0;attempt<80;attempt++){
        const snapshot=await (await request('/api/bootstrap',web)).json();
        completed=snapshot.chats.find(c=>c.id===chat.id).turns?.find(t=>t.provider===provider);
        if(completed)break;
        await wait(50);
      }
      assert.equal(completed?.phase,'finished');
      assert.equal(completed.replyTo,previous);
      assert.equal(completed.answer,(provider==='codex'?'Codex':'Claude')+' saw check-'+provider);
      previous=completed.id;
    }
    assert.equal((await request('/api/ideas',{...web,data:{text:'Paired web test'}})).status,201);
    assert.equal((await (await request('/api/bootstrap')).json()).ideas[0].text,'Paired web test');
    assert.equal((await request('/api/web/disconnect',{origin:base,token:local.token,data:{}})).status,200);
    assert.equal((await request('/api/bootstrap',web)).status,401);
  }finally{
    if(server.exitCode===null){const exited=once(server,'exit');server.kill();await exited;}
    await rm(data,{recursive:true,force:true});
  }
});
