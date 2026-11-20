import test from 'node:test';
import assert from 'node:assert/strict';
import {readableText} from '../public/readable.js';
import {renderMarkdown} from '../public/local-files.js';

test('complete and partial internal directives are hidden while ordinary text and code survive',()=>{
 const result=readableText('The file is ready.\n\n::created-thread{threadId="abc"}\n::code-comment{title="Quoted \\"text\\""\n body="A } brace"}\n\nReview the options.\n::created-thread{threadId="unfinished');
 assert.equal(result,'The file is ready.\n\nReview the options.');
 const css='::before{content:"keep."}';
 assert.equal(readableText(css),css);
 assert.equal(readableText('Result first\n<<<SWITCHBOARD_HANDOFF>>>\n{"internal":true}'),'Result first');
 assert.doesNotMatch(renderMarkdown('Useful prose\n::created-thread{threadId="abc"}'),/created-thread|abc/);
});
