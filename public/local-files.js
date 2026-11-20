const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const localLink=/\[([^\]\n]+)\]\((<\/[^>\n]+>|\/[^)\n]+)\)/g;
export function localReferences(text){
 return String(text||'').split(/(```[^\n]*\n[\s\S]*?```|`[^`\n]+`)/g).flatMap(part=>part.startsWith('`')?[]:[...part.matchAll(localLink)].map(m=>({label:m[1],path:m[2].startsWith('<')?m[2].slice(1,-1):m[2]})));
}
export function renderMarkdown(text,{project,canReveal=false}={}){
 const inline=raw=>{
  // Tokenize links before escaping; attribute values and labels are escaped separately.
  const tokens=[];
  let value=String(raw).replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|<\/[^>\n]+>|\/[^)\n]+)\)/g,(match,label,target)=>{
   if(target.startsWith('<'))target=target.slice(1,-1);
   let html;
   if(/^https?:\/\//.test(target))html=`<a class="message-link" href="${esc(target)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;
   else if(canReveal && project?.cwd && target.startsWith(project.cwd.replace(/\/$/,'')+'/') && !target.split('/').includes('..'))html=`<button type="button" class="text-button" data-reveal-file="${esc(target)}" data-reveal-project="${esc(project.id)}" title="Reveal in Finder">${esc(label)} · Show in Finder ↗</button>`;
   else return match;
   tokens.push(html);return '\u0000'+(tokens.length-1)+'\u0000';
  });
  return esc(value).replace(/^#{1,4} (.+)$/gm,'<strong class="message-heading">$1</strong>').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>').replace(/\u0000(\d+)\u0000/g,(_,i)=>tokens[Number(i)]||'');
 };
 return String(text||'').trim().split(/(```[^\n]*\n[\s\S]*?```|`[^`\n]+`)/g).map(part=>{
  if(part.startsWith('```'))return '<pre>'+esc(part.replace(/^```[^\n]*\n/,'').replace(/```$/,''))+'</pre>';
  if(part.startsWith('`'))return '<code>'+esc(part.slice(1,-1))+'</code>';
  return inline(part);
 }).join('');
}
