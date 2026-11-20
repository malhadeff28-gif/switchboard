// Build the public UI only. No workspace files or provider credentials are read.
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

if(!process.argv[2])throw Error('Usage: node scripts/package-website.mjs <destination app directory>');
const dest=path.resolve(process.argv[2]);
const assets=new URL('../public/',import.meta.url);
await mkdir(dest,{recursive:true});
for(const file of ['app.js','drafts.js','local-files.js','styles.css','web-session.js']){
  await copyFile(new URL(file,assets),path.join(dest,file));
}
const policy="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src http://127.0.0.1:4317; base-uri 'none'; form-action 'none'; object-src 'none'";
const template=await readFile(new URL('index.html',assets),'utf8');
const html=template.replace('<html lang="en">','<html lang="en" data-mode="website">')
  .replace('<meta charset="utf-8">',`<meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${policy}">`)
  .replace('href="/styles.css"','href="./styles.css"')
  .replace('src="/app.js"','src="./app.js"');
await writeFile(path.join(dest,'index.html'),html);
