# Plan: one audience removal row per segment, enforced by the database

Spec: `specs/142-audience-audit-once/spec.md` · Size: M · Agreed by the user on: 6 Nov 2026 (plan mode; the dev cleanup decided the same day)

## Approach

A partial unique index on `audit_log` replaces the advisory lock and `EXISTS` dedupe of `broadcast_audience_deleted`. The deleted row is written through a new `emitOnce` (since review round 1 on the narrow port `AudienceDeletedAuditPort`, not `AuditPort`), an `INSERT … ON CONFLICT … DO NOTHING RETURNING 1` like the invoicing overdue adapter's. It answers whether it wrote. With the database as the arbiter, three things that existed only to bound or route the lock wait go:
- the 5 s `lock_timeout`;
- the WARN arm for a timed-out wait;
- reclaim's deadline charge for that wait.

The pre-call envelope is shared. `writeAudienceRow` (spec 139 s2) and `recordUnverifiableCount` (spec 140 s4) implement the same policy:
- a row written in its own tenant transaction before an irreversible Resend call;
- an adapter invariant error rethrown;
- any other failure logged at ERROR and counted, with the call going ahead.

They become one helper. One builder makes the deleted-row payload.

**Alternatives not taken:**
- **Keep the lock** (the maintainer's option 2). Rejected by the maintainer: it keeps three mechanisms that exist only for the lock.
- **Exclude old rows with a date literal in the index predicate.** An unsourced bound in a constraint, which leaves earlier rows unconstrained and has to be repeated in every `ON CONFLICT`.
- **A `DELETE` of the duplicates inside the migration.** That migration also runs on prod, and it would set a precedent for deleting from the append-only table. The one dev duplicate was cleaned by hand instead (spec § Premises).
- **Converting the unverifiable and evidence reads too.** Out of scope (spec § Out of scope).

**Paths kept compatible:** `recordUnverifiableCount`'s behaviour and log name (`broadcasts.audience_import.unverifiable_audit_emit_failed`). Its usage is the import tick on every failed membership count; prod has 0 broadcasts (spec § Premises).

## Files and modules

Rules: `.claude/rules/modules/broadcasts.md`, in particular "Gates and audit rows for Resend calls" and "A bound in prose names its source"; `architecture.md` (migrations, `tx` threading).
- **Migration:** `drizzle/migrations/0328_audit_log_audience_deleted_once.sql`, plus its `meta/_journal.json` entry (idx 329; its `when` is above 0327's `1798546000000`).
- **`scripts/verify-schema.ts`:** a canary for the index.
- **Port:** `src/modules/broadcasts/application/ports/audit-port.ts`. Add `emitOnce` on the narrow `AudienceDeletedAuditPort` (review round 1). *Superseded:* `AUDIENCE_AUDIT_LOCK_TIMEOUT_MS` is kept (plan review fold-in).
- **Adapter:** `src/modules/broadcasts/infrastructure/audit-adapter.ts`. Add `emitOnce`.
- **Use cases:**
  - new shared `application/use-cases/_pre-call-audit-row.ts`;
  - `_audience-audit.ts`, which uses it, with one deleted-payload builder;
  - `build-audience-tick.ts` (`recordUnverifiableCount`, which uses it);
  - `reclaim-orphaned-audiences.ts` (the deadline charge goes);
  - `_dispatch-lease.ts` (its docblock entry goes).
- **Repo:** `ports/broadcasts-repo.ts` and `infrastructure/db/drizzle-broadcasts-repo.ts`.
  - `hasAudienceDeletedAuditInTx` becomes a lockless read, used only by reclaim, with no `SET LOCAL` and no lock. It keeps `assertAudienceAuditTenantBoundTx`.
  - `setLocalLockTimeout` stays for its other callers.
- **Tests:**
  - the unit files for the three sites and the source scan;
  - `audience-audit-rows.test.ts`. Its lock cells become constraint cells, and its fixture must never seed two deleted rows for one key;
  - every typed `AuditPort` fake, found by grepping the symbol `AuditPort`.
- **Docs:**
  - RoPA F7 "Removal rows", `observability.md` § 22.1 / § 22.3 and `cron-jobs.md`;
  - spec 139 `plan.md`, where the rows that describe the lock are marked superseded;
  - the changelog.

## Data model and migration

0328 is one statement after a pre-check:
```sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM audit_log WHERE event_type = 'broadcast_audience_deleted' AND tenant_id IS NOT NULL
             GROUP BY tenant_id, payload->>'resend_audience_id' HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0328: duplicate broadcast_audience_deleted keys exist; clean them first (spec 142 § Premises)';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_audience_deleted_once
  ON audit_log (tenant_id, (payload->>'resend_audience_id'))
  WHERE event_type = 'broadcast_audience_deleted';
```
- **NULL tenants:** a NULL `tenant_id` never conflicts, which is standard unique-index semantics. These are test fixtures only, because the product always writes a tenant.
- **Build:** non-CONCURRENTLY inside the migration tx, as 0021 does. The dev build time is measured and recorded here.
- **Rollout:** the migration is unflagged. `vercel-build` migrates before the code serves.
- **Rollback:** reverting the code is safe, because a plain `emit` is not used for this event after the change. Dropping the index takes a forward migration.

## Test plan

| Done-when line | Test that goes red first (file, name) | Level |
|---|---|---|
| AO1: the index exists | `scripts/verify-schema.ts` canary; `audience-audit-rows.test.ts` "a second deleted row for the same tenant and segment is refused by the index (23505)" (a raw second INSERT, rolled back) | integration |
| AO1: the pre-check | `audience-audit-rows.test.ts` or a migration test: the pre-check SQL raises on a seeded duplicate in a rolled-back tx | integration |
| AO2: `emitOnce` writes once | `audience-audit-rows.test.ts` "f7AuditAdapter.emitOnce > answers true, then false, and leaves one row"; "two concurrent emitOnce for one segment leave one row: the second waits, then answers false"; "an INSERT behind a held insert of the key fails with a lock timeout (55P03, not an invariant error)" (these replace the held-lock and lock-timeout cells) | integration |
| AO2: other tenants | the same file, cross-tenant: tenant B's row for the same segment id does not block tenant A's (the key includes the tenant) | integration |
| AO3: restart, cleanup and reclaim write through `emitOnce`, with no lock | the unit files of the three sites: the call order shows `emitOnce` and no `hasAudienceDeletedAuditInTx` in restart/cleanup; reclaim reads the lockless check, then the disclosure, then `emitOnce` | unit |
| AO3: reclaim skips a recorded segment with no unattributed WARN | the existing reclaim cell, kept | unit |
| AO3: a tenant-binding refusal still fails closed | the existing integration cross-tenant cell, kept | integration |
| AO3: the lock-timeout arms now bound the INSERT wait (plan review fold-in) | *Superseded:* the cells were not deleted; they moved onto the INSERT wait. Live-Neon: `audience-audit-rows.test.ts` 55P03 cell (waits about 5.5 s). The old reclaim deadline-charge cell is deleted, and a budget cell (a chunk starts when exactly one Resend call fits) replaces it. The source scan pins the writers to `emitOnce` | unit + integration |
| AO4: one helper | `recordUnverifiableCount`'s unit and integration cells pass unchanged through the helper; a helper unit test covers invariant rethrow, lost row (ERROR + `auditEmitFailed`, the call proceeds), and written (`auditEmitCount`) | unit + integration |
| AO5: the docs | the grep in spec AO5 returns nothing outside history markers | gate (grep in the PR) |
| AO6: hold on live Resend | the maintainer's `/verify` | verify |

**Cross-tenant:** the AO2 row above. **e2e:** none, because the change touches no UI.

## Plan review fold-in (6 Nov 2026: drizzle-migration-reviewer, reliability-guardian)

Where these points and the sections above disagree, these points win.

**`emitOnce` (migration H1, reliability M2)**
- **A literal conflict clause.** The `ON CONFLICT` target and `WHERE` are fixed SQL text, never parameters: `ON CONFLICT (tenant_id, (payload->>'resend_audience_id')) WHERE event_type = 'broadcast_audience_deleted' DO NOTHING RETURNING 1`. With a parameter, as in `emit()`'s `${eventType}::audit_event_type` or the `${AUDIENCE_AUDIT_PAYLOAD_KEYS}` interpolation, Postgres cannot prove the predicate and answers 42P10. The `VALUES` row stays parameterised.
- **Errors propagate.** Unlike the overdue adapter, `emitOnce` swallows nothing, so a lost row still reaches the helper's ERROR and counter.
- **Refusals.** It refuses a null tx and a null `tenantId` (`AuditPortInvariantError`). In a unique index NULLs never conflict, so either would silently allow duplicates.
- **The segment id is required by type.** The one deleted-row builder requires `resend_audience_id`, for the same reason.
- **A tenant check at every site.** `assertAudienceAuditTenantBoundTx` runs at all three sites before `emitOnce`, either inside `emitOnce` or in the repo read; restart and cleanup used to get it from `hasAudienceDeletedAuditInTx`.

**The wait is not gone (reliability M1)**
- An `INSERT … ON CONFLICT` still waits on another transaction that holds an uncommitted insert of the same key. If that transaction commits, ours does nothing and answers false. If it rolls back, ours writes and answers true. "First reason wins" therefore still holds, and a rollback is handled correctly.
- `emitOnce` keeps `SET LOCAL lock_timeout` at `AUDIENCE_AUDIT_LOCK_TIMEOUT_MS` (5 s; the pooler drops `statement_timeout`). The constant stays and so does its WARN arm (`*.audience_audit_lock_timeout`, 55P03). What goes is the advisory lock, the `EXISTS` read on restart and cleanup, and the lock namespace.
- In practice the key holder's transaction is a single INSERT, so the wait is milliseconds.
- **Reclaim's deadline charge is removed** (reliability L3). `RECLAIM_DEADLINE_MARGIN_MS` = 30 s already covers the DB work, and the Resend call is bounded by `RESEND_CALL_TIMEOUT_MS`. A comment beside the check (~:420) says so.
- **Superseded:** § Approach's "the lock and all three additions can go", and AO3's removal of the `lock_timeout` and the WARN.

**Migration 0328 (migration M2–M3, L5–L6; reliability M3, L4)**
- **Lock timeout.** `SET LOCAL lock_timeout = '5s';--> statement-breakpoint` comes before the CREATE, and the old value is restored as the last statement (the 0325:96-99 pattern). A non-CONCURRENTLY build holds a SHARE lock, which blocks every audit INSERT, sign-in included. Do not copy 0021's header claim that it takes "ACCESS EXCLUSIVE".
- **No CONCURRENTLY.** The repo has no precedent for it, and `run-migrations.ts` cannot run a statement outside the transaction.
- **Build time.** Dev: heap 270 MB, about 860k rows, a full seq scan in 982 ms, so the build should take about 1–2 s. 0021's own rule says to go CONCURRENTLY outside the pipeline above 1M rows, so the prod row count (measured before merge) is recorded against it.
- **The pre-check names the keys.** It filters `AND payload ? 'resend_audience_id' AND tenant_id IS NOT NULL`, collects `string_agg(tenant_id || '/' || (payload->>'resend_audience_id'), ', ')` into a variable, and raises `'0328: duplicate keys: %'`. Neither value is a forbidden log field.
- **`--> statement-breakpoint`** follows `END $$;`.
- **Journal:** idx 329, `when` 1798546100000. Re-check before merge.
- **`db:verify` canary:** take the `LIKE` text from `pg_get_indexdef` on dev after the apply, not from the file, and require `CREATE UNIQUE INDEX%` with its `WHERE`. Add a positive control.
- **Not touched:** `enum-migration-guard`.
- **RLS:** checked and passing. One `FOR ALL` policy with identical `USING` and `WITH CHECK`; `DO NOTHING` checks only the new row; the tenant is in the key. No grant change is needed.

**The shared helper (reliability L1)**
- `recordUnverifiableCount` differs from `writeAudienceRow`, and its differences survive:
  - on an invariant error it rethrows without logging;
  - its lost-row log is `broadcasts.audience_import.unverifiable_audit_emit_failed` with `{ err: errKind(e), tenantId, broadcastId, importId }`, and no severity or eventType;
  - its dedupe uses its own lock;
  - the caller's re-gate stays outside the helper and runs on every outcome.
- The helper therefore takes a caller-supplied `onLost` / `onInvariant` log hook. AO4's "its unit cells pass unchanged" stands only if those differences are kept.

**Reclaim (reliability L2)**
- `emitOnce` answering false maps to `'skip'`: no unattributed WARN and no `auditEmitCount`.
- The lockless `EXISTS` read before the disclosure read no longer orders reclaim against cleanup. The worst case is one false WARN, because cleanup acts on a live row and reclaim on a gone one. The docblock says so.

**Added test cells**
- two concurrent `emitOnce` where the first rolls back → the second writes (true);
- an adapter error → the ERROR `audience_audit_lost`, not a skip;
- tenant B's row does not block tenant A;
- the pre-check does not raise on rows whose key is NULL;
- the source scan pins the deleted-row writers to `emitOnce`;
- `emitOnce` with a null tenant or a null tx → `AuditPortInvariantError`.

Kept unchanged: the reclaim skip cell, the cross-tenant fail-closed cell, every `recordUnverifiableCount` cell, and the hold cell (`eblast-send-time-standing.test.ts:504-568`).

## Review round 1 fold-in (7 Nov 2026: code-review, migration and reliability findings on PR #767)

Where these rows and the sections above disagree, these rows win. Each mechanism the reviewers asked for gets its row here before its GREEN commit (D-043).

| Finding | Mechanism | Test (file, name) | Commit kind |
|---|---|---|---|
| R1 (CR #7) | `emitOnce` leaves the shared `AuditPort` for a narrow `AudienceDeletedAuditPort`; `f7AuditAdapter` implements both; the restart (`BuildAudienceTickDeps.audit`), cleanup and reclaim deps take it; the unrelated test fakes lose their `emitOnce` stub | typecheck finds the set (a stray stub is an excess property, a missing one a missing property); the existing site cells stay green | refactor |
| R2 (CR #3) | `emit`, `emitTyped` (through `emit`) and the multi-row `emitMany` / `emitManyTyped` refuse `broadcast_audience_deleted` with `AuditPortInvariantError` before any write; `emitOnce` is its only writer | `audience-audit-rows.test.ts` "emit, emitTyped and emitMany refuse broadcast_audience_deleted before any write" | test (red) → fix |
| R3 (CR #5, migration L1) | Reclaim reads the disclosure first. Found: `emitOnce` (false is a skip). Not found: the lockless existence read, found is a skip with no WARN, else unattributed. `hasAudienceDeletedAuditInTx` writes the key as the literal `payload->>'resend_audience_id'`, so the read's expression matches the index's | `reclaim-orphaned-audiences.test.ts`, the call-order cells (disclosure first); `audience-audit-sites.test.ts` "the deleted-row key is the literal AUDIENCE_AUDIT_PAYLOAD_KEYS.resendAudienceId in the read, the ON CONFLICT and 0328" | test (red) → fix |
| R4 (CR #8, migration L2) | 0328's `CREATE UNIQUE INDEX` loses `IF NOT EXISTS`, so a name clash fails the migration; the pre-check loses the redundant `payload ? 'resend_audience_id'` (`->> IS NOT NULL` covers it). Dev keeps the index built by the earlier file version (same definition); `db:migrate` is not re-run, `db:verify` re-checked | `audience-audit-rows.test.ts` "the CREATE statement fails on an existing index name (42P07), not a NOTICE"; the NULL-key pre-check cell covers the filter | test (red) → fix |
| R5 (CR #2) | The port docblock: `emitOnce` runs `SET LOCAL lock_timeout` for the rest of the caller's tx, so it runs in its own tx and as its last lock-taking statement | — (a docblock) | docs |
| R6 (CR #4) | `RECLAIM_DEADLINE_MARGIN_MS`'s docblock names the per-orphan audit-row DB work and the INSERT wait the last chunk can overrun by | — (a docblock) | docs |
| R7 (CR #6) | One row builder for `emit`, `emitMany` and `emitOnce`: the column list and the defaults exist once; `emitOnce` keeps its literal event type and `ON CONFLICT` | the existing `audience-audit-rows.test.ts` adapter cells (a 42P10 would fail them) | refactor |
| R8 (reliability L1) | Pin the unverifiable row's lost line (`broadcasts.audience_import.unverifiable_audit_emit_failed` with `{ err, tenantId, broadcastId, importId }`, `auditEmitFailed`) and the invariant arm's silence | `build-audience-tick-failure-paths.test.ts` "a lost unverifiable row …" and "(d) an AuditPortInvariantError on the unverifiable row …" | test (characterization) |
| R9 (reliability L2) | `emitOnce` refuses an empty `resend_audience_id` and a wrong event type, with no row written | `audience-audit-rows.test.ts` "refuses an empty resend_audience_id and another event type as invariant errors" | test (characterization) |

**Superseded by these rows:** the Test plan's AO3 order ("reclaim reads the lockless check, then the disclosure, then `emitOnce`"); § Data model's `CREATE UNIQUE INDEX IF NOT EXISTS`; the fold-in's pre-check filter `AND payload ? 'resend_audience_id'`; the port's "REQUIRED" note on `emitOnce`.

## Review round 2 fold-in (7 Nov 2026: code-review and reliability findings on PR #767)

Where these rows and the sections above disagree, these rows win. Each row lands before its GREEN commit (D-043).

| Finding | Mechanism | Test (file, name) | Commit kind |
|---|---|---|---|
| S1 (CR2 #1, #3, reliability r2 LOW) | 0328 is idempotent again: `CREATE UNIQUE INDEX IF NOT EXISTS`, then a `DO $$` block that reads `pg_indexes.indexdef` for the name and raises `0328: index audit_log_audience_deleted_once has another definition` unless it equals the text `pg_get_indexdef` prints on dev (exact string; a missing index raises too). A re-run is a no-op; an index of another definition under the name still fails the deploy. Dev keeps its index; `db:migrate` is not re-run | `audience-audit-rows.test.ts` "the index check passes on the live index, whose indexdef is the check's expected text" and "the index check raises on another definition and on a missing index" (both read-only: the check reads `pg_indexes` only; no index is created on `audit_log`). They replace the 42P07 cell, which took a SHARE lock on the shared table | test (red) → fix |
| S2 (CR2 #2) | `AuditEmitInput.eventType` is `F7EmitEventType` (`F7AuditEventType` without `broadcast_audience_deleted`), so `emit` and `emitMany` reject the event at compile time; `emitTyped` and `emitManyTyped` constrain `E` to `F7EmitTypedEventType` (`keyof F7AuditPayloadShapes` without it). The runtime refusal stays (a cast past the type) | `audit-port-typed-constraint.test.ts` "emit, emitTyped, emitMany and emitManyTyped do not compile with broadcast_audience_deleted" (`@ts-expect-error` cells; RED is the unused-directive errors from `tsc`) | test (red) → fix |
| S3 (CR2 #6) | Every adapter INSERT binds `event_type` in `VALUES`, `emitOnce` included; only the `ON CONFLICT` target and its `WHERE` stay literal (a bound VALUES cell does not affect index inference) | the existing `audience-audit-rows.test.ts` `emitOnce` cells (true then false, concurrent, rollback); a 42P10 would fail them | refactor |
| S4 (CR2 #7) | `AuditRowFields` is `AuditEmitInput \| AudienceDeletedEmitInput`, the two port inputs, not a hand-declared copy | typecheck | refactor |
| S5 (CR2 #5) | `RECLAIM_DEADLINE_MARGIN_MS`'s docblock: the INSERT wait is bounded by `AUDIENCE_AUDIT_LOCK_TIMEOUT_MS`, but the tenant probe and the two reads have no statement bound (the pooler drops `statement_timeout`), so the margin covers their typical cost, not a worst case | — (a docblock) | docs |

**Superseded by these rows:** R4's "loses `IF NOT EXISTS`" and its 42P07 cell.

## Constitution Check
- **I Privacy & Security:**
  - the index key includes the tenant;
  - payloads are unchanged (ids and counts only);
  - the RoPA is updated in the same PR;
  - the one dev `audit_log` delete was a one-off, made on the maintainer's word on dev test data and recorded in the spec's Premises.
- **II Test-First:** a RED commit comes before each GREEN commit, and `check:red-first` checks it.
- **III Clean Architecture:** `emitOnce` is a port method, and the SQL stays in infrastructure.
- **IV PCI:** n/a.
- **V i18n:** n/a, because no labels change.
- **VI Inclusive UX:** n/a.
- **VII Perf & Observability:**
  - removes a lock and up to 5 s of wait from every removal;
  - the index is maintained only for rows of this event type (partial);
  - the build is timed on dev.
- **VIII Reliability:** the database is the single arbiter, and a lost row keeps its ERROR and counter.
- **IX Code Quality:** one helper replaces two copies, and there is no `return _exhaustive`.
- **X Simplicity:** zero new dependencies, and the change removes code.

## Complexity Tracking

| Deviation | Why it is needed | Simpler alternative rejected, and why |
|---|---|---|
| A one-off manual delete of 1 fixture row in dev `audit_log`, with the append-only trigger disabled for one statement | The unique index cannot build while a duplicate exists, and the migration must not delete rows (it also runs on prod) | A delete inside the migration (a prod precedent on an append-only table); a date literal in the predicate (unsourced, and it leaves rows unconstrained) |
| Solo-maintainer review (audit log) | No second human reviewer | — the five checks are evidenced in § Evidence |

## Evidence

### Dev cleanup (6 Nov 2026, the maintainer's yes)
`node wt/v139/devdedupe.mjs` ran on host `ep-gentle-king-…` (dev). It refuses any other host.

The guard: exactly 1 row with id `7db7cd75-85ed-4047-b2f5-5f5cc4581799`, `broadcast_audience_deleted`, summary `spec 139 s2 fixture`, and a tenant matching `test-%`.

The delete ran with `audit_log_no_delete` disabled, and the trigger was re-enabled in the same transaction.

Result: `{"deleted":["7db7cd75-85ed-4047-b2f5-5f5cc4581799"],"triggerEnabled":"O","remainingDuplicateKeys":0}`.

The guard, as run (pdpa round 1 L-3), in one transaction:
```sql
-- refuse unless exactly one row matches all four guards
SELECT id FROM audit_log WHERE id = '7db7cd75-85ed-4047-b2f5-5f5cc4581799'::uuid
  AND event_type = 'broadcast_audience_deleted' AND summary = 'spec 139 s2 fixture' AND tenant_id LIKE 'test-%';
ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete;
DELETE FROM audit_log WHERE id = '7db7cd75-85ed-4047-b2f5-5f5cc4581799'::uuid
  AND event_type = 'broadcast_audience_deleted' AND summary = 'spec 139 s2 fixture' AND tenant_id LIKE 'test-%' RETURNING id;
ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete;
```
The script refused any host but `ep-gentle-king-` (the dev branch).

## Rollout
- Unflagged.
- Migration 0328 runs on deploy, before the code serves.
- Rollback is a revert commit. The index stays and is harmless.

## Risks

| Risk | How we notice |
|---|---|
| The shared `ci` Neon branch holds fixture duplicates | The pre-check RAISE fails the migration in CI, naming the cause. The maintainer is asked before that branch is touched |
| The index build is slow on prod `audit_log` | The prod row count is measured before merge, and the dev build time is recorded above |
| A future writer uses plain `emit` for this event and gets a 23505 | It lands in the lost-row ERROR. The source scan pins the deleted-row writers to `emitOnce` |
