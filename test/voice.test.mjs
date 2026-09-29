import test from 'node:test';
import assert from 'node:assert/strict';
import {Telegram} from '../src/telegram.mjs';
import {Bot} from '../src/bot.mjs';
import {transcribeVoice} from '../src/transcription.mjs';
import {VOICE_MAX_BYTES} from '../src/core.mjs';

test('OpenRouter transcribes Russian, English and mixed speech without a language hint', async () => {
  for(const text of ['Создай игру, пожалуйста.', 'Build a game, please.', 'Добавь кнопку Play 🎮']) {
    let calls=0;
    const actual=await transcribeVoice(Buffer.from('voice bytes'),'TEST_KEY','audio/ogg; codecs=opus',async(url,options)=>{
      calls++;
      assert.equal(url,'https://openrouter.ai/api/v1/audio/transcriptions');
      assert.equal(options.method,'POST');
      assert.equal(options.headers.Authorization,'Bearer TEST_KEY');
      assert.deepEqual(JSON.parse(options.body),{
        model:'openai/gpt-4o-mini-transcribe',input_audio:{data:Buffer.from('voice bytes').toString('base64'),format:'ogg'},
      });
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({text:` ${text} `});
    });
    assert.equal(actual,text);assert.equal(calls,1);
  }
});

test('transcription limits input and responses and never retries or exposes provider errors', async () => {
  const fail=async()=>{assert.fail('must reject before network')};
  await assert.rejects(transcribeVoice(Buffer.from('a'),undefined,'audio/ogg',fail),/not configured/);
  await assert.rejects(transcribeVoice(Buffer.alloc(VOICE_MAX_BYTES+1),'KEY','audio/ogg',fail),/Invalid voice/);
  await assert.rejects(transcribeVoice(Buffer.alloc(0),'KEY','audio/ogg',fail),/Invalid voice/);
  await assert.rejects(transcribeVoice(Buffer.from('a'),'KEY','text/html',fail),/Unsupported/);
  for (const response of [
    ()=>new Response('SECRET provider body',{status:429}),
    ()=>new Response('SECRET provider body',{status:500}),
    ()=>{throw new Error('SECRET network error')},
    ()=>{throw new DOMException('SECRET timeout','TimeoutError')},
    ()=>Response.json({text:12}),
    ()=>Response.json({text:'x'.repeat(16001)}),
    ()=>new Response('x'.repeat(256*1024+1)),
  ]) {
    let calls=0;
    await assert.rejects(transcribeVoice(Buffer.from('a'),'KEY','audio/ogg',async()=>{calls++;return response()}),
      {message:'Voice transcription failed'});
    assert.equal(calls,1);
  }
  assert.equal(await transcribeVoice(Buffer.from('a'),'KEY',undefined,async()=>Response.json({text:' '})),'');
});

test('voice transcript replies remain literal and italic across Telegram chunks and edits', async () => {
  const telegram=new Telegram('unused');const calls=[];
  telegram.call=async(method,body)=>{calls.push({method,body});return {message_id:calls.length}};
  const spoken='Привет **world** <tag> 🎮 '.repeat(220);
  const text=`🎤 ${spoken}`;
  const extra={progress:true,entities:[{type:'italic',offset:3,length:spoken.length}],reply_parameters:{message_id:42,allow_sending_without_reply:true}};
  for(const chat of [123,-123]) {
    calls.length=0;
    const ids=await telegram.update(chat,55,text,extra);
    assert.ok(ids.length>1);
    assert.equal(calls.map(c=>c.body.text).join(''),text);
    for(const [index,{method,body}] of calls.entries()) {
      assert.equal(method,'sendMessage');assert.equal(body.chat_id,chat);assert.equal(body.message_thread_id,55);
      assert.equal(body.reply_parameters.message_id,42);
      assert.equal(body.parse_mode,undefined);
      assert.deepEqual(body.entities,[{type:'italic',offset:index===0?3:0,length:body.text.length-(index===0?3:0)}]);
    }
    calls.length=0;
    await telegram.update(chat,55,text,extra,ids);
    assert.ok(calls.every(c=>c.method==='editMessageText' && c.body.reply_parameters===undefined));
  }
});

test('voice download is bounded and cannot leak the bot token through errors', async () => {
  const tg = new Telegram('SECRET',async()=>new Response(new Uint8Array(11)));
  tg.call=async()=>({file_path:'voice/file.oga',file_size:1});
  await assert.rejects(tg.download('id',10),/Could not download/);
  tg.fetch=async()=>{throw new Error('https://api.telegram.org/file/botSECRET/voice')};
  await assert.rejects(tg.download('id',10),e=>!e.message.includes('SECRET'));
  tg.call=async()=>({file_path:'../elsewhere'});
  await assert.rejects(tg.download('id',10),/Invalid Telegram file path/);
  tg.call=async()=>({file_path:'voice/file.oga'});
  tg.fetch=async()=>new Response(Uint8Array.from([0,255,128,13]));
  assert.deepEqual([...await tg.download('id',10)],[0,255,128,13]);
});

test('voice limits and missing login fail before download or transcription', async () => {
  const messages=[];
  const bot=new Bot({owner:123,chat:123},{query:async sql=>({rows:sql.startsWith('SELECT * FROM sessions')?[{topic:55}]:[],rowCount:0}),enqueue:async(_key,_topic,text)=>messages.push(text)}, {}, {
    rpc:async()=>({account:null,requiresOpenaiAuth:true}),
  });
  const message={from:{id:123},chat:{id:123,type:'private'},message_thread_id:55,voice:{file_id:'voice',duration:181}};
  await bot.handle({update_id:1,message});
  assert.match(messages.pop(),/under 3 minutes/);
  await bot.handle({update_id:2,message:{...message,voice:{...message.voice,duration:8}}});
  assert.match(messages.pop(),/Sign in with \/login/);
});
