# T7 live runs

The audit log `data/audit.jsonl` is gitignored because it holds Fo response text. It is kept locally. Read-only snapshot after S2:
`data/archive/audit-after-S2-20261018T083055Z.jsonl`, sha256 `c0ac1a07d4668946d144519143b30b47fe9f2bac38ab682054da781def38466b`
(28 entries, `bouncer verify` OK, head `8443ad9ce6e5bdcf61c048a9c09d9b96570b9b4e66ac1522fd50aae3d7935878`).

| Scenario | Audit seq | Outcome |
|---|---|---|
| S1 blocked: "buy two movie tickets" | 6–7 | denied by rule `money`; never reached Fo |
| S2 held → approved on iPhone, email to friend@example.com | 18–28 | see below; delivered |
| S3 auto-allow self-email to you@example.com | 29–32 | allowed by rule `self-email`, no human step; Fo reports sent |

## S2 (2026-10-18 UTC)
- 08:23:33 seq 18 `device.paired` iPhone over the tailnet.
- 08:24:38 seq 19–20: `ask_fo` (newConversation) held by rule `trusted-recipient`, hash `2f839551…`.
- 08:27:04 seq 21–22: approved by iPhone; released with the same hash.
- 08:27:34 seq 23: Fo staged the email and asked for an explicit go-ahead (conv `0043a8a0-eb59-4c34-88b3-03733270dd74`).
- 08:27:37 seq 24–25: the agent's confirmation was held by rule `follow-up`, hash `de779f52…`.
- 08:27:58 seq 26–27: approved by iPhone; released with the same hash.
- 08:28:29 seq 28: Fo replied "Sent, exactly as specified". Message-ID `wajo-3f9a97dfbd8bcc65ff89e0982c67f1f7@wajo.ai`.
- Delivery: the second (friend@example.com) inbox (Gmail connector, read-only search) has one thread from `fo@wajo.ai`, subject
  "Bouncer demo", at 08:28:09Z. The body matches.

Agent: `bin/agent.sh -p --model haiku` (doctor passed). Takeaway: one email took two human approvals, because Fo asks for its
own confirmation and Bouncer holds every follow-up.

## S3 (2026-10-18 UTC, authorized by Rello at about 08:34)
- 08:35:17 seq 29–31: `ask_fo` (newConversation) allowed by rule `self-email` and released by policy, hash `9e6f8a96…`.
- 08:35:28 seq 32: Fo replied "Sent to you@example.com, subject "Bouncer Demo", exactly that body. Nobody else was contacted."
  Conversation `c25c92d3-00b3-4462-8a13-834f8178ff70`. Fo didn't ask for a confirmation, so nothing was held.
- Delivery: the Gmail connector is signed in to second (friend@example.com), so Rello checked the owner (you@example.com) inbox himself and confirmed it arrived. The secondary inbox
  still has only the S2 email, so nothing spilled over.
- Final snapshot: `data/archive/audit-after-S3-20261018T083552Z.jsonl`, sha256 `e7df69d67cb226f9ac1e9bf8fca1751face4ff17330ab2c07d54783d519d0add`.
  `bouncer verify`: 32 entries, chain intact, head `2aad284491707fb145db1f21b7fd94e9784c2d5a144ce8542226726f0f9de022`.
- Final trace: `proof/out/trace-final.txt` and `.json` (gitignored, local). Counts: 6 Fo calls gated · 3 auto-allowed ·
  2 held (2 approved) · 1 denied · 5 reached Fo · 5 returned a result · 0 failed.
