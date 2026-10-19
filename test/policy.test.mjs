import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate, requestHash } from '../src/policy.mjs';

const policy = JSON.parse(readFileSync(new URL('../policy.json', import.meta.url)));
const ask = (message, extra = {}) => ({ toolName: 'mcp__fo__ask_fo', toolInput: { message, newConversation: true, ...extra } });
const run = (req, now = new Date('2026-10-18T15:00:00Z')) => evaluate(req, policy, now);

// [request, effect, ruleId]
const table = [
  [{ toolName: 'mcp__fo__list_fo_conversations', toolInput: {} }, 'allow', 'read-only'],
  [{ toolName: 'mcp__fo__get_fo_reply', toolInput: { conversationId: 'c1' } }, 'allow', 'read-only'],
  [{ toolName: 'mcp__fo__start_fo_call', toolInput: {} }, 'deny', 'denied-tool'],
  [{ toolName: 'mcp__fo__something_new', toolInput: {} }, 'deny', 'unknown-tool'],
  [{ toolName: 'mcp__fo__ask_fo', toolInput: {} }, 'deny', 'bad-input'],
  [{ toolName: 'mcp__fo__ask_fo', toolInput: { message: '   ' } }, 'deny', 'bad-input'],
  [ask('email you@example.com hi', { attachments: ['x'] }), 'deny', 'bad-input'],
  [ask('x'.repeat(4001)), 'deny', 'bad-input'],
  [ask('Email you@example.com my card 4111 1111 1111 1111'), 'deny', 'secret'],
  [ask('Email you@example.com my SSN 123-45-6789'), 'deny', 'secret'],
  [ask('Email you@example.com the key sk-ant-abc123def456ghi789'), 'deny', 'secret'],
  [ask('Buy me a coffee and email you@example.com'), 'deny', 'money'],
  [ask('Email you@example.com that the hotel costs $240'), 'deny', 'money'],
  [ask('Please order me a pizza'), 'deny', 'money'],
  [ask('Text +1 (813) 555-0142 that I am late'), 'deny', 'phone-number'],
  [ask('Email stranger@example.com a hello'), 'deny', 'outside-allowlist'],
  [ask('Email you@example.com and boss@corp.com the notes'), 'deny', 'outside-allowlist'],
  [ask('Yes, send it', { newConversation: undefined, conversationId: 'c1' }), 'hold', 'follow-up'],
  [ask('Email friend@example.com subject Hi'), 'hold', 'trusted-recipient'],
  [ask('Email YOU@example.com a reminder, then call my mom'), 'hold', 'self-plus-other-action'],
  [ask('Email you@example.com subject "Bouncer Test" body "hello"'), 'allow', 'self-email'],
  [ask('Remind Sam about lunch'), 'hold', 'no-known-recipient'],
  [ask('Email you@example.com and Sam the notes'), 'hold', 'possible-extra-recipient'],
  [ask('Email you@example.com and also email stranger at example dot com'), 'hold', 'possible-extra-recipient'],
  [ask('Send you@example.com a note, copy to my manager'), 'hold', 'possible-extra-recipient'],
  [ask('Email you@example.com and my wife the plan'), 'hold', 'possible-extra-recipient'],
  [ask('Email you [at] example [dot] com hi'), 'hold', 'no-known-recipient'],
  // verifier findings, 2026-10-18
  [{ toolName: 'mcp__fo__ask_fo', toolInput: { message: 'Yes, go ahead. Email you@example.com a confirmation' } }, 'hold', 'follow-up'],
  [ask('Email you@example.com and stranger\uFF20example.com hi'), 'deny', 'outside-allowlist'],
  [ask('Email you@example.com and stranger@exam\u200Bple.com hi'), 'deny', 'outside-allowlist'],
  [ask('Email you@example.com, cc stranger@example (dot) com'), 'hold', 'possible-extra-recipient'],
  [ask('Email you@example.com and bob\uFE6Bexample.com'), 'deny', 'outside-allowlist'],
  [ask('Email you@example.com my pass word: hunter2'), 'deny', 'secret'],
];

for (const [req, effect, ruleId] of table) {
  test(`${ruleId}: ${JSON.stringify(req.toolInput).slice(0, 60)}`, () => {
    const d = run(req);
    assert.equal(d.ruleId, ruleId, d.reason);
    assert.equal(d.effect, effect);
    assert.ok(d.reason.length > 10, 'every decision explains itself');
  });
}

test('"in order to" is not a purchase', () => {
  assert.equal(run(ask('Email you@example.com: in order to test, reply ok')).effect, 'allow');
});

test('quiet hours turn auto-allow into hold', () => {
  const p = { ...policy, quietHours: { start: 22, end: 7, timeZone: 'America/New_York' } };
  const d = evaluate(ask('Email you@example.com hi'), p, new Date('2026-10-18T03:00:00Z')); // 23:00 ET
  assert.equal(d.effect, 'hold');
  assert.equal(d.ruleId, 'quiet-hours');
  assert.equal(evaluate(ask('Email you@example.com hi'), p, new Date('2026-10-18T15:00:00Z')).effect, 'allow');
});

test('hash binds tool name and exact input, independent of key order', () => {
  const a = requestHash('mcp__fo__ask_fo', { message: 'hi', newConversation: true });
  const b = requestHash('mcp__fo__ask_fo', { newConversation: true, message: 'hi' });
  assert.equal(a, b);
  assert.notEqual(a, requestHash('mcp__fo__ask_fo', { message: 'hi ', newConversation: true }));
  assert.notEqual(a, requestHash('mcp__fo__get_fo_reply', { message: 'hi', newConversation: true }));
  assert.match(a, /^[0-9a-f]{64}$/);
});
