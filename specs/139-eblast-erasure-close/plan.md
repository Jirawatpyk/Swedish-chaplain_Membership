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
     - **200 / 404** → `applyTransition('cancelled')` in the same transaction;
     - **403** → no write, plus the `already_sent` residual audit row;
     - **retryable or other** → unexpected. The reconciler drives it again.

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
- **P5 — A 403 is probed before it is believed** (architect M4). A restricted key also answers 403. On `forbidden`, the cascade calls `retrieveBroadcast`:
  - `queued`, `sending` or `sent` → `already_sent`;
  - anything else → unexpected.
- **P6 — The 403 evidence row is durable** (pdpa H-2, architect L). It is written on its own transaction through `deps.audit.emit(tx, …)`, not through `skipConcurrent`'s `audit.emit(null)`. A failed write counts as unexpected, so the reconciler drives the erasure again. *Revised at /simplify (30 Oct):* the 403 probe and this row come **after** the lock tx ends, because `retrieveBroadcast` retries (up to 31 s) and the SDK has no timeout; a queued / sending / sent broadcast never returns to draft, so deciding outside the lock is safe.
- **P7 — "Clean" can no longer hide a sent E-Blast** (pdpa H-3).
  - The cascade result gains `alreadySentCount`.
  - The members adapter carries it into the `member_erased` payload as `broadcasts_already_sent_count`. This is a payload key, not a new event.
  - Runbook step 4 reads it before ticking the erasure complete.
- **P8 — A lost race is not a server error** (architect M5). When the legacy leg's `/send` 404 → `resource_missing` re-read, or the import leg's `sendLostToHold` re-read, finds `status !== 'approved'`, it is a concurrent skip at info level, not `server_error`.
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
- **D-039 also records** that a single DELETE 404 is trusted (the import leg wants two). The risk is hypothetical, because a 404 to our own id after our own create is not a stale read we have ever observed.

**Slice 2 conditions (pdpa):**
- **M-1:** the orphan sweeps run on one Resend team shared by every tenant, so a deleted row's `tenant_id` comes from our broadcast row. A deletion that cannot be attributed writes no tenant row. It is logged and counted, never filed under a guessed tenant.
- **M-2:** the label for `broadcast_audience_deleted` says the audience (segment) was removed, never that contacts were deleted. They survive (8a).
- **L-2:** a failed audit write logs at error level and increments a counter with an alert rule, as `broadcast_send_started` does.
- **Payload:** `broadcast_id` (nullable for orphans), `related_member_id`, the audience id, `recipient_count`, `leg`, the delete `reason` and `outcome`. No addresses and no hashes.
- **Slice 1's RoPA edits** must not name the slice-2 rows as evidence before they exist.

**Rejected alternatives** (Complexity Tracking, D-039):
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
| 1 | Erasure close: gate + cascade | DE1–DE6 | security-engineer, pdpa-gdpr, reliability-guardian, senior-tester, spec-compliance-auditor | `139-eblast-erasure-close-s1` | — · open |
| 2 | Art. 30 audit events | DA1–DA5 | pdpa-gdpr, drizzle-migration-reviewer, observability-instrumentor, spec-compliance-auditor | `139-eblast-erasure-close-s2` | — · open |

## State table (slice 1: the erasure cascade × a dispatch tick on one row)

| Row when the cascade locks | Tick position | DELETE answer | Handler | Test |
|---|---|---|---|---|
| `approved`, no `resendBroadcastId` | before persist | — (not called) | cancel, as today. The tick's persist CAS then fails, so the mint is reclaimed | existing D1 "import-only id cancelled" + `dispatch-persist-before-send` |
| `approved` + id | after persist, before `/send` | 200 | cancel. The tick's `/send` → 404 → its transition loses | **new** interleave (legacy) |
| `approved` + id | after persist, before `/send`, import leg | 200 | cancel. A re-mint persist waits on the lock, then its CAS fails | **new** interleave (import) |
| `approved` + id | `/send` already accepted | 403 + probe queued/sending/sent | no row write; `already_sent` audit row in the locked tx; `alreadySentCount` +1 | **new** unit 403 arm |
| `approved` + id | any | 403 + probe draft / other | unexpected (a restricted key, not a send) | **new** unit 403-not-sent arm |
| `approved` + id | any | 200, then the cancel tx rolls back (audit write fails) | unexpected; the draft is gone, so a tick's `/send` → 404 → concurrent skip; the reconciler finishes the cancel | **new** unit rollback arm |
| `approved` + id, cascade failed earlier | the next tick reaches the gate first | gate: DELETE `deleted`/`absent` → refuse; other → undecided | P2 | **new** integration "erased gate deletes the draft" (both legs) |
| `approved` + id | any | timeout (10 s) | unexpected, row unchanged | **new** unit timeout arm |
| `approved` + id | none (retryable send failure last tick) | 200 | cancel. The next tick's lock step skips a non-`approved` row | **new** unit 200 arm + DE1 gate test |
| `approved` + id | any | 404 | cancel, `resendOutcome: 'absent'` | **new** unit 404 arm |
| `approved` + id | any | retryable / other | unexpected → `cascade_partial_failure`; row unchanged | **new** unit retryable arm |
| `approved` + id, archive caller | any | — (not called) | skip, as today | **new** DE4 archive test |
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
  - The cascade holds the lock for at most one Resend call.
  - A counter or log line is added for each cascade outcome.
