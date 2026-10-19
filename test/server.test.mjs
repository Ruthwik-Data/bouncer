import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startBouncer, SELF, TRUSTED, STRANGER, waitFor } from './helpers.mjs';
import { verify } from '../src/audit.mjs';
import { createBouncer } from '../src/server.mjs';

const types = (t, id) => t.b.store.requests.get(id).events.map((e) => e.type);

test('a denied request can never be released', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const r = (await s.submit(STRANGER)).json;
  assert.equal(r.effect, 'deny');
  assert.equal(r.ruleId, 'outside-allowlist');
  const rel = await s.gate('POST', `/gate/requests/${r.id}/release`, { hash: r.hash });
  assert.equal(rel.status, 409);
  assert.equal(s.b.store.requests.get(r.id).status, 'denied');
  assert.deepEqual(types(s, r.id), ['request.received', 'policy.decided', 'release.refused'], 'the refused attempt is itself audited');
});

test('an auto-allowed request is released exactly once', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const r = (await s.submit(SELF)).json;
  assert.equal(r.effect, 'allow');
  assert.equal((await s.gate('POST', `/gate/requests/${r.id}/release`, { hash: r.hash })).status, 200);
  assert.equal((await s.gate('POST', `/gate/requests/${r.id}/release`, { hash: r.hash })).status, 409, 'replayed release refused');
});

test('held request: approval binds to the hash, is single-use, and releases once', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const phone = await s.pair();
  const r = (await s.submit(TRUSTED)).json;
  assert.equal(r.effect, 'hold');
  assert.equal((await s.gate('POST', `/gate/requests/${r.id}/release`, { hash: r.hash })).status, 409, 'no release before approval');
  assert.equal((await phone.decide(r.id, 'approve', 'f'.repeat(64))).status, 409, 'approval for different content refused');
  assert.equal((await phone.decide(r.id, 'approve', r.hash)).status, 200);
  assert.equal((await phone.decide(r.id, 'approve', r.hash)).status, 409, 'replayed approval refused');
  assert.equal((await phone.decide(r.id, 'reject', r.hash)).status, 409, 'cannot flip a decision');
  assert.equal((await s.gate('POST', `/gate/requests/${r.id}/release`, { hash: 'a'.repeat(64) })).status, 409, 'release with a different call refused');
  assert.equal((await s.gate('POST', `/gate/requests/${r.id}/release`, { hash: r.hash })).status, 200);
  assert.equal((await s.gate('POST', `/gate/requests/${r.id}/release`, { hash: r.hash })).status, 409, 'replayed release refused');
  const req = s.b.store.requests.get(r.id);
  assert.equal(req.decision.by, 'iPhone');
  assert.equal(types(s, r.id).filter((x) => x === 'approval.refused').length, 3);
});

test('rejected request is never released', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const phone = await s.pair();
  const r = (await s.submit(TRUSTED)).json;
  assert.equal((await phone.decide(r.id, 'reject', r.hash)).status, 200);
  assert.equal((await s.gate('POST', `/gate/requests/${r.id}/release`, { hash: r.hash })).status, 409);
  assert.equal(s.b.store.requests.get(r.id).status, 'rejected');
});

test('held request expires, then cannot be approved or released', async (t) => {
  const s = await startBouncer({ policy: { holdTimeoutSeconds: 1 } }); t.after(s.close);
  const phone = await s.pair();
  const r = (await s.submit(TRUSTED)).json;
  await waitFor(() => s.b.store.requests.get(r.id).status === 'expired', 3000);
  assert.equal((await phone.decide(r.id, 'approve', r.hash)).status, 409);
  assert.equal((await s.gate('POST', `/gate/requests/${r.id}/release`, { hash: r.hash })).status, 409);
});

test('long-poll returns as soon as a decision lands', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const phone = await s.pair();
  const r = (await s.submit(TRUSTED)).json;
  const started = Date.now();
  const poll = s.gate('GET', `/gate/requests/${r.id}?wait=10`);
  setTimeout(() => phone.decide(r.id, 'approve', r.hash), 150);
  const p = await poll;
  assert.equal(p.json.status, 'approved');
  assert.ok(Date.now() - started < 3000);
});

