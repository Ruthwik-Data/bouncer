import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { startBouncer, SELF, STRANGER, TRUSTED } from './helpers.mjs';

const CLI = new URL('../bin/bouncer.mjs', import.meta.url).pathname;
const cli = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, BOUNCER_DATA: join(dir, 'data') }, encoding: 'utf8' });

test('trace, stats and verify read a mixed audit log', async () => {
  const s = await startBouncer();
  const phone = await s.pair();
  const a = (await s.submit(SELF, { toolUseId: 'toolu_a' })).json;
  await s.gate('POST', `/gate/requests/${a.id}/release`, { hash: a.hash });
  await s.gate('POST', '/gate/results', { toolUseId: 'toolu_a', event: 'PostToolUse', response: [{ type: 'text', text: '{"status":"complete"}' }] });
  await s.submit(STRANGER);
  const h = (await s.submit(TRUSTED)).json;
  await phone.decide(h.id, 'reject', h.hash);
  await s.close();
  const t = cli(s.dir, 'trace');
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /3 Fo calls gated · 1 auto-allowed · 1 held for a human \(0 approved, 1 rejected, 0 expired\) · 1 denied/);
  assert.match(t.stdout, /policy DENY: Recipient outside allowlist/);
  assert.match(t.stdout, /rejected by iPhone/);
  assert.equal(JSON.parse(cli(s.dir, 'stats').stdout).reachedFo, 1);
  assert.equal(cli(s.dir, 'verify').status, 0);
  assert.equal(JSON.parse(cli(s.dir, 'trace', '--json').stdout).chain.ok, true);
});
