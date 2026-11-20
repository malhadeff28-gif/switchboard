import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,readFile,rename,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {newWatch,pollTranscript,observeHook,note} from '../lib/turns.mjs';
import {makeCard,rawCard} from '../lib/handoffs.mjs';
import {agentPrompt} from '../lib/core.mjs';
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
  assert.deepEqual(makeCard({summary:'Done',decision:null,options:[{label:'invent option',tradeoff:'none'}]},turn).options,[]);
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