test('approver API: unpaired, cross-origin and missing CSRF are refused', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const phone = await s.pair();
  const r = (await s.submit(TRUSTED)).json;
  assert.equal((await fetch(`${s.base}/api/state`)).status, 401);
  const noSession = await fetch(`${s.base}/api/requests/${r.id}/decision`, { method: 'POST', headers: { origin: s.base, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve', hash: r.hash }) });
  assert.equal(noSession.status, 401);
  const path = `/api/requests/${r.id}/decision`;
  assert.equal((await phone.post(path, { decision: 'approve', hash: r.hash }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await phone.post(path, { decision: 'approve', hash: r.hash }, { 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal(s.b.store.requests.get(r.id).status, 'pending');
});

test('pairing links are single use', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const code = s.b.issuePairCode();
  assert.equal((await fetch(`${s.base}/pair/${code}`, { redirect: 'manual' })).status, 303);
  assert.equal((await fetch(`${s.base}/pair/${code}`, { redirect: 'manual' })).status, 403);
});

test('gate API needs the gate token', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  assert.equal((await s.gate('POST', '/gate/requests', { toolName: 'mcp__fo__ask_fo', toolInput: { message: SELF } }, 'wrong')).status, 401);
  assert.equal((await s.gate('GET', '/gate/health', undefined, '')).status, 401);
  assert.equal(s.b.store.requests.size, 0);
});

test('unknown Host header is refused (DNS rebinding)', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: s.port, path: '/api/state', headers: { host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 421);
});

test('results attach only to released requests', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const toolUseId = 'toolu_released';
  const r = (await s.submit(SELF, { toolUseId })).json;
  await s.gate('POST', `/gate/requests/${r.id}/release`, { hash: r.hash });
  const response = [{ type: 'text', text: JSON.stringify({ status: 'complete', conversationId: 'conv_1', response: 'Sent.' }) }];
  await s.gate('POST', '/gate/results', { toolUseId, event: 'PostToolUse', response });
  const req = s.b.store.requests.get(r.id);
  assert.equal(req.status, 'completed');
  assert.equal(req.result.foStatus, 'complete');
  assert.equal(req.result.conversationId, 'conv_1');

  const d = (await s.submit(STRANGER, { toolUseId: 'toolu_denied' })).json;
  await s.gate('POST', '/gate/results', { toolUseId: 'toolu_denied', event: 'PostToolUse', response });
  assert.equal(s.b.store.requests.get(d.id).status, 'denied', 'a result never upgrades a blocked request');

  const f = (await s.submit(SELF, { toolUseId: 'toolu_fail' })).json;
  await s.gate('POST', `/gate/requests/${f.id}/release`, { hash: f.hash });
  await s.gate('POST', '/gate/results', { toolUseId: 'toolu_fail', event: 'PostToolUseFailure', error: 'MCP error: needs sign in' });
  assert.equal(s.b.store.requests.get(f.id).status, 'failed');
});

test('restart keeps history, verifies the chain, and blocks anything left waiting', async (t) => {
  const s = await startBouncer();
  const held = (await s.submit(TRUSTED)).json;
  const denied = (await s.submit(STRANGER)).json;
  await s.close();
  const again = await startBouncer({ dir: s.dir }); t.after(again.close);
  assert.equal(again.b.store.requests.get(held.id).status, 'expired');
  assert.match(again.b.store.requests.get(held.id).expiredReason, /restarted/);
  assert.equal(again.b.store.requests.get(denied.id).status, 'denied');
  assert.equal(verify(join(s.dir, 'data', 'audit.jsonl')).ok, true);
});

test('an edited audit line fails verification and the server refuses to start on it', async () => {
  const s = await startBouncer();
  await s.submit(STRANGER);
  await s.close();
  const path = join(s.dir, 'data', 'audit.jsonl');
  const lines = readFileSync(path, 'utf8').split('\n');
  lines[2] = lines[2].replace('"deny"', '"allow"');
  writeFileSync(path, lines.join('\n'));
  const v = verify(path);
  assert.equal(v.ok, false);
  assert.equal(v.line, 3);
  assert.throws(() => createBouncer({ dataDir: join(s.dir, 'data'), homeDir: join(s.dir, 'home'), policy: {}, port: 0 }), /failed verification/);
});

test('a deleted audit line fails verification', async () => {
  const s = await startBouncer();
  await s.submit(STRANGER);
  await s.close();
  const path = join(s.dir, 'data', 'audit.jsonl');
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.splice(1, 1);
  writeFileSync(path, lines.join('\n'));
  assert.equal(verify(path).ok, false);
});

test('if the audit log cannot be written, the request fails with a 5xx', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  chmodSync(join(s.dir, 'data', 'audit.jsonl'), 0o400);
  t.after(() => chmodSync(join(s.dir, 'data', 'audit.jsonl'), 0o600));
  const res = await s.submit(SELF);
  assert.equal(res.status, 500);
});

test('short pairing codes: single use, case-insensitive, and 5 failures cancel every outstanding code', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const code = s.b.issueShortPairCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal((await fetch(`${s.base}/p/${code.toLowerCase().replace('-', '')}`, { redirect: 'manual' })).status, 303);
  assert.equal((await fetch(`${s.base}/p/${code}`, { redirect: 'manual' })).status, 403, 'single use');

  const live = s.b.issueShortPairCode();
  const longLive = s.b.issuePairCode();
  for (let i = 0; i < 5; i++) assert.equal((await fetch(`${s.base}/p/AAAA-AAAA`, { redirect: 'manual' })).status, 403);
  assert.equal((await fetch(`${s.base}/p/${live}`, { redirect: 'manual' })).status, 403, 'guessing burned the live short code');
  assert.equal((await fetch(`${s.base}/pair/${longLive}`, { redirect: 'manual' })).status, 403, 'and the long one');
});

test('independent checks are separate from the lifecycle and only attach to known requests', async (t) => {
  const s = await startBouncer(); t.after(s.close);
  const phone = await s.pair();
  const r = (await s.submit(SELF)).json;
  const check = { outcome: 'confirmed', by: 'Rello', method: 'inbox check', checkedAt: '2026-10-18T08:40Z', detail: 'arrived' };
  writeFileSync(join(s.dir, 'data', 'verifications.json'), JSON.stringify({
    [r.id]: check, req_000000000000: check, [`${r.id}x`]: check,
  }));
  const state = await (await fetch(`${s.base}/api/state`, { headers: { cookie: phone.cookie } })).json();
  assert.deepEqual(Object.keys(state.verifications), [r.id]);
  assert.equal(state.verifications[r.id].outcome, 'confirmed');
  assert.equal(s.b.store.requests.get(r.id).status, 'allowed', 'a recorded check never changes the request lifecycle');
  writeFileSync(join(s.dir, 'data', 'verifications.json'), '{not json');
  const broken = await (await fetch(`${s.base}/api/state`, { headers: { cookie: phone.cookie } })).json();
  assert.deepEqual(broken.verifications, {});
});
