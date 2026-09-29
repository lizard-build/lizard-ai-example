export const questionTool = {
  type:'function', name:'telegram_ask_user',
  description:'Ask the user 1–3 clarification questions in Telegram with choice buttons and a custom text answer. Wait for the answers. Use only for missing information or preferences, never routine tool permissions.',
  inputSchema:{type:'object',additionalProperties:false,required:['questions'],properties:{questions:{type:'array',minItems:1,maxItems:3,items:{type:'object',additionalProperties:false,required:['id','question','options'],properties:{id:{type:'string'},question:{type:'string'},options:{type:'array',maxItems:6,items:{type:'object',additionalProperties:false,required:['label','description'],properties:{label:{type:'string'},description:{type:'string'}}}}}}}}},
};
export const isQuestion = a => a.method?.endsWith('/requestUserInput') || (a.method === 'item/tool/call' && a.params?.tool === questionTool.name);
export function validQuestions(questions) {
  return Array.isArray(questions) && questions.length>0 && questions.length<=3
    && new Set(questions.map(q=>q.id)).size===questions.length
    && questions.every(q=>typeof q.id==='string' && /^[\w-]{1,80}$/.test(q.id) && typeof q.question==='string' && q.question.length>0 && q.question.length<=4000
      && (q.options==null || Array.isArray(q.options) && q.options.length<=6 && q.options.every(o=>typeof o.label==='string' && o.label.length>0 && o.label.length<=200 && (!o.description || typeof o.description==='string' && o.description.length<=2000))));
}
export class Questions {
  constructor(bot) { this.bot=bot; }
  async show(a) {
    await this.bot.store.pauseThinking(a.topic);
    const questions=a.params.questions, answers=a.answers || {};
    const index=questions.findIndex(q=>!Object.hasOwn(answers,q.id));
    if (index<0) return;
    const q=questions[index], buttons=(q.options || []).map((o,i)=>[{text:Array.from(o.label).slice(0,60).join(''),callback_data:`question:${a.id}:${index}:${i}`}]);
    if (buttons.length) buttons.push([{text:'Write my own answer',callback_data:`question:${a.id}:${index}:other`}]);
    const title=questions.length>1 ? `Question ${index+1} of ${questions.length}` : 'A quick question';
    const blocks=[{type:'heading',size:3,text:title},{type:'paragraph',text:q.question}];
    for(const o of q.options || []) if(o.description) blocks.push({type:'paragraph',text:[{type:'bold',text:o.label},` — ${o.description}`]});
    const hint=this.bot.cfg.groupOwner ? 'Choose an option or reply to this message with your answer.' : 'Choose an option or type your answer in this topic.';
    blocks.push({type:'paragraph',text:hint});
    blocks.push(...buttons.map(row=>({type:'buttons',buttons:row})));
    const text=[title,q.question,...(q.options || []).map(o=>`${o.label}: ${o.description || ''}`),hint].join('\n\n');
    await this.bot.say(`question:${a.id}:${index}`,a.topic,text,{rich_message:{blocks},fallback_markup:{inline_keyboard:buttons}});
  }
  async current(topic, id) {
    const {rows}=await this.bot.store.query("SELECT * FROM approvals WHERE topic=$1 AND state='pending' AND generation=$2 AND ($3::text IS NULL OR id=$3) ORDER BY created_at",[topic,this.bot.runtime.generation,id || null]);
    return rows.find(isQuestion);
  }
  async accept(a, index, value) {
    const questions=a.params.questions;
    if (index!==questions.findIndex(q=>!Object.hasOwn(a.answers || {},q.id))) return false;
    if (typeof value!=='string' || !value.trim() || value.length>16000) return false;
    const answers={...(a.answers || {}),[questions[index].id]:{answers:[value.trim()]}};
    await this.bot.store.query('UPDATE approvals SET answers=$2 WHERE id=$1',[a.id,JSON.stringify(answers)]);
    a.answers=answers;
    if(questions.some(q=>!Object.hasOwn(answers,q.id))) await this.show(a);
    else await this.finish(a);
    return true;
  }
  async finish(a) {
    const answers=a.answers;
    const result=a.method==='item/tool/call' ? {success:true,contentItems:[{type:'inputText',text:JSON.stringify({answers})}]} : {answers};
    // The same bridge key recovers a lost reply without submitting it twice.
    await this.bot.runtime.reply(a,result,`decision:${a.id}`);
    await this.bot.store.query("UPDATE approvals SET state='answered' WHERE id=$1",[a.id]);
    await this.bot.say(`answered:${a.id}`,a.topic,'Thanks — continuing.');
  }
  async text(topic,text,id,expectedIndex) {
    const a=await this.current(topic,id);
    if(!a) return false;
    const index=a.params.questions.findIndex(q=>!Object.hasOwn(a.answers || {},q.id));
    if(expectedIndex!==undefined && index!==expectedIndex) return false;
    if(index>=0) await this.accept(a,index,text);
    else await this.finish(a);
    return true;
  }
  async callback(callback,match) {
    const [,id,question,choice]=match, topic=callback.message?.message_thread_id;
    const a=await this.current(topic,id), index=Number(question);
    if(a && a.params.questions.every(q=>Object.hasOwn(a.answers || {},q.id))) {
      await this.finish(a);
      return this.bot.telegram.call('answerCallbackQuery',{callback_query_id:callback.id,text:'Answer received'});
    }
    const q=a?.params.questions[index];
    if(!a || !q || index!==a.params.questions.findIndex(q=>!Object.hasOwn(a.answers || {},q.id))) {
      await this.bot.telegram.call('answerCallbackQuery',{callback_query_id:callback.id,text:'This question is already closed.'}); return;
    }
    const value=q.options?.[Number(choice)]?.label;
    if(choice!=='other' && !value) return this.bot.telegram.call('answerCallbackQuery',{callback_query_id:callback.id,text:'This option is unavailable.'});
    await this.bot.telegram.call('answerCallbackQuery',{callback_query_id:callback.id,text:choice==='other' ? (this.bot.cfg.groupOwner ? 'Reply to the question with your answer.' : 'Type your answer in this topic.') : 'Answer received'});
    if(choice==='other') return this.bot.say(`custom:${a.id}:${index}`,topic,q.question,{reply_markup:{force_reply:true,input_field_placeholder:'Write your answer…',selective:true}});
    if(await this.accept(a,index,value)) {
      // Clear both rich in-text buttons and the legacy keyboard on this card.
      await this.bot.telegram.call('editMessageText',{chat_id:this.bot.cfg.chat,message_id:callback.message.message_id,rich_message:{blocks:[{type:'paragraph',text:[q.question,'\n',{type:'bold',text:`Selected: ${value}`}]}]},reply_markup:{inline_keyboard:[]}}).catch(()=>{});
    }
  }
}
