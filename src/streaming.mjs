export const STREAM_INTERVAL_MS = 150;

// Hold only the unfinished last word. Always send the newest prefix, never
// queue token-by-token animation that could fall behind the model.
export function completeWords(text) {
  const end = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\n'), text.lastIndexOf('\t'));
  return end < 0 ? '' : text.slice(0,end+1);
}

export class Delivery {
  constructor(control,telegram,now=Date.now) {
    Object.assign(this,{control,telegram,now});
    this.active=new Map();this.cooldowns=new Map();
  }
  async tick() {
    for(const [chat,until] of this.cooldowns) if(until<=this.now()) this.cooldowns.delete(chat);
    if(this.active.size>=10) return;
    const {rows}=await this.control.query(`SELECT DISTINCT ON (chat_id) * FROM control.outbox
      WHERE failed=false AND (sent=false OR (
        chat_id>0 AND extra->>'thinking'='true' AND message_ids='[]'::jsonb
        AND thinking_refreshed_at<now()-interval '20 seconds')) ORDER BY chat_id,id`);
    for(const row of rows.sort((a,b)=>Number(a.id)-Number(b.id))) {
      const chat=String(row.chat_id);
      if(this.active.size>=10) break;
      if(this.active.has(chat) || this.cooldowns.has(chat) || new Date(row.next_attempt).getTime()>this.now()) continue;
      const task=this.send(row).finally(()=>this.active.delete(chat));
      this.active.set(chat,task);
    }
  }
  async send(row) {
    const chat=String(row.chat_id);
    try {
      await this.control.deliver(this.telegram,row);
      this.cooldowns.set(chat,this.now()+(row.extra?.progress ? STREAM_INTERVAL_MS : 1100));
    } catch(error) {
      const delay=error.telegramCode===429 ? Math.max(1000,(error.retryAfter || 2)*1000) : 15000;
      this.cooldowns.set(chat,this.now()+delay);
      try {
        if(error.telegramCode===429) {
          // A new preview/final revision must not bypass Telegram's retry_after.
          await this.control.query("UPDATE control.outbox SET next_attempt=greatest(next_attempt,now()+($2::int * interval '1 millisecond')) WHERE chat_id=$1 AND sent=false",[row.chat_id,delay]);
        } else if([400,403].includes(error.telegramCode)) {
          await this.control.query('UPDATE control.outbox SET failed=true WHERE id=$1 AND revision=$2',[row.id,row.revision]);
        } else await this.control.query("UPDATE control.outbox SET next_attempt=now()+interval '15 seconds' WHERE id=$1 AND revision=$2",[row.id,row.revision]);
      } catch { /* Durable rows remain pending if the database is unavailable. */ }
    }
  }
  async drain() { await Promise.allSettled(this.active.values()); }
}
