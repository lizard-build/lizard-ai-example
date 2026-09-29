import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { attachment, attachmentLimitError, ATTACHMENT_MAX_BYTES } from '../src/attachments.mjs';
import { Runtime } from '../src/runtime.mjs';
import { Store } from '../src/store.mjs';
import { Bot } from '../src/bot.mjs';
import { Control } from '../src/control.mjs';
import { TenantWorker } from '../src/worker.mjs';
import { config } from '../src/core.mjs';

const photo=[{file_id:'thumb',width:90,height:90},{file_id:'full',width:1200,height:1600}];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=','base64');

test('binary uploads survive the text-only SDK transport and stay under the session folder',async()=>{
  const root=await mkdtemp(join(tmpdir(),'telegram-attachment-'));
  const local=path=>join(root,path);
  const runtime=new Runtime({},null,{});
  runtime.sandbox={fs:{write:async(path,text)=>{
    assert.equal(typeof text,'string');
    await mkdir(dirname(local(path)),{recursive:true});await writeFile(local(path),text);
  }},process:{exec:async command=>{
    const [node,script,path]=command.split(' ');
    assert.equal(node,'node');
    await promisify(execFile)(process.execPath,[local(script),local(path)]);
    return {exitCode:0};
  }}};
  const saved=await runtime.saveAttachment(png,55,10,{kind:'photo'});
  assert.equal(saved.path,'/workspace/sessions/55/attachments/10/image.png');
  assert.deepEqual(await readFile(local(saved.path)),png);
  // Multi-chunk binary file, hostile name, and names used by the upload protocol.
  const bytes=Buffer.alloc(700001);for(let i=0;i<bytes.length;i++) bytes[i]=i%256;
  const document=await runtime.saveAttachment(bytes,56,11,{kind:'document',file_name:'../../part-0.b64'});
  assert.equal(document.path,'/workspace/sessions/56/attachments/11/file-part-0.b64');
  assert.equal(document.image,false);
  assert.deepEqual(await readFile(local(document.path)),bytes);
  const duplicate=await runtime.saveAttachment(bytes,56,11,{kind:'document',file_name:'../../part-0.b64'});
  assert.deepEqual(duplicate,document);
  await assert.rejects(runtime.saveAttachment(bytes,'55;echo bad',12,{}),/Invalid attachment/);
  await assert.rejects(runtime.saveAttachment(bytes,55,12,{kind:'photo'}),/Invalid photo/);
  const originalWrite=runtime.sandbox.fs.write;
  runtime.sandbox.fs.write=async(path,text)=>originalWrite(path,path.endsWith('/part-0.b64')?'AAAA':text);
  await assert.rejects(runtime.saveAttachment(png,55,13,{kind:'photo'}),/checksum mismatch/);
});

test('photos select the largest variant and reject oversized files before download',()=>{
  assert.equal(attachment({photo:[...photo].reverse()}).file_id,'full');
  assert.match(attachmentLimitError({document:{file_id:'x',file_size:ATTACHMENT_MAX_BYTES+1}}),/20 MB/);
});

