import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createBouncer } from '../src/server.mjs';

export const basePolicy = JSON.parse(readFileSync(new URL('../policy.json', import.meta.url)));
export const GATE = new URL('../bin/gate.mjs', import.meta.url).pathname;

export const SELF = 'Email you@example.com subject "Bouncer Test" body "hello"';
export const TRUSTED = 'Email friend@example.com subject "Hi" body "from Bouncer"';
export const STRANGER = 'Email stranger@example.com a hello';

export async function startBouncer({ dir = mkdtempSync(join(tmpdir(), 'bouncer-test-')), policy = {} } = {}) {
  const b = createBouncer({ dataDir: join(dir, 'data'), homeDir: join(dir, 'home'), policy: { ...basePolicy, ...policy }, port: 0 });
  const port = await b.listen();
  const base = `http://127.0.0.1:${port}`;
  const gate = async (method, path, body, token = b.gateToken) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-bouncer-gate': token }, body: body && JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const submit = (message, extra = {}) => gate('POST', '/gate/requests', { toolName: 'mcp__fo__ask_fo', toolInput: { message, newConversation: true }, toolUseId: `toolu_${Math.random().toString(36).slice(2)}`, ...extra });
  async function pair() {
    const res = await fetch(`${base}/pair/${b.issuePairCode()}`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    const post = async (path, body, headers = {}) => {
      const r = await fetch(base + path, { method: 'POST', headers: { cookie, origin: base, 'x-csrf-token': state.csrf, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    };
    const decide = (id, decision, hash) => post(`/api/requests/${id}/decision`, { decision, hash });
    return { cookie, csrf: state.csrf, post, decide };
  }
  return { b, dir, base, port, gate, submit, pair, close: () => b.close() };
}

export function runGate(payload, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE], { env: { ...process.env, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

export const hookPayload = (message, extra = {}) => ({
  session_id: 'test-session', hook_event_name: 'PreToolUse', tool_name: 'mcp__fo__ask_fo',
  tool_input: { message, newConversation: true }, tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`, ...extra,
});

export async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('waitFor timed out');
}
