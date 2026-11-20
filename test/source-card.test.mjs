import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceCard} from '../lib/handoffs.mjs';

const question='Should the next view sort by **lowest stock** or **largest shortage**?';
const first='Sorting by lowest stock puts the fewest remaining units first.';
const second='Sorting by largest shortage puts the items furthest below their reorder thresholds first.';
const pair=first+' '+second;
function card(explanation){return sourceCard({id:'pantry-turn',answer:explanation+'\n\n'+question,facts:[{id:'evidence',text:'Original test output'}]});}

test('source fallback carries exact adjacent sorting explanations into both options without changing original context',()=>{
 const result=card(pair);
 assert.deepEqual(result.options,[{label:'lowest stock',tradeoff:first},{label:'largest shortage',tradeoff:second}]);
 assert.equal(result.summary,pair+'\n\n'+question);
 assert.equal(result.decision,'Should the next view sort by lowest stock or largest shortage?');
 assert.ok(result.evidence.some(e=>e.id==='evidence'));
 assert.ok(result.evidence.some(e=>e.text===result.summary));
});

test('source fallback does not guess from missing, ambiguous, remote or question-like comparisons',()=>{
 for(const explanation of [
  '',first,second,
  first+' '+first,
  second+' '+first,
  'Sorting by lowest stock puts largest shortage first. '+second,
  'Sorting by lowest stock puts lowest stock first. '+second,
  first+' Sorting by largest shortage puts which items first?',
  pair+' More details are available.',
  pair+'\n\nThe file is ready.',
  'Sorting by lowest stock puts '+ 'x'.repeat(400)+'. '+second,
  '[Sorting by lowest stock puts the fewest remaining units first.](https://example.com) '+second
 ]){
  const result=card(explanation);
  assert.deepEqual(result.options.map(o=>o.tradeoff),['',''],explanation);
  assert.equal(result.summary,explanation+'\n\n'+question);
 }
});

test('source fallback also accepts an exact label-led pair without a sorting prefix',()=>{
 const explanation='Reuse spare stock keeps the total at $89. Buy new supplies adds $12, which exceeds the cap.';
 const answer=explanation+'\n\nShould we **reuse spare stock** or **buy new supplies**?';
 const result=sourceCard({id:'workshop-turn',answer,facts:[]});
 assert.deepEqual(result.options,[
  {label:'reuse spare stock',tradeoff:'Reuse spare stock keeps the total at $89.'},
  {label:'buy new supplies',tradeoff:'Buy new supplies adds $12, which exceeds the cap.'}
 ]);
 assert.equal(result.summary,answer);
 const ambiguous=sourceCard({answer:'Reuse spare stock or buy new supplies keeps the total at $89. Buy new supplies adds $12.\n\nShould we **reuse spare stock** or **buy new supplies**?',facts:[]});
 assert.deepEqual(ambiguous.options.map(o=>o.tradeoff),['','']);
});

test('source fallback recognizes only explicit final standalone Choose/Pick formatted alternatives',()=>{
 for(const directive of [
  'Choose **expand welcome** or **expand schedule**.',
  'Pick **A** or **B**',
  'Choose **A**, **B**, or **C**.',
  'Pick **A**, **B**, **C** or **D**!',
  'Choose **A** or **B** or **C**.'
 ]){
  const answer='The existing draft is ready.\n\n'+directive,result=sourceCard({answer,facts:[]});
  assert.equal(result.decision,directive.replace(/\*\*/g,''));assert.equal(result.options.length,[...directive.matchAll(/\*\*/g)].length/2);assert.ok(result.options.every(option=>option.tradeoff===''));assert.equal(result.summary,answer);
  assert.ok(result.evidence.some(e=>e.text===answer));
 }
});
test('imperative fallback does not extract prose evidence, casual mentions, code, duplicates or unsupported option formatting',()=>{
 for(const answer of [
  'I would choose **expand welcome** or **expand schedule**.',
  'The test says: Choose **passed** or **failed**.',
  'Choose **A** or **B**. These are examples from the output.',
  'Choose **A** or **B**.\nThe test passed.',
  'The test passed.\nChoose **A** or **B**.',
  'Choose **A** or **B**.\n\nMore evidence follows.',
  '> Choose **A** or **B**.',
  '- Choose **A** or **B**.',
  '    Choose **A** or **B**.',
  '```text\n\nChoose **A** or **B**.',
  '~~~\n\nChoose **A** or **B**.',
  'Choose **[test passed](https://example.com)** or **failed**.',
  'Choose **A** and **B**.',
  'Choose A or B.',
  'Choose **A** or **A**.',
  'Choose ** A** or **B**.',
  'Choose **A**, **B**, **C**, **D**, or **E**.',
  'Choose **A** or **B** with **the evidence**.'
 ]){
  const result=sourceCard({answer,facts:[]});assert.equal(result.decision,null,answer);assert.deepEqual(result.options,[],answer);assert.equal(result.summary,answer);
 }
});
