import {createHash,randomUUID} from 'node:crypto';
import {linkSync,mkdirSync,readFileSync,realpathSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';

export function workspaceIdentity(directory) {
  return createHash('sha256').update(realpathSync(directory)).digest('hex');
}

function owner(file) {
  try {
    const value=JSON.parse(readFileSync(file,'utf8'));
    if(Number.isSafeInteger(value.pid) && value.pid>0 && typeof value.token==='string')return value;
    throw Error(`The workspace lock at ${file} is unreadable. Close other instances before repairing it.`);
  } catch(error) {
    if(error.code==='ENOENT')return null;
    throw error;
  }
}

function processExists(pid) {
  try {process.kill(pid,0);return true;}
  catch(error) {if(error.code==='ESRCH')return false;return true;}
}

export function lockWorkspace(directory) {
  const lock=path.join(directory,'workspace.lock');
  const recovery=lock+'.recovery';
  const token=randomUUID();
  const staged=lock+'.'+token;
  const busy=held=>Error(`This workspace is already open${held ? ` in Switchboard (PID ${held.pid})` : ''}. Close the other launcher before opening it here.`);
  writeFileSync(staged,JSON.stringify({pid:process.pid,token}),{flag:'wx',mode:0o600});
  try {
    try {
      // Publish a complete owner record atomically. Never write over an existing lock.
      linkSync(staged,lock);
    } catch(error) {
      if(error.code!=='EEXIST')throw error;
      const held=owner(lock);
      if(held && processExists(held.pid))throw busy(held);
      try {mkdirSync(recovery,{mode:0o700});}
      catch(error) {if(error.code==='EEXIST')throw busy(held);throw error;}
      try {
        // Another process may have claimed the workspace since the first read.
        const current=owner(lock);
        if(current && processExists(current.pid))throw busy(current);
        if(current)unlinkSync(lock);
        try {linkSync(staged,lock);}
        catch(error) {if(error.code==='EEXIST')throw busy(owner(lock));throw error;}
      } finally {
        rmdirSync(recovery);
      }
    }
  } finally {
    unlinkSync(staged);
  }
  return ()=>{
    if(owner(lock)?.token===token)unlinkSync(lock);
  };
}
