import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {draftStore,choiceText,editDraft,replyRequestId} from '../public/drafts.js';

test('choice drafts survive reload and lose confirmation on any edit',async()=>{
 const values=new Map(), storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const option={label:'Calendar reminder draft',tradeoff:'Local only'}, choice={index:1,...option};
 const draft={id:'draft',provider:'codex',turnId:'original',text:choiceText(1,option),choice};
 const first=draftStore(storage,'workspace');first.write('chat',draft);
 assert.equal(values.size,1); // Clicking writes only browser draft storage.
 const loaded=draftStore(storage,'workspace').read('chat');assert.deepEqual(loaded,draft);
 assert.deepEqual(editDraft(loaded,loaded.text).choice,choice);
 assert.equal(choiceText(0,{label:'Proceed',tradeoff:''}),'Use option 1: Proceed.');
 const changed={...loaded};delete changed.choice;first.write('chat',changed);
 first.clearIfUnchanged('chat',loaded);assert.deepEqual(first.read('chat'),changed);
 const edited=editDraft(loaded,'Custom reply');assert.equal(edited.choice,undefined);
 assert.equal(editDraft(edited,loaded.text).choice,undefined);
 globalThis.crypto ||= webcrypto;
 const payload={text:draft.text,provider:draft.provider,turnId:draft.turnId,choice};
 assert.equal(await replyRequestId(draft,payload),await replyRequestId(loaded,payload));
 assert.notEqual(await replyRequestId(draft,payload),await replyRequestId(draft,{...payload,choice:undefined}));
});
