// Installed in the user's Switchboard data directory when Claude watching is enabled.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
async function record() {
  let input='';
  for await(const chunk of process.stdin){input+=chunk;if(input.length>2e6)return;}
  const e=JSON.parse(input);
  const selected=JSON.parse(fs.readFileSync(path.join(__dirname,'watched.json'),'utf8'));
  if(!selected.includes(e.session_id)||!['Stop','StopFailure'].includes(e.hook_event_name))return;
  const at=Date.now(), id=crypto.randomUUID();
  const file=path.join(__dirname,'events',at+'-'+id+'.json');
  const item={at,session_id:e.session_id,hook_event_name:e.hook_event_name,last_assistant_message:String(e.last_assistant_message||'').slice(0,24000),error:String(e.error||'').slice(0,500),error_details:String(e.error_details||'').slice(0,1200)};
  fs.writeFileSync(file+'.tmp',JSON.stringify(item),{mode:0o600});fs.renameSync(file+'.tmp',file);
}
record().catch(()=>{});