- **VIII Reliability:** fail closed throughout; the reconciler drives retries again.
- **IX Code Quality:** no `return _exhaustive`.
- **X Simplicity:** zero new dependencies.

## Complexity Tracking

| Deviation | Why it is needed | Simpler alternative rejected, and why |
|---|---|---|
| A row lock held across one Resend HTTP call (cascade, erasure mode only) | Our side needs a single arbiter for the row while Resend arbitrates the draft | Cancel-then-DELETE (lying state on 403); unlocked DELETE-then-cancel (the import re-mint from pre-scrub content); a re-check before `/send` (narrows the window, does not close it) |
| The erased refusal writes no standing-refusal row; `broadcast_failed_to_dispatch` carries `standing: 'erased'` | Keeps slice 1 migration-free, so it can gate the flip alone | A new event value (a migration in slice 1); reusing the member-visible `broadcast_membership_suspended_blocked` (it would label an erasure as a suspension) |
| Solo-maintainer review: the five checks in `review-and-ship` § 2 | No second human reviewer | — Evidenced per slice below |

## Evidence

### Slice 1

**Live Verify, 30 Oct 2026, on `71a7f9318`** (`run-chamber-os`: the branch on :3400 from the `f139` worktree, dev Neon, tenant `swecham`, the live Resend Broadcasts account, recipient `delivered@resend.dev` only).
- Before seeding, `SELECT … status='approved' AND scheduled_for <= now()` on dev returned 0 rows, so the cron touched only the seeds.
- The real surfaces were driven: `POST /api/members/{id}/erase` as the e2e super-admin, and `GET /api/cron/broadcasts/dispatch-scheduled`.
- Seeds removed afterwards: 4 members, 4 broadcasts, the Resend audience.

| Done-when | Evidence |
|---|---|
| DE2 200 arm | S1: a real Resend draft (`draft`) on an `approved` row. Erase → `200 cascadesComplete:true`; GET the draft → **404**; the row is `cancelled`; `broadcast_cancelled` has `resendOutcome:"deleted"`; `member_erased` has `broadcasts_already_sent_count:0`; log `dispatch_begun_delete outcome:"deleted"`. |
| DE2 403 arm (8c) | S3: the row's id is a broadcast Resend had already `sent` to the sink. Erase → 200; the row stays `approved`; `broadcast_concurrent_action_blocked` has `{dispatchBegun:true, resendOutcome:"already_sent", observedResendStatus:"sent"}`; `member_erased` has `broadcasts_already_sent_count:1`; log `outcome:"forbidden"`, then the WARN `dispatch_begun_already_sent` (probed after the lock). Made due afterwards, the cron caught it up to `sending` with `broadcast_send_started` (the mail was really out). |
| DE1 + P2 | S2: an erased member and a due row with a real draft. Cron `processed:2, permanent_failed:2`; the draft → **404**; the row is `failed_to_dispatch` / `member_not_in_good_standing`; audit `broadcast_failed_to_dispatch {standing:"erased", resendDraftOutcome:"deleted"}`; no "membership suspended" row. |
| DE1, no id | P4: an erased member with no Resend id → `failed_to_dispatch`, `resendDraftOutcome:"none"`, no Resend call. A second cron tick → `processed:0`. |
| Probes | Wrong cron secret → `401`. Erase as a plain admin → `403 forbidden` (`members.erasure` is super-admin only), nothing written. `identityVerified:false` → `400 invalid_body`. |
| DE3 / DE3b | Not reachable live (the race needs a parked `/send`). Pinned by `tests/integration/broadcasts/erasure-vs-dispatch-begun.test.ts` 3/3 (live Neon; legacy, import tick 2, the import re-mint window). |
| DE4 | `cancel-in-flight-broadcasts-for-member.test.ts`: the default-mode D1 cases (archive), no DELETE. |
| DE6 | `tests/integration/broadcasts/members-bridge-erased-at.test.ts` 3/3. |

**Findings from Verify, fixed after it** (maintainer: "แก้ finding แล้วทำต่อเลย"). Each is pinned by a test; the live run was not repeated.
- **A re-erasure wrote a second `already_sent` row** (measured: 2 rows after 2 erasures). Fixed in `ecbe9fd0b` / `33849eaa6` with `hasAlreadySentEvidenceInTx`, a tenant-scoped EXISTS on `audit_log`. Tests: `tests/integration/broadcasts/already-sent-evidence.test.ts` 4/4, and the unit "a re-erasure … writes no second one".
  - Residual: two concurrent re-drives could both miss the row, because EXISTS is not a lock (403 path only).
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

## Rollout

- **Slice 1 is live on merge for the legacy leg:** erasure now deletes and cancels a dispatch-begun draft.
  - No flag, because this is a privacy fix.
  - Rollback is a revert commit.
  - Once it has merged, step 3b is retired from the runbook.
- **Slice 2:** migration 0322 runs on deploy (`vercel-build`); the rows start on merge. Rollback is a revert commit; the enum values stay.

## Risks

| Risk | How we notice |
|---|---|
| A slow Resend DELETE holds the row lock and the tick blocks | `deleteBroadcastOnce` has a hard 10 s `AbortSignal.timeout` (the SDK has none); the cascade's duration is logged |
| A Resend outage during erasure | `cascade_partial_failure` → `member_erased` is withheld → the `reconcile-erasures` cron and its gauge |
| A 403 race: mail already sent | the `broadcast_concurrent_action_blocked` row with `resendOutcome: 'already_sent'`, quoted in the DSR answer |
