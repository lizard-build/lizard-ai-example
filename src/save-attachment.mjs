import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Runs inside the user's sandbox. The SDK's text-only file transport would
// corrupt raw binary, so decode the bounded chunks and verify before publishing.
const root = process.argv[2];
const job = JSON.parse(await readFile(`${root}/input.json`,'utf8'));
if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,79}$/.test(job.name) || !Number.isInteger(job.chunks) || job.chunks<1 || job.chunks>107
    || !Number.isInteger(job.size) || job.size<1 || job.size>20*1024*1024) throw new Error('Invalid attachment');
const parts=[];
for(let i=0;i<job.chunks;i++) parts.push(await readFile(`${root}/part-${i}.b64`,'utf8'));
const bytes=Buffer.from(parts.join(''),'base64');
if(bytes.length!==job.size || createHash('sha256').update(bytes).digest('hex')!==job.sha256) throw new Error('Attachment checksum mismatch');
await writeFile(`${root}/pending`,bytes,{mode:0o600});
await rename(`${root}/pending`,`${root}/${job.name}`);
for(let i=0;i<job.chunks;i++) await unlink(`${root}/part-${i}.b64`);
