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

test('genuine Codex file citations share Finder rendering and referenced-path allowlist',()=>{
 const cwd='/Users/maxalhadeff/Documents/Codex/2026-11-20/switchboard-trial-8-transit-buffer';
 const file=cwd+'/outputs/buffers.csv';
 const captured=`Source: :codex-file-citation{path="${file}" artifact_kind="workbook" purpose="source"}`;
 const options={project:{id:'transit',cwd},canReveal:true};
 const html=renderMarkdown(captured,options);
 assert.match(html,/buffers\.csv · Show in Finder/);
 assert.ok(html.includes(`data-reveal-file="${file}"`));
 assert.deepEqual(localReferences(captured),[{path:file,label:'buffers.csv'}]);
 assert.match(renderMarkdown(`:codex-file-citation{label="<Output & CSV>" path="${file}"}`,options),/&lt;Output &amp; CSV&gt;/);
 const code='```text\n'+captured+'\n```\n`'+captured+'`';
 assert.doesNotMatch(renderMarkdown(code,options),/data-reveal-file/);
 assert.deepEqual(localReferences(code),[]);
 assert.doesNotMatch(renderMarkdown(captured,{...options,canReveal:false}),/data-reveal-file/);
 for(const malformed of [
  ':codex-file-citation{path=unquoted}',
  ':codex-file-citation{path="relative.csv"}',
  `:codex-file-citation{path="${file}" path="${file}"}`,
  `:codex-file-citation{path="${file}" unexpected="value"}`,
  `:codex-file-citation{path="${file}"label="No separator"}`,
  `:codex-file-citation{path="${file}"`,
  ':codex-file-citation{label="Missing path"}'
 ]){
  assert.deepEqual(localReferences(malformed),[]);
  assert.doesNotMatch(renderMarkdown(malformed,options),/data-reveal-file/);
 }
 for(const target of ['/another-project/buffers.csv',cwd+'-other/buffers.csv',cwd+'/../outside.csv']){
  assert.doesNotMatch(renderMarkdown(`:codex-file-citation{path="${target}"}`,options),/data-reveal-file/);
 }
});

test('Codex directive references pass through canonical server validation without expanding project access',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sb-citation-'));
 try{
  const folder=path.join(dir,'project');await mkdir(folder);
  const file=path.join(folder,'buffers.csv'),outside=path.join(dir,'outside.csv');
  await writeFile(file,'private output');await writeFile(outside,'other project');
  const escape=path.join(folder,'escape.csv');await symlink(outside,escape);
  const chat={cwd:folder,messages:[{text:[file,outside,escape].map(p=>`:codex-file-citation{path="${p}" artifact_kind="workbook" purpose="source"}`).join('\n')}]};
  const calls=[];
  const run=(...args)=>{calls.push(args);const child=new EventEmitter();queueMicrotask(()=>child.emit('close',0));return child;};
  await revealProjectFile(chat,file,{platform:'darwin',run});
  assert.deepEqual(calls[0][1],['-R',await realpath(file)]);
  for(const target of [outside,escape])await assert.rejects(revealProjectFile(chat,target,{platform:'darwin',run}));
  assert.equal(calls.length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
