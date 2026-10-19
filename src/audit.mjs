// Append-only JSONL audit log. Each entry carries the hash of the previous one, so an edited
// or deleted line breaks the chain. Truncating the tail needs an external anchor: the head hash.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, sha256 } from './policy.mjs';

export const GENESIS = '0'.repeat(64);

const entryHash = ({ seq, ts, type, requestId, data, prev }) => sha256(canonical({ seq, ts, type, requestId, data, prev }));

export function readEntries(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function verify(path) {
  if (!existsSync(path)) return { ok: true, count: 0, head: GENESIS };
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { return { ok: false, count: i, line: i + 1, reason: 'line is not valid JSON' }; }
    if (e.seq !== i + 1) return { ok: false, count: i, line: i + 1, reason: `expected seq ${i + 1}, found ${e.seq} (a line was removed or reordered)` };
    if (e.prev !== prev) return { ok: false, count: i, line: i + 1, reason: 'prev hash does not match the line before it' };
    if (entryHash(e) !== e.hash) return { ok: false, count: i, line: i + 1, reason: 'content does not match its hash (the line was edited)' };
    prev = e.hash;
  }
  return { ok: true, count: lines.length, head: prev };
}

export class AuditLog {
  constructor(path, now = () => new Date()) {
    this.path = path;
    this.now = now;
    mkdirSync(dirname(path), { recursive: true });
    const v = verify(path);
    // Refuse to extend a broken chain: new entries would launder the tampering.
    if (!v.ok) throw new Error(`audit log failed verification at line ${v.line}: ${v.reason}`);
    this.seq = v.count;
    this.head = v.head;
  }

  append(type, requestId, data) {
    const e = { seq: this.seq + 1, ts: this.now().toISOString(), type, requestId: requestId ?? null, data: data ?? {}, prev: this.head };
    e.hash = entryHash(e);
    const fd = openSync(this.path, 'a', 0o600);
    try { writeSync(fd, JSON.stringify(e) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    this.seq = e.seq;
    this.head = e.hash;
    return e;
  }
}
