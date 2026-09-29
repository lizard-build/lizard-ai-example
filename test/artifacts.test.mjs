import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {outputFiles,readOutputChunk,OUTPUT_MAX_BYTES} from '../src/artifacts.mjs';
import {Runtime} from '../src/runtime.mjs';
import {Telegram} from '../src/telegram.mjs';
import {Store} from '../src/store.mjs';
import {Control} from '../src/control.mjs';
import {Bot} from '../src/bot.mjs';

const cwd='/workspace/sessions/55',pdf=Buffer.from('%PDF-1.7\n\x00\xff\n%%EOF','latin1');
test('output links select deliverables only within this session and deduplicate paths',()=>{
  const text=`[Report](${cwd}/report.pdf) [Again](sandbox:${cwd}/report.pdf)
[Spaces](<${cwd}/a report (final).pdf>) [Relative](report%20two.pdf)
[Other](/workspace/sessions/56/report.pdf) [Secret](../../.config/gh/hosts.yml)
[Hidden](${cwd}/.hidden/secret.json) [Outside](file:///tmp/x.pdf)
[Web](https://example.com/file.pdf) [Escape](../56/report.pdf)
\`[Example](fake.pdf)\`\n\`\`\`\n[Example](fake2.pdf)\n\`\`\``;
  assert.deepEqual(outputFiles(text,cwd).map(f=>f.name),['report.pdf','a report (final).pdf','report two.pdf']);
});

test('sandbox output reads reject symlink escapes, private files, directories and oversized files',async()=>{
  let resolved=cwd+'/report.pdf',size=pdf.length,opened=0;
  const fs={realpath:async p=>p===cwd?cwd:resolved,open:async()=>{
    opened++;
    return {stat:async()=>({isFile:()=>true,size,ino:1,mtimeMs:2,ctimeMs:3}),
      read:async b=>{pdf.copy(b);return {bytesRead:b.length};},close:async()=>{}};
  }};
  const part=await readOutputChunk({cwd,file:resolved},fs);
  assert.deepEqual(Buffer.from(part.data,'base64'),pdf);
  for(const destination of ['/etc/passwd','/workspace/sessions/56/report.pdf',cwd+'/.config/token.json']) {
    resolved=destination;const before=opened;
    await assert.rejects(readOutputChunk({cwd,file:cwd+'/link.pdf'},fs));assert.equal(opened,before);
  }
  resolved=cwd+'/report.pdf';size=OUTPUT_MAX_BYTES+1;
  await assert.rejects(readOutputChunk({cwd,file:resolved},fs),/20 MB/);
  await assert.rejects(readOutputChunk({cwd:'/workspace',file:resolved},fs),/Invalid/);
});

test('output transport reassembles binary chunks and rejects a changing file',async()=>{
  const bytes=Buffer.alloc(500001);for(let i=0;i<bytes.length;i++) bytes[i]=i%256;
  const runtime=new Runtime({},null,{});let changed=false,calls=0;
  runtime.sandbox={process:{exec:async command=>{
    calls++;
    const source=Buffer.from(command.match(/base64,([A-Za-z0-9+/=]+)/)[1],'base64').toString();
    const args=JSON.parse(source.match(/await read\((\{.*\})\)/)[1]);
    assert.equal(args.file,cwd+'/report.pdf');
    return {exitCode:0,stdout:JSON.stringify({size:bytes.length,version:changed&&args.offset?'2':'1',data:bytes.subarray(args.offset,args.offset+192*1024).toString('base64')})};
  }}};
  assert.deepEqual(await runtime.readOutput(cwd,cwd+'/report.pdf'),bytes);assert.equal(calls,3);
  changed=true;await assert.rejects(runtime.readOutput(cwd,cwd+'/report.pdf'),/changed/);
});

test('completed file replies survive restarts and arrive once in the right Telegram topic',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});t.after(()=>admin.end());
  await admin.query('CREATE DATABASE outputs_test');
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/outputs_test';
  const cfg={database:url.toString(),owner:123,chat:123,token:'123:test',project:'test',volume:'owner'};
  const control=new Control(cfg);await control.start();t.after(()=>control.close());
  let store=new Store(cfg.database);await store.start();t.after(()=>store.close());
  let reads=0;
  const runtime={generation:'g',readOutput:async(root,file)=>{reads++;assert.equal(root,cwd);assert.equal(file,cwd+'/report.pdf');return pdf;}};
  let bot=new Bot(cfg,store,{},runtime);await bot.saveSession(55,'Report');
  await store.query("UPDATE sessions SET thread_id='t',turn_id='turn' WHERE topic=55");
  const event={seq:1,generation:'g',data:{method:'item/completed',params:{threadId:'t',turnId:'turn',item:{id:'item',type:'agentMessage',text:`[PDF report](${cwd}/report.pdf)`}}}};
  await bot.event(event);await bot.event(event);assert.equal(reads,1);
  await control.exported(store,123);await control.exported(store,123);
  assert.equal((await store.query('SELECT bytes FROM outgoing_files')).rows[0].bytes,null,'worker releases its upload buffer after durable handoff');
  await store.close();store=new Store(cfg.database);await store.start();bot=new Bot(cfg,store,{},runtime);
  await bot.event(event);assert.equal(reads,1,'journal replay does not read or enqueue the file again');
  const rows=(await control.query('SELECT * FROM control.outbox ORDER BY id')).rows;
  assert.equal(rows.length,2);assert.equal(rows[1].extra.document,true);
  const uploads=[];
  const telegram=new Telegram('test',async(url,opts)=>{
    assert.ok(url.endsWith('/sendDocument'));const form=opts.body;
    assert.ok(form instanceof FormData);assert.equal(opts.headers,undefined);
    assert.equal(form.get('chat_id'),'123');assert.equal(form.get('message_thread_id'),'55');
    assert.equal(form.get('document').name,'report.pdf');
    uploads.push(Buffer.from(await form.get('document').arrayBuffer()));
    return {json:async()=>({ok:true,result:{message_id:99,document:{file_id:'stored-in-telegram'}}})};
  });
  await control.deliver(telegram,rows[1]);await control.deliver(telegram,rows[1]);
  assert.deepEqual(uploads,[pdf]);
  const receipt=(await control.query('SELECT * FROM control.outgoing_files')).rows[0];
  assert.equal(receipt.bytes,null);assert.equal(receipt.file_id,'stored-in-telegram');
  assert.equal((await control.query('SELECT sent FROM control.outbox WHERE id=$1',[rows[1].id])).rows[0].sent,true);
  // A broken file cannot swallow the answer or other output events.
  runtime.readOutput=async()=>{throw new Error('private sandbox details');};
  await bot.event({...event,seq:2,data:{...event.data,params:{...event.data.params,item:{...event.data.params.item,id:'missing',text:`[Missing](${cwd}/missing.pdf)`}}}});
  const error=(await store.query("SELECT text FROM outbox WHERE dedup_key LIKE '%:error'")).rows[0].text;
  assert.match(error,/could not attach missing.pdf/);assert.ok(!error.includes('private sandbox details'));
});
