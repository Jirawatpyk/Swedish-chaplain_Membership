# 108 — the #353 follow-ups, closed in one PR (2026-09-10)

Branch `111-broadcasts-followups`, off `33f26161c` (#353 merged). Nine review follow-ups from
the eight rounds on #353 (`review-20260910-013000.md` and the round-7/8 `whole-branch-reviewer`
reports), plus the tasks.md sweep the maintainer asked for. One PR, four code commits, no
migration.

## The nine, and where each landed

| # | finding | what shipped | commit |
|---|---|---|---|
| 1 | `reconcile-stuck-sending` `markSent` never read `resource.status` — ANY present resource consumed the member's annual quota, audited `broadcast_sent`, emailed a delivery summary. The round-6 dispatch defect reached its harm through this line 24 h later. | Third outcome `unresolved_provider_status`: only `sent` completes; `draft`/`queued`/`sending`/`cancelled`/`unknown` are left in `sending`, no quota CONSUMED (and — post-review — no slot RESERVED either: a `sending` row is in neither quota bucket, a pre-existing gap this outcome makes unbounded; the runbook tells the operator to check the count before completing), no audit, no email, logged at critical with the status word, counted on `broadcasts.reconcile_unresolved_status.total{observed_status}`, re-reported every tick. The code now decides exactly what the runbook's step 2 decides. `sending` is the discriminating case (went to `markSent` yesterday). Bonus: `sent_at` on the reconciled row and the `broadcast_sent` audit row is Resend's own `sent_at` (this path is ≥ 24 h late by definition). | `88897ab60` |
| 2 | Three dispatch arms minted a Resend broadcast, could not persist its id, and wrote "we leak it — the gateway has no `deleteBroadcast`". | `deleteBroadcast` on the port + adapter (404/410 resolve, 5xx retryable, mock-client test with a positive control). `reclaimMintedBroadcast` on all three arms. The persist-fault arm READS THE ROW BACK first: a commit whose ack was lost surfaces like one that never landed, and deleting the resource in that case destroys the id the next tick inherits (probe `not_found` → send → 404 → terminal). id landed → kept; absent → reclaimed; read-back failed → kept. | `a00be36ac` + `41081dc37` |
| 3 | Step 2's terminal refusals ran BEFORE the probe. A row already handed to `/send` could be marked `failed_to_dispatch` by this tick's re-resolve — quota released, member emailed "failed" for delivered mail. | Probe is Step 1b, in its own try. On a positive answer a refused resolve is recorded (`replay_resolve_refused`) and the row advances on the frozen estimate via `advanceToSending` (Step 4 extracted for its second caller). A probe that cannot be answered now returns before the F3 page walk. | `41081dc37` |
| 4 | FR-021 budget did not bound returns from inside the try; "extract helper, 2 callers". | `applyRetryBudget` — callers: the Step-3 catch and the probe's own catch. **The two in-try `dispatch.server_error` returns are deliberately NOT budgeted**, and the helper's docblock says why: the unknown-status refusal (a clock would turn "unknown whether sent" into "failed, member told") and the persist fault (DB faults are not budgeted on either leg — round 4 F3; the leak that made unbounded retry costly there is closed by 2). This is a narrower reading of the finding than "bound everything", on the code's own recorded reasoning. | `41081dc37` |
| 5 | `dispatch_resolve_failed.total` overloaded three ways (lock / resolve / gate / persist; import leg also gateway-within-budget) while its name and runbook described one. | Closed `phase` on `dispatch.server_error` on both legs (live: `lock` `resolve` `inherited_status` `persist_broadcast_id`; import: `gateway` `resolve` `terminal_write`); the route labels the counter; name kept so the catalogued alert keeps firing; observability rows + `broadcast-audience-build.md` § C say which phase opens which section; route contract asserts the label BY VALUE. | `41081dc37` |
| 6 | Asymmetric severity between the two leak arms (critical vs warn, same leak). | Symmetric by construction: the grade is decided by whether the reclaim worked — `minted_broadcast_reclaimed` (info) / `minted_broadcast_leaked` (error, critical) — on every arm alike. | `41081dc37` |
| 7 | Drift check never ran on the probe-positive path. | **Implemented in `41081dc37`, then REFUTED by the whole-branch review of that commit and reverted.** An inherited id proves the prior tick's push completed (write ordering: push → `createBroadcast` → `attachBroadcastId` in one try — the same invariant the contact-push guard rests on), so on that path the check's question is already answered and its only possible output is a FALSE `broadcast_resend_audience_drift` row (append-only, pages) for a member who joined between the two ticks. `verifyAudienceOnReplay` stays extracted with ONE caller (the 409 arm, pre-existing); the unit case that implemented (7) is inverted and now pins "same mismatch, no drift row". Delivery truth for a sent broadcast is the webhook-fed `broadcast_deliveries` aggregate. | `41081dc37` → reverted in the review-fix commit |
| 8 | `getAudienceContactCount`'s `not_found` arm is dead code (the list endpoint answers a missing audience with `200` + empty list, MEASURED). | `GetAudienceContactCountOutcome` → plain `AudienceContactCount { count, complete }`; adapter's `resource_missing → not_found` catch deleted; nine doubles updated (tsc enumerated); TEST-G3 re-aimed from the impossible input to the path a 404 WOULD take (the unverifiable arm). | `a00be36ac` |
| 9 | No integration test for the separate-tx property #353 shipped. | `dispatch-persist-before-send.test.ts` on live Neon: a retryable send failure leaves the id COMMITTED on an `approved` row and the next tick inherits it (1 mint, 1 push, 2 sends, row `sending`); `attachBroadcastId`'s CAS is SQL. **Mutation-proved**: CAS predicate → `true` fails the second case. | `861670ba8` |

