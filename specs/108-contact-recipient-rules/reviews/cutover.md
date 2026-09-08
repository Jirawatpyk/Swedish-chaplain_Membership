# 108 — Cutover record (T094)

**Feature**: `108-contact-recipient-rules` · **Flag**: `FEATURE_CONTACT_MARKETING_RECIPIENTS`
**Opened**: 2026-09-08 · **Owner**: maintainer (solo-maintainer substitute, Constitution § Governance)

This file is the artefact T094 names. It is written BEFORE the flip and updated at each step, so
that the state of every precondition is recorded at the moment it was true — not reconstructed
afterwards. **T094 does not complete when the flag is set. It completes when the five signals in
§ 4 have been observed on a real send.**

---

## 1. Flag state

| When (Asia/Bangkok) | Event | Evidence |
|---|---|---|
| 2026-09-07 | PR-C #346 (`91505b8f2`) merged; migrations `0294`–`0297` applied to prod on the deploy | CLAUDE.md § Recent Changes |
| 2026-09-08 09:36 | Last production deployment: `#351` (`d7003ea0c`, the `check:f8-error-id` CRLF fix) | Vercel deployment `dpl_BTvaqa62oyK1ypzRtBmEbvCcrwPV`, target `production`, state READY, created `2026-09-08T02:36:59Z` |
| 2026-09-08 ~09:44 | `FEATURE_CONTACT_MARKETING_RECIPIENTS=true` set in the Vercel project | maintainer, confirmed in session |
| 2026-09-08 ~10:41 | **Variable DELETED from the Vercel project** — the flip is disarmed | maintainer, confirmed in session |

**→ The flag is ABSENT, therefore `false`, and the flip is NOT armed.** `src/lib/env.ts:638`
declares `booleanFromString.default(false)`, so a missing variable is a valid boot and resolves to
off; the running production build resolves the `primary_only` leg with
`audienceCeiling(false) = 5_000`, and so will the next deployment.

**Consequence**: `main` is safe to merge again, and the preconditions in § 2 can be closed in the
order the plan intended. Setting the variable to `true` is now the deliberate first step of the
flip rather than a state the next unrelated merge would cash in.

### Why it was deleted — keep this if the variable is ever set early again

There was a window on 2026-09-08 between 09:44 and 10:41 in which the variable was `true` while
production had not yet been redeployed. That is not a harmless "staged" state. `vercel.json` has
**no `ignoreCommand`**, so every push to `main` produces a production deployment (`vercel-build`
= `run-migrations.ts && next build`): the next deployment would have performed the flip **whatever
it was for** — a docs-only PR, a typo fix, a CI-gate change. Nobody would have decided to flip it;
someone would merely have merged something. The docs PR that opened this very file would have
done it.

Deleting the variable restored the property the flag exists for: an operator gate between deploy
and the first E-Blast to newly eligible contacts (`plan.md` § Complexity Tracking #2, which
rejected flip-on-merge for exactly this reason).

The alternative — freezing `main` until the gates close — is worse: it blocks unrelated work and
it fails open, because a freeze is a convention while the deployment is automatic.

**Rule this leaves behind: on this project, setting a feature-flag env var IS the flip, scheduled
for whenever someone next merges anything. Set it when you are ready to redeploy, not before.**

---

## 2. Preconditions (quickstart § Cutover 1–3b)

