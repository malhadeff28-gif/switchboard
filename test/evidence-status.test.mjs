import test from 'node:test';
import assert from 'node:assert/strict';
import {managedEvidence,newWatch,observe,note} from '../lib/turns.mjs';

const cases=[
 [0,'Command succeeded · exit 0'],[1,'Command failed · exit 1'],[2,'Command failed · exit 2'],
 [undefined,'Command result'],[null,'Command result'],['0','Command result'],['1','Command result'],[0.5,'Command result']
];
const command='python3 verify.py';
const output='Deliberate assertion failed\nthen fixed';
function unchangedEvidence(actual,raw,label){
 const old=note('tool','Command result',raw);
 assert.equal(actual.id,old.id);
 assert.equal(actual.text,old.text);
 assert.equal(actual.kind,old.kind);
 assert.equal(actual.label,label);
}

test('managed Codex command status changes only the display label using numeric exit_code',()=>{
 for(const [exit_code,label] of cases){
  const actual=managedEvidence('codex',{type:'item.completed',item:{type:'command_execution',command,exit_code,aggregated_output:output}});
  unchangedEvidence(actual,command+'\nExit '+(exit_code??'unknown')+'\n'+output,label);
 }
});

test('watched Codex command status labels both event forms without changing evidence identity or order',()=>{
 for(const [exit_code,label] of cases){
  const w=newWatch({provider:'codex',sourceSession:'test'});
  observe(w,{type:'event_msg',payload:{type:'task_started',turn_id:'t'}},1);
  observe(w,{type:'event_msg',payload:{type:'exec_command_end',command:[command],exit_code,stdout:output}},2);
  observe(w,{type:'event_msg',payload:{type:'item_completed',turn_id:'t',item:{type:'CommandExecution',command,exit_code,aggregated_output:output}}},3);
  assert.equal(w.current.facts.length,2);
  unchangedEvidence(w.current.facts[0],JSON.stringify([command])+'\nExit '+(exit_code??'unknown')+'\n'+output,label);
  unchangedEvidence(w.current.facts[1],command+'\nExit '+(exit_code??'unknown')+'\n'+output,label);
 }
});

test('unstructured Claude and legacy evidence stay generic even if output mentions an exit',()=>{
 const text='Command failed · exit 1\nExit 0';
 const result=managedEvidence('claude',{type:'user',message:{content:[{type:'tool_result',content:text}]}});
 assert.equal(result.label,'Claude tool result');
 assert.equal(result.text,text);
 assert.equal(note('tool','Command result',text).label,'Command result');
 const unknown=managedEvidence('codex',{type:'item.completed',item:{type:'command_execution',command,aggregated_output:'Exit 0\nCommand succeeded'}});
 assert.equal(unknown.label,'Command result');
});
