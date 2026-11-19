import {open} from 'node:fs/promises';

// Offsets point past complete records. A partial final write is retried on the next poll.
export async function* records(file, start = 0) {
  const handle = await open(file, 'r');
  try {
    const {size} = await handle.stat();
    let offset = start, parts = [], length = 0, oversized = false;
    const chunk = Buffer.alloc(65536);
    while (offset < size) {
      const {bytesRead} = await handle.read(chunk, 0, Math.min(chunk.length, size-offset), offset);
      if (!bytesRead) break;
      let pos = 0;
      while (pos < bytesRead) {
        const newline = chunk.subarray(pos,bytesRead).indexOf(10);
        const end = newline < 0 ? bytesRead : pos + newline;
        length += end-pos;
        if (length > 32*1024*1024) { oversized = true; parts = []; }
        if (!oversized) parts.push(Buffer.from(chunk.subarray(pos,end)));
        pos = end + (newline < 0 ? 0 : 1);
        if (newline >= 0 || offset+pos === size) {
          let record;
          if (!oversized && length) { try {record = JSON.parse(Buffer.concat(parts).toString('utf8'));} catch {} }
          if (newline >= 0 || record) yield {record, end:offset+pos};
          parts = []; length = 0; oversized = false;
        }
      }
      offset += bytesRead;
    }
  } finally { await handle.close(); }
}
export async function firstRecord(file) {
  for await (const {record} of records(file)) return record ?? null;
  return null;
}
export function messageText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(x=>['text','input_text','output_text'].includes(x?.type)).map(x=>x.text||'').join('\n') : '';
}
export function userContent(text) {
  return text && !/^\s*<(?:environment_context|system-reminder|external_|send_user_message_question_reply|local-command|command-|user_action)/.test(text);
}
