import path from 'node:path';

export const OUTPUT_MAX_BYTES=20*1024*1024;
const links=/!?\[([^\]\n]*)\]\((<[^>\n]+>|(?:[^\s()]|\([^()]*\))+)(?:\s+"[^"\n]*")?\)/g;

export function outputFiles(text,cwd) {
  const files=new Map();
  // Examples in code blocks are not requests to send files.
  for(const m of text.replace(/```[\s\S]*?```|`[^`\n]*`/g,'').matchAll(links)) {
    let target=m[2].replace(/^<|>$/g,'').replace(/^sandbox:/,'');
    try { target=decodeURIComponent(target); } catch { continue; }
    if(/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) continue;
    const absolute=path.posix.resolve(cwd,target);
    if(!absolute.startsWith(`${cwd}/`) || target.includes('\0')) continue;
    const relative=path.posix.relative(cwd,absolute);
    if(relative.split('/').some(p=>p.startsWith('.') || p==='node_modules')) continue;
    if(!/\.(pdf|md|txt|csv|json|html|xlsx?|docx?|pptx?|zip|png|jpe?g|webp|gif|svg|mp3|mp4|wav)$/i.test(absolute)) continue;
    files.set(absolute,{path:absolute,name:path.posix.basename(absolute),label:m[1]});
  }
  return [...files.values()].slice(0,10);
}

// Runs inside the user's sandbox. Return bounded binary chunks over the SDK's text transport.
export async function readOutputChunk({cwd,file,offset=0},filesystem) {
  const fs=filesystem || await import('node:fs/promises');
  const path=await import('node:path');
  if(!/^\/workspace\/sessions\/[1-9]\d*$/.test(cwd) || !Number.isSafeInteger(offset) || offset<0) throw new Error('Invalid output request');
  const root=await fs.realpath(cwd),resolved=await fs.realpath(file);
  if(root!==cwd || !resolved.startsWith(root+'/')) throw new Error('File is outside this session');
  if(path.relative(root,resolved).split(path.sep).some(p=>p.startsWith('.') || p==='node_modules')) throw new Error('Private file');
  const handle=await fs.open(resolved,'r');
  try {
    const stat=await handle.stat();
    if(!stat.isFile() || stat.size<1 || stat.size>20*1024*1024 || offset>=stat.size) throw new Error('File must be between 1 byte and 20 MB');
    const bytes=Buffer.alloc(Math.min(192*1024,stat.size-offset));
    const result=await handle.read(bytes,0,bytes.length,offset);
    if(result.bytesRead!==bytes.length) throw new Error('File changed');
    return {size:stat.size,version:`${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`,data:bytes.toString('base64')};
  } finally { await handle.close(); }
}
