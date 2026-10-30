# Plan: an erased member's E-Blast never goes out; the Resend disclosure is audited

Spec: `specs/139-eblast-erasure-close/spec.md` · Size: L · Agreed by the user on: 30 Oct 2026 (plan mode)

## Approach

**Slice 1 closes both windows. Each half needs its own fix.**

1. **The gate reads erasure (next-tick window).**
   - `MembersBridgePort` gains `getMemberErasedAt(tenant, memberId)`. The adapter reads `drizzleMemberRepo.findErasedAtById` through the members barrel.
   - The read is not cached in `tick-memoized-members-bridge.ts`, for the same reason the fresh halt re-read is not.
   - `MemberSendStanding` gains `{ kind: 'erased' }` and `{ kind: 'erasure_read_failed' }`. Erasure is read first, because erasure removes the member from the halt list.
   - `_dispatch-standing-gate.ts` maps `erased` to `refuse` and the failed read to `undecided`.
   - The other gate callers (`submit-broadcast`, `approve-broadcast`, `confirm-schedule`) map them to their existing refusal and their existing fail-closed path.
   - **The refusal stays migration-free:**
     - The `failure_reason` token is `member_not_in_good_standing`, which already exists with i18n in three locales.
     - No standing-refusal audit row is written. The `broadcast_failed_to_dispatch` row carries `standing: 'erased'` (P3 below).
   - **The gate sends no member email on `erased`:** the email path is skipped in code (P3). The cascade's normal outcome is a cancel, so this refusal is the backstop.

2. **The cascade handles a dispatch-begun row (same-tick window).**
   - `cancelInFlightBroadcastsForMember` gains an input `onDispatchBegun: 'skip' | 'delete_then_cancel'`. The default is `'skip'`, so archive and bulk archive are unchanged.
   - `erase-member` passes `'delete_then_cancel'` through `BroadcastsCascadePort` and `broadcasts-cascade-adapter.ts`.
   - Its deps gain `deleteBroadcastOnce`. This is a gateway method that makes one attempt, with no `withRetry` backoff. Under the existing `lockForUpdate`:
     - every decision is made under that lock (review round 1): one DELETE and, after a 404 or 403, one bounded GET (`retrieveBroadcastOnce`);
     - **200**, **404 + not found**, **403 + `cancelled`** → `applyTransition('cancelled')` in the same transaction;
     - **404 / 403 + queued/sending/sent** → no row write, plus the `already_sent` residual audit row after the lock tx;
     - **any other answer** → unexpected. The reconciler drives it again (the state table below has every cell).

**Changes from the pre-read (30 Oct 2026, `chamber-os-architect` + `pdpa-gdpr`):**

- **P1 — A hard timeout on the DELETE** (architect H1). The Resend SDK has no timeout (`resend-broadcasts-client.ts:31-36`; resend@4.8.0 has no `signal`).
  - `deleteBroadcastOnce` calls `fetch` directly with `AbortSignal.timeout(10_000)`, the way `importFetch` does (`resend-broadcasts-gateway.ts:921`).
  - It returns a typed outcome: `deleted | absent | forbidden | retryable | other`. The existing `deleteBroadcast` returns void and swallows 404/410.
  - A timeout is ambiguous, so it counts as `retryable`: the cascade records it as unexpected and leaves the row unchanged.
- **P2 — An erased refusal deletes the draft first** (architect H2, pdpa H-1). When the cascade fails retryably, the next dispatch tick (every 5 min) reaches the gate before `reconcile-erasures` runs (every 30 min). The refusal then made the row terminal and left the pre-scrub draft at Resend. Now, on `erased`, if the row has an id the probe says was not handed:
  - The gate arm calls `deleteBroadcastOnce` before refusing.
  - On `deleted` or `absent` it refuses terminally.
  - On any other outcome it returns `undecided`: the row stays `approved` and nothing is sent. The next tick or the reconciler tries again.
  - This also cleans up any row erased before 139 that is still `approved` with an id.
- **P3 — The erased refusal has no standing-refusal audit row** (architect M1, pdpa M-3).
  - The member-visible event `broadcast_membership_suspended_blocked` (labelled "membership suspended") is not used.
  - The existing `broadcast_failed_to_dispatch` row, written in the same transaction, carries `standing: 'erased'`.
  - The member-email path is skipped explicitly in code for `erased`. It does not rely on the contacts having been scrubbed.
- **P4 — Not-found means refuse** (architect M3). `findErasedAtById` answers `repo.not_found`, never null (`drizzle-member-repo.ts:686`). A member row is never deleted by erasure, so not-found means the member is gone. It maps to the same `erased` refusal, not `undecided`, which would stall the row on every tick.
  - **Superseded at dispatch in review round 2 (maintainer, 30 Oct 2026):** because erasure never deletes a member row, a missing requester is *not* evidence of an erasure, and refusing it deleted a draft and ended a row on a guess. The standing now carries `missing: true` on the `erased` kind; `decideDispatchStanding` answers `undecided` (`member_standing_requester_not_found`) for it, so on both legs nothing is sent, the draft is not deleted and the row stays `approved`; each leg writes the WARN `broadcasts.dispatch.requester_not_found` (ids only), and the cron counts it under the existing `broadcasts.dispatch_resolve_failed.total{phase="standing"}` (no new metric). Submit, approve and confirm-schedule keep refusing it (non-destructive). The stall it accepts is the reason the round-1 text rejected `undecided`: **there is NO FK from `broadcasts.requested_by_member_id` to `members`** (checked on dev: six orphan rows), so a genuinely deleted requester's row stays `approved` and unsent until it is cancelled by hand — runbook `member-erasure.md` § "A requester who no longer exists".
