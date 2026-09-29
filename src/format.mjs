// Convert common Codex Markdown to Telegram entities, without an HTML parse mode.
export function formatMarkdown(source) {
  let text = ''; const entities = []; let cursor = 0;
  const pattern = /```([^\n`]*)\n([\s\S]*?)```|`([^`\n]+)`|\*\*([\s\S]+?)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  for (const match of source.matchAll(pattern)) {
    text += source.slice(cursor, match.index);
    const content = match[2] ?? match[3] ?? match[4] ?? match[5];
    const type = match[2] !== undefined ? 'pre' : match[3] !== undefined ? 'code' : match[4] !== undefined ? 'bold' : 'text_link';
    const entity = { type, offset: text.length, length: content.length };
    if (type === 'pre' && /^[\w+-]+$/.test(match[1])) entity.language = match[1];
    if (type === 'text_link') entity.url = match[6];
    if (content) entities.push(entity);
    text += content; cursor = match.index + match[0].length;
  }
  text += source.slice(cursor);
  // Device codes should be tappable/copyable even when the model used bold.
  let copyCode;
  if (source.includes('https://github.com/login/device')) {
    const code = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
    if (code) {
      copyCode = code[0];
      const overlapping = entities.filter(e => e.offset < code.index + code[0].length && e.offset + e.length > code.index);
      for (const e of overlapping) entities.splice(entities.indexOf(e), 1);
      entities.push({ type: 'code', offset: code.index, length: code[0].length });
    }
  }
  return { text, entities, copyCode };
}