| # | Precondition | Status | Note |
|---|---|---|---|
| 1 | PR-A, PR-B, PR-D deployed; V1 = 0 violations before PR-B | **CLEARED** | All four PRs merged; `0292`–`0297` applied. V1 ran read-only against prod before PR-B merged. |
| 2 | PR-C deployed with the flag OFF | **CLEARED** | #346 deployed 2026-09-07; the nine unflagged changes have been live since (quickstart § Rollback matrix row C). |
| 3 | **T093** — FR-027a pre-flight review on `/admin/marketing/audience?kind=secondary&state=on&eligible=1`; switch off anyone who must not receive; record date + reviewer in `docs/go-live-readiness.md` | **OPEN — measurement pending** | Vacuous if and only if the eligible-secondary count is 0. NOT YET MEASURED against prod on 2026-09-08. See § 3. |
| 3a | **GDPR Art. 14 first-contact attestation** (`docs/compliance/processing-records.md:128-135`) — either the system notices a new secondary on first marketing contact, or T093 attests per contact | **OPEN — measurement pending** | Same dependency as row 3: a secondary who never gave their address to the chamber directly is a data subject the chamber has not informed. Vacuous at 0 eligible secondaries. |
| 3b | **Push-capacity gate (staff review 🔴)** | **OPEN — and it stays open regardless of today's scale** | See § 5. This is the one precondition that a small member base does not close; it only makes it unreachable today. |
| — | **T098** `/speckit.analyze` FR↔SC↔contract traceability, findings folded into `spec.md` | **IN PROGRESS** | Ordered before T094 by `tasks.md:305`. |
| — | **T095** — record the team's real Resend rate limit (Settings → Usage) in `research.md` § R9/R16 | **OPEN — operator** | Needed as the measured input to § 5. Every rate number in the codebase today is an unsourced comment (`~2 req/s` in `audience-ceiling.ts`, `10 req/s` in the F7 notes). |
| — | **T096** — record of processing + legitimate-interest assessment | **CLEARED** | Delivered with PR-D in `docs/compliance/processing-records.md` (recipient-side LIA `:113-135`, per-contact-preference activity `:136-152`). |

---

## 3. Production scale at cutover

The 1:N widening changes the audience **only** if the tenant actually has secondary contacts that
are marketing-eligible. At 0 eligible secondaries the flag-ON audience is byte-identical to the
flag-OFF audience, rows 3 and 3a of § 2 have nothing to review, and the flip is a no-op that can
be observed safely on the next real send.

Run read-only against prod and paste the output here **on the day of the flip** — a count from an
earlier day is not evidence, because SweCham's secondary-contact import is pending and would
change it in one step:

```
EXPORT_DOWNLOAD_TOKEN_SECRET='<any 32+ char dummy>' TENANT_SLUG=swecham \
TSX_TSCONFIG_PATH=tsconfig.scripts.json \
node --env-file=.env.production --import tsx scripts/inventory-primary-contact-invariant.ts
```

| Measure | Value | Measured (Asia/Bangkok) |
|---|---|---|
| live contacts — primaries | **not measured 2026-09-08 — run before the flip** | |
| live contacts — secondaries | **not measured 2026-09-08 — run before the flip** | |
| of those, marketing-eligible (opt-out NULL, not suppressed) — the T093 preset set | **not measured 2026-09-08 — run before the flip** | |
| `marketing_unsubscribes` rows | **not measured 2026-09-08 — run before the flip** | |
| members with zero live primaries / more than one (`violations`) | **not measured 2026-09-08 — run before the flip** | |
| broadcasts currently in `approved` / `scheduled` / `sending` | **not measured 2026-09-08 — run before the flip** | |

No measurement was in flight when this file was written. The session that opened it could not
reach `.env.production` (the tool sandbox refuses it), so the numbers below the header are absent
by circumstance, not pending by process — someone has to run the command above.

Last known figures (2026-09-05, PR-B post-deploy inventory): 150 members / 150 primaries /
**0 secondaries** / 0 violations. If that still holds, rows 3 and 3a of § 2 are **VACUOUS** — record
that verdict in `docs/go-live-readiness.md` with the date and the number, not as "n/a".

---

## 4. First send — the five signals (T094 completion criteria)

The `audience_import_status` gauge went with the deferred T086 and **does not exist** — do not
wait for it. The five signals PR-C actually ships:

