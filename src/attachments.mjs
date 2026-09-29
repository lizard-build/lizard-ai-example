export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export function attachment(message) {
  if (message?.document) return { ...message.document, kind: 'document' };
  if (message?.photo?.length) {
    const photo = message.photo.reduce((a,b) => a.width*a.height > b.width*b.height ? a : b);
    return { ...photo, kind: 'photo', file_name: 'photo.jpg' };
  }
  return null;
}

export function attachmentLimitError(message) {
  const file = attachment(message);
  if (!file) return null;
  if (!file.file_id) return 'I could not read this attachment. Please send it again.';
  if (file.file_size > ATTACHMENT_MAX_BYTES) return 'Please send a file smaller than 20 MB.';
  return null;
}

export function attachmentName(name) {
  return String(name || 'attachment').split(/[\\/]/).at(-1).replace(/[^a-zA-Z0-9._-]/g,'_').replace(/^\.+/,'').slice(-80) || 'attachment';
}

// Inspect bytes, not Telegram's user-supplied filename or MIME type.
export function imageExtension(bytes) {
  if (bytes.subarray(0,3).equals(Buffer.from([255,216,255]))) return 'jpg';
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii'))) return 'gif';
  if (bytes.subarray(0,4).toString('ascii')==='RIFF' && bytes.subarray(8,12).toString('ascii')==='WEBP') return 'webp';
  return null;
}