test('attachments reach Codex with captions, persist across restarts and respect admission and sleep rules',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});t.after(()=>admin.end());
  await admin.query('CREATE DATABASE attachments_test');
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/attachments_test';
  const cfg=config({TELEGRAM_BOT_TOKEN:'123:test',TELEGRAM_OWNER_ID:'123',DATABASE_URL:url.toString(),LIZARD_PROJECT_ID:'test',LIZARD_API_KEY:'test'});
  const control=new Control(cfg);await control.start();t.after(()=>control.close());
  let store=new Store(cfg.database);await store.start();t.after(()=>store.close());
  const calls=[],downloads=[],uploads=[];
  const runtime={generation:'g',rpc:async(method,params)=>{
    calls.push({method,params});
    return method==='account/read'?{account:{}}:method==='thread/start'?{thread:{id:`thread-${params.cwd}`}}:method==='turn/start'?{turn:{id:'turn'}}:{};
  },saveAttachment:async(bytes,topic,id,file)=>{
    uploads.push({bytes,topic,id,file});return {path:`/workspace/sessions/${topic}/attachments/${id}/file`,name:file.file_name,image:file.kind==='photo'||file.mime_type==='image/png'};
  }};
  const tg={download:async id=>{downloads.push(id);return png;},call:async()=>({})};
  let bot=new Bot(cfg,store,tg,runtime);
  const message=(id,topic,fields)=>({update_id:id,message:{from:{id:123},chat:{id:123,type:'private'},message_thread_id:topic,...fields}});
  const first=message(10,55,{photo,caption:'Translate this screenshot'});
  await store.receive([first]);await bot.handle(first);await bot.handle(first);
  assert.deepEqual(downloads,['full']);assert.equal(uploads.length,1);
  const prompt=(await store.query('SELECT * FROM prompts WHERE update_id=10')).rows[0];
  assert.equal(prompt.text,first.message.caption);
  assert.equal(prompt.input[2].type,'localImage');
  assert.equal((await bot.session(55)).first_message_title,first.message.caption);
  assert.equal((await store.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n,1);
  await store.close();store=new Store(cfg.database);await store.start();bot=new Bot(cfg,store,tg,runtime);
  await bot.startPrompts();
  assert.deepEqual(calls.find(c=>c.method==='turn/start').params.input,prompt.input);
  const document=message(11,55,{document:{file_id:'pdf',file_name:'report.pdf'},caption:'/stop'});
  await store.receive([document]);await bot.handle(document);
  const doc=(await store.query('SELECT * FROM prompts WHERE update_id=11')).rows[0];
  assert.equal(doc.text,'/stop','captions are task content, never bot commands');
  assert.equal(doc.input.length,2);assert.match(doc.input[1].text,/report.pdf/);
  assert.equal(calls.some(c=>c.method==='turn/interrupt'),false);
  assert.equal((await bot.session(55)).first_message_title,first.message.caption,'a later attachment never renames the topic');
  const bare=message(12,56,{photo});await store.receive([bare]);await bot.handle(bare);
  assert.match((await store.query('SELECT text FROM prompts WHERE update_id=12')).rows[0].text,/photo/);
  const imageDoc=message(13,56,{document:{file_id:'png',file_name:'screenshot.png',mime_type:'image/png'},caption:'Check this'});
  await store.receive([imageDoc]);await bot.handle(imageDoc);
  assert.equal((await store.query('SELECT input FROM prompts WHERE update_id=13')).rows[0].input.at(-1).type,'localImage');
  const before=downloads.length;
  await bot.handle(message(14,56,{document:{file_id:'large',file_size:ATTACHMENT_MAX_BYTES+1}}));
  assert.equal(downloads.length,before);
  runtime.rpc=async()=>({account:null,requiresOpenaiAuth:true});
  await bot.handle(message(15,56,{photo}));assert.equal(downloads.length,before,'signed-out users do not download');
  runtime.rpc=async()=>({account:{}});
  tg.download=async()=>{throw new Error('download failed');};
  await bot.handle(message(16,56,{photo}));
  assert.equal((await store.query('SELECT 1 FROM prompts WHERE update_id=16')).rowCount,0);
  assert.match((await store.query("SELECT text FROM outbox WHERE dedup_key='progress:16'")).rows[0].text,/send it again/);
  // New people still require the owner's approval. They cannot upload or allocate compute.
  const guest={...message(20,55,{text:'/start'}),message:{...message(20,55,{text:'/start'}).message,from:{id:456},chat:{id:456,type:'private'}}};
  await control.receive([guest]);assert.equal((await control.tenant(456)).admission,'pending');
  assert.equal((await control.query('SELECT 1 FROM control.inbox WHERE user_id=456')).rowCount,0);
  await control.receive([message(21,null,{text:'/allow 456'})]);
  let starts=0;
  class FakeRuntime {async start(){starts++;throw new Error('Stop after counting start');}}
  const worker=new TenantWorker(cfg,control,tg,await control.tenant(456),FakeRuntime);
  await worker.store.start();t.after(()=>worker.store.close());
  const guestPhoto=(id,topic,extra={})=>({update_id:id,message:{from:{id:456},chat:{id:456,type:'private'},message_thread_id:topic,photo,...extra}});
  await control.receive([guestPhoto(22,null),guestPhoto(23,55,{photo:undefined,document:{file_id:'large',file_size:ATTACHMENT_MAX_BYTES+1}})]);
  await worker.tick();assert.equal(starts,0,'outside-topic and oversized attachments do not wake compute');
  await control.receive([guestPhoto(24,55)]);
  await assert.rejects(worker.tick(),/Stop after counting start/);
  assert.equal(starts,1,'valid photos wake a sleeping environment');
});
