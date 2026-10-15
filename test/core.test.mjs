import test from 'node:test';
import assert from 'node:assert/strict';
import {nextAttention,parseHandoff,agentPrompt,cliArgs,decodeEvent} from '../lib/core.mjs';
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
