// Deterministic policy for Fo-bound tool calls. First matching rule wins; no LLM involved.
import { createHash } from 'node:crypto';

export const RULES = {
  'read-only': 'Read-only Fo tool',
  'denied-tool': 'Tool is never allowed',
  'unknown-tool': 'Unknown Fo tool',
  'bad-input': 'Malformed request',
  secret: 'Sensitive data in message',
  money: 'Spending or payment',
  'phone-number': 'Phone number in message',
  'outside-allowlist': 'Recipient outside allowlist',
  'follow-up': 'Reply inside an existing Fo conversation',
  'trusted-recipient': 'Email to a trusted address',
  'possible-extra-recipient': 'Self email that may reach someone else',
  'self-plus-other-action': 'Self email bundled with another action',
  'quiet-hours': 'Quiet hours',
  'self-email': 'Email to yourself only',
  'no-known-recipient': 'No allowlisted recipient found',
};

const decide = (effect, ruleId, reason, facts = {}) => ({ effect, ruleId, rule: RULES[ruleId], reason, facts });

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const SECRET_RES = [
  [/\b\d{3}-\d{2}-\d{4}\b/, 'a US Social Security number'],
  [/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/, 'an API key or token'],
  [/\b(pass\s*word|passcode|pwd|pin|otp|2fa code)\s*(is|:|=)/i, 'a password or one-time code'],
];

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function findCard(text) {
  for (const m of text.matchAll(/\b\d(?:[ -]?\d){12,18}\b/g)) {
    if (luhn(m[0].replace(/\D/g, ''))) return true;
  }
  return false;
}

function findPhone(text) {
  for (const m of text.matchAll(/\+?\(?\d[\d\s().-]{7,}\d/g)) {
    const n = m[0].replace(/\D/g, '').length;
    if (n >= 10 && n <= 15) return m[0].trim();
  }
  return null;
}

function hourIn(now, timeZone) {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now));
}

function inQuietHours(q, now) {
  if (!q) return false;
  const h = hourIn(now, q.timeZone);
  return q.start > q.end ? h >= q.start || h < q.end : h >= q.start && h < q.end;
}

// Patterns are case-insensitive unless prefixed with "case:" (needed to spot capitalised names).
const anyMatch = (patterns = [], text) => patterns.some((p) => (p.startsWith('case:') ? new RegExp(p.slice(5)) : new RegExp(p, 'i')).test(text));

export function evaluate({ toolName, toolInput }, policy, now = new Date()) {
  if (policy.readOnlyTools.includes(toolName)) {
    return decide('allow', 'read-only', `${toolName.replace('mcp__fo__', '')} only reads Fo data and changes nothing. Allowed and logged.`);
  }
  if (policy.deniedTools[toolName]) return decide('deny', 'denied-tool', policy.deniedTools[toolName]);
  if (toolName !== policy.askTool) {
    return decide('deny', 'unknown-tool', `Bouncer has no rule for ${toolName}. Unknown tools are blocked until a rule is written.`);
  }

  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const extra = Object.keys(input).filter((k) => !policy.askInputKeys.includes(k));
  if (extra.length) return decide('deny', 'bad-input', `Unexpected field(s) ${extra.join(', ')}. The Fo schema changed or the call was tampered with.`);
  if (typeof input.message !== 'string' || !input.message.trim()) return decide('deny', 'bad-input', 'The request has no message for Fo.');
  // Match on a normalised copy: full-width ＠ becomes @, and invisible characters can't split an address.
  const message = input.message.normalize('NFKC').replace(/[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '');
  if (input.message.length > policy.maxMessageChars) {
    return decide('deny', 'bad-input', `Message is ${input.message.length} characters; the limit is ${policy.maxMessageChars}. Long messages are hard to review.`);
  }

  if (findCard(message)) return decide('deny', 'secret', 'The message contains what looks like a payment card number. Bouncer never forwards card numbers to Fo.');
  for (const [re, what] of SECRET_RES) {
    if (re.test(message)) return decide('deny', 'secret', `The message contains ${what}. Bouncer never forwards secrets to Fo.`);
  }
  if (anyMatch(policy.moneyPatterns, message.replace(/\bin order to\b/gi, ''))) {
    return decide('deny', 'money', 'The message mentions buying, paying or a price. Agents can’t spend money through Bouncer.');
  }
  const phone = findPhone(message);
  if (phone) return decide('deny', 'phone-number', `The message includes a phone number (${phone}). Calls and texts to numbers can’t be checked against the allowlist.`, { phone });

  const matches = message.match(EMAIL_RE) || [];
  const recipients = [...new Set(matches.map((e) => e.toLowerCase()))];
  const self = policy.self.map((e) => e.toLowerCase());
  const trusted = policy.trusted.map((e) => e.toLowerCase());
  const outsiders = recipients.filter((r) => !self.includes(r) && !trusted.includes(r));
  const facts = { recipients };
  if (outsiders.length) {
    return decide('deny', 'outside-allowlist', `${outsiders.join(', ')} ${outsiders.length > 1 ? 'are' : 'is'} not on the allowlist. Only your own and trusted addresses can be contacted.`, { ...facts, outsiders });
  }

  // Fo continues the current conversation unless told otherwise, so anything not explicitly new is a follow-up.
  if (input.newConversation !== true) {
    return decide('hold', 'follow-up', 'This continues an existing Fo conversation. Short replies like “yes, send it” can confirm an action, so you decide.', facts);
  }
  if ((message.match(/@/g) || []).length > matches.length) {
    return decide('hold', 'possible-extra-recipient', 'The message has an @ that isn’t part of a complete address, so it may reach someone not on the allowlist. You decide.', facts);
  }
  if (recipients.some((r) => trusted.includes(r))) {
    return decide('hold', 'trusted-recipient', 'The recipient is on your trusted list but isn’t you. Mail to other people always needs your approval.', facts);
  }
  if (recipients.length) {
    // Heuristic, and it only ever moves a call toward a human: text can name people without an address.
    if (anyMatch(policy.extraRecipientPatterns, message)) {
      return decide('hold', 'possible-extra-recipient', 'You are the only address listed, but the wording may name someone else (a name, “my manager”, an address spelled out). You decide.', facts);
    }
    if (anyMatch(policy.otherActionPatterns, message)) {
      return decide('hold', 'self-plus-other-action', 'The only recipient is you, but the message also asks for something else (a call, text, invite or forward). You decide.', facts);
    }
    if (inQuietHours(policy.quietHours, now)) {
      return decide('hold', 'quiet-hours', 'Normally auto-allowed, but it’s quiet hours, so it waits for you.', facts);
    }
    return decide('allow', 'self-email', 'An email to your own address only, with no other action, money or secrets. Auto-allowed and logged.', facts);
  }
  return decide('hold', 'no-known-recipient', 'No allowlisted address in the message, so Bouncer can’t tell who it reaches. You decide.', facts);
}

// Canonical JSON: sorted keys, undefined dropped. The hash binds an approval to the exact call.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const requestHash = (toolName, toolInput) => sha256(canonical({ toolName, toolInput: toolInput ?? {} }));
