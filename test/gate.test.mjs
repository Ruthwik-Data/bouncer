// Runs the real hook script as Claude Code would: payload on stdin, decision by exit code + stdout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBouncer, runGate, hookPayload, waitFor, SELF, TRUSTED, STRANGER } from './helpers.mjs';

const envFor = (s, extra = {}) => ({ BOUNCER_URL: s.base, BOUNCER_HOME: join(s.dir, 'home'), ...extra });
const pendingId = (s) => waitFor(() => [...s.b.store.requests.values()].find((r) => r.status === 'pending')?.id);

function assertBlocked(out) {
  assert.equal(out.code, 2, out.stderr);
  assert.equal(out.stdout, '', 'a blocked call prints nothing to stdout');
  assert.match(out.stderr, /^Bouncer blocked this Fo call/);
}

test('allow prints exactly the allow JSON and exits 0', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const out = await runGate(hookPayload(SELF), envFor(s));
  assert.equal(out.code, 0, out.stderr);
  const j = JSON.parse(out.stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal([...s.b.store.requests.values()][0].status, 'released');
});

test('deny exits 2 with the rule and reason', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const out = await runGate(hookPayload(STRANGER), envFor(s));
  assertBlocked(out);
  assert.match(out.stderr, /not on the allowlist/);
});

test('held then approved on the phone: allowed', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const phone = await s.pair();
  const pending = runGate(hookPayload(TRUSTED), envFor(s));
  const id = await pendingId(s);
  await phone.decide(id, 'approve', s.b.store.requests.get(id).hash);
  const out = await pending;
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, 'allow');
});

test('held then rejected: blocked', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const phone = await s.pair();
  const pending = runGate(hookPayload(TRUSTED), envFor(s));
  const id = await pendingId(s);
  await phone.decide(id, 'reject', s.b.store.requests.get(id).hash);
  const out = await pending;
  assertBlocked(out);
  assert.match(out.stderr, /rejected/);
});

test('held and nobody answers: blocked when it expires', async (t) => {
  const s = await startBouncer({ policy: { holdTimeoutSeconds: 1 } }); t.after(s.close);
  assertBlocked(await runGate(hookPayload(TRUSTED), envFor(s)));
});

test('gate deadline fires before Claude Code would kill the hook: blocked and marked expired', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const out = await runGate(hookPayload(TRUSTED), envFor(s, { BOUNCER_GATE_DEADLINE_MS: '800' }));
  assertBlocked(out);
  assert.match(out.stderr, /deadline/);
  assert.equal([...s.b.store.requests.values()][0].status, 'expired');
});

test('server down: blocked', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bouncer-home-'));
  const s = await startBouncer();
  const env = envFor(s);
  await s.close(); // token exists, server gone
  assertBlocked(await runGate(hookPayload(SELF), { ...env, BOUNCER_HOME: env.BOUNCER_HOME }));
  assertBlocked(await runGate(hookPayload(SELF), { BOUNCER_URL: 'http://127.0.0.1:9', BOUNCER_HOME: home }));
});

test('no gate token on disk: blocked', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  assertBlocked(await runGate(hookPayload(SELF), { BOUNCER_URL: s.base, BOUNCER_HOME: mkdtempSync(join(tmpdir(), 'empty-')) }));
});

test('garbage on stdin: blocked', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  assertBlocked(await runGate('not json {', envFor(s)));
});

test('audit write failure on the server: blocked', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  chmodSync(join(s.dir, 'data', 'audit.jsonl'), 0o400);
  t.after(() => chmodSync(join(s.dir, 'data', 'audit.jsonl'), 0o600));
  assertBlocked(await runGate(hookPayload(SELF), envFor(s)));
});

test('the settings wrapper turns a missing gate script into a block', () => {
  const r = spawnSync('/bin/sh', ['-c', 'node /nonexistent/gate.mjs || exit 2'], { input: '{}' });
  assert.equal(r.status, 2);
});