- **P5 — A 403 or 404 is probed before it is believed** (architect M4; revised in review round 1). A restricted key also answers 403, and the import leg wants two not-founds before it calls an id dead. On `forbidden` or `absent`, the cascade calls `retrieveBroadcastOnce` **under the row lock** (one attempt, 10 s timeout, never throws); after `absent` it first waits `REPROBE_PAUSE_MS` (3 s, `_reprobe-pause.ts`, the import leg's own pause; review round 2):
  - `queued`, `sending` or `sent` → `already_sent`;
  - 404 + not found → cancel (`absent`); 403 + `cancelled` → cancel (`cancelled_at_resend`);
  - anything else → unexpected (fail closed).
- **P6 — The 403 evidence row is durable** (pdpa H-2, architect L). It is written on its own transaction through `deps.audit.emit(tx, …)`, not through `skipConcurrent`'s `audit.emit(null)`. A failed write counts as unexpected, so the reconciler drives the erasure again. *Revised at /simplify (30 Oct), then again in review round 1:* the probe moved out of the lock because `retrieveBroadcast` retries (up to 31 s); review round 1 showed that a cancel decided after the lock rests on a status-only CAS, which an import tick re-minting from pre-scrub content can beat. The probe is now the bounded `retrieveBroadcastOnce` and runs **under** the lock (max hold ≈ 23 s with the 3 s pause after a 404, review round 2); only this evidence row comes after the lock tx, on its own tx under a `broadcasts-evidence:` advisory lock, once per broadcast.
- **P7 — "Clean" can no longer hide a sent E-Blast** (pdpa H-3).
  - The cascade result gains `alreadySentCount`. *Review round 1:* it is **derived**, not accumulated — at the end of every erasure run, the number of distinct broadcasts with `already_sent` evidence for the member (`readAlreadySentEvidenceInTx`), so a re-drive with nothing left in flight still reports it; a lost race whose re-read finds the send started writes the evidence too.
  - **Reconciler budget (review round 1):** a dispatch-begun row can hold its lock for ≈ 23 s (review round 2), so `reconcile-erasures` stops starting new members at 240 s of its 300 s and defers the rest to the next tick (logged, `deferred` in the response); the erase route declares `maxDuration = 300`.
  - **Accepted bound (review round 2, security MEDIUM / code-review #6):** the budget is checked BETWEEN members only. One member's cascade costs up to ≈ 23 s per dispatch-begun row × the cascade's CAS retries, so a member with several such rows can overrun `maxDuration = 300`. That fails closed — the row's lock tx rolls back, `member_erased` is withheld — and the next tick resumes the member. Recorded in `cron-jobs.md` § reconcile-erasures and the route's docblock. A per-row budget was rejected as more moving parts for a case that needs several dispatch-begun E-Blasts of one member at once.
  - The members adapter carries it into the `member_erased` payload as `broadcasts_already_sent_count`. This is a payload key, not a new event.
  - Runbook step 4 reads it before ticking the erasure complete.
- **P8 — A lost race is not a server error** (architect M5). When the legacy leg's `/send` 404 → `resource_missing` re-read, or the import leg's `sendLostToHold` re-read, finds `status !== 'approved'`, it is a concurrent skip at info level, not `server_error`.
  - **Review round 2 (code-review #3 + #9):** the four copies of that re-read (these two, the legacy erased refusal's lost CAS, the import leg's `failTerminally` concurrent-loss skip) are one helper, `_reread-after-lost-race.ts`. It re-reads under `lockForUpdate` in a short tx of its own, so it waits for a cascade still deciding the row instead of reading `approved` and taking the error path. `sendLostToHold`'s id check, its vanished-row skip and its fixed `observedStatus` are explicit parameters. The halted / terminated refusals are not routed through it (CR2#8, deferred).
- **P9 — Files the first draft missed** (architect M2):
  - `approval-dependency-error.ts:59-65` (the `Extract` union and the dependency name)
  - `read-dispatch-hold.ts:50`
  - the `access` typing in `confirm-schedule.ts:323-329,367`
  - `src/lib/broadcast-approval-deps.ts:166,221`
  - `broadcasts-deps.ts:377,527,1277`
  - the cron `route.ts:303` (its `Pick`s)
  - **the 24 test files that fake `getMembersHaltedInTenant`.** A fake cast with `as` and no `getMemberErasedAt` would throw, become `erasure_read_failed`, and silently flip "send" tests. Each fake gets the method explicitly.
- **Residual 8c (pdpa).** "An E-Blast Resend had already accepted for sending before the erasure cascade's DELETE." It cannot be undone (Art. 19). Resend keeps the sent object under its own retention, which has not been measured. There is an Art. 28(3)(e) instruction item, as for 8a. The DSR answer quotes the `already_sent` row and the recipient count.
- **Archive (pdpa L-1).** The runbook states that archive never stands in for an erasure request.
- **D-040 first trusted** a single DELETE 404 (the import leg wants two). *Review round 1 (CR#1) replaced that:* a 404 is confirmed by the bounded GET under the lock, so the cascade also asks twice.

**Slice 2 conditions (pdpa):**
- **M-1:** the orphan sweeps run on one Resend team shared by every tenant, so a deleted row's `tenant_id` comes from our broadcast row. A deletion that cannot be attributed writes no tenant row. It is logged and counted, never filed under a guessed tenant.
- **M-2:** the label for `broadcast_audience_deleted` says the audience (segment) was removed, never that contacts were deleted. They survive (8a).
- **L-2:** a failed audit write logs at error level and increments a counter with an alert rule, as `broadcast_send_started` does.
- **Payload:** `broadcast_id` (nullable for orphans), `related_member_id`, the audience id, `recipient_count`, `leg`, the delete `reason` and `outcome`. No addresses and no hashes.
- **Slice 1's RoPA edits** must not name the slice-2 rows as evidence before they exist.

**Rejected alternatives** (Complexity Tracking, D-040):
- **Cancel first, then DELETE:** a 403 leaves a `cancelled` row whose mail went out, so the quota and the audit would lie.
- **DELETE first, then cancel, with no lock:** the import leg re-probes `not_found`, waits 3 s, mints a new broadcast from the *pre-scrub* row and persists it while the row is still `approved`.
- **A re-check of erasure between persist and `/send`:** this narrows the window but cannot close it. Only Resend's own arbitration (DELETE answers 200 only on a draft; `/send` works only on a draft) closes it.
- **Gate only, with 8b narrowed:** rejected by the maintainer.

**Slice 2 adds two audit event types**, `broadcast_audience_disclosed` and `broadcast_audience_deleted`, with migration 0322, following the `add-audit-event` skill. They are emitted at the six sites listed in the spec, through `deps.audit.emit` inside each step's own `withTx`. A disclosure row is written after Resend returns the id. If that write fails, it is logged and counted, never rolled back, mirroring `broadcast_send_started` on the import leg.

## Files and modules

Rules: `.claude/rules/modules/broadcasts.md` (the measured Resend traps), `members.md`, `architecture.md` (barrels, `tx` threading).

**Slice 1**
- **broadcasts**
  - `application/ports/members-bridge-port.ts`
  - `infrastructure/members-bridge.ts`
  - `infrastructure/tick-memoized-members-bridge.ts` (pass-through)
  - `application/use-cases/_member-send-standing.ts`
  - `_dispatch-standing-gate.ts`
  - `cancel-in-flight-broadcasts-for-member.ts`
  - `approval/confirm-schedule.ts`, `submit-broadcast.ts`, `approve-broadcast.ts` (their exhaustive switches)
  - `application/ports/broadcasts-gateway-port.ts` + `infrastructure/resend/resend-broadcasts-gateway.ts` (`deleteBroadcastOnce`)
  - `infrastructure/broadcasts-deps.ts`
- **members**
  - `application/ports/broadcasts-cascade-port.ts`
  - `infrastructure/adapters/broadcasts-cascade-adapter.ts`
  - `application/use-cases/erase-member.ts` (passes the mode)
- **Cross-module port meaning changes**, so grep `tests/` for the symbols `cancelInFlightForMember`, `getMembersHaltedInTenant` and `MembersBridgePort`. This catches the fakes in other modules.

**Slice 2**
- `audit-port.ts` (tuple and assert)
- `auth/infrastructure/db/schema.ts` (enum)
- i18n EN, TH and SV
- the count tests
- `dispatch-scheduled-broadcast.ts`, `build-audience-tick.ts`, `cleanup-orphaned-audiences.ts`, `reclaim-orphaned-audiences.ts`

## Data model and migration

- **Slice 1:** n/a.
- **Slice 2:** `0322`, two `ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS` statements inside `DO $$` guards. Unflagged on deploy; inert until a row is written. Rollback: enum values cannot be dropped, and they are harmless if unused.

## Slices

| # | Slice | Done-when lines it covers | Surface reviewers | Branch | PR · status |
|---|---|---|---|---|---|
| 1 | Erasure close: gate + cascade | DE1–DE6 | security-engineer, pdpa-gdpr, reliability-guardian, senior-tester, spec-compliance-auditor | `139-eblast-erasure-close-s1` | #698 · done |
| 2 | Art. 30 audit events | DA1–DA5 | pdpa-gdpr, drizzle-migration-reviewer, observability-instrumentor, spec-compliance-auditor | `139-eblast-erasure-close-s2` | — · open |

## State table (slice 1: the erasure cascade × a dispatch tick on one row)

| Row when the cascade locks | Tick position | DELETE answer | Handler | Test |
|---|---|---|---|---|
| `approved`, no `resendBroadcastId` | before persist | — (not called) | cancel, as today. The tick's persist CAS then fails, so the mint is reclaimed | existing D1 "import-only id cancelled" + `dispatch-persist-before-send` |
| `approved` + id | after persist, before `/send` | 200 | cancel. The tick's `/send` → 404 → its transition loses | **new** interleave (legacy) |
| `approved` + id | after persist, before `/send`, import leg | 200 | cancel. A re-mint persist waits on the lock, then its CAS fails | **new** interleave (import) |
| `approved` + id | `/send` already accepted | 403 + GET (under the lock) queued/sending/sent | the lock tx ends with no row write; the `already_sent` evidence row on its own tx after it; `alreadySentCount` derived | `tests/unit/broadcasts/application/cancel-in-flight-broadcasts-for-member.test.ts` "DELETE answers forbidden › … says %s → already sent" |
| `approved` + id | `/send` already accepted, Resend answers 404 | 404 + GET queued/sending/sent | as the row above | same file, "DELETE answers absent › … says %s → already sent" |
| `approved` + id | any | 403 + GET `cancelled` (Resend says `canceled`, one L — mapped since review round 2; before that this arm was unreachable) | cancel, `resendOutcome: 'cancelled_at_resend'` | same file, "DELETE answers forbidden and the probe says cancelled"; gateway `resend-retrieve-broadcast-once.test.ts` `['canceled','cancelled']` |
| `approved` + id | any | 403 + GET draft / not found / unknown | unexpected (a restricted key, not a send); lock tx rolls back | same file, "DELETE answers %s but the probe says %s → unexpected" |
| `approved` + id | any | 404 + GET draft | unexpected (inconsistent answer) | same `it.each`, `['absent','draft']` |
| `approved` + id | any | **404 + GET `cancelled`** (named cell, coordinator 30 Oct) | unexpected (inconsistent answer; a later run may get 403 + cancelled) | same `it.each`, `['absent','cancelled']` |
| `approved` + id | any | **404 + GET `unknown`** (named cell, coordinator 30 Oct) | unexpected (inconsistent answer) | same `it.each`, `['absent','unknown']` |
| `approved` + id | any | 404 or 403 + GET retryable / other / timeout | unexpected; lock tx rolls back | same file, "and the probe answers %s → unexpected" |
| `approved` + id | any | 200, then the cancel tx rolls back (audit write fails) | unexpected. The draft is gone at Resend, so nothing can be sent, but the row is still `approved`: a `/send` already in flight gets 404 → `resource_missing` (P8 skips only a row that left `approved`, review round 1 M3); the next tick's probe reads not found and its erased gate refuses the row (`failed_to_dispatch`); or the reconciler's re-drive cancels it first (404 + not found) | **new** unit rollback arm |
| `approved` + id, cascade failed earlier | the next tick reaches the gate first | gate: DELETE `deleted`/`absent` → refuse; other → undecided | P2 | **new** integration "erased gate deletes the draft" (both legs) |
| `approved` (+ id or not), requester NOT FOUND (no FK) | the gate | — (not called) | undecided (`member_standing_requester_not_found`): nothing sent, nothing deleted, the row stays `approved`; WARN `broadcasts.dispatch.requester_not_found` (P4, review round 2) | `tests/integration/broadcasts/eblast-send-time-standing.test.ts` "P4 legacy: …" / "P4 import: …"; unit `member-send-standing.test.ts` |
| `approved` + id | any | DELETE timeout (10 s) | unexpected, row unchanged, no GET | **new** unit timeout arm (`retryable`) |
| `approved` + id | none (retryable send failure last tick) | 200 | cancel. The next tick's lock step skips a non-`approved` row | **new** unit 200 arm + DE1 gate test |
| `approved` + id | any | 404, then `REPROBE_PAUSE_MS` (3 s, review round 2), then GET not found (two not-founds) | cancel, `resendOutcome: 'absent'` | `tests/unit/broadcasts/application/cancel-in-flight-broadcasts-for-member.test.ts` "DELETE answers absent and the probe UNDER the lock says not_found" (asserts `pause:3000` between them; the 403 arms assert no pause) |
| listed `submitted` (any status other than the locked one), locked `approved` + id (review round 2, M-NEW-1) | after persist | — (not called on that attempt) | the attempt throws `BroadcastConcurrentMutationError` before any Resend call; the re-read retries from `approved`, which DELETEs once | same file, "the locked row is not at the snapshot status → no Resend call on that attempt; the retry from the status read DELETEs once → deleted" |
| `approved` + id | any | retryable / other | unexpected → `cascade_partial_failure`; row unchanged | **new** unit retryable arm |
| `approved` + id, archive caller | any | — (not called) | skip, as today | **new** DE4 archive test |
| left `approved` before the lock (CAS lost), re-read `sending`/`sent`/`partially_sent`/`partial_delivery_accepted` | — | — | erasure mode: ONLY the `already_sent` evidence row (8c), no best-effort skip row; counted as already sent, metric `already_sent` (review round 2, reliability LOW-1). Archive mode: skip, as before | `tests/unit/broadcasts/application/cancel-in-flight-broadcasts-for-member.test.ts` "P7 (a) — a lost race whose re-read finds the send started writes ONLY the already_sent evidence row" |
| (the tick's side) a lost-race re-read while the cascade holds the row lock | after the cascade's DELETE | — | the re-read takes `lockForUpdate`, waits for the cascade's commit, reads `cancelled` → concurrent skip at info (review round 2) | `dispatch-scheduled-broadcast.test.ts` / `build-audience-tick-failure-paths.test.ts` "spec 139 P8 …" (`lockCalls` / `rowLocks` = 2) |
| none in flight (a re-drive) | — | — | `alreadySentCount` = distinct broadcasts with evidence for the member | `tests/unit/broadcasts/application/cancel-in-flight-broadcasts-for-member.test.ts` "P7 — the count is DERIVED" |
| `sending` / terminal | any | — | not in scope (not in progress) | existing |

## Test plan

| Done-when line | Test that goes red first (file, name) | Level |
|---|---|---|
| DE1 gate refuses erased, both legs | `tests/integration/broadcasts/eblast-send-time-standing.test.ts` — "erased member → refused, no send (legacy)" / "(import)" | integration |
| DE1 erased read first; read failure → undecided | `tests/unit/broadcasts/application/member-send-standing.test.ts` (new or the nearest existing file) | unit |
| DE1 other callers route `erased` | the `submit-broadcast` / `approve-broadcast` / `confirm-schedule` unit tests, one case each | unit |
| DE2 200 / 404 / 403 / retryable arms | `tests/unit/broadcasts/application/cancel-in-flight-broadcasts-for-member.test.ts` — **flip** the D1 "dispatchBegun: true" case for the erasure mode | unit |
| DE2 single attempt | `tests/unit/broadcasts/infrastructure/` gateway test — `deleteBroadcastOnce` makes one SDK call on 5xx | unit |
| DE3 interleave | **new** `tests/integration/broadcasts/erasure-vs-dispatch-begun.test.ts` (real PG, a fake gateway modelling Resend's draft-only DELETE and send), legacy and import cases; **flip** `eblast-approved-exit-vs-dispatch.test.ts` §(d) for the erasure caller only | integration |
| DE4 archive unchanged | `tests/unit/members/.../archive-cascade` (or the nearest broadcasts cascade test) — no DELETE, row skipped | unit |
| DE2 wiring | `tests/unit/members/infrastructure/broadcasts-cascade-adapter.test.ts` — erasure passes `delete_then_cancel` | unit |
| DE6 cross-tenant | `it.each` in the members-bridge integration test — another tenant's member id → null / `tx tenant mismatch` | integration |
| DA1–DA3 | a unit test per emit site (row written, payload ids only); `tests/integration/audit/completeness.test.ts` | unit + integration |
| DA4 | `check:audit-events`, `check:audit-counts`, `db:verify` after `db:migrate` on dev | gate |

e2e: none (cron and erasure server paths only; no UI).

## Constitution Check

- **I Data Privacy & Security:** this closes an erasure gap. The new read is tenant-scoped (`runInTenant` plus a tenant predicate) and covered by the DE6 cross-tenant test. No PII in logs or audit rows.
- **II Test-First:** RED commits per row; `check:red-first` is live.
- **III Clean Architecture:** members are reached only through the barrel and the F7 port. Broadcasts is reached from members only through the existing cascade port.
- **IV PCI DSS:** n/a.
- **V i18n:** slice 1 reuses existing tokens; slice 2 adds the event labels in EN/TH/SV.
- **VI Inclusive UX:** n/a.
- **VII Perf & Observability:**
  - The gate does one extra indexed read per row per tick.
  - The cascade holds the lock for at most two bounded Resend calls and the 3 s re-probe pause after a 404 (≈ 23 s; review rounds 1 and 2).
  - A counter or log line is added for each cascade outcome.
- **VIII Reliability:** fail closed throughout; the reconciler drives retries again.
- **IX Code Quality:** no `return _exhaustive`.
- **X Simplicity:** zero new dependencies.

## Complexity Tracking

| Deviation | Why it is needed | Simpler alternative rejected, and why |
|---|---|---|
| A row lock held across at most two bounded Resend calls — one DELETE, one GET — and the 3 s re-probe pause after a 404 (cascade, erasure mode only; ≈ 23 s) | Our side needs a single arbiter for the row while Resend arbitrates the draft | Cancel-then-DELETE (lying state on 403); unlocked DELETE-then-cancel (the import re-mint from pre-scrub content); a re-check before `/send` (narrows the window, does not close it) |
| The erased refusal writes no standing-refusal row; `broadcast_failed_to_dispatch` carries `standing: 'erased'` | Keeps slice 1 migration-free, so it can gate the flip alone | A new event value (a migration in slice 1); reusing the member-visible `broadcast_membership_suspended_blocked` (it would label an erasure as a suspension) |
| Solo-maintainer review: the five checks in `review-and-ship` § 2 | No second human reviewer | — Evidenced per slice below |

## Evidence

### Slice 1

**Live re-Verify after review round 1, 30 Oct 2026, on `8e3057fa3`.** Same set-up as the first run (:3400, dev Neon, live Resend, sink only, super-admin through the real erase route). Seeds were removed afterwards.

| Case | Observed |
|---|---|
| S1: a draft on an `approved` row | Erase → 200 `cascadesComplete:true`. The draft → **404**. The row is `cancelled` with **`cancellation_reason:"gdpr_erasure_request"`**, so the scrub kept the cascade's reason. `broadcast_cancelled` has `resendOutcome:"deleted"`. `member_erased` has `broadcasts_already_sent_count:0`. |
| S3: a broadcast Resend had already `queued` | Erase → 200. The row stays `approved`. One `broadcast_concurrent_action_blocked` with `resendOutcome:"already_sent"` and `observedResendStatus:"queued"`. `member_erased` has `broadcasts_already_sent_count:1`. Log: `dispatch_begun_delete outcome:"forbidden"`, then the WARN `dispatch_begun_already_sent`. |
| S3 re-erasure (a re-drive) | Erase again → 200. There is still **one** evidence row, so the dedupe holds. The second `member_erased` (`re_drive:true`) also says `broadcasts_already_sent_count:1`, the derived count. |

**Live Verify, 30 Oct 2026, on `71a7f9318`** (`run-chamber-os`: the branch on :3400 from the `f139` worktree, dev Neon, tenant `swecham`, the live Resend Broadcasts account, recipient `delivered@resend.dev` only).
- Before seeding, `SELECT … status='approved' AND scheduled_for <= now()` on dev returned 0 rows, so the cron touched only the seeds.
- The real surfaces were driven: `POST /api/members/{id}/erase` as the e2e super-admin, and `GET /api/cron/broadcasts/dispatch-scheduled`.
- Seeds removed afterwards: 4 members, 4 broadcasts, the Resend audience.

| Done-when | Evidence |
|---|---|
| DE2 200 arm | S1: a real Resend draft (`draft`) on an `approved` row. Erase → `200 cascadesComplete:true`; GET the draft → **404**; the row is `cancelled`; `broadcast_cancelled` has `resendOutcome:"deleted"`; `member_erased` has `broadcasts_already_sent_count:0`; log `dispatch_begun_delete outcome:"deleted"`. |
| DE2 403 arm (8c) | S3: the row's id is a broadcast Resend had already `sent` to the sink. Erase → 200; the row stays `approved`; `broadcast_concurrent_action_blocked` has `{dispatchBegun:true, resendOutcome:"already_sent", observedResendStatus:"sent"}`; `member_erased` has `broadcasts_already_sent_count:1`; log `outcome:"forbidden"`, then the WARN `dispatch_begun_already_sent` (probed after the lock). Made due afterwards, the cron caught it up to `sending` with `broadcast_send_started` (the mail was really out). |
| DE1 + P2 | S2: an erased member and a due row with a real draft. Cron `processed:2, permanent_failed:2`; the draft → **404**; the row is `failed_to_dispatch` / `member_not_in_good_standing`; audit `broadcast_failed_to_dispatch {standing:"erased", resendDraftOutcome:"deleted"}`; no "membership suspended" row. |
| DE1, no id | Erased member (seeded `erased_at`), row with no Resend id → `failed_to_dispatch`, `resendDraftOutcome:"none"`, no Resend call. A second cron tick → `processed:0`. |
| Probes | Wrong cron secret → `401`. Erase as a plain admin → `403 forbidden` (`members.erasure` is super-admin only), nothing written. `identityVerified:false` → `400 invalid_body`. |
| DE3 / DE3b | Not reachable live (the race needs a parked `/send`). Pinned by `tests/integration/broadcasts/erasure-vs-dispatch-begun.test.ts` 3/3 (live Neon; legacy, import tick 2, the import re-mint window). |
| DE4 | `cancel-in-flight-broadcasts-for-member.test.ts`: the default-mode D1 cases (archive), no DELETE. |
| DE6 | `tests/integration/broadcasts/members-bridge-erased-at.test.ts` 3/3. |

**Findings from Verify, fixed after it** (maintainer: "แก้ finding แล้วทำต่อเลย"). Each is pinned by a test; the live run was not repeated.
- **A re-erasure wrote a second `already_sent` row** (measured: 2 rows after 2 erasures). Fixed in `ecbe9fd0b` / `33849eaa6` with `hasAlreadySentEvidenceInTx`, a tenant-scoped EXISTS on `audit_log` (folded into `readAlreadySentEvidenceInTx` in review round 1). Tests: `tests/integration/broadcasts/already-sent-evidence.test.ts` 4/4, and the unit "a re-erasure … writes no second one".
  - Residual: two concurrent re-drives could both miss the row, because EXISTS is not a lock (403 path only). Closed in review round 1 by the `broadcasts-evidence:` advisory lock.
- **The content scrub NULLed the cascade's own `cancellation_reason`.** Fixed in `4e036c626` / `55832a161` / `b02f1d595`: `gdpr_erasure_request`, `pdpa_deletion_request` and `originator_member_deleted` are kept; free text is still NULLed. Tests: `scrub-content-for-member` 22/22 and `erase-member-cascade-real` 2/2.
  - The tenant-sql-shape scan was red on `55832a161`..`33849eaa6` and green from `b02f1d595`.
- **The log field `lockHeldMs` measured only the DELETE.** Renamed to `deleteMs` in `4b849e254`.

**Gates on `b02f1d595`:**
- `pnpm check` exit 0 (red-first: 23 commits);
- `pnpm vitest run tests/contract/` 2836 passed;
- unit broadcasts + broadcast + members: 5192/5192;
- integration by path, all exit 0: scrub-content-for-member 22, already-sent-evidence 4, audience-import-repo 28, member-erasure-cascade 4, erasure-vs-dispatch-begun 3, erase-member-f7-content 5, eblast-erasure-reach 2, erase-member-cascade-real 2, halt-flag-precondition 7.
- **Not run locally:** the full `pnpm test:coverage` (CI runs it).

**RED evidence:** in each `test(…)` commit message and the build report; every RED failed on an assertion.
- The `?.` calls in `37fa2113e` were removed in `97abda837`.
- The RED commit `ecbe9fd0b` also carries the port declaration and a stub returning `false`, so that the tests failed on an assertion, not on "is not a function".

**Dev litter:** each run of `already-sent-evidence.test.ts` leaves one `audit_log` row with `tenant_id IS NULL` (summary `spec 139 evidence fixture`), because `audit_log` is append-only.

### Review round 1 (30 Oct 2026)

`/code-review high` (CR), reliability-guardian (M/L), pdpa-gdpr (M-/L-) and security-engineer (L; signed with conditions). The cascade's decision table was rewritten once, as a whole (the state table above). Each finding, with its fixing commit (RED → GREEN) or its disposition; "docs" means the docs commit that carries this block.

| Finding | Fix / disposition |
|---|---|
| CR#1 — a single DELETE 404 cancelled the row; a stale 404 for an accepted send would cancel a row whose mail went out | Two not-founds: 404 + a bounded GET under the lock. `9b3ee0816` → `b883145b8` (`retrieveBroadcastOnce`), `1767fd8b0` → `34bbf693c` (the table) |
| CR#2 — `reconcile-erasures` could outrun `maxDuration` (10 s DELETE + ~31 s probe per row); the erase route had none | `ba0fb0ee9` → `9372458d0` (240 s budget, `deferred`; erase route `maxDuration = 300`); the probe is bounded (`b883145b8`) |
| CR#3 — 403 + cancelled / unknown stayed unexpected for ever, unlike the gate's cancelled arm | 403 + `cancelled` cancels (`cancelled_at_resend`) in `34bbf693c`; 403 + `unknown` stays unexpected (fail closed) — runbook manual recovery (docs) |
| CR#4 — the erased refusal's terminal CAS racing the cascade logged `cleanup_failed` + `server_error` | `ffa0aae49` → `8d0ec3bc1` (both legs: re-read, a non-`approved` row is a concurrent skip at info) |
| CR#5 — the scrub NULLed the erased refusal's `failure_reason` token | `b1afb7739` → `2bfe9eddf` (`member_not_in_good_standing` / `member_halted` kept; free text NULLed) |
| CR#6 — the P2 docblock overclaimed; terminal rows keep minted pre-scrub drafts; 8b rested on in-flight rows only | Deferred and documented: residual **8d** (OPEN, follow-up issue #699); docblock + call-site comment `1ee307d41`; 8b says "closed for sends" (docs) |
| CR#7 — closure variables out of `withTx` | `34bbf693c` (the lock tx returns `{kind, lockedStatus, resendStatus}`) |
| CR#8 — the cascade reason tuple lived in a use case; members' union could drift | `e5df65439` (Domain value object; a type test pins it equal to `SystemCancellationReason`) |
| CR#9 — `already_sent` was labelled `concurrent_skip` | `34bbf693c` (`already_sent` label in `src/lib/metrics.ts`; `docs/observability.md` § 14.8.1 row) |
| CR#10 — `err: e.name` in the gateway | `bc22a6375` → `ce54350f9` (`errKind(e)` + `timedOut`) |
| reliability M1 — a row moving approved → sending before the lock was not counted | `1b4ab1267` → `a0a4ad93a` (per-member distinct count), `34bbf693c` (evidence on the lost-race re-read; count derived at the end) |
| reliability M2 — cascade vs gate disagreed on 403 + cancelled | as CR#3 |
| reliability M3 — the rollback cell claimed a concurrent skip | state-table cell corrected (docs) |
| reliability L4 — "in the locked tx" was stale | state table rewritten (docs) |
| reliability L5 — the gate's DELETE without the row lock raced the cascade into ERROR noise | as CR#4 |
| reliability L6 — the already_sent arm emitted `concurrent_skip` without counting a skip | as CR#9 |
| reliability L7 — the 403 probe was unbounded in the erase route | `b883145b8` + `34bbf693c` |
| reliability L8 — EXISTS is not a lock | `a0a4ad93a` (`broadcasts-evidence:` advisory lock), pinned by the held-lock case in `already-sent-evidence.test.ts` |
| reliability L9 — 403 + other / unknown never completes | runbook § 3b "A row the cascade cannot settle" (docs) |
| pdpa M-1 — a re-drive reported 0; step 4 read 0 as clean; 3b searched by the re-drive's request id; the state query lacked two statuses | derived count (`a0a4ad93a`, `34bbf693c`); runbook 3b / 4 (docs) |
| pdpa L-1 — 403 + cancelled unresolved | as CR#3 |
| pdpa L-2 — erased members get the standing-refusal error kinds | accepted; one line in RoPA 8b (docs) |
| pdpa L-3 — concurrent re-drives may double-write evidence | as reliability L8 |
| pdpa L-4 — plan.md "in the locked tx" | as reliability L4 |
| security L1 — the gate→send TOCTOU can still let an E-Blast out | accepted as 8c; RoPA 8c and the go-live § 6.10 sign-off say so (docs) |
| security L2 — check-then-insert without serialisation | as reliability L8 |
| security L3 — a minted draft whose reclaim fails stays at Resend (pre-existing) | residual 8d (docs), follow-up issue #699 |
| security Info — 403 + draft loops for ever; wants a signal | the `broadcasts.cascade.tx_or_audit_failed` line with `resendOutcome`, `members_erasure_outcome_total{still_pending}` and the half-run card; runbook recovery (docs). No new alert rule (no alerting backend is bound in code) |

**Gates after round 1, on `3b48d29a9`:**
- `pnpm check` exit 0 (red-first: 46 commits, every logic change has a RED before it);
- `pnpm vitest run tests/contract/` 256 files, 2838 passed + 2 todo;
- unit broadcasts + broadcast + members: 472 files, 5232/5232;
- integration by path, each exit 0: erasure-vs-dispatch-begun 3, already-sent-evidence 6, scrub-content-for-member 24, member-erasure-cascade 4, eblast-send-time-standing 19, audience-import-repo 28, members/erase-member-cascade-real 2, members/erase-member-f7-content 5, members/reconcile-erasures 2; and the files whose fakes changed: eblast-approved-exit-vs-dispatch 7, jcc-test-tenant-fixture 3, halt-flag-precondition 7.
- **Not run locally:** the full `pnpm test:coverage` (CI runs it).
- **The live Verify on `71a7f9318` was not repeated after round 1.** The round-1 behaviour is pinned by the unit table in `cancel-in-flight-broadcasts-for-member.test.ts` and the integration files above; the 404 + GET arms and 403 + `cancelled` are pinned at unit level only (no integration interleave reaches them). The Verify row "DE2 403 arm (8c) … (probed after the lock)" above is evidence of the pre-round-1 build, not of the current one.

### Review round 2 (30 Oct 2026)

reliability-guardian, pdpa-gdpr, security-engineer and `/code-review high` (CR2) on `6c876536d`, plus one measured coordinator item. Each finding with its commit (RED → GREEN) or disposition; "docs" = the docs commit that carries this block.

| Finding | Fix / disposition |
|---|---|
| reliability **M-NEW-1** — a row listed `submitted` but locked `approved` + id got a DELETE whose CAS (on the snapshot status) could not land, and the retry DELETEd again | `a95c6cafd` → `b3455d2e6`: the attempt throws `BroadcastConcurrentMutationError` before any Resend call; the re-read retries from the observed status. State-table row added |
| reliability **LOW-1** / CR2 **#5** — a lost race to a started send wrote two rows (the best-effort skip row and the evidence row) and counted a skip | `7bb3bd513` → `64b34d8c8`: only the `already_sent` evidence row; counted as already sent, metric `already_sent`. Archive unchanged |
| reliability **LOW-2** | no change in this round: the round-2 brief lists it with no action (open question for the coordinator if one was meant) |
| reliability **LOW-3** | no-op (as the reviewer noted) |
| pdpa **M-2** — step 4 read `broadcasts_already_sent_count` alone; a row already `sending` when the cascade listed in-flight rows has no evidence row | runbook step 4 runs the 3b STATE query on every erasure, any hit is 8c even at count 0; RoPA 8c says such a row is found only from state (docs) |
| pdpa **L-5** — 8d had no review date | RoPA 8d: "Review by 2027-01-30" (docs) |
| security **L3** — a minted draft whose reclaim fails stays at Resend | residual 8d, issue **#699** — **needs an owner decision before the `FEATURE_F7_IMPORT_AUDIENCE` flip** (open question) |
| security **MEDIUM** — the reconciler's budget is per member, not per row | accepted bound (P7 above; `cron-jobs.md`; the route docblock): fail closed, the next tick resumes (docs) |
| security **LOW** — no index for the evidence count read | deferred: `readAlreadySentEvidenceInTx` filters `audit_log` by tenant, event type and payload keys; per-erasure, not per-tick. Revisit if the erase route's p95 moves (no measurement taken in this round) |
| security **LOW** — the P8 re-read did not lock | as CR2 #3 |
| CR2 **#1** — no pause between the DELETE 404 and the GET, so "two not-founds" could be one stale answer read twice | `4fee38c3e` (refactor: `REPROBE_PAUSE_MS` to `_reprobe-pause.ts`, re-exported) → `2245f93fb` → `76448c076`: `pauseBeforeReprobe` dep (default a timer), after a 404 only. Lock hold ≤ ≈ 23 s: D-040, this plan, the docblock, the route comment (docs) |
| CR2 **#2** — 403 + `unknown` (a `failed` broadcast) stays unexpected for ever | kept unexpected (fail closed). Settling it needs `failed` out of `normaliseStatus`'s `unknown` on BOTH legs (both refuse it today) — deferred; runbook manual recovery "403 + `unknown`" (docs) |
| CR2 **#3** — the lost-race re-reads did not take the row lock, so they could read `approved` under an in-flight cascade and log ERROR | `4e847aa1d` → `d30595ca5` (with #9) |
| CR2 **#4** — P4 refused a missing requester as erased | `441197f34` → `29fc52461`: undecided at dispatch, `missing: true` on `erased`; runbook orphan recovery (maintainer decision 30 Oct 2026) |
| CR2 **#6** — per-member budget | as security MEDIUM |
| CR2 **#7** — the `member_erased` comment said a re-drive counts only what it met | `erase-member.ts` comment: the count is DERIVED from all of the member's evidence rows and is authoritative on a re-drive (docs) |
| CR2 **#8** (Low) — route the halted / terminated refusals' lost CAS through the same skip | deferred, as the brief directs |
| CR2 **#9** — four copies of the lost-race re-read | `d30595ca5`: one helper, `_reread-after-lost-race.ts`; each caller's semantics kept (sendLostToHold's id check, vanished-row skip, fixed `observedStatus` as parameters) |
| CR2 **#10** (Low) — confirm-schedule's redundant guard; the R2 halted re-read repeats the erasure read | guard: `a82b6ee5e` (refactor, no behaviour change). The repeated erasure read on the R2 fresh halt re-read: listed, not changed — one extra indexed read paid only on the way to a halt refusal, and the re-read deliberately goes through the whole reader |
| coordinator (MEASURED 2026-10-30, live account, sink only, 2 runs) — after `POST /broadcasts/{id}/cancel` on a `queued` broadcast, GET answers **`canceled` (one L)** at +0/2/15/45 s; DELETE → 403; GET after → 200; re-send → 422. `normaliseStatus` mapped only `cancelled`, so every `cancelled` arm (cascade `cancelled_at_resend`, gate 403-on-cancelled, 138's import-leg cancelled re-mint) was unreachable | `304be0ad7` → `3c80d1093`: both spellings map to `cancelled` (shared by `retrieveBroadcast` and `retrieveBroadcastOnce`); recorded in `.claude/rules/modules/broadcasts.md` (docs) |

No new cascade decision cell: M-NEW-1 is a pre-Resend guard; the pause adds a wait, not an answer; `canceled` lands in cells already decided (404 + `cancelled` → unexpected; 403 + `cancelled` → cancel).

**Gates after round 2, on `0a504dc76`** (this gate list is the only edit after them, docs only):
- `pnpm check` exit 0 (red-first: 64 commits, every logic change has a RED before it; one pre-existing lint warning in `tests/unit/layout/breadcrumb-provider.test.tsx`, not touched here);
- `pnpm vitest run tests/contract/` 256 files, 2838 passed + 2 todo;
- unit broadcasts + broadcast + members: 472 files, 5239/5239;
- integration by path, each exit 0: erasure-vs-dispatch-begun 3, already-sent-evidence 6, eblast-send-time-standing 21, member-erasure-cascade 4, scrub-content-for-member 24, dispatch-persist-before-send 2, audience-import-two-tick 4, eblast-approved-exit-vs-dispatch 7, members/erase-member-cascade-real 2, members/reconcile-erasures 2.
- **Not run locally:** the full `pnpm test:coverage` (CI runs it); no live Verify of round 2 (the pause, the locked re-read and P4 are pinned by unit and integration tests; `canceled` by the gateway unit tests and the coordinator's live measurement).

## Rollout

- **Slice 1 is live on merge for the legacy leg:** erasure now deletes and cancels a dispatch-begun draft.
  - No flag, because this is a privacy fix.
  - Rollback is a revert commit.
  - Once it has merged, runbook step 3b needs no manual Resend action.
- **Slice 2:** migration 0322 runs on deploy (`vercel-build`); the rows start on merge. Rollback is a revert commit; the enum values stay.

## Risks

| Risk | How we notice |
|---|---|
| A slow Resend holds the row lock and the tick blocks | `deleteBroadcastOnce` and `retrieveBroadcastOnce` each have a hard 10 s `AbortSignal.timeout` (the SDK has none), plus the 3 s pause after a 404, so ≈ 23 s at most; the cascade logs `deleteMs` and `resendMs`; `reconcile-erasures` keeps a 240 s budget (checked between members — the accepted bound in P7) |
| An orphan requester's row (no FK) stays `approved` and unsent for ever (P4, review round 2) | WARN `broadcasts.dispatch.requester_not_found` every tick; `broadcasts.dispatch_resolve_failed.total{phase="standing"}` alarms; runbook `member-erasure.md` § "A requester who no longer exists" |
| A Resend outage during erasure | `cascade_partial_failure` → `member_erased` is withheld → the `reconcile-erasures` cron and its gauge |
| A 403 race: mail already sent | the `broadcast_concurrent_action_blocked` row with `resendOutcome: 'already_sent'`, quoted in the DSR answer |

### Review round 3 (30 Oct 2026, on `1f95171bf`)

| Reviewer | Verdict |
|---|---|
| `reliability-guardian` | PASS WITH CONDITIONS. M-NEW-1 and LOW-1 closed; LOW-2 accepted; the shared re-read keeps every caller's semantics |
| `/code-review high` | 9 findings, none a send of an erased member's content |
| `senior-tester` | NOT SHIP-READY on one item: the pinned coverage of `_dispatch-standing-gate.ts` (fixed below) |
| `spec-compliance-auditor` | DE1–4 and DE6 MET; DE5 PARTIAL on wording (fixed below) |

| Finding | Disposition |
|---|---|
| senior-tester CRITICAL — `recordRequesterNotFound` only reached by an integration test (pinned 100%) | `0a4f0a896`: P4 unit cases on both legs |
| senior-tester HIGH — the 10 s timeout not pinned | `0a4f0a896`: `AbortSignal.timeout(10_000)` asserted on both once-methods |
| senior-tester HIGH — the lost-race evidence write failure untested | `0a4f0a896` |
| senior-tester MEDIUM — the re-read helper had no unit test of its own | `0a4f0a896`: `reread-after-lost-race.test.ts`, 8 arms |
| senior-tester MEDIUM — the import leg's erased-draft retryable DELETE has no unit pair (the legacy leg has one) | listed; the arm is shared code (`deleteErasedDraftBeforeRefusal`), unit-tested in the gate tests |
| senior-tester MEDIUM — DE6 does not tell RLS from the tenant predicate | listed (existing read); the two-layer pair is proved for the new evidence read |
| **reliability MEDIUM / code-review #2 — new cell, import leg: a broadcast an operator cancels in the Resend dashboard now reads `cancelled`, so the import leg re-mints and sends** | **Deferred to spec 140** (maintainer: 140 rewrites the import leg's table and makes it the only leg). The leg is dark and prod has 0 broadcasts. Not measured: whether cancelling a partially delivered broadcast also reads `canceled`. On the LIVE legacy leg a canceled inherited id now ends `failed_to_dispatch` with the member's failure email (changelog). |
| code-review #1 / #4 — `broadcasts_already_sent_count` misses (a) a first-pass evidence write that failed before the row reached `sending`, (b) a row already `sending` when the cascade listed rows | Accepted, documented: runbook step 4 runs the STATE query on every erasure regardless of the count (pdpa M-2), and RoPA 8c says such a row is found from state only. Deriving the count from state too is a spec 140 candidate |
| code-review #3 — the reconciler always starts from the oldest stuck erasures, so slow ones can starve newer ones | Listed for spec 140 (a rotating order); a starved erasure shows as half-run, then OVERDUE, on the erasure-log card (runbook step 4) |
| code-review #5 — `missing?: true` on the erased kind instead of its own kind | Listed (Low) |
| code-review #6 — an erased member's submit says "membership suspended" | Accepted in round 1 (pdpa L-2, RoPA 8b) |
| code-review #7–#9 — duplicated once-fetch setup, `countUnexpected` used at some sites only, one erasure read per row per tick | Listed (Low); spec 140's consolidation |
| reliability LOW — the detail page logs `dispatch_hold_read_failed` on an orphan row and shows staff nothing | Listed (Low) |
| reliability LOW — no wait-time field on the locking re-read | Listed (Low) |
| reliability LOW — `reconcileUnresolvedStatus` label `cancelled` instead of `unknown` | No change needed: `cancelled` is already a documented `observed_status` value, and the alarm fires on any label (`docs/observability.md:1332`, `:1382`) |
| auditor DE5 wording (spec Status, DE1 403+cancelled arm, step 3b, D-040 bound, the P4 Evidence label, changelog "closed for sends", the gateway comment, two stale comments, D-038's "directories do not exist") | Fixed in the docs commit after `0a4f0a896` |
| auditor — the PR body was two rounds stale | Rewritten |