## tasks.md

- **Closed as SUPERSEDED, with the reason on the line**: T006 (answered by `research.md` § V2/V5 + the adapter tests), T140 / T141 / T142 (all three describe the 9b batch model that `ca51f59a1` deleted the same day — a file one of them names no longer exists).
- **Left open, with what actually blocks each written down**: T094 — an operator decision AND SweCham's secondary-contact import (prod measured 2026-09-10: 150 / 150 / 150 / **0 secondaries**, so the flip changes nothing until then); T099 — waits on T094's clock; **T110 — NOT blocked**, a scope decision (resend 4.8 → 6.x is a major bump under a gateway that just took eight review rounds), and the earlier "external condition" wording was wrong.
- T100 — see § Gates.

## TDD ledger

| commit | RED | GREEN |
|---|---|---|
| reconcile (1) | 6 (5 statuses + provider `sent_at`) | 25/25 unit + route contract |
| dispatch (2–7) | 12 of 14 new cases (the two "keep the resource" cases pass on the old code by construction — they are guards for the reclaim, not for the leak) | 98 files / 1,267 tests across `tests/unit/broadcasts` + `tests/unit/broadcast` + the two cron contract suites |
| port (2, 8) | `tsc` enumerated every double; the adapter tests were rewritten to the new shape | 96 files / 1,223 |
| integration (9) | first run green — the code under test shipped in #353; the gap was the *proof on Neon*, so the discriminator is the mutant, not a RED | 4 suites / 9 tests on dev Neon; mutant killed |

## What this PR does NOT do, stated

- T110 (`resend` 6.x) — deferred by choice, above.
- The `dispatch_resolve_failed.total` metric NAME still says "resolve" — kept on purpose so the catalogued 15-minute alarm keeps firing; the label is the truth now. Renaming is a one-line follow-up once whoever owns the alert config has switched it.
- The full `tests/integration/` sweep (~40 min) was not run by hand; the four suites whose doubles or subject changed were (9/9), and the pre-push hook runs the whole `tests/integration/broadcasts/` folder on push because `src/modules/broadcasts/**` is touched.

## Post-review — `whole-branch-reviewer` (fable), one pass, read-only during the e2e run

Verdict MERGEABLE; 1 MEDIUM + 6 LOW, all verified against the code before acting, all closed in the review-fix commit:

