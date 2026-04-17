# Staff Review — Path C (F1 atomic createUser + Option B + test isolation)

- **Feature**: 005-members-contacts (PR #6)
- **Branch**: `005-members-contacts` @ `5e97e4a`
- **Scope**: 4 new commits since the previous ship-gate review:
  - `b83ae9e` — ESLint: block Application→Infrastructure value imports
  - `984ee14` — refactor(f1): atomic createUser via db.transaction
  - `bee45e0` — feat(db): migration 0018 outbox_permanent_updated_idx
  - `5e97e4a` — test(f3): fix cross-test outbox isolation
- **Diff size**: 19 files, +2947 / −178
- **Date**: 2026-04-17 23:05 +07
- **Prior reviews**: 5 full-F3 rounds (all APPROVED); this is a follow-up focused ONLY on Path C delta
- **Verdict**: ✅ **APPROVED**

---

## Executive Summary

Path C closes the last structural silent-success scenario in the F1 admin-invite flow by wrapping all 4 side effects (user insert + invitation insert + outbox enqueue + audit append) inside a single `db.transaction(...)`. The refactor correctly uses the `CreateUserAbort` throw-to-rollback pattern that mirrors the F3 `UseCaseAbort` already battle-tested in archive-member, change-plan, and the 4 W1-fixed use cases.

Supporting changes:
- **ESLint hardening** — blocks future B1-class regressions by forbidding Application-layer value imports from `@/modules/*/infrastructure/**`. `allowTypeImports: true` keeps the existing DI pattern (type-only imports of port interfaces) legal — the correct scope.
- **Migration 0018** — partial index on `notifications_outbox (updated_at) WHERE status='permanently_failed'` backs the `OutboxHealthBadge` L3 query which runs on every admin page load. Applied to live Neon; verified present via `pg_indexes`.
- **Test isolation fix** — 2 outbox tests from `1b0f7f4` leaked state across the integration suite (stale pending rows inflated `sendMock` call counts and timed out stuck-rows detection). The `beforeEach` guard narrows scope to `tenant_id IS NULL AND status='pending'` so tenant-scoped tests stay untouched.

**All 953 unit + 317 integration tests pass on live Neon post-Path-C.** No blockers, no warnings, 3 non-blocking suggestions.

---

## Findings

| ID | Severity | File | Line(s) | Description | Recommendation |
|----|----------|------|---------|-------------|----------------|
| S1 | 🟢 Suggestion | `src/modules/auth/application/create-user.ts` | 106–107, 124 | `EnqueueInvitationFn` type + `enqueueInvitation` required field in `CreateUserDeps` are now dead code — the atomic flow calls only `enqueueInvitationInTx`. A `grep deps.enqueueInvitation\b` returns 0 hits. Test stubs still fill the field but it is never exercised. Keeping it forces every consumer (route handlers, test stubs) to wire a port they will never use. | Either (a) remove `enqueueInvitation` + `EnqueueInvitationFn` entirely, or (b) mark them optional (`readonly enqueueInvitation?: EnqueueInvitationFn`) with a doc comment explaining they remain only for non-tx callers that may appear in future features. Option (a) is cleaner given no current caller uses it. |
| S2 | 🟢 Suggestion | `src/modules/auth/infrastructure/db/audit-repo.ts` | 46–58, 62–76 | `append` and `appendInTx` duplicate the 2-line `summary` truncation + 6-field value-mapping logic verbatim. Minor but will drift on any schema / truncation-policy change. | Extract a private helper (`buildAuditRow(event)`) that returns the shared `.values({...})` object. Each method then becomes a 3-line wrapper around the correct client (db vs tx). |
| S3 | 🟢 Suggestion | `scripts/apply-migration-0018.ts` | — | One-off workaround for pre-existing `drizzle-kit migrate` drift (snapshots missing between 0009 and 0017). Now that 0018 is applied to live Neon, the script is redundant UNLESS the team plans to apply it on staging/prod later. | Either (a) delete after 0018 hits staging/prod, or (b) keep + rename to `scripts/apply-migration-adhoc.ts` with a parameterised migration name for future drift workarounds. Pre-existing drizzle-kit drift is tracked separately (not Path C scope). |

---

## Cross-Cutting Sweep Results

### Correctness & Logic ✅

| Check | Result |
|-------|--------|
| `db.transaction(async tx => ...)` rollback on throw (not return err) | ✅ Consistent with F3 `UseCaseAbort` pattern |
| Throw-to-rollback coverage: all 5 failure branches throw CreateUserAbort | ✅ email-taken, token-throw, enqueue-err, audit-throw, outer unexpected |
| Post-commit metric ordering (`authMetrics.invitationSent` after `db.transaction` returns) | ✅ Counter stays accurate on rollback |
| Unexpected throws (non-CreateUserAbort) re-raised to route handler | ✅ Maps to 500; log entry `create_user.unexpected_tx_failure` |
| Pre-tx input validation (email shape) short-circuits before tx open | ✅ Saves DB round-trip + tx overhead |

### Security ✅

| Check | Result |
|-------|--------|
| SQL injection surface in migration 0018 | ✅ Parameterless CREATE INDEX, hardcoded literals |
| PII in new logs (`create_user.unexpected_tx_failure`) | ✅ Only `requestId` + `errMessage` — no email/token/userId |
| Race condition on dup-check → insert (TOCTOU) | ✅ Eliminated — dup-check now inside tx holds conceptual lock |
| `enqueueInvitationInTx` error `cause` field | ✅ Sanitised to string (pre-existing pattern preserved) |
| CRON_SECRET still gated | ✅ Unchanged (not touched by Path C) |

### Performance ✅

| Check | Result |
|-------|--------|
| Transaction duration (5 sequential queries) | ✅ Bounded; Neon statement_timeout=5s covers all steps |
| Partial index size | ✅ Minimal — only indexes permanent-failed rows |
| `OutboxHealthBadge` query backed by 0018 index | ✅ `EXPLAIN`-friendly after migration applied |
| N+1 / unbounded loops added | ✅ None |

### Clean Architecture ✅

| Check | Result |
|-------|--------|
| Application-layer imports from `@/modules/*/infrastructure/**` | ✅ 0 value imports (verified via new ESLint rule); only type-only imports remain |
| `DbTx` alias for bare-tx intent | ✅ Exported from `src/lib/db.ts`, semantic wrapper over `TenantTx` |
| `CreateUserAbort` mirrors `UseCaseAbort` | ✅ Same shape; separate class for module locality |

### Test Quality ✅

| Check | Result |
|-------|--------|
| Unit test rewrite (create-user.test.ts — 7 tests) | ✅ Covers happy + invalid-input + email-taken + unexpected-throw + enqueue-err + metric + locale |
| `db.transaction` mock semantics | ✅ Invokes callback with dummy tx; re-throws → matches Drizzle behavior |
| Integration stub updates (last-admin-protection.test.ts) | ✅ `findByEmailInTx` + `createPendingInTx` now passthrough to real repo |
| Test isolation fix — scope guard | ✅ `tenant_id IS NULL` filter preserves F3 tenant-scoped test rows |
| Full-suite regression verified | ✅ 953 unit + 317 integration pass |

---

## Spec Coverage Matrix

| Concern | Addressed | Evidence |
|---------|-----------|----------|
| F1 invitation silent-success (Principle VIII Reliability) | ✅ Structurally eliminated | createUser wraps in `db.transaction`; compensating-delete logic removed |
| Principle III lint enforcement (B1-class regression guard) | ✅ Extended to Application layer | `eslint.config.mjs` — `allowTypeImports: true` preserves DI |
| OutboxHealthBadge scale readiness | ✅ Partial index live | Migration 0018 + `pg_indexes` confirms on `ap-southeast-1` |
| Flaky integration tests from `1b0f7f4` | ✅ Cross-test isolation fixed | `beforeEach` guard + full-suite 317/317 pass |

---

## Test Coverage Assessment

### Path C-specific tests

| Test | Scope | Result |
|------|-------|--------|
| `create-user.test.ts` (7) | Atomic flow shape, error paths, metric ordering | 7/7 ✅ |
| `last-admin-protection.test.ts` (3) | F1 invariant, `oneAdminRepo` stub + new InTx passthroughs | 3/3 ✅ |
| `outbox-permanent-failure.test.ts` (2) | Pre-existing, unchanged by Path C | 2/2 ✅ |
| `outbox-member-invitation.test.ts` (2) | T049 outbox shape, unchanged | 2/2 ✅ |
| `outbox-permanent-failure-metrics.test.ts` (3) | Fixed by isolation guard | 3/3 ✅ |
| `outbox-stuck-rows.test.ts` (2) | Fixed by isolation guard | 2/2 ✅ |

### Missing from Path C (non-blocking)

| Gap | Justification |
|-----|---------------|
| Live integration test for "enqueue fail → tx rollback" | Simulating an in-tx outbox INSERT failure requires mocking `enqueueInvitationInTx` at adapter boundary; the unit test at `create-user.test.ts:199-251` covers the state-machine shape. Not required for ship. |
| Concurrent-admin-invite TOCTOU race coverage | Pre-Path-C was theoretical; Path C eliminates it structurally. Racing two `createUser` calls on the same email now produces exactly one user + one 409 (email-taken). Worth a future integration test but non-blocking. |

---

## Constitution Compliance

| # | Principle | Status |
|---|-----------|--------|
| I (NN) Data Privacy + Tenant Isolation | ✅ Unchanged; F1 is cross-tenant, outbox row tenant_id=null per migration 0011 |
| II (NN) Test-First | ✅ Unit tests rewritten before refactor landed (see commit order) |
| III (NN) Clean Architecture | ✅ ENHANCED — ESLint rule now blocks Application→Infrastructure value imports project-wide |
| IV (NN) PCI DSS | ✅ N/A |
| V i18n | ✅ Unchanged (725 × 3 locales) |
| VI Inclusive UX | ✅ Unchanged |
| VII Performance & Observability | ⚠️ Partial (T158 staging perf still human-gated) |
| VIII **Reliability** | ✅ **STRENGTHENED** — atomicity now structural, not compensating |
| IX Code Quality | ✅ typecheck + lint + i18n clean |
| X Simplicity | ✅ Compensating-delete logic removed (less code, clearer invariant) |

---

## Metrics

| Metric | Value |
|--------|-------|
| Commits in scope | 4 (b83ae9e, 984ee14, bee45e0, 5e97e4a) |
| Files changed | 19 |
| Lines added | +2,947 |
| Lines removed | −178 |
| Findings | 0 Blocker / 0 Warning / **3 Suggestion (non-blocking)** |
| Constitution violations | 0 |
| Test results (post-Path-C) | Unit 953/953 ✅ · Integration 317/317 ✅ (+ 4 skipped) · Typecheck clean · Lint clean |

---

## Recommended Actions

### Before merge (none required)
No blocking or warning-level fixes. PR #6 is ship-ready.

### Post-merge cleanup (optional)
1. **S1** — Remove `EnqueueInvitationFn` + `enqueueInvitation` dead field. ~5 min. Propagates to `auth-deps.ts` + 1 unit test stub.
2. **S2** — Extract `buildAuditRow(event)` helper in `audit-repo.ts`. ~10 min.
3. **S3** — Delete `scripts/apply-migration-0018.ts` once staging/prod are synced; alternatively promote it to a generic adhoc runner.

### Separately tracked
4. **drizzle-kit journal drift** — pre-existing; snapshots missing between 0009 and 0017 prevent `pnpm db:migrate` from working cleanly. Not Path C scope; should get its own ticket + staging catch-up migration.
5. **T158** — staging perf traces (human-gated, unchanged).

---

## Verdict

✅ **APPROVED**

Path C delivers what the prior reviews flagged as "nice-to-have" (structural silent-success fix) with proper engineering rigor: the `CreateUserAbort` pattern matches F3's existing `UseCaseAbort`, the ESLint rule choice (`allowTypeImports: true`) correctly distinguishes value from type imports, and the test isolation fix is scoped narrowly (`tenant_id IS NULL`) to avoid cascade effects on tenant-scoped test files.

Three suggestions are minor cleanup items that can land in a follow-up chore commit or be deferred.

**Next step**: `gh pr merge 6 --squash` (or equivalent) once reviewer sign-off lands. T158 staging perf + Grafana dashboard wiring remain the only open post-merge operational gates.
