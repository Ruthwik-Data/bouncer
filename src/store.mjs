// Request state machine. Every change is written to the audit log first, then applied, and the
// same apply() rebuilds state from the log on restart. The audit log is the only source of truth.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { evaluate, requestHash } from './policy.mjs';
import { readEntries } from './audit.mjs';

const MAX_TEXT = 20000;
export const OPEN = new Set(['pending']);
const RELEASABLE = new Set(['allowed', 'approved']);

export class Store extends EventEmitter {
  constructor(audit, policy, now = () => new Date()) {
    super();
    this.audit = audit;
    this.policy = policy;
    this.now = now;
    this.requests = new Map();
    this.byToolUse = new Map();
    this.recent = [];
    for (const e of readEntries(audit.path)) this.apply(e);
    this.record('server.started', null, { entriesReplayed: audit.seq });
    for (const r of this.requests.values()) {
      if (OPEN.has(r.status) || RELEASABLE.has(r.status)) {
        this.record('request.expired', r.id, { reason: 'Bouncer restarted. The hook that was waiting had already failed closed, so this call was blocked.' });
      }
    }
  }

  record(type, requestId, data) {
    const e = this.audit.append(type, requestId, data);
    this.apply(e);
    this.emit('change', e);
    return e;
  }

  apply(e) {
    this.recent.push(e);
    if (this.recent.length > 500) this.recent.shift();
    const r = e.requestId && this.requests.get(e.requestId);
    const d = e.data;
    switch (e.type) {
      case 'request.received': {
        const req = { id: e.requestId, createdAt: e.ts, toolName: d.toolName, toolInput: d.toolInput, hash: d.hash,
          toolUseId: d.toolUseId, sessionId: d.sessionId, status: 'received', events: [] };
        this.requests.set(req.id, req);
        if (d.toolUseId) this.byToolUse.set(d.toolUseId, req.id);
        break;
      }
      case 'policy.decided':
        r.policy = { effect: d.effect, ruleId: d.ruleId, rule: d.rule, reason: d.reason, facts: d.facts };
        r.status = { allow: 'allowed', deny: 'denied', hold: 'pending' }[d.effect];
        r.expiresAt = d.expiresAt ?? null;
        break;
      case 'approval.decided':
        r.status = d.decision; // approved | rejected
        r.decision = { decision: d.decision, by: d.by, at: e.ts };
        break;
      case 'request.expired': r.status = 'expired'; r.expiredReason = d.reason; break;
      case 'release.granted': r.status = 'released'; r.releasedAt = e.ts; break;
      case 'result.recorded':
        r.status = d.ok ? 'completed' : 'failed';
        r.result = { ok: d.ok, foStatus: d.foStatus, conversationId: d.conversationId, text: d.text, error: d.error, at: e.ts };
        break;
    }
    const target = e.requestId && this.requests.get(e.requestId); // re-read: request.received creates it
    if (target) target.events.push({ seq: e.seq, ts: e.ts, type: e.type, data: d });
  }

  // ---- operations used by the gate ----

  submit({ toolName, toolInput, toolUseId, sessionId }) {
    const id = `req_${randomBytes(6).toString('hex')}`;
    const hash = requestHash(toolName, toolInput);
    this.record('request.received', id, { toolName, toolInput: toolInput ?? {}, hash, toolUseId: toolUseId ?? null, sessionId: sessionId ?? null });
    const decision = evaluate({ toolName, toolInput }, this.policy, this.now());
    const expiresAt = decision.effect === 'hold'
      ? new Date(this.now().getTime() + this.policy.holdTimeoutSeconds * 1000).toISOString() : undefined;
    this.record('policy.decided', id, { ...decision, expiresAt });
    return this.requests.get(id);
  }

  release(id, hash) {
    const r = this.requests.get(id);
    if (!r) return { ok: false, reason: 'unknown request' };
    this.expireDue();
    if (!RELEASABLE.has(r.status)) {
      this.record('release.refused', id, { reason: `status is ${r.status}`, hash });
      return { ok: false, reason: `request is ${r.status}` };
    }
    if (hash !== r.hash) {
      this.record('release.refused', id, { reason: 'hash mismatch: the call differs from what was evaluated', hash });
      return { ok: false, reason: 'hash mismatch' };
    }
    this.record('release.granted', id, { hash, via: r.decision ? 'human approval' : 'policy' });
    return { ok: true };
  }

  abandon(id, reason) {
    const r = this.requests.get(id);
    if (r && (OPEN.has(r.status) || RELEASABLE.has(r.status))) this.record('request.expired', id, { reason });
  }

  result({ toolUseId, event, response, error }) {
    const id = this.byToolUse.get(toolUseId);
    const r = id && this.requests.get(id);
    if (!r || r.status !== 'released') {
      this.record('result.orphan', id ?? null, { toolUseId, event, status: r?.status ?? 'unknown' });
      return;
    }
    const parsed = parseFoResponse(response);
    const ok = event === 'PostToolUse' && !parsed.isError && parsed.foStatus !== 'failed';
    this.record('result.recorded', id, { ok, event, foStatus: parsed.foStatus, conversationId: parsed.conversationId,
      text: parsed.text?.slice(0, MAX_TEXT) ?? null, error: error ? String(error).slice(0, 2000) : null });
  }

  // ---- operations used by the approver ----

  decide(id, decision, hash, by) {
    const r = this.requests.get(id);
    if (!r) return { ok: false, code: 404, reason: 'unknown request' };
    this.expireDue();
    const refuse = (code, reason) => { this.record('approval.refused', id, { attempted: decision, by, reason }); return { ok: false, code, reason }; };
    if (r.status !== 'pending') return refuse(409, `already ${r.status}; a decision can only be made once`);
    if (hash !== r.hash) return refuse(409, 'the request changed since you looked at it');
    this.record('approval.decided', id, { decision, by, hash });
    return { ok: true };
  }

  expireDue() {
    const now = this.now().getTime();
    for (const r of this.requests.values()) {
      if (r.status === 'pending' && r.expiresAt && Date.parse(r.expiresAt) <= now) {
        this.record('request.expired', r.id, { reason: `No decision within ${this.policy.holdTimeoutSeconds}s. Expired requests are blocked.` });
      }
    }
  }
}

// Fo's MCP replies arrive as content blocks whose text is usually JSON. Keep the raw text either way.
export function parseFoResponse(response) {
  let text = null;
  let isError = false;
  if (typeof response === 'string') text = response;
  else if (Array.isArray(response)) text = response.map((b) => b?.text ?? '').join('\n');
  else if (response && typeof response === 'object') {
    isError = response.isError === true;
    if (Array.isArray(response.content)) text = response.content.map((b) => b?.text ?? '').join('\n');
    else text = JSON.stringify(response);
  }
  let foStatus = null;
  let conversationId = null;
  try {
    const j = JSON.parse(text);
    foStatus = typeof j.status === 'string' ? j.status : null;
    conversationId = j.conversationId ?? null;
  } catch {
    const m = text?.match(/"?status"?\s*[:=]\s*"?(complete|working|failed)/i);
    if (m) foStatus = m[1].toLowerCase();
  }
  return { text, isError, foStatus, conversationId };
}
