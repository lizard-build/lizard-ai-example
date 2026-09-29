import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,readlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
const script=new URL('../src/volume-transfer.mjs',import.meta.url);
test('volume transfer requires its one-use token and verifies files, permissions and symlinks',async t=>{
  const root=await mkdtemp(join(tmpdir(),'volume-transfer-')),source=join(root,'source'),dest=join(root,'dest');
  await mkdir(join(source,'.config'),{recursive:true});await mkdir(dest);
  await writeFile(join(source,'.config/login'),'saved login',{mode:0o600});await writeFile(join(source,'notes'),'saved notes');
  await symlink('.config/login',join(source,'login-link'));
  const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
  const input=join(root,'source.json'),receive=join(root,'receive.json'),output=join(root,'result.json'),jobId=randomUUID(),url=`http://127.0.0.1:${port}`;
  await writeFile(input,JSON.stringify({token:'secret',jobId,root:source,port}));
  const server=spawn(process.execPath,[script.pathname,'serve',input],{stdio:'ignore'});t.after(()=>server.kill());
  for(let i=0;i<100;i++){try{if((await fetch(`${url}/status`)).status===403)break;}catch{}await new Promise(r=>setTimeout(r,20));}
  assert.equal((await fetch(`${url}/archive`)).status,403);
  await writeFile(receive,JSON.stringify({token:'secret',jobId,root:dest,url,output}));
  const child=spawn(process.execPath,[script.pathname,'receive',receive],{stdio:'ignore'});
  assert.equal(await new Promise(r=>child.on('exit',r)),0);
  const result=JSON.parse(await readFile(output,'utf8'));assert.equal(result.jobId,jobId);assert.equal(result.ok,true);assert.ok(result.bytes>0);
  assert.equal(await readFile(join(dest,'.config/login'),'utf8'),'saved login');assert.equal((await stat(join(dest,'.config/login'))).mode&0o777,0o600);
  assert.equal(await readlink(join(dest,'login-link')),'.config/login');assert.equal(await readFile(join(source,'notes'),'utf8'),'saved notes');
  assert.equal((await fetch(`${url}/archive`,{headers:{authorization:'Bearer secret'}})).status,409);
});
