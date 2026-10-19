# Bouncer: product context

Inferred from Rello's written brief (2026-10-18). No interview was run. Assumptions are marked *(assumed)*.

**What it is.** An approval gate between an AI agent (Claude Code) and Wajo Fo, which takes real-world actions
(email, calls, purchases). Every Fo call is checked against deterministic rules. Some are allowed, some are
denied, and the rest wait for a human to approve them on a phone.

**Who uses it.** One person, Rello, who owns the agent and the Fo account. He approves from an iPhone, often
away from the desk *(assumed)*, and in a recorded demo for hackathon judges (Anthropic + Wajo engineers).

**Success.** A held request is understood and decided in under ten seconds on a phone: what goes out, to whom,
why it was held, and how long is left. Afterwards the audit trail shows exactly what happened, and it is evidence,
not a claim.

**Surfaces.** One dashboard (Operate mode): pending approvals, counts, activity, and per-request audit detail.
A pairing screen for unpaired devices.

**Voice.** Plain and exact. Name what Fo will receive and what Bouncer decided. Never claim delivery: Fo's
replies are labelled "Fo-reported".

**Constraints.** Local only (127.0.0.1 + Tailscale). CSP `script-src 'self'`, no external fonts or CDNs.
No framework. Functional approval flow over decoration.

**Anti-references.** Generic SaaS card grids, neon "cyber" security clichés, and hero-metric dashboards.
