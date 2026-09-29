export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const VOICE_MAX_BYTES = 4 * 1024 * 1024;
export const VOICE_MAX_SECONDS = 180;
export function voiceLimitError(voice) {
  return voice?.duration > VOICE_MAX_SECONDS || voice?.file_size > VOICE_MAX_BYTES
    ? 'Please send a voice message under 3 minutes and 4 MB.' : null;
}

export function config(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_ID', 'DATABASE_URL', 'LIZARD_API_KEY', 'LIZARD_PROJECT_ID'];
  for (const key of required) if (!env[key]) throw new Error(`Missing ${key}`);
  const owner = Number(env.TELEGRAM_OWNER_ID);
  const chat = Number(env.TELEGRAM_CHAT_ID || owner);
  if (!Number.isSafeInteger(owner) || owner <= 0 || !Number.isSafeInteger(chat) || !chat) throw new Error('Invalid Telegram IDs');
  if (chat !== owner) throw new Error('Multi-user mode requires private Telegram chats');
  const role = env.BOT_ROLE || 'all';
  if (!['all', 'gateway', 'worker'].includes(role)) throw new Error('Invalid BOT_ROLE');
  return {
    token: env.TELEGRAM_BOT_TOKEN, owner, chat, database: env.DATABASE_URL,
    project: env.LIZARD_PROJECT_ID, apiKey: env.LIZARD_API_KEY,
    apiUrl: env.LIZARD_API_URL || 'https://lizard.build',
    volume: env.LIZARD_VOLUME_NAME || 'codex-personal', sizeGb: Number(env.LIZARD_VOLUME_SIZE_GB || 10),
    template: env.LIZARD_TEMPLATE || 'codex', model: env.CODEX_MODEL || undefined,
    openaiKey: env.OPENAI_API_KEY, openrouterKey: env.OPENROUTER_API_KEY, port: Number(env.PORT || 3000),
    miniAppUrl: env.TELEGRAM_MINI_APP_URL || (role !== 'worker' && env.LIZARD_PUBLIC_DOMAIN ? `https://${env.LIZARD_PUBLIC_DOMAIN}/settings` : undefined),
    role, idleMs: integer('SANDBOX_IDLE_MINUTES', 30, 1, 10080) * 60000,
    managedAccounts: env.LIZARD_MANAGED_ACCOUNTS === 'true',
    tenantCredentialKey: env.TENANT_CREDENTIAL_KEY,
    provisionerKey: env.LIZARD_PROVISIONER_KEY,
    maxSandboxes: integer('MAX_ACTIVE_SANDBOXES', 10, 1, 1000),
    workerSlots: integer('WORKER_SLOTS', 10, 1, 100),
    maxUsers: integer('MAX_APPROVED_USERS', 100, 1, 100000),
    maxSessions: integer('MAX_SESSIONS_PER_USER', 20, 1, 1000),
    maxQueued: integer('MAX_QUEUED_PER_USER', 20, 1, 1000),
    maxTurns: integer('MAX_ACTIVE_TURNS_PER_USER', 2, 1, 10),
    ratePerMinute: integer('USER_MESSAGES_PER_MINUTE', 20, 1, 1000),
    tenantSizeGb: integer('TENANT_VOLUME_SIZE_GB', 2, 1, 100),
    sandboxLifetimeMs: integer('SANDBOX_LEASE_MINUTES', 120, 30, 1440) * 60000,
    maxTaskMs: integer('MAX_TASK_MINUTES', 240, 5, 10080) * 60000,
    approvalWaitMs: integer('APPROVAL_WAIT_MINUTES', 60, 5, 1440) * 60000,
  };
}

export function privateUser(update) {
  if (update.stopped_message_generation) {
    const s=update.stopped_message_generation;
    return s.chat?.type === 'private' && Number.isSafeInteger(s.chat.id) && s.chat.id>0 ? s.chat.id : null;
  }
  const message = update.message ?? update.callback_query?.message;
  const user = update.callback_query?.from ?? update.message?.from;
  return message?.chat?.type === 'private' && !user?.is_bot && Number.isSafeInteger(user?.id)
    && user.id > 0 && message.chat.id === user.id ? user.id : null;
}

export function authorized(update, cfg) {
  if (update.stopped_message_generation) return privateUser(update) === cfg.owner && update.stopped_message_generation.chat.id === cfg.chat;
  const message = update.message ?? update.callback_query?.message;
  const user = update.callback_query?.from ?? update.message?.from;
  // Anonymous admins and forwarded bot messages cannot act as the owner.
  if(cfg.groupOwner) return update.group_authorized===true && !!message && !message.sender_chat
    && !user?.is_bot && Number.isSafeInteger(user?.id) && user.id>0 && message.chat.id===cfg.chat
    && ['group','supergroup'].includes(message.chat.type);
  return !!message && !user?.is_bot && user?.id === cfg.owner && message.chat.id === cfg.chat;
}

export function chunks(text, limit = 3800) {
  const result = [];
  let part = '';
  for (const character of String(text)) {
    if (part.length + character.length > limit) { result.push(part); part = ''; }
    part += character;
  }
  if (part) result.push(part);
  return result;
}

export function topicTitle(text) {
  const clean = text.replace(/\s+/gu, ' ').trim();
  if (Array.from(clean).length <= 32) return clean;
  let prefix = Array.from(clean).slice(0, 31).join('').trimEnd();
  const boundary = prefix.lastIndexOf(' ');
  if (boundary >= 16) prefix = prefix.slice(0, boundary);
  return `${prefix}…`;
}

export function command(text = '') {
  const match = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1].toLowerCase(), argument: match[2]?.trim() || '' } : null;
}

export function approvalResult(method, params, accepted) {
  if (method === 'item/permissions/requestApproval') return { permissions: accepted ? params.permissions : {}, scope: 'turn' };
  if (method === 'mcpServer/elicitation/request') return { action: accepted ? 'accept' : 'decline', content: null };
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) return { decision: accepted ? 'accept' : 'decline' };
  throw new Error('Unsupported approval');
}
