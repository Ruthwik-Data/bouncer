# Bouncer

An approval gate between an AI agent and [Wajo Fo](https://wajo.ai), which takes real-world actions:
email, calls and purchases. Before any Fo tool call leaves Claude Code, Bouncer checks it against
deterministic rules. It lets it through, blocks it, or holds it until you approve it on your phone.
Every step goes into a hash-chained audit log.

```
Claude Code agent ──mcp__fo__*──▶ PreToolUse hook (bin/gate.mjs) ──▶ Bouncer server (127.0.0.1 + Tailscale)
        ▲                               │ allow only after a one-time,            │ policy · approvals · audit log
        │                               │ hash-bound release; else exit 2         ▼
        └── Fo result ◀── Fo MCP ◀──────┘                        dashboard / iPhone approval card
                    PostToolUse hook (bin/post.mjs) records what Fo reported
```

**Demo:** [`submission/bouncer-demo-narrated.mp4`](submission/bouncer-demo-narrated.mp4) (84 s, narrated; silent version `bouncer-demo.mp4`). It's a captioned walkthrough of the real
dashboard and audit log from live runs on Oct 18, 2026. It shows recorded evidence, not a live take, and personal
addresses are redacted.

## Run it

```sh
cd ~/dev/bouncer
npm test            # 65 tests, no dependencies
npm start           # prints single-use pairing links for this Mac and the iPhone (Tailscale)
npm run doctor      # checks hooks, allowlists, server, audit chain
bin/agent.sh        # Claude Code from the directory where Fo is configured, every Fo call gated
npm run trace       # run trace + counts for the submission; `npm run verify` re-checks the hash chain
```

**Addresses.** `policy.json` ships with demo placeholders: `you@example.com` (your own address) and
`friend@example.com` (a trusted second address). The tests use the same placeholders. To run it for real, copy it
to `policy.local.json` (gitignored) and put your addresses there; `npm start` uses that file when it exists. The
proof write-ups use the same placeholders in place of the real inboxes used in the Oct 18 runs. The audit log
itself is untouched and not in the repo.

**Paths.** `bin/agent.sh`, `hooks/claude-settings.json` and the proof scripts use absolute paths for the
author's machine (`/Users/rello/...`), because Claude Code hook commands need absolute paths. Change them for yours.

## Policy (`policy.json`, first match wins)

| Rule | Effect |
|---|---|
| Read-only Fo tools (`list_fo_conversations`, `get_fo_conversation`, `get_fo_reply`) | allow, logged |
| `start_fo_call`, or any unknown Fo tool | deny |
| Malformed input, unexpected fields, message over 4,000 chars | deny |
| Card number (Luhn), SSN, API key, password or OTP in the message | deny |
| Buying, paying, prices, orders, bookings | deny |
| Phone number in the message | deny |
| Any email address not on the self/trusted allowlist | deny |
| Anything not marked `newConversation: true` (Fo continues the current conversation by default, so "yes, send it" is a follow-up) | hold |
| An `@` that isn't part of a complete address | hold |
| Email to a trusted address that isn't you | hold |
| Email to yourself, but the wording may name someone else ("and Sam", "my manager", "x at y dot com") | hold |
| Email to yourself, bundled with a call, text, invite or forward | hold |
| Email to yourself only (during quiet hours, if set: hold) | allow |
| Anything else | hold |

A held request expires after 240 s. An expired request is blocked.

## The dashboard: one task, start to finish

The dashboard groups Fo calls into **tasks**. A follow-up that carries a Fo `conversationId` joins the task that
opened that conversation, so "email my second inbox" shows as one task with two Fo calls and two approvals. Each call
shows the stages the audit log actually records:

| Stage | Source | Shown as |
|---|---|---|
| Agent asked | `request.received` | the exact message, word for word |
| Policy | `policy.decided` | allow / deny / hold, rule and reason |
| Human | `approval.decided` | approved or rejected, on which device, bound to the SHA-256 hash. "Not needed" or "Not asked" when policy decided |
| Fo says | `release.granted` + `result.recorded` | Fo's reply, labelled *Fo's own report, not a delivery check*. "Never released to Fo" when there is no release |
| Independent check | `data/verifications.json` (optional) | only when a person checked outside Fo. Otherwise "Not verified" |

An approval alone never shows a task as done. Independent checks are recorded by hand after the fact, outside the hash
chain. They never change a request's state, and the dashboard says so next to each one. A panel above the tasks states
the boundary: the agent proposes, policy sorts, only a paired device authorizes, and evidence stays separate.

## What is guaranteed, and how it's tested

- **Nothing reaches Fo without a release.** The gate prints the allow decision only after the server
  grants a one-time release for the exact SHA-256 of `{toolName, toolInput}` that was evaluated. Every
  other path exits 2: deny, reject, expiry, server down, bad token, crash, malformed input, a 5xx
  (including an audit write failure), and the gate's own 280 s deadline, which sits under the 300 s hook
  timeout. The hook command is wrapped as `node gate.mjs || exit 2`. Tests: `test/gate.test.mjs`.
  Real Claude Code runs: `proof/t6/RESULTS.md`.
- **No replay.** A decision is made once. A release happens once, for one hash. Denied, rejected and
  expired requests can't be released, and a late result can't upgrade them. Tests: `test/server.test.mjs`.
- **Approver auth.** Pairing links work once and expire in 10 minutes. Sessions live in memory, so a restart
  means pairing again. Cookies are HttpOnly and SameSite=Strict. Every POST needs the same Origin plus a
  CSRF token. Unknown Host headers are refused, which blocks DNS rebinding. The gate API is loopback-only
  and needs a token. The server binds to 127.0.0.1 and the 100.x Tailscale IP, never 0.0.0.0.
- **Audit evidence.** Append-only JSONL, where each entry hashes the previous one. `verify` detects an
  edited, deleted or reordered line, and the server refuses to start on a broken chain. State is rebuilt
  from the log, and anything still pending at a restart is marked expired.
- **Honest results.** Fo's replies are stored verbatim and labelled *Fo-reported*. Bouncer never claims
  delivery; check delivery in the inbox.

## Limits (stated plainly)

Bouncer is fail-closed **for Fo tool calls made through Claude Code sessions that load
`hooks/claude-settings.json`** (via `bin/agent.sh`), under the failure modes listed above. It is not universal:

- **Other paths bypass it.** Fo reached by SMS, email, Telegram, voice or the Wajo app, or from a Claude Code
  session started without these settings, is not gated. A session in `auto`/`bypassPermissions` mode with a
  broken hook config has no backstop (`proof/PROOF.md`). Use default mode, which `bin/agent.sh` sets.
- **Same-user agent.** The agent runs as your macOS user, so Bouncer's settings take its Bash, Write and Edit
  tools away completely. Deny rules beat every allow rule, including broad ones like `Bash(python3 *)` in
  `~/.claude/settings.local.json`, which this project found and tested (`proof/t6/RESULTS.md`). `bin/agent.sh`
  refuses to start unless `doctor` confirms this. Anything that *can* run code as you, including other
  sessions, scripts and you, could read the gate token, expire or forge results for requests, or stop
  Bouncer and answer on its port in its place: the gate doesn't authenticate the server. Fixing that needs a
  key the agent can't read (e.g. the Keychain), which is out of scope for the demo.
- **The policy reads text, not intent.** It matches addresses, numbers and keywords, after Unicode normalisation (full-width ＠, zero-width characters). Auto-allow is the riskiest
  rule, so it's narrow: your address is the only one in the message, and nothing hints at another person
  (a capitalised name after "and/to/cc", "my manager", an address spelled out with "at … dot"), another
  action, money or secrets. Any hint means a hold, never an allow. These hints are heuristics, so wording like
  "email me and sam" in lower case can still slip through to auto-allow. Set `self` to an empty list to
  hold every email. Fo's actions after release are Fo's: Bouncer gates the message, not what Fo does with it.
- **Tail truncation.** Deleting the last lines of the log leaves a valid shorter chain. `trace` prints the
  head hash, so keep it with the submission as an external anchor.
- **No delivery receipts.** Fo sometimes puts a message ID in its reply text, but that is still self-reported. Delivery is checked in the inbox, by a person, and recorded by hand in `data/verifications.json`. That file isn't hash-chained or signed: it's a labelled note, not proof.
