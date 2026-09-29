import { chunks, sleep } from './core.mjs';
import { formatMarkdown } from './format.mjs';

export class Telegram {
  constructor(token, fetcher = fetch) { this.token = token; this.fetch = fetcher; }
  async call(method, body = {}, { transient = false } = {}) {
    // Internal topic 1 represents a group's main conversation, not a forum topic.
    if(!(body instanceof FormData) && Number(body.chat_id)<0 && Number(body.message_thread_id)===1) {
      body={...body};delete body.message_thread_id;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try {
        response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: 'POST', ...(body instanceof FormData ? {body} : {headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)}),
          signal: AbortSignal.timeout(transient ? 3000 : method === 'sendDocument' ? 120000 : method === 'getUpdates' ? 40000 : 20000),
        });
      } catch { throw new Error(`Telegram ${method}: network failure; delivery unknown`); }
      const data = await response.json();
      if (data.ok) return data.result;
      if (!transient && data.error_code === 429 && attempt < 3) { await sleep(Math.min(data.parameters?.retry_after || 2, 60) * 1000); continue; }
      // Never include URLs or token-bearing fetch errors in logs.
      const error = new Error(`Telegram ${method}: ${data.error_code}`);
      error.telegramCode = data.error_code;
      error.retryAfter = data.parameters?.retry_after;
      error.messageNotModified = /message is not modified/i.test(data.description || '');
      error.messageMissing = /message to edit not found/i.test(data.description || '');
      error.topicNotModified = /TOPIC_NOT_MODIFIED|topic is not modified/i.test(data.description || '');
      throw error;
    }
  }
  async document(chat,topic,name,bytes) {
    const form=new FormData();
    form.set('chat_id',String(chat));
    if(topic && !(Number(chat)<0 && Number(topic)===1)) form.set('message_thread_id',String(topic));
    form.set('document',new Blob([bytes],{type:'application/octet-stream'}),name);
    return this.call('sendDocument',form);
  }
  async send(chat, topic, text, extra = {}) {
    if (extra.rich || extra.rich_message) return this.sendRich(chat, topic, text, extra);
    let last; let offset = 0;
    const { markdown, entities: suppliedEntities, ...options } = extra;
    const formatted = markdown ? formatMarkdown(text) : { text, entities: suppliedEntities || [] };
    if (formatted.copyCode && !options.reply_markup) options.reply_markup = { inline_keyboard: [[{ text: 'Copy code', copy_text: { text: formatted.copyCode } }]] };
    const parts = chunks(formatted.text);
    for (const [index, part] of parts.entries()) {
      if (index && this.chunkDelayMs) await sleep(this.chunkDelayMs);
      const entities = formatted.entities.flatMap(entity => {
        const start = Math.max(entity.offset, offset), end = Math.min(entity.offset + entity.length, offset + part.length);
        return end > start ? [{ ...entity, offset: start - offset, length: end - start }] : [];
      });
      last = await this.call('sendMessage', {
      chat_id: chat, ...(topic ? { message_thread_id: Number(topic) } : {}), text: part,
      link_preview_options: { is_disabled: true }, ...(entities.length ? { entities } : {}), ...(index === parts.length - 1 ? options : {}),
    });
      offset += part.length;
    }
    return last;
  }
  async sendRich(chat, topic, text, extra = {}) {
    const {rich, rich_message, markdown, fallback_markup, ...options} = extra;
    const parts = rich_message ? [rich_message] : chunks(text, 30000).map(markdown => ({markdown}));
    let last;
    for (const [index, content] of parts.entries()) {
      if (index && this.chunkDelayMs) await sleep(this.chunkDelayMs);
      const opts = index === parts.length-1 ? options : {};
      const code = formatMarkdown(text).copyCode;
      if (code && index===parts.length-1 && !opts.reply_markup) opts.reply_markup = {inline_keyboard:[[{text:'Copy code',copy_text:{text:code}}]]};
      try {
        last = await this.call('sendRichMessage', {chat_id:chat, ...(topic ? {message_thread_id:Number(topic)} : {}), rich_message:content, ...opts});
      } catch (error) {
        // Fall back only after a definite rejection, never an uncertain network send.
        if (![400,404].includes(error.telegramCode)) throw error;
        last = await this.send(chat, topic, content.markdown || text, {...opts,...(fallback_markup ? {reply_markup:fallback_markup} : {}),markdown:true});
      }
    }
    return last;
  }
  async update(chat, topic, text, extra={}, messageIds=[], checkpoint=async()=>{}) {
    const {progress,streamPreview,rich,rich_message,markdown,fallback_markup,entities:suppliedEntities,...options}=extra;
    const formatted=rich || markdown ? formatMarkdown(text) : {text,entities:suppliedEntities || []};
    const parts=chunks(rich ? text : formatted.text,rich ? 30000 : 4096);
    const ids=[...messageIds];let offset=0;
    for(const [index,part] of parts.entries()) {
      const markup=index===parts.length-1 ? options.reply_markup || (formatted.copyCode ? {inline_keyboard:[[{text:'Copy code',copy_text:{text:formatted.copyCode}}]]} : {inline_keyboard:[]}) : {inline_keyboard:[]};
      const entities=formatted.entities.flatMap(e=>{
        const start=Math.max(e.offset,offset),end=Math.min(e.offset+e.length,offset+part.length);
        return end>start?[{...e,offset:start-offset,length:end-start}]:[];
      });
      const body={chat_id:chat,...options,reply_markup:markup,...(rich?{rich_message:{markdown:part}}:{text:part,entities,link_preview_options:{is_disabled:true}})};
      let result;
      try {
        if(ids[index]) {
          try {result=await this.call('editMessageText',{...body,reply_parameters:undefined,message_id:ids[index]},{transient:Boolean(streamPreview)});}
          catch(error) {
            if(error.messageNotModified) result={message_id:ids[index]};
            else if(!error.messageMissing) throw error;
          }
        }
        if(!result) result=await this.call(rich?'sendRichMessage':'sendMessage',{...body,...(topic?{message_thread_id:Number(topic)}:{})},{transient:Boolean(streamPreview)});
      } catch(error) {
        if(rich && [400,404].includes(error.telegramCode)) return this.update(chat,topic,text,{...options,streamPreview,markdown:true},ids,checkpoint);
        throw error;
      }
      ids[index]=result.message_id || ids[index];
      if(!ids[index]) throw new Error('Telegram did not return a message ID');
      await checkpoint(ids);
      offset+=part.length;
      if(index<parts.length-1 && this.chunkDelayMs) await sleep(this.chunkDelayMs);
    }
    return ids;
  }
  async draft(chat, topic, id, text) {
    const body = {chat_id:chat, ...(topic ? {message_thread_id:Number(topic)} : {}),draft_id:id,can_stop:true,keep_on_stop:false};
    const preview = chunks(text,30000)[0] || 'Working…';
    try { return await this.call('sendRichMessageDraft',{...body,rich_message:{markdown:preview}},{transient:true}); }
    catch (error) {
      if (![400,404].includes(error.telegramCode)) throw error;
      return this.call('sendMessageDraft',{...body,text:chunks(formatMarkdown(preview).text)[0]},{transient:true});
    }
  }
  async thinking(chat, topic, id) {
    // Telegram's native thinking block is draft-only and private-chat-only.
    if(Number(chat)<0) return false;
    const body={chat_id:chat,...(topic?{message_thread_id:Number(topic)}:{}),draft_id:Number(id),can_stop:false,keep_on_stop:false};
    try {
      await this.call('sendRichMessageDraft',{...body,rich_message:{blocks:[{type:'thinking',text:'Thinking…'}]}},{transient:true});
      return true;
    } catch(error) {
      if(![400,404].includes(error.telegramCode)) throw error;
    }
    try {await this.call('sendMessageDraft',{...body,text:''},{transient:true});return true;}
    catch(error) {if(![400,404].includes(error.telegramCode)) throw error;return false;}
  }
  typing(chat, topic) {
    return this.call('sendChatAction',{chat_id:chat,...(topic ? {message_thread_id:Number(topic)} : {}),action:'typing'},{transient:true});
  }
  async download(fileId, maxBytes) {
    const file = await this.call('getFile', { file_id: fileId });
    if (file.file_size > maxBytes) throw new Error('File too large');
    const path = file.file_path;
    if (!path || !/^[a-zA-Z0-9_./-]+$/.test(path) || path.startsWith('/') || path.split('/').includes('..')) throw new Error('Invalid Telegram file path');
    try {
      const response = await this.fetch(`https://api.telegram.org/file/bot${this.token}/${path}`, {
        redirect: 'error', signal: AbortSignal.timeout(45000),
      });
      if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) throw new Error();
      const parts = []; let size = 0;
      for await (const part of response.body) {
        size += part.length;
        if (size > maxBytes) throw new Error();
        parts.push(Buffer.from(part));
      }
      if (!size) throw new Error();
      return Buffer.concat(parts);
    } catch { throw new Error('Could not download attachment'); }
  }
}
