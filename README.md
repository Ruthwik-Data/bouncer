# Bouncer

**An approval gate for an AI agent that can act in the real world.**

[Wajo Fo](https://wajo.ai) can send email, place calls and buy things for you. Connect it to a coding agent like
Claude Code, and one bad prompt could email the wrong person or spend money. Bouncer sits between Claude Code and
Fo MCP. It checks every Fo request against fixed rules before Fo sees it. Purchases are blocked. Sensitive requests
wait for your approval on your iPhone. Every step goes into a tamper-evident log.

▶ **Demo (45 s):** https://x.com/Rellobuilds/status/2112235395182178486. It's a narrated, animated walkthrough
built from the real dashboard and audit log of the Oct 18, 2026 runs below. It shows recorded evidence, not a live
screen take. Longer version (84 s): [`submission/bouncer-demo-narrated.mp4`](submission/bouncer-demo-narrated.mp4).

Built for the Wajo × Anthropic GSD hackathon (Oct 17–19, 2026). Node 22, no dependencies, 65 tests.

## How it works

```
Claude Code ──Fo request──▶ Bouncer hook ──▶ Bouncer server: rules ─▶ (hold ─▶ your iPhone) ─▶ audit log
                                 │
                                 ├─ released ─▶ Fo MCP ─▶ real world (email)
                                 └─ anything else ─▶ blocked; Fo never sees it
```

- **You approve the exact request, nothing else.** When a request is held, your phone shows the exact message.
  Bouncer fingerprints it (SHA-256 of the tool name and input) and releases only a request with that same
  fingerprint, and only once. If the agent changes one word, that's a new request and needs a new decision.
- **When in doubt, it blocks.** The hook lets a Fo call through only when the server explicitly releases it. If
  the server is down, the request times out, the hook crashes or the input is malformed, the call is blocked.
- **The log can be checked.** Each audit entry contains the hash of the one before it, so an edited, deleted or
  reordered entry breaks the chain. `npm run verify` checks it. (Removing only the newest entries isn't
  detectable this way; see Limits.)
- **"Fo says" is not "it happened".** Fo's reply is stored as Fo's own report. Whether the email actually arrived
  is recorded separately, and only when a person checked outside Fo.

## Three real runs (Oct 18, 2026)

| Run | Request | What Bouncer did | Outcome |
|---|---|---|---|
| S1 | "Buy two movie tickets" | Denied by the money rule. No human was asked. | Never reached Fo. |
| S2 | Email a trusted second address | Held, then approved on the iPhone. Fo then asked to confirm, and that follow-up was held and approved too. | Fo reported "Sent". Separately, the email was found in the recipient's inbox with a matching body. |
| S3 | Email to myself | Allowed by the self-email rule, with no human step. | Fo reported it sent. The owner confirmed it in their own inbox. |

Timestamps, audit sequence numbers and hashes are in [`proof/t7/RESULTS.md`](proof/t7/RESULTS.md). The audit log
itself isn't published because it contains Fo's reply text. Its final head hash is recorded there. Run count:
6 Fo calls gated, 3 auto-allowed, 2 held and approved, 1 denied, 5 reached Fo, 0 failed.

## Try it

Needs Node 22+, Claude Code with the Wajo Fo MCP server configured, and (for phone approvals) Tailscale.

```sh
git clone https://github.com/Ruthwik-Data/bouncer && cd bouncer
npm test            # 65 tests, no install step
npm start           # starts the server and prints single-use pairing links for this Mac and your phone
npm run doctor      # checks hooks, allowlists, server and audit chain
bin/agent.sh        # in a second terminal: Claude Code with every Fo call gated (see "Where to launch")
npm run verify      # re-checks the audit hash chain
npm run trace       # run trace and counts
```

**Where to launch.** `bin/agent.sh` runs `doctor`, then `cd`s into the directory where the Fo MCP server is
configured and starts `claude` there with Bouncer's hook settings. Claude Code only loads a local-scoped MCP server
in the directory it was added from; run `claude mcp list` there to confirm Fo is listed. As shipped, the script `cd`s to the
author's home directory (`/Users/rello`) and expects Bouncer at `/Users/rello/dev/bouncer`. Edit both in
`bin/agent.sh` (and the paths in `hooks/claude-settings.json`) before running it. If Fo is configured at user
scope, any directory works.

To repeat the three runs, ask the agent to buy movie tickets (blocked), to email your trusted address (held:
approve it on your phone), and to email yourself (allowed). S2 and S3 send real email from your Fo account. Then
open the dashboard and run `npm run verify`.

**Addresses.** `policy.json` ships with demo placeholders: `you@example.com` (your own address) and
`friend@example.com` (a trusted second address). The tests use the same placeholders. To run it for real, copy it
to `policy.local.json` (gitignored) and put your addresses there; `npm start` uses that file when it exists. The
proof write-ups use the same placeholders in place of the real inboxes used in the Oct 18 runs. The audit log
itself is untouched and not in the repo.

**Paths.** `bin/agent.sh`, `hooks/claude-settings.json` and the proof scripts use absolute paths for the
author's machine (`/Users/rello/...`), because Claude Code hook commands need absolute paths. Change them for yours.

## Scope

Bouncer gates **Fo tool calls made by Claude Code sessions started with `bin/agent.sh`**. It is not a security
layer for Fo in general:

- Fo reached any other way (SMS, email, Telegram, voice, the Wajo app, or another Claude Code session) is not gated.
- Once a request is released, what Fo does with it is up to Fo. Bouncer controls the message, not Fo's actions.
- The rules read text, not intent, so they can be fooled by wording.
- There are no delivery receipts. "Delivered" means a person checked the inbox.

The full list is under [Limits](#limits-stated-plainly).

## Architecture in detail

```
Claude Code agent ──mcp__fo__*──▶ PreToolUse hook (bin/gate.mjs) ──▶ Bouncer server (127.0.0.1 + Tailscale)
        ▲                               │ allow only after a one-time,            │ policy · approvals · audit log
        │                               │ hash-bound release; else exit 2         ▼
        └── Fo result ◀── Fo MCP ◀──────┘                        dashboard / iPhone approval card
                    PostToolUse hook (bin/post.mjs) records what Fo reported
```

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
