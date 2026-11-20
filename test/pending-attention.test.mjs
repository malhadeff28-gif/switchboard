import test from 'node:test';
import assert from 'node:assert/strict';
import {attentionStatus,nextAttention,pendingWatchedReply} from '../lib/core.mjs';
const result=(id,origin,decision)=>({id,origin,phase:'finished',analysis:'ready',card:{decisionFormatValid:true,decision}});

test('either active result with an unresolved decision keeps the project queued',()=>{
 const managed=result('managed','managed','Choose concise or detailed handoff?');
 const watched=result('watched','watched',null);
 const base={id:'project',status:'ready',displayTurn:managed.id,unseenWatchedTurn:watched.id,turns:[managed,watched],watch:{enabled:true,phase:'finished'}};
 assert.equal(attentionStatus(base),'ready');assert.equal(nextAttention([base]),base.id);
 const bothDone={...base,turns:[{...managed,card:{decisionFormatValid:true,decision:null}},watched]};
 assert.equal(attentionStatus(bothDone),'parked');assert.equal(nextAttention([bothDone]),null);
 const originalQuestion={...bothDone,turns:[bothDone.turns[0],{...watched,card:{decisionFormatValid:true,decision:'Legend or badge?'}}]};
 assert.equal(attentionStatus(originalQuestion),'ready');assert.equal(nextAttention([originalQuestion]),base.id);
 for(const status of ['parked','running','stopping'])for(const c of [base,bothDone,originalQuestion])assert.equal(attentionStatus({...c,status}),status);
 assert.equal(attentionStatus({...bothDone,error:'Provider failure'}),'ready');
 assert.equal(attentionStatus({...base,watch:{enabled:true,phase:'working'}}),'ready');
 assert.equal(attentionStatus({...bothDone,watch:{enabled:true,phase:'working'}}),'watching');
 assert.equal(attentionStatus({...originalQuestion,watch:{enabled:true,phase:'working'}}),'ready');
 // Missing, unverified, failed or not-yet-analyzed pending results stay reviewable.
 for(const change of [{analysis:'source'},{analysis:'error'},{analysis:'analyzing'},{card:{decision:null}},{card:{decisionFormatValid:false,decision:null}}]){
  assert.equal(attentionStatus({...bothDone,turns:[bothDone.turns[0],{...watched,...change}]}),'ready');
 }
 assert.equal(attentionStatus({...bothDone,unseenWatchedTurn:'missing'}),'ready');
});

test('project-level drafts preserve active originals without reopening answered or dismissed work',()=>{
 const watched=result('original','watched','Legend or badge?');
 const c={id:'project',status:'ready',displayTurn:watched.id,turns:[watched],messages:[]};
 for(const target of [undefined,null]){
  assert.equal(pendingWatchedReply(c,target),watched.id);
  assert.equal(pendingWatchedReply({...c,status:'parked'},target),undefined);
  assert.equal(pendingWatchedReply({...c,messages:[{role:'user',replyTo:watched.id}]},target),undefined);
  assert.equal(pendingWatchedReply({...c,turns:[{...watched,card:{decisionFormatValid:true,decision:null}}]},target),undefined);
 }
});
