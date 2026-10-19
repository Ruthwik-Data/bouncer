# Bouncer submission draft (local only; nothing has been posted or submitted)

Deadlines (from ~/WAJO_HACKATHON_RESEARCH.md): X quote-post **Mon Oct 19, 10:15 AM PT**. Quote Shivani's 10 AM PT post.
Organizers asked people not to post early. Google Form: treat **Mon Oct 19, 10:15 PM PT** as the safe deadline (sources conflict).

Open items for Rello before posting:
- [x] S3 email ("Bouncer Demo") arrived in you@example.com (confirmed by Rello).
- [ ] Decide the run-count wording in G (two options below).
- [ ] Record the video in one unedited take (script below). That means one more live Fo run, which needs your go-ahead at the time.
- [ ] Teammates? If any, list them in B and tag them in the X post.

---

## X quote-post (≤280 chars)

> Bouncer: a bouncer between my AI agent and Fo. Every Fo call from Claude Code is checked first. Emails to me go straight through, mail to anyone else waits for a tap on my iPhone, and purchases are blocked. All of it lands in a hash-chained log. Demo 👇

(Alt, shorter) Agents that can email and buy things need a bouncer. I built one for Fo: rules, iPhone approval, tamper-evident log.

---

## Form answers

**A) X link:** _(after posting)_

**B) Team email(s):** you@example.com

**C) Video:** _(link after recording; one unedited take)_

**D) Write-up**

*Who it's for.* Me, and anyone who wants to hand an agent real-world tools without handing over control. Fo can email, call and
buy things for you. That's what makes it useful, and it's also why "the agent decided to" is a bad answer.

*What I built at the event.* Bouncer is a gate between a Claude Code agent and the Fo MCP. Before any `mcp__fo__*` call leaves Claude Code, a
PreToolUse hook sends it to a small local server. Deterministic rules decide; there's no LLM in the loop:
- Read-only Fo tools and email to my own address are **allowed** and logged.
- Email to a trusted second address, and any follow-up inside a Fo conversation (such as "yes, send it"), is **held** until I tap Approve on
  my iPhone (paired over Tailscale; the approval expires after 4 minutes).
- Money, strangers, phone numbers, secrets and voice calls are **denied**. Fo never sees them.
Fo only gets the call after a one-time release bound to the SHA-256 of the exact request. Every step lands in an append-only,
hash-chained audit log, which `bouncer verify` re-checks.

*What existed before.* Fo and its MCP (Wajo) and Claude Code's hook system. Bouncer is new code written this weekend, in Node with zero dependencies,
63 tests.

*Mocked or hard-coded.* Nothing in the demo is mocked: real Fo, real emails, real phone approval. Hard-coded: the allowlist (my address plus
one trusted test address) and the keyword rules in `policy.json`. Delivery is checked in the inbox, because Fo's "sent" is self-reported.

**E) Build note**

*Tools the agent uses.* The Fo MCP: `ask_fo`, `list_fo_conversations`, `get_fo_conversation` and `get_fo_reply`. `start_fo_call` is always denied,
because a live call can't be checked message by message. The demo agent gets no Bash, Write or Edit, so its only way to reach Fo is through the gate.

*What we added on top.* A fail-closed hook: a crash, timeout, server down, bad token or 5xx all block the call. Also a deterministic policy, a paired
iPhone approval card (single-use pairing, CSRF, Origin and Host checks), a one-time hash-bound release, and a hash-chained audit with `verify` and `trace`.

*One thing that didn't work.* My first plan was to approve once per email. Fo, though, stages the email and asks "go ahead?", and
the agent's "yes" is a second `ask_fo` call. A gate that waved follow-ups through would let a one-word reply send anything. So
Bouncer holds every follow-up too, and the trusted-recipient email took **two** taps on my phone. That's safer, but clunkier.
Also: the hook settings I inherited pre-approved `Bash(python3 *)` for sessions in my home folder, which would have let an agent route around
the gate. I found this in an independent review and fixed it by denying Bash, Write and Edit to the demo agent outright.

*Limits, stated plainly.* Bouncer only gates the Claude Code → Fo path. Fo reached by SMS, email or the app isn't gated. The policy reads
text, not intent. Code running as my macOS user could get around it. Details are in the README.

**F) Run trace** — paste from `proof/out/trace-final.txt` (regenerate with `npm run trace`). Head hash `2aad284491707fb1…`.
The best single run to show is S2 (seq 19–28): held → approved on the iPhone → Fo staged it → confirmation held → approved → Fo "Sent" (Message-ID
`wajo-3f9a97dfbd8bcc65ff89e0982c67f1f7@wajo.ai`) → delivered to the second inbox at 08:28:09Z.

**G) Run count** — pick one:
- *Final log:* 6 Fo calls gated by Bouncer: 3 auto-allowed, 2 held and both approved on the iPhone, 1 denied. 5 reached Fo, 5 returned a result,
  0 failed. Three live demo scenarios (blocked purchase, approved email, auto-allowed self-email), all 3 behaved as intended, and both
  emails were delivered.
- *Including earlier test runs:* add 7 gated calls from the T6 dry runs and the pre-restart test log (archived in `data/archive/`): 4 read-only
  allows, 1 stranger denied, 1 purchase denied, 1 trusted-recipient hold. Plus one server-down run that was blocked before reaching the log.

---

## Video script (one unedited take, about 90 seconds)

Before you hit record: `npm start` in a visible terminal; pair the iPhone; dashboard open on the Mac; the phone on screen or held to the camera;
both inboxes open. Each live run needs a go-ahead at the time. Use new subjects (for example "Bouncer live 2") so the inbox shows a fresh email.

1. (10s) "Fo can email, call and buy things for me. Bouncer decides what my agent is allowed to ask it to do." Show the dashboard.
2. (20s) Blocked: in `bin/agent.sh`, ask "Use Fo to buy two movie tickets". The dashboard shows DENY, money rule. "Fo never saw that."
3. (35s) Held: ask for an email to the second address. The card pops up on the iPhone, tap Approve; Fo asks to confirm, the second card, Approve.
   Switch to the second inbox and show it arriving.
4. (15s) Allowed: an email to myself goes straight through. Show the audit entry.
5. (10s) `npm run verify` → "hash chain intact". "Every decision, every approval, tamper-evident."
