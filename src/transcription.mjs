import { VOICE_MAX_BYTES } from './core.mjs';

export const TRANSCRIPTION_MODEL = 'openai/gpt-4o-mini-transcribe';
const formats = new Map([
  ['audio/ogg', 'ogg'], ['application/ogg', 'ogg'], ['audio/opus', 'ogg'],
  ['audio/mpeg', 'mp3'], ['audio/mp3', 'mp3'], ['audio/mp4', 'm4a'], ['audio/x-m4a', 'm4a'],
  ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/flac', 'flac'],
  ['audio/webm', 'webm'], ['audio/aac', 'aac'],
]);

// Service-side only: neither audio nor the service key enters the user's Sandbox.
export async function transcribeVoice(audio, apiKey, mimeType = 'audio/ogg', fetcher = fetch) {
  if (!apiKey) throw new Error('Voice transcription is not configured');
  if (!Buffer.isBuffer(audio) || !audio.length || audio.length > VOICE_MAX_BYTES) throw new Error('Invalid voice audio');
  const format = formats.get(mimeType.split(';', 1)[0].trim().toLowerCase());
  if (!format) throw new Error('Unsupported voice format');
  try {
    const response = await fetcher('https://openrouter.ai/api/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TRANSCRIPTION_MODEL, input_audio: { data: audio.toString('base64'), format } }),
      // No language hint: preserve Russian, English and mixed speech without translation.
      signal: AbortSignal.timeout(75000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Provider rejected transcription'); }
    const reader = response.body.getReader();
    const parts = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256 * 1024) throw new Error('Oversized transcription response');
        parts.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (typeof data.text !== 'string' || data.text.length > 16000) throw new Error('Invalid transcript');
    return data.text.trim();
  } catch {
    // Provider bodies and fetch errors can contain audio, transcripts or credentials.
    // Do not retry automatically: an uncertain request may already have been billed.
    throw new Error('Voice transcription failed');
  }
}
