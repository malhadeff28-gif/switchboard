import {readableText} from './readable.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const localLink=/\[([^\]\n]+)\]\((<\/[^>\n]+>|\/[^)\n]+)\)/g;
const directive=/:codex-file-citation\{([^{}\n]*)\}/g;
function citation(body){
 const attrs={};
 const pattern=/([a-z_]+)="([^"\n]*)"/gy;
 let offset=0;
 while(offset<body.length){
  const space=body.slice(offset).match(/^\s*/)[0];offset+=space.length;
  if(offset===body.length)break;
  pattern.lastIndex=offset;const match=pattern.exec(body);
  if(!match || !['path','label','artifact_kind','purpose'].includes(match[1]) || Object.hasOwn(attrs,match[1]))return null;
  attrs[match[1]]=match[2];offset=pattern.lastIndex;
  if(offset<body.length && !/\s/.test(body[offset]))return null;
 }
 if(!attrs.path?.startsWith('/') || attrs.path.includes('\0'))return null;
 return {path:attrs.path,label:attrs.label||attrs.path.split('/').at(-1)||'Project file'};
}
export function localReferences(text){
 return String(text||'').split(/(```[^\n]*\n[\s\S]*?```|`[^`\n]+`)/g).flatMap(part=>part.startsWith('`')?[]:[
  ...[...part.matchAll(localLink)].map(m=>({label:m[1],path:m[2].startsWith('<')?m[2].slice(1,-1):m[2]})),
  ...[...part.matchAll(directive)].map(m=>citation(m[1])).filter(Boolean)
 ]);
}
export function renderMarkdown(text,{project,canReveal=false}={}){
 const inline=raw=>{
  // Tokenize links before escaping; attribute values and labels are escaped separately.
  const tokens=[];
  const localButton=(label,target)=>canReveal && project?.cwd && target.startsWith(project.cwd.replace(/\/$/,'')+'/') && !target.split('/').includes('..')
   ?`<button type="button" class="text-button" data-reveal-file="${esc(target)}" data-reveal-project="${esc(project.id)}" title="Reveal in Finder">${esc(label)} · Show in Finder ↗</button>`:null;
  const token=html=>{tokens.push(html);return '\u0000'+(tokens.length-1)+'\u0000';};
  let value=String(raw).replace(directive,(match,body)=>{
   const file=citation(body);const html=file && localButton(file.label,file.path);
   return token(html||(file?`<span class="file-reference">${esc(file.label)}</span>`:''));
  }).replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|<\/[^>\n]+>|\/[^)\n]+)\)/g,(match,label,target)=>{
   if(target.startsWith('<'))target=target.slice(1,-1);
   let html;
   if(/^https?:\/\//.test(target))html=`<a class="message-link" href="${esc(target)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;
   else html=localButton(label,target);
   return html?token(html):match;
  });
  return esc(value).replace(/^#{1,4} (.+)$/gm,'<strong class="message-heading">$1</strong>').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>').replace(/\u0000(\d+)\u0000/g,(_,i)=>tokens[Number(i)]||'');
 };
 return readableText(text).trim().split(/(```[^\n]*\n[\s\S]*?```|`[^`\n]+`)/g).map(part=>{
  if(part.startsWith('```'))return '<pre>'+esc(part.replace(/^```[^\n]*\n/,'').replace(/```$/,''))+'</pre>';
  if(part.startsWith('`'))return '<code>'+esc(part.slice(1,-1))+'</code>';
  return inline(part);
 }).join('');
}
