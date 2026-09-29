import test from 'node:test';
import assert from 'node:assert/strict';
import {taskFailure} from '../src/task-error.mjs';

test('task failures show the real provider message, code and details without guessing a cause',()=>{
  const message='This content was flagged for possible cybersecurity risk.';
  const result=taskFailure({status:'failed',error:{message,codexErrorInfo:'cyberPolicy'}});
  assert.ok(result.includes(message));assert.match(result,/cyberPolicy/);
  assert.doesNotMatch(result,/sign-in|limits/);
  assert.match(taskFailure({error:{message:'Try again later.',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:503}},additionalDetails:'HTTP 503'}}),/httpConnectionFailed[\s\S]*HTTP 503/);
  assert.match(taskFailure({error:{code:401,message:'Account authorization expired.'}}),/401[\s\S]*Account authorization expired/);
});
test('failure messages redact credentials and never serialize other event fields',()=>{
  const token='private-service-credential';
  const result=taskFailure({error:{message:`${token} sk-test-secret Bearer opaque-secret ghp_secret123 123456:abcdefghijklmnopqrstuvwxyz https://user:pass@example.com access_token=opaque-refresh`,
    additionalDetails:'{"refresh_token":"secret-refresh"}',codexErrorInfo:'unknown',request:{secret:'must-not-appear'}}},{apiKey:token});
  for(const secret of [token,'sk-test-secret','opaque-secret','ghp_secret123','abcdefghijklmnopqrstuvwxyz','user:pass','opaque-refresh','secret-refresh','must-not-appear'])assert.ok(!result.includes(secret),secret);
  assert.match(result,/redacted/);
});
test('missing and oversized errors have honest bounded output; stopping stays distinct',()=>{
  assert.match(taskFailure({status:'failed'}),/did not provide an error message/);
  assert.equal(taskFailure({status:'interrupted',error:{message:'Do not show'}}),'Task stopped.');
  const long=taskFailure({error:{message:'x'.repeat(20000)}});
  assert.ok(long.length<=6000);assert.match(long,/truncated/);
});
