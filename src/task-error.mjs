// Provider errors may include request details. Show only the error fields,
// never the full event, and remove credentials before persisting chat output.
export function taskFailure(turn, cfg = {}) {
  if (turn?.status === 'interrupted') return 'Task stopped.';
  const secrets = ['token','apiKey','openaiKey','openrouterKey','provisionerKey','tenantCredentialKey','database']
    .map(key=>cfg[key]).filter(value=>typeof value==='string' && value.length>=8);
  const clean = value => {
    if(typeof value!=='string') return '';
    let text=value;
    for(const secret of secrets) text=text.replaceAll(secret,'[redacted]');
    return text
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,'[redacted]')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9_+/.=:-]+/gi,'[redacted]')
      .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g,'[redacted]')
      .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g,'[redacted]')
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[redacted]@')
      .replace(/((?:["']?(?:access_token|refresh_token|api_key|password|authorization)["']?)\s*[:=]\s*)["']?[^\s,"'&}]+["']?/gi,'$1[redacted]')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim();
  };
  const error=turn?.error;
  const info=error?.codexErrorInfo;
  const code=clean(typeof info==='string'?info:info && typeof info==='object'?Object.keys(info)[0]:String(error?.code ?? '')).slice(0,100);
  const message=clean(typeof error==='string'?error:error?.message);
  const details=clean(error?.additionalDetails);
  const text=[`Codex error${code?` (${code})`:''}:`,message || 'Codex did not provide an error message.',
    details && details!==message?details:'','Your history is saved.'].filter(Boolean).join('\n\n');
  return text.length>6000?text.slice(0,5900)+'\n\n[Error message truncated]':text;
}
