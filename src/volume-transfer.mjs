// One-use authenticated streaming copy between two user-owned Sandboxes.
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash,timingSafeEqual} from 'node:crypto';
import {Transform,Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
const mode=process.argv[2],input=JSON.parse(await readFile(process.argv[3] || '/tmp/tg-volume-transfer.json','utf8'));
const output=input.output || '/tmp/tg-volume-transfer-result.json',root=input.root || '/workspace';
if(!input.jobId || !input.token)throw new Error('Missing transfer identity');
if(mode==='serve') {
  let claimed=false,state={running:false};
  const server=createServer(async(req,res)=>{
    const given=Buffer.from(req.headers.authorization || ''),expected=Buffer.from(`Bearer ${input.token}`);
    if(given.length!==expected.length || !timingSafeEqual(given,expected)){res.writeHead(403);res.end();return;}
    if(req.url==='/status'){res.setHeader('content-type','application/json');res.end(JSON.stringify(state));return;}
    if(req.url!=='/archive' || claimed){res.writeHead(409);res.end();return;}
    claimed=true;state={running:true};
    const tar=spawn('tar',['-C',root,'-czf','-','.'],{stdio:['ignore','pipe','ignore']});
    const finished=new Promise(resolve=>tar.on('close',resolve).on('error',()=>resolve(-1)));
    const hash=createHash('sha256');let bytes=0;
    const meter=new Transform({transform(chunk,encoding,done){hash.update(chunk);bytes+=chunk.length;done(null,chunk);}});
    try {await pipeline(tar.stdout,meter,res);const code=await finished;state={running:false,ok:code===0,sha256:hash.digest('hex'),bytes};}
    catch {tar.kill();state={running:false,ok:false};}
  });
  server.listen(input.port || 43771,'0.0.0.0');setTimeout(()=>server.close(),30*60000).unref();
} else if(mode==='receive') {
  try {
    const response=await fetch(`${input.url}/archive`,{headers:{authorization:`Bearer ${input.token}`},signal:AbortSignal.timeout(20*60000)});
    if(!response.ok)throw new Error('Transfer rejected');
    const tar=spawn('tar',['-C',root,'-xzf','-'],{stdio:['pipe','ignore','ignore']});
    const finished=new Promise(resolve=>tar.on('close',resolve).on('error',()=>resolve(-1)));
    const hash=createHash('sha256');let bytes=0;
    const meter=new Transform({transform(chunk,encoding,done){hash.update(chunk);bytes+=chunk.length;done(null,chunk);}});
    await pipeline(Readable.fromWeb(response.body),meter,tar.stdin);
    if(await finished!==0)throw new Error('Extract failed');
    const digest=hash.digest('hex');
    let source;
    for(let i=0;i<20;i++) {
      source=await fetch(`${input.url}/status`,{headers:{authorization:`Bearer ${input.token}`},signal:AbortSignal.timeout(5000)}).then(r=>r.json());
      if(!source.running)break;await new Promise(r=>setTimeout(r,250));
    }
    if(!source.ok || source.sha256!==digest || source.bytes!==bytes)throw new Error('Archive verification failed');
    await writeFile(output,JSON.stringify({jobId:input.jobId,ok:true,bytes,sha256:digest}),{mode:0o600});
  } catch {await writeFile(output,JSON.stringify({jobId:input.jobId,ok:false}),{mode:0o600});process.exitCode=1;}
} else throw new Error('Invalid transfer mode');
