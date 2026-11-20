// Codex emits UI directives as transcript text. Preserve prose, links and
// code, while removing structured controls which only the original UI uses.
const attributeDirective=/(?<![\w:])::[a-z][a-z\d-]*\{(?:[ \t\r\n]*[\w-]+[ \t]*=[ \t]*(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'))+[ \t\r\n]*\}/gi;
const unfinishedControl=/^[ \t]*(?:[-*][ \t]+|>[ \t]*)?`?::(?:created-thread|code-comment|archive-thread|placeholder)\{[^\r\n]*$/gim;
const handoffTrailer=/(?:^|\r?\n)[ \t]*<<<SWITCHBOARD_HANDOFF>>>[\s\S]*$/;

export function readableText(value){
 const raw=String(value??'');
 const cleaned=raw.replace(handoffTrailer,'').replace(attributeDirective,'').replace(unfinishedControl,'');
 if(cleaned===raw)return raw;
 return cleaned.replace(/^[ \t]*(?:``|[-*][ \t]*|>[ \t]*)[ \t]*\r?$/gm,'')
  .replace(/\n(?:[ \t]*\r?\n){2,}/g,'\n\n').trim();
}