| # | sev | finding | disposition |
|---|---|---|---|
| 1 | MEDIUM | "the quota slot stays reserved" (docblock, test comment, runbook § 2b) is false — `countMemberQuotaBucketsOnTx` buckets `submitted\|approved` and `sent\|partial_delivery_accepted`; `sending` is in neither, so a parked row is invisible to the cap and hand-completing it can make the year N + 1 | CONFIRMED by reading the query. Three sentences corrected to what the code does; runbook § 2b now says to check the member's count before step 4. Holding the slot (adding `sending` to the reserved bucket) changes submit semantics and is its own change with its own red test — not folded in. |
| 2 | LOW | parked rows are the OLDEST in a `LIMIT 50` pre-select and never leave it — at 50 unresolved rows nothing newer is reconciled; `cron-jobs.md` retry table had no row for the new 200 body key | runbook § 2b documents the starvation shape (unreachable at SweCham scale, structural); `cron-jobs.md` row added ("harness MUST NOT retry") |
| 3 | LOW | moved probe block still described control flow that no longer exists ("this `return` leaves from inside the `try`", "`errClass: 'gate'` … appears in no runbook", "routes it to the audience-build runbook, which is a different subsystem"); Step-3 "sentinel … used by the idempotency_conflict handler" (stale since #353); two dead line refs `:524`/`:608` | all rewritten |
| 4 | LOW | § C omitted the third read-back branch (read-back failed → resource KEPT) and called a persistent fault "junk-free" | § C now lists all three branches and says a Neon outage that outlasts the read-back leaves one draft per tick in the dashboard, safe to delete |
| 5 | LOW | ledger row 7 said "called from both" — it was two of three prior-tick-sent paths; and on the probe-positive path the check compares a prior push against THIS tick's re-resolve, so a membership change between ticks files a false drift row and pages | Went further than the finding: **(7) refuted and reverted** (see row 7 above). The reviewer's "separate PR" suggestion (compare against a persisted pushed count) is the real fix for the 409 arm's residual false-positive and is noted in `verifyAudienceOnReplay`'s docblock. |
| 6 | LOW | T141's note cited `9b4583451` as #352; that hash is #354, #352 is `4094361e6` | corrected |
| 7 | LOW | a BAT test comment still named the deleted `GetAudienceContactCountOutcome` | renamed |

Refuted by the reviewer itself (kept here so nobody re-raises them): a GET answering 409 has no realistic input; `not_found` on an inherited id cannot reach the reclaim (it sends → 404 → `resource_missing`); the persist-fault reclaim leaves the next tick in the same state as `main`; `deleteBroadcast` only ever sees a never-sent resource; the pre-change "resource present → markSent" vocabulary survives nowhere in docs.

## Post-review — `reliability-guardian` (opus), same pass, read-only

Verdict MERGEABLE conditional on H-1, which the working tree had already reverted when the report landed (both reviewers found it independently). All closed in the review-fix commit:

| # | sev | finding | disposition |
|---|---|---|---|
| H-1 | HIGH | the probe-positive drift check compared the prior tick's audience against THIS tick's re-resolve → false `broadcast_resend_audience_drift` (append-only, **page**) for two unsubscribes between ticks; `drift: -2` is a value the event's semantics cannot express | same as fable #5 — (7) refuted and reverted; test inverted |
| M-1 | MEDIUM | drift/unverifiable audit summaries say "on idempotency replay" on a path that learned by asking | moot after the revert: the only caller is the 409 arm, which IS an idempotency replay |
| M-2 | MEDIUM | "quota slot stays reserved" false in three places; the runbook even told the operator to transition "to release" a slot that was never held | same as fable #1 — corrected; runbook says to check the count before completing |
| M-3 | MEDIUM | probe comment cites a `return` "inside the try" and a `pastBudget` that moved | rewritten (fable #3) |
| M-4 | MEDIUM | "Step 4 — which runs after the catch" describes one of `advanceToSending`'s two call sites | rewritten to name both |
| L-1 | LOW | provider `sent_at` parsed but unbounded — a nonsense-but-parseable value reaches `broadcasts.sent_at` (a `member_timeline_v` key) and the append-only row | bounded to `[broadcast.createdAt, now]`; out of range → `now` + `provider_sent_at_out_of_range` warn; two `it.each` cases (future / before creation) |
| L-2 | LOW | `sent_at < sending_started_at` is now possible on a replayed row | it is the TRUTH on such a row (mail went out on the earlier tick; the flip caught up later) — documented at the write, `handedToSendOnPriorTick` names the rows; deliberately no CHECK |
| L-3 | LOW | the (6) test title claimed "on any arm; a successful one is info" while exercising one arm's failure | title narrowed; the vanished-row case now asserts the info grade and the absence of the leak line |
| L-4 | LOW | the unparseable-`sent_at` case passes on the old code | named as a mutation guard in its docblock (it is one: drop the `isNaN` check and `.toISOString()` throws in the tx) |
| L-5 | LOW | **pre-existing**: the reconcile route logged `message: result.error.message` at error — `e.message` from the outer catch, a `NeonDbError` with bound parameters on this module, and `message` is not a REDACT_PATH; the class round 4 L3 fixed on the dispatch route | `reconcile.server_error` carries `errClass` (from `errKind`); the route logs that instead |

The reviewer's escalation note — audit trail + a paid-benefit quota ⇒ Review gate wants ≥ 2 reviewers with one signing the security checklist — is met under the constitution's solo-maintainer substitute by the two independent agent passes above; no auth/RBAC/PII/payment surface changed (no new audit event type, no migration, no flag, no route shape).

## Gates (T100) — measured on the maintainer's workstation, 2026-09-10

| gate | result |
|---|---|
| `pnpm lint` (full) | 0 |
| `pnpm typecheck` | 0 (run after the last edit of every commit) |
| static: `check:i18n` (5,256 keys × 3) · `check:layout` · `check:fixme` · `check:template-seed` · `check:money-recipient` · `check:dates` · `check:env-example` · `check:f8-error-id` · `check:audit-events` · `check:audit-counts` | 10/10 |
| `pnpm test:coverage` (the CI-blocking instrumented run) | **1,238 files / 13,985 tests green, 2 todo, 1,255 s; own exit 0 — thresholds met** (read from the run's own `COVERAGE_EXIT=` line, not the wrapper's) |
| `pnpm vitest run tests/contract/` | 188 files / 1,944 green, 220 s |
| `tests/unit/broadcasts` + `tests/unit/broadcast` + the two cron contract suites | 98 files / 1,267 |
| integration on dev Neon (the 4 touched suites) | 9/9 |
| `pnpm test:e2e --workers=1` (full, against the maintainer's dev server on `:3100`) | see the PR body — running at the time of this commit; the result is appended there, not claimed here |