- [ ] `broadcasts_audience_resolved_total{mode}` flips from `primary_only` to `all_contacts` on the first resolve (phase `dispatch`)
- [ ] `broadcasts_recipient_count_ms{outcome="ok"}` p95 inside SLO-F7-013 (400 ms @ 5,000) — note FR-043 requires this measured from `sin1`, never from CI (which scales budgets ×6) and never from a workstation
- [ ] `broadcasts_dispatch_resolve_failed_total` stays 0 **and** `broadcasts_approved_overdue_count` stays 0 through the send
- [ ] `broadcasts_marketing_opt_out_filter_count{phase="dispatch"}` is a LIVE series — present even at 0; its **absence** means the filter stopped running
- [ ] the outbox: `estimated_recipient_count` = delivered

Any of the first four wrong → § Rollback (flag OFF + redeploy) before the next dispatch tick.

**Observed on**: _pending first send_

---

## 5. The push-capacity gate (§ 2 row 3b) — why it stays open

With the flag ON, `audienceCeiling(true) = 50_000`. `split-large-broadcasts` routes to per-batch
audiences only above `SPLIT_THRESHOLD_RECIPIENTS = 10_000`, so a broadcast resolving to
**5,001–10,000** recipients falls to `dispatch-scheduled`, whose push is a serial
one-contact-per-request loop inside `maxDuration = 300`. Such a broadcast is **accepted at submit
and never delivered** — it sits in `approved`.

Three facts that are easy to get wrong here:

1. **This is not created by the flip, it is widened by it.** `plan.md:268` states the serial push
   cannot finish even 5,000 contacts inside the 300 s budget, so the hazard already exists at the
   flag-OFF ceiling. The flip raises the accepted band, it does not invent the gap.
2. **Round 2 of the review "cleared" this and was wrong.** It reasoned about ROUTING (Resend permits
   10,000 contacts per audience) and never checked the WALL CLOCK. The docblock in
   `src/modules/broadcasts/domain/audience-ceiling.ts` says so explicitly: *"5,001–10,000 IS a gap —
   do not re-derive that it is not."*
3. **Every rate number in the repo is an unsourced comment.** `~2 req/s` in the docblock,
   `10 req/s` in the F7 notes; T095 exists precisely because nobody has measured it. At 2 req/s the
   safe bound is ≈ 600 recipients; at 10 req/s ≈ 3,000. Both are **below** the flag-OFF ceiling of
   5,000 — so the bound must be derived from a measured rate, not chosen to match a ceiling.

**Closure requires ONE of** (quickstart § Cutover 3b):

- the import build (T086/T087/T106 — deferred, not authored); or
- a lowered `SPLIT_THRESHOLD_RECIPIENTS` **plus** a wall-clock budget with resume in `addContactsToAudience`; or
- an explicit **submit-time refusal** above `300 s × measured req/s − margin`.

The third is the cheapest and is the recommended closure: a Domain change with a named constant
whose comment points at T095 as the thing that replaces the guessed rate. It is a code change and
therefore takes its own TDD cycle, review stack and PR — it is not part of this cutover record.

Two different numbers get conflated here — keep them apart:

- **Today** (0 secondaries, § 3): ~150 addresses ≈ **75 s** at 2 req/s. Comfortable.
- **After SweCham's secondary import** (the quickstart's projection, ~150 members × 3 contacts
  ≈ 450 addresses): ≈ **225 s against a 300 s budget** — no margin, and that is before anyone
  writes a broadcast to a custom list.

So the 5,001–10,000 band is unreachable today, but the budget stops being comfortable at the very
step SweCham is already preparing. Record the measured rate in `reviews/pr-c.md` row 33 when T095
lands, and re-derive both numbers from it rather than from the 2 req/s guess above.

---

## 6. After the flip

- One clean week → **T099**: delete the flag from `src/lib/env.ts`, `.env.example` and Vercel, and delete the `primary_only` leg in `resolve-segment-recipients.ts` and `findMembersBySegmentForBroadcast`; re-pin the tests.
- Separate, unrelated to the flag: the live-mode switch item — Stripe Dashboard → Customer emails → **"Successful payments" = OFF** (quickstart § Cutover 7, gap G1's operator residual).
