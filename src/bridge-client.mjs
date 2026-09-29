import { readFileSync, unlinkSync } from 'node:fs';
const root = process.env.BRIDGE_ROOT || '/workspace/.telegram-codex';
try {
  const requestPath = process.argv[2];
  let body;
  if (requestPath) {
    if (!/^\/opt\/telegram-codex\/request-[a-f0-9-]+\.json$/.test(requestPath)) throw new Error('Invalid request path');
    body = readFileSync(requestPath, 'utf8');
    unlinkSync(requestPath);
  } else body = Buffer.from(process.env.BRIDGE_REQUEST, 'base64').toString('utf8');
  const response = await fetch(`http://127.0.0.1:${process.env.BRIDGE_PORT || 43127}/`, {
    method: 'POST', headers: { authorization: `Bearer ${readFileSync(`${root}/bridge.key`, 'utf8')}`, 'content-type': 'application/json' },
    body, signal: AbortSignal.timeout(60000),
  });
  const data = await response.json();
  const request = JSON.parse(body);
  if (request.action === 'rpc' && request.method === 'thread/resume' && data.result?.thread) {
    // Resume returns the full transcript, including large command results.
    // Sandbox exec truncates stdout at 512 KiB. The controller only needs the
    // thread ID and active turn IDs for recovery; Codex keeps the full history.
    const thread = data.result.thread;
    data.result = { thread: { id: thread.id, turns: (thread.turns || [])
      .filter(turn => turn.status === 'inProgress')
      .map(turn => ({ id: turn.id, status: turn.status })) } };
  }
  console.log(JSON.stringify(data));
  if (!response.ok) process.exitCode = 1;
} catch { console.log(JSON.stringify({ error: 'Bridge unavailable' })); process.exitCode = 1; }
