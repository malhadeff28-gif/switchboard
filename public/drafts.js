import {readableText} from './readable.js';

function readObject(storage,key) {
  try {
    const value=JSON.parse(storage.getItem(key));
    return value && typeof value==='object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function draftStore(storage,workspace) {
  const prefix='switchboard-draft:'+workspace+':';
  const legacy=readObject(storage,'switchboard-drafts');
  const turns=readObject(storage,'switchboard-draft-turns');
  const providers=readObject(storage,'switchboard-draft-providers');
  function read(id) {
    const key=prefix+id;
    if(storage.getItem(key)!==null){
      const value=readObject(storage,key);
      return typeof value.text==='string' ? value : {text:''};
    }
    return {
      text:typeof legacy[id]==='string' ? legacy[id] : '',
      turnId:typeof turns[id]==='string' ? turns[id] : null,
      provider:['codex','claude'].includes(providers[id]) ? providers[id] : undefined
    };
  }
  function write(id,draft) {
    storage.setItem(prefix+id,JSON.stringify(draft));
    return draft;
  }
  return {
    read,write,
    owns(key){return typeof key==='string' && key.startsWith(prefix);},
    clearIfUnchanged(id,expected) {
      const current=read(id);
      if(current.id===expected.id && current.text===expected.text &&
        current.provider===expected.provider && current.turnId===expected.turnId &&
        sameChoice(current.choice,expected.choice)) {
        write(id,{text:''});
      }
    }
  };
}

export async function replyRequestId(draft,payload) {
  const encoded=new TextEncoder().encode(JSON.stringify([draft.id,payload.text,payload.provider,payload.turnId,...(payload.choice===undefined?[]:[[payload.choice?.index,payload.choice?.label,payload.choice?.tradeoff]])]));
  const digest=await crypto.subtle.digest('SHA-256',encoded);
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}

export function choiceText(index,option) {
  return `Use option ${index+1}: ${readableText(option.label)}. ${readableText(option.tradeoff)}`.trim();
}

// An edit permanently detaches the earlier choice, even if later undone.
export function editDraft(draft,text) {
  const next={...draft,text};
  if(text!==draft.text)delete next.choice;
  return next;
}

export function sameChoice(first,second) {
  return first===second || (first!=null && second!=null && first.index===second.index &&
    first.label===second.label && first.tradeoff===second.tradeoff);
}

export function sameDraft(first,second) {
  return !!first && !!second && first.id===second.id && first.text===second.text &&
    first.provider===second.provider && first.turnId===second.turnId && sameChoice(first.choice,second.choice);
}
