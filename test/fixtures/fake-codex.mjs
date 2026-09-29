#!/usr/bin/env node
import { createInterface } from 'node:readline';
let turns = 0;
const send = data => console.log(JSON.stringify(data));
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined || !request.method) return;
  if (request.method === 'initialize') return send({ id: request.id, result: {} });
  if (request.method === 'account/read') return send({ id: request.id, result: { account: null, calls: turns } });
  if (request.method === 'thread/read') {
    for(const delta of ['Hello ','**world**']) send({method:'item/agentMessage/delta',params:{threadId:'stream-thread',turnId:'stream-turn',itemId:'stream-item',delta}});
    send({method:'item/reasoning/textDelta',params:{threadId:'stream-thread',delta:'PRIVATE REASONING'}});
    return send({id:request.id,result:{}});
  }
  if (request.method === 'turn/interrupt') {
    send({method:'item/completed',params:{threadId:'stream-thread',turnId:'stream-turn',item:{id:'stream-item',type:'agentMessage',text:'Hello **world**'}}});
    send({method:'turn/completed',params:{threadId:'stream-thread',turn:{id:'stream-turn',status:'interrupted'}}});
    return send({id:request.id,result:{}});
  }
  if (request.method === 'turn/start') {
    turns++;
    send({ id: request.id, result: { turn: { id: `turn-${turns}`, status: 'inProgress' } } });
    send({ method: 'item/completed', params: { threadId: 'test-thread', item: { type: 'agentMessage', text: 'Готово 🦎' } } });
    send({ id: 900 + turns, method: 'item/commandExecution/requestApproval', params: { threadId: 'test-thread', turnId: `turn-${turns}`, command: 'git status' } });
    return;
  }
  send({ id: request.id, result: {} });
});
