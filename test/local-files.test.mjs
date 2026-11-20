import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {localReferences,renderMarkdown} from '../public/local-files.js';
import {revealProjectFile} from '../lib/local-files.mjs';

test('local links render Finder buttons only for Mac project paths while code and web links remain safe',()=>{
 const project={id:'p',cwd:'/work/project'};
 const text='[output](/work/project/a file.txt) [web](https://example.com/?x=1&y=2)\n```sh\n[code](/work/project/code.txt)\n**literal**\n```\n`[inline](/work/project/inline.txt)`\n[other](/work/other/a.txt)';
 const html=renderMarkdown(text,{project,canReveal:true});
 assert.match(html,/data-reveal-file="\/work\/project\/a file.txt"/);
 assert.match(html,/data-reveal-project="p"/);
 assert.match(html,/href="https:\/\/example.com\/\?x=1&amp;y=2"/);
 assert.match(html,/<pre>\[code\].*\n\*\*literal\*\*\n<\/pre>/);
 assert.match(html,/<code>\[inline\]/);
 assert.equal((html.match(/data-reveal-file=/g)||[]).length,1);
 assert.equal(localReferences(text).length,2);
 assert.doesNotMatch(renderMarkdown(text,{project,canReveal:false}),/data-reveal-file/);
 assert.doesNotMatch(renderMarkdown('[escape](/work/project/../other/a)',{project,canReveal:true}),/data-reveal-file/);
 assert.match(renderMarkdown('[<img>](/work/project/a"b.txt)',{project,canReveal:true}),/&lt;img&gt;/);
 assert.match(renderMarkdown('[output](</work/project/a (1).txt>)',{project,canReveal:true}),/a \(1\).txt/);
});

test('Finder reveal validates reference, regular file, canonical folder and argument separation',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sb-reveal-'));
 try{
  const folder=path.join(dir,'project'),other=path.join(dir,'project-other');
  await mkdir(folder);await mkdir(other);
  const file=path.join(folder,'report $(touch unsafe).txt'),outside=path.join(other,'secret.txt');
  await writeFile(file,'private output');await writeFile(outside,'other project');
  const escape=path.join(folder,'escape.txt'),inside=path.join(folder,'inside.txt');
  await symlink(outside,escape);await symlink(file,inside);
  const traversal=path.join(folder,'sub')+'/../../project-other/secret.txt';
  const missing=path.join(folder,'missing.txt');
  const chat={cwd:folder,messages:[{text:[file,outside,escape,inside,traversal,missing,folder].map(p=>`[file](<${p}>)`).join('\n')}]};
  const calls=[];
  const run=(...args)=>{calls.push(args);const child=new EventEmitter();queueMicrotask(()=>child.emit('close',0));return child;};
  const options={platform:'darwin',run};
  await revealProjectFile(chat,file,options);
  assert.deepEqual(calls[0],['/usr/bin/open',['-R',await realpath(file)],{stdio:'ignore'}]);
  await revealProjectFile(chat,inside,options);
  assert.deepEqual(calls[1][1],['-R',await realpath(file)]);
  for(const target of [outside,escape,traversal,missing,folder,'relative.txt'])await assert.rejects(revealProjectFile(chat,target,options));
  await assert.rejects(revealProjectFile({...chat,messages:[]},file,options),/not referenced/);
  await assert.rejects(revealProjectFile({...chat,messages:[{text:'```\n[file](<'+file+'>)\n```'}]},file,options),/not referenced/);
  await assert.rejects(revealProjectFile(chat,file,{...options,platform:'linux'}),/macOS/);
  assert.equal(calls.length,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
