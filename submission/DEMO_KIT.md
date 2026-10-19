# Bouncer demo kit (2026-10-19)

Drafts only. Nothing here has been posted, uploaded or pushed.

## Demo script (75–90 s)

Uses the real audit from 2026-10-18 (32 entries, head `2aad2844…`). No new Fo actions are needed for this cut.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:10 | Dashboard top: counts + "Who can do what" | "Fo can send email and spend money for me. Bouncer sits between my Claude Code agent and Fo. The agent proposes, policy sorts, and only my phone can authorize." |
| 0:10–0:25 | Task "Buy two movie tickets…" expanded | "The agent asked Fo to buy tickets. Policy denied it on the money rule. No human was asked, and Fo was never called: the audit shows no release." |
| 0:25–0:50 | Task "Use Fo to email second (friend@example.com)…" expanded | "Email to someone else is held. I approved it on my iPhone, and the approval is bound to the message's hash. Fo staged it and asked to confirm. That reply was held too, and I approved it again. One email, two human decisions." |
| 0:50–1:05 | Same task: "Fo says" vs "Independent check" | "This is what Fo says it did. It's labelled as Fo's own report. Separately, the recipient's inbox was checked, and that's marked as an independent check, outside Fo." |
| 1:05–1:15 | Task "Send one email to owner (you@example.com)…" | "Email to myself is routine, so policy let it through with no human step. Still logged, still checked." |
| 1:15–1:25 | Chain badge, then terminal: `npm run verify` | "Every step is hash-chained. Edit one line and verify fails. 65 tests, zero dependencies." |

Optional live segment (needs your go-ahead at the time, sends a real email): approve a held request on the iPhone on camera.

## Recording checklist

- [ ] Live server in tmux `bouncer` (`tmux attach -t bouncer`), restarted 2026-10-19 so "Independent check" rows show.
      Pair the browser again with a fresh link from `tmux capture-pane -pJ -t bouncer`, or "Pair a device" from a paired tab.
- [ ] The dashboard reads the real audit, so task titles show the real addresses (the repo uses placeholders).
      Blur them in edit or keep the zoom so they aren't legible, if you don't want them public.
- [ ] Open the dashboard in a clean browser window, 1280–1440 px wide, dark mode. Close other tabs and notifications (Focus on).
- [ ] Expand the three tasks in script order before recording, or click them on camera.
- [ ] Run `npm test` and `npm run verify` once in a terminal with a large font, so the output can be shown.
- [ ] Decide whether recipient addresses may appear on screen (both are yours). If not, record at a zoom that hides them or blur in edit.
- [ ] Keep it under 90 s. No live Fo actions unless you approve each one at the time.

## X post (draft)

> Agents that act in the real world need a bouncer.
>
> I put one between Claude Code and @wajo_ai Fo. Every Fo call goes through a hook: money and strangers get denied,
> email to me goes through, everything else waits for my iPhone. Approval is bound to the exact message hash.
>
> The dashboard shows each task from request to result, and keeps "Fo says it sent it" apart from "I checked the inbox."
>
> Real runs, hash-chained audit, 65 tests, zero deps. [video]

(Check Wajo's handle and the hackathon's required tag/quote-post format before posting. See `DRAFT.md` and
`~/WAJO_HACKATHON_RESEARCH.md`.)

## Screenshots and evidence to show

1. Dashboard top: counts strip + "Who can do what" panel.
2. S2 task expanded: 2 Fo calls, 2 iPhone approvals with hash, "Fo says", "Independent check: Confirmed outside Fo".
3. S1 task expanded: "Deny · Money", "Not asked", "Never released to Fo".
4. S3 task expanded: "Allow · Email to yourself only", "Not needed", Fo's report, Rello's inbox check.
5. Terminal: `npm test` → 65 pass, 0 fail.
6. Terminal: `npm run verify` → 32 entries, chain intact, head `2aad284491707fb1…`.
7. `npm run trace` output (local `proof/out/trace-final.txt`).
8. `proof/PROOF.md` table: which hook failures fail open and how the wrapper closes them.
9. Phone screenshot of the approval card (from the S2 run if you have one, otherwise skip; don't stage a new one without a live run).
