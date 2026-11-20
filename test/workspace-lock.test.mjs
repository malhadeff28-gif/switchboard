import {availablePort} from '../scripts/available-port.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('two server processes cannot write the same workspace, and a crashed owner can be replaced',{timeout:20000},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'switchboard-lock-'));
  const children=[];
  async function launch() {
    const port=await availablePort();
    const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{
      env:{...process.env,SWITCHBOARD_DATA_DIR:dir,PORT:String(port)},stdio:['ignore','pipe','pipe']
    });
    children.push(child);
    let stderr='';
    child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
    const closed=once(child,'close');
    const running=new Promise(resolve=>child.stdout.on('data',chunk=>{if(String(chunk).includes('is running'))resolve(true);}));
    const started=await Promise.race([running,closed.then(()=>false)]);
    return {child,closed,started,stderr,url:'http://127.0.0.1:'+port};
  }
  try {
    const first=await launch();
    assert.ok(first.started,first.stderr);
    const denied=await launch();
    assert.equal(denied.started,false);
    assert.match(denied.stderr,/workspace is already open/i);
    const boot=async s=>(await fetch(s.url+'/api/bootstrap')).json();
    const {token}=await boot(first);
    const response=await fetch(first.url+'/api/ideas',{
      method:'POST',headers:{'Content-Type':'application/json','X-Switchboard-Token':token},body:JSON.stringify({text:'Keep this idea'})
    });
    assert.equal(response.status,201);
    first.child.kill('SIGKILL');
    await first.closed;
    const recovered=await launch();
    assert.ok(recovered.started,recovered.stderr);
    assert.deepEqual((await boot(recovered)).ideas.map(i=>i.text),['Keep this idea']);
  } finally {
    await Promise.all(children.filter(child=>child.exitCode===null && child.signalCode===null).map(async child=>{
      const closed=once(child,'close');
      child.kill('SIGTERM');
      await closed;
    }));
    await rm(dir,{recursive:true,force:true});
  }
});
