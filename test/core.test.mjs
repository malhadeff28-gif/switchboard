import test from 'node:test';
import assert from 'node:assert/strict';
import {attentionStatus,nextAttention,parseHandoff,agentPrompt,cliArgs,replyContext,decodeEvent} from '../lib/core.mjs';
test('attention skips working and caught-up chats, favors priority, then oldest ready',()=>{
 const chats=[{id:'busy',status:'running',priority:1},{id:'old',status:'ready',readyAt:1},{id:'new',status:'ready',readyAt:2},{id:'priority',status:'ready',readyAt:3,priority:1},{id:'done',status:'parked'}];
 assert.equal(nextAttention(chats),'priority');assert.equal(nextAttention(chats,'priority'),'old');assert.equal(nextAttention(chats.map(c=>({...c,status:'running'}))),null);
});
test('handoff extracts actual context and malformed responses remain readable',()=>{
 const response='The draft is ready.\n<<<SWITCHBOARD_HANDOFF>>>{"summary":"Draft ready","decisions":["Use a short intro",3],"next_action":"Choose the title"}';
 assert.deepEqual(parseHandoff(response),{text:'The draft is ready.',summary:'Draft ready',decisions:['Use a short intro'],nextAction:'Choose the title'});
 assert.equal(parseHandoff('hi <<<SWITCHBOARD_HANDOFF>>> broken').text,'hi <<<SWITCHBOARD_HANDOFF>>> broken');
});
test('provider switching carries history and resumes only the matching managed session',()=>{
 const c={title:'Prototype',sessions:{codex:'codex-session'},permission:'read',messages:[{role:'user',text:'Build a calendar',provider:'codex'}],decisions:['Start small']};
 assert.match(agentPrompt(c,'Outline it','claude'),/Build a calendar/);assert.match(agentPrompt(c,'Outline it','claude'),/Start small/);
 assert.ok(cliArgs('codex',c).includes('resume'));assert.ok(cliArgs('codex',c).includes('codex-session'));assert.ok(!cliArgs('claude',c).includes('--resume'));
 assert.ok(!cliArgs('codex',c).includes('--dangerously-bypass-approvals-and-sandbox'));assert.equal(cliArgs('claude',c).at(-1),'Read,Glob,Grep');
});
test('provider errors and permission denials are exposed',()=>{
 assert.equal(decodeEvent('codex',{type:'turn.failed',error:{message:'Rate limit'}}).error,'Rate limit');
 assert.equal(decodeEvent('claude',{type:'result',is_error:true,errors:['Not signed in']}).error,'Not signed in');
 assert.equal(decodeEvent('claude',{type:'result',result:'Done',permission_denials:[{tool_name:'Bash'}]}).denials.length,1);
});
test('replying to an older result avoids resuming a provider session with newer work',()=>{
 const earlier={id:'old',provider:'codex',origin:'managed',at:10,card:{summary:'Choose CSV or JSON.'}};
 const later={id:'new',provider:'codex',origin:'managed',at:20,card:{summary:'Discard the export.'}};
 const chat={sessions:{codex:'latest-session'},turns:[earlier,later],messages:[
  {role:'assistant',provider:'codex',at:20,text:'Discard the export.'}
 ]};
 const older=replyContext(chat,'codex',earlier);
 assert.ok(!cliArgs('codex',older).includes('resume'));
 assert.ok(!agentPrompt(older,'Choose JSON','codex',earlier).includes('Discard the export.'));
 assert.ok(cliArgs('codex',replyContext(chat,'codex',later)).includes('resume'));
});

test('a caught-up managed result shows original work while preserving unresolved attention and manual status',()=>{
 const turn={id:'managed',origin:'managed',analysis:'ready',card:{decisionFormatValid:true,decision:null}};
 const chat={id:'project',status:'ready',displayTurn:turn.id,turns:[turn],watch:{enabled:true,phase:'working'}};
 assert.equal(attentionStatus(chat),'watching');
 assert.equal(nextAttention([chat]),null);
 assert.equal(attentionStatus({...chat,watch:{enabled:false,phase:'working'}}),'parked');
 assert.equal(attentionStatus({...chat,watch:{enabled:true,phase:'finished'}}),'parked');
 for(const status of ['parked','running','stopping'])assert.equal(attentionStatus({...chat,status}),status);
 assert.equal(attentionStatus({...chat,error:'Provider failed'}),'ready');
 for(const change of [
  {analysis:'error'}, {analysis:'analyzing'},
  {card:{decisionFormatValid:true,decision:'Choose a title'}},
  {card:{decisionFormatValid:false,decision:null}}, {card:{decision:null}}, {card:{}}
 ]){
  const unresolved={...chat,turns:[{...turn,...change}]};
  assert.equal(attentionStatus(unresolved),'ready');
  assert.equal(nextAttention([unresolved]),chat.id);
 }
 // A newer unseen original result can still need a decision during further work.
 const unseen={id:'unseen',origin:'watched',analysis:'ready',card:{decisionFormatValid:true,decision:'Approve?'}};
 assert.equal(attentionStatus({...chat,unseenWatchedTurn:unseen.id,turns:[turn,unseen]}),'ready');
 assert.equal(attentionStatus({...chat,turns:[{...turn,origin:'watched'}]}),'watching');
});
