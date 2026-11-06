# 142 — One audience removal row per segment, enforced by the database

**Size**: M (`docs/workflow.md` § Sizes: a migration on `audit_log`, an audit-log write path).
**Status**: started 6 Nov 2026. The plan was agreed by the maintainer in plan mode on 6 Nov 2026.
**Source**: the Low follow-ups of spec 139 slice 2 (PR #763): `specs/139-eblast-erasure-close/plan.md` § Evidence, review rounds 1–3.

## Why

Spec 139 slice 2 writes `broadcast_audience_deleted` once per Resend segment. It enforces that with an advisory lock and an `EXISTS` read on `audit_log` (`hasAudienceDeletedAuditInTx`). Review then added three things around that lock:
- a 5 s `lock_timeout`;
- a WARN arm for a timed-out wait, where the row may or may not exist;
- a deadline charge for the wait in the reclaim cron.

Each was needed only because the dedupe lived in application code. A partial unique index makes the database the single arbiter, so the lock and all three additions can go.

The same slice left three near-copies of the "write an audit row before an irreversible call" envelope (`writeAudienceRow`, `recordUnverifiableCount`) and of its payload literal. They drift independently.

## Premises (checked 6 Nov 2026)

- **Usage.** Prod `audit_log` held 0 `broadcast_audience_deleted` rows: no E-Blast has run since 0327, prod has 0 `broadcasts` rows, and a read-only count at 12:00 UTC on 6 Nov 2026 found 0 audience orphans. The prod `audit_log` row count and the duplicate check are taken before merge, read-only, on the maintainer's order.
- **Dev before cleanup.** Dev `audit_log` held 912,103 rows, 104 of them `broadcast_audience_deleted` (14 with a NULL tenant). One key had two rows: tenant `test-swecham-73d5fae7`, segment `9dd78c02…`, both rows with summary `spec 139 s2 fixture`. They were raw INSERTs by `tests/integration/broadcasts/audience-audit-rows.test.ts`, not rows the product wrote.
- **Dev cleanup.** With the maintainer's yes on 6 Nov 2026, the later of the two rows (`7db7cd75…`) was deleted once, by hand, on dev only. The `audit_log_no_delete` trigger was disabled for that one statement and re-enabled in the same transaction (`tgenabled = 'O'` after). 0 duplicate keys remain.
- **The shared `ci` Neon branch** may hold the same fixture litter. If it does, the migration's pre-check stops loudly in CI, and the maintainer is asked before that branch is touched.
- **Migrations run in one transaction** (drizzle `migrate` → `session.transaction`; `scripts/run-migrations.ts`), so the index is built non-CONCURRENTLY, the shape of `0021_audit_overdue_idempotency.sql`. 0021's 55P04 note is met: the enum value has existed since 0327, which is already merged.
- **The ON CONFLICT precedent is** `src/modules/invoicing/infrastructure/adapters/overdue-audit-adapter.ts:43-63`: `INSERT … ON CONFLICT (…) WHERE event_type = … DO NOTHING RETURNING 1`. The broadcasts adapter (`f7AuditAdapter.emit`) is a plain `INSERT` that takes such a clause.
- **Without a matching index, an `ON CONFLICT` with that target fails (42P10).** `vercel-build` migrates before the new code serves, so deploy order is safe.
- **The hold path.** `tests/integration/broadcasts/eblast-send-time-standing.test.ts:504-568` already asserts one `['broadcast_audience_deleted','hold']` row on live Neon. What is missing is a run against live Resend, which needs a member whose latest renewal cycle is `awaiting_payment` (access `suspended`). The halt flag does not give that: it is a terminal refusal.

## User story

### US1 — The database refuses a second removal row for a segment, and the lock goes

**Done when:**
- **AO1.** Migration 0328 creates `audit_log_audience_deleted_once`, a partial unique index on `(tenant_id, (payload->>'resend_audience_id'))` where `event_type = 'broadcast_audience_deleted'`.
  - Before it builds, a `DO $$` pre-check raises if any duplicate key exists, and names the keys.
  - `db:verify` checks that the index exists.
- **AO2.** `AuditPort.emitOnce` exists for the deleted row only. It runs `INSERT … ON CONFLICT … DO NOTHING RETURNING 1` and answers whether a row was written. A second write for the same tenant and segment answers false and writes nothing.
- **AO3.** The restart, cleanup and reclaim sites write the deleted row through `emitOnce`, with no advisory lock and no `EXISTS` dedupe read on restart and cleanup.
  - *Amended at plan review, 6 Nov 2026:* an `INSERT … ON CONFLICT` still waits on an uncommitted insert of the same key. So `emitOnce` keeps `SET LOCAL lock_timeout` at `AUDIENCE_AUDIT_LOCK_TIMEOUT_MS` (5 s), and a timeout still logs the WARN `*.audience_audit_lock_timeout`.
  - Removed:
    - the advisory lock and its `broadcasts-audience-audit:` namespace;
    - reclaim's deadline charge for the audit wait (`RECLAIM_DEADLINE_MARGIN_MS` covers the DB work);
    - the `_dispatch-lease.ts` "outside W_max" entry, replaced by a note on the INSERT wait.

  Kept:
  - Reclaim still skips a segment that already has a deleted row without reporting it unattributed, through a lockless read.
  - A tenant-binding refusal still fails closed (`AuditPortInvariantError`).
- **AO4.** One shared helper writes a pre-call audit row, so that its success, its lost-row path and its invariant rethrow are not reimplemented. Both the audience rows and `recordUnverifiableCount` use it. `recordUnverifiableCount` keeps its log name `broadcasts.audience_import.unverifiable_audit_emit_failed`. One builder makes the deleted-row payload for every site.
- **AO5.** The docs no longer describe the lock:
  - the RoPA F7 "Removal rows" names one failure mode;
  - `observability.md` § 22.1 / § 22.3 and `cron-jobs.md` are updated;
  - the spec 139 plan rows that describe the lock are marked superseded by 142.

  Every syntactic form of `broadcasts-audience-audit:` and of the advisory-lock dedupe is gone from `src`, `tests` and `docs`, or is marked historical. The lock-timeout wording is rewritten to name the INSERT wait, not the advisory lock.
- **AO6.** The hold path runs against live Resend in the maintainer's `/verify`:
  - one tick on a suspended member's row at tick 2 answers `held`;
  - the segment is gone at Resend, and exactly one `broadcast_audience_deleted` row has `reason: 'hold'`;
  - the next tick writes no second row.

## Out of scope
- The unverifiable dedupe (spec 140 s4, `hasUnverifiableCountAuditInTx`). It keeps its lock: converting it is s4 scope and needs its own duplicate check.
- `readAlreadySentEvidenceInTx`. It is an aggregate with erasure-count semantics, not a dedupe.
- `safeAuditEmit` / `safeAuditEmitTyped` and their ~20 callers. They take the caller's tx and dedupe nothing.

## Open questions
None. The maintainer decided on 6 Nov 2026 to build the index and clean the dev fixture duplicate by hand.
