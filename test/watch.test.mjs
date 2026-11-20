import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,readFile,rename,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {newWatch,pollTranscript,observeHook,note} from '../lib/turns.mjs';
import {makeCard,rawCard,sourceCard} from '../lib/handoffs.mjs';
import {agentPrompt,attentionStatus} from '../lib/core.mjs';
import {setClaudeHooks,drainHooks} from '../lib/hooks.mjs';
import {findBinary} from '../lib/providers.mjs';
import {createMonitor} from '../lib/monitor.mjs';

const jsonl=rows=>rows.map(x=>JSON.stringify(x)).join('\n')+'\n';
const lifecycle=(type,turn_id,extra={})=>({type:'event_msg',payload:{type,turn_id,...extra}});
test('watch checkpoints complete records and catches up once after restart',async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'sb-watch-'));
  try{
    const file=path.join(tmp,'chat.jsonl');
    const watch=newWatch({provider:'codex',transcriptPath:file,sourceSession:'test'});
    const input={type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Must preserve nested fields during export.'}]}};
    await writeFile(file,jsonl([lifecycle('task_started','old'),input,lifecycle('task_complete','old',{last_agent_message:'Initial decision saved.'}),lifecycle('task_started','latest'),lifecycle('exec_command_end','latest',{command:['npm','test'],exit_code:0,stdout:'12 tests passed'}),lifecycle('task_complete','latest',{last_agent_message:'The export tests passed.'})]));
    const turns=[];await pollTranscript(watch,t=>turns.push(t));assert.deepEqual(turns.map(t=>t.id),['latest']);
    assert.ok(turns[0].facts.some(e=>e.kind==='tool'&&e.text.includes('12 tests passed')));
    assert.ok(turns[0].earlier.some(e=>e.text.includes('nested fields')));
    const interrupted=JSON.stringify(lifecycle('turn_aborted','next',{reason:'User interrupted'}));
    await appendFile(file,jsonl([lifecycle('task_started','next')])+interrupted.slice(0,20));
    await pollTranscript(watch,t=>turns.push(t));assert.equal(watch.phase,'working');
    const restored=JSON.parse(JSON.stringify(watch));await appendFile(file,interrupted.slice(20)+'\n'+jsonl([lifecycle('task_started','last'),lifecycle('turn_failed','last',{message:'Quota reached'})]));
    await pollTranscript(restored,t=>turns.push(t));await pollTranscript(restored,t=>turns.push(t));
    assert.deepEqual(turns.map(t=>t.phase),['finished','interrupted','failed']);
  }finally{await rm(tmp,{recursive:true,force:true});}
});
test('Codex watches recover chat turns created through app tools and their command evidence',async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'sb-watch-app-tool-'));
  try{
    const file=path.join(tmp,'chat.jsonl');
    const watch=newWatch({provider:'codex',transcriptPath:file,sourceSession:'trial-chat'});
    const turn_id='received-turn';
    const root_turn_id='root-in-another-chat';
    const start=lifecycle('task_started',turn_id,{root_turn_id,turn_attribution:{
      turn_id,root_turn_id,parent_turn_id:root_turn_id,turn_trigger:'app_tool_create_thread',initiating_agent_path:null
    }});
    const command=lifecycle('item_completed',turn_id,{thread_id:'trial-chat',item:{
      type:'CommandExecution',command:'python3 audit.py',exit_code:0,aggregated_output:'Total: $104.97'
    }});
    const transcript=jsonl([
      start,
      lifecycle('task_started','nested',{root_turn_id,turn_attribution:{initiating_agent_path:'child'}}),
      lifecycle('task_complete','nested',{root_turn_id,last_agent_message:'Unrelated child work'}),
      {...command,payload:{...command.payload,thread_id:'another-chat'}},
      command,
      lifecycle('task_complete',turn_id,{root_turn_id,last_agent_message:'The subscription audit is ready.'})
    ]);
    await writeFile(file,transcript);
    watch.offset=Buffer.byteLength(transcript);
    watch.initialized=true;
    const turns=[];
    await pollTranscript(watch,turn=>turns.push(turn));
    await pollTranscript(watch,turn=>turns.push(turn));
    assert.deepEqual(turns.map(turn=>turn.id),[turn_id]);
    assert.equal(watch.phase,'finished');
    assert.equal(turns[0].answer,'The subscription audit is ready.');
    assert.deepEqual(turns[0].facts.filter(fact=>fact.kind==='tool').map(fact=>fact.text),[
      'python3 audit.py\nExit 0\nTotal: $104.97'
    ]);
  }finally{await rm(tmp,{recursive:true,force:true});}
});
test('watch keeps the reply provider and catches up all paused turns and same-size replacements',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'sb-watch-resume-'));
  const chat={id:'project',provider:'claude',status:'ready',messages:[]};
  const file=path.join(dir,'chat.jsonl');
  const source={provider:'codex',transcriptPath:file,sourceSession:'test'};
  const turn=id=>jsonl([lifecycle('task_started',id),lifecycle('task_complete',id,{last_agent_message:'Result '+id})]);
  const monitor=createMonitor({
    state:{chats:[chat]},storage:dir,save(){},publish(){},isConnected:()=>false
  });
  try {
    await writeFile(file,turn('a'));
    await monitor.watch(chat,source);
    monitor.pause(chat);
    await appendFile(file,turn('b')+turn('c'));
    await monitor.watch(chat,source);
    assert.deepEqual(chat.turns.map(t=>t.id),['a','b','c']);
    assert.equal(chat.provider,'claude');
    assert.equal(chat.displayTurn,'c');
    const replacement=path.join(dir,'replacement.jsonl');
    await writeFile(replacement,turn('d')+turn('e')+turn('f'));
    await rename(replacement,file);
    await monitor.poll();
    assert.deepEqual(chat.turns.map(t=>t.id),['a','b','c','d','e','f']);
    await appendFile(file,jsonl([lifecycle('task_complete','f',{last_agent_message:'Corrected result'})]));
    await monitor.poll();
    assert.equal(chat.turns[5].answer,'Corrected result');
    assert.equal(chat.messages[5].text,'Corrected result');
  } finally {
    monitor.close();
    await rm(dir,{recursive:true,force:true});
  }
});
test('evidence links resolve to actual records and a cross-provider reply retains option order',()=>{
  const tool=note('tool','Test result','Exit 0: 12 tests passed'), prior=note('user','Constraint','Must retain nested fields');
  const turn={id:'turn',phase:'finished',provider:'codex',facts:[tool],earlier:[prior]};
  turn.card=makeCard({summary:'Tests ran.',claims:[{text:'12 passed',sources:[tool.id,'invented']},{text:'Shipped',sources:['made-up']}],decision:'Which format?',options:[{label:'CSV',tradeoff:'Flattens nested data'},{label:'JSON',tradeoff:'Preserves nested data'}]},turn);
  assert.deepEqual(turn.card.claims.map(c=>c.sources),[[tool.id],[]]);
  const prompt=agentPrompt({messages:[],decisions:['Use UTF-8']},'take the second option','claude',turn);
  for(const s of ['12 tests passed','Must retain nested fields','Use UTF-8','Flattens nested data','Preserves nested data','take the second option'])assert.ok(prompt.includes(s));
  assert.ok(prompt.indexOf('CSV')<prompt.indexOf('JSON'));
  assert.throws(()=>makeCard({summary:'Done',decision:null,options:[{label:'Invented',tradeoff:'None'}]},turn),/options without a decision/);
});
test('the original Codex response supplies its own question and choices when analysis is unavailable',()=>{
  const result=note('tool','Command result','Total: $28');
  const turn={id:'source',phase:'finished',facts:[result]};
  const card=sourceCard({...turn,answer:'The weekend plan costs $28.\n\nWould you prefer an **indoor** plan or an **outdoor** plan?'});
  assert.equal(card.decision,'Would you prefer an indoor plan or an outdoor plan?');
  assert.deepEqual(card.options,[{label:'indoor',tradeoff:''},{label:'outdoor',tradeoff:''}]);
  assert.ok(card.evidence.some(item=>item.id===result.id));
  assert.equal(attentionStatus({status:'ready',displayTurn:turn.id,turns:[{...turn,card,analysis:'source'}]}),'ready');
  const plain=sourceCard({...turn,answer:'Should the audit flag the largest plans or the unused plans?'});
  assert.equal(plain.decision,'Should the audit flag the largest plans or the unused plans?');
  assert.deepEqual(plain.options,[]);
  assert.equal(sourceCard({...turn,answer:'The planner is ready.'}).decision,null);
});
test('only a well-formed explicit no-decision moves a project out of the attention queue',()=>{
  const turn={id:'result',analysis:'ready',facts:[]};
  const chat={status:'ready',displayTurn:turn.id,turns:[turn]};
  turn.card=makeCard({summary:'Done',decision:null,options:[]},turn);
  assert.equal(attentionStatus(chat),'parked');
  for(const decision of [{question:'Which format?'},'',false,undefined]){
    const payload={summary:'Pick which format',decision,options:[{label:'JSON',tradeoff:'Keeps nesting'}]};
    assert.throws(()=>makeCard(payload,turn),/decision could not be read/i);
  }
  turn.card={decision:null};
  assert.equal(attentionStatus(chat),'ready','cards from the older build need review');
});
test('older result carries original instructions even when evidence is full or analysis fails',()=>{
  const prior=note('user','Earlier instruction','Never publish the fixture dataset');
  const facts=Array.from({length:24},(_,i)=>note('tool','Test result','Fixture step '+i));
  const turn={id:'old',at:100,phase:'finished',provider:'codex',answer:'Original answer',request:'Use a local export',facts,earlier:[prior]};
  const chat={title:'Fixture',messages:[{role:'assistant',text:'Newer unrelated result',at:101}],requirements:'Always retain nested fields'};
  for(const card of [rawCard(turn),makeCard({summary:'Old result',claims:facts.slice(1,11).map(f=>({text:f.text,sources:[f.id]})),decision:'Choose a format'},turn)]) {
    const prompt=agentPrompt(chat,'Continue','claude',{...turn,card});
    for(const text of ['Never publish the fixture dataset','Use a local export','Always retain nested fields'])assert.ok(prompt.includes(text));
    assert.ok(!prompt.includes('Newer unrelated result'));
  }
});
test('Claude hooks are scoped, persist offline, preserve unrelated settings and correlate delayed events',async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'sb-hooks-')), prev=process.env.CLAUDE_CONFIG_DIR;
  try{
    const config=path.join(tmp,'config');process.env.CLAUDE_CONFIG_DIR=config;await mkdir(config);
    const settings={theme:'dark',hooks:{Stop:[{hooks:[{type:'command',command:'echo existing'}]}]}};
    await writeFile(path.join(config,'settings.json'),JSON.stringify(settings));
    setClaudeHooks(tmp,['chosen']);setClaudeHooks(tmp,['chosen']);
    const updated=JSON.parse(await readFile(path.join(config,'settings.json')));assert.equal(updated.hooks.Stop.length,2);
    const bridge=path.join(tmp,'claude-hook','record.cjs');
    for(const session_id of ['unselected','chosen'])execFileSync(process.execPath,[bridge],{input:JSON.stringify({session_id,hook_event_name:'Stop',last_assistant_message:'Ready'})});
    await writeFile(path.join(tmp,'claude-hook','events','0.json'),'{');
    const received=[];drainHooks(tmp,h=>received.push(h));drainHooks(tmp,h=>received.push(h));assert.equal(received.length,1);
    const event=received[0],w={session:'chosen',phase:'working',current:{id:'new',startedAt:event.at+1000},previous:[{id:'prior',startedAt:event.at-500,request:'Review',facts:[]}],history:[]};
    assert.equal(observeHook(w,event).id,'prior');assert.equal(w.phase,'working');
    w.previous[0].phase='interrupted';
    assert.equal(observeHook(w,event),undefined);
    const failure={...event,hook_event_name:'StopFailure',error:'Late failure'};
    w.previous[0].phase='finished';
    assert.equal(observeHook(w,failure),undefined);
    w.previous[0].provisional=true;
    assert.equal(observeHook(w,failure).phase,'failed');
    setClaudeHooks(tmp,[]);assert.deepEqual(JSON.parse(await readFile(path.join(config,'settings.json'))),settings);
  }finally{if(prev===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=prev;await rm(tmp,{recursive:true,force:true});}
});
test('a newly installed CLI is discoverable on refresh without restarting the app',async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'sb-bin-'));
  try{
    const target=path.join(tmp,process.platform==='win32'?'claude.exe':'claude');
    assert.notEqual(findBinary('claude',{PATH:tmp}),target);
    await writeFile(target,'fixture',{mode:0o755});assert.equal(findBinary('claude',{PATH:tmp}),target);
  }finally{await rm(tmp,{recursive:true,force:true});}
});
