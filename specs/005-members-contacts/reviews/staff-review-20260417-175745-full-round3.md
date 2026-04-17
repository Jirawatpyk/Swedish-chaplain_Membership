# Staff Review — F3 Members & Contacts (Full Holistic Round 3)

- **Feature**: 005-members-contacts
- **Branch**: `005-members-contacts` @ `0690c27`
- **Diff range**: `58526ad..HEAD` = 51 commits
- **Date**: 2026-04-17 17:57 +07
- **Prior reviews**: staff-review-20260417-161134 (found B1+W1, fixed in 83b075a) → staff-review-20260417-170823 (found S1, fixed in 0690c27)
- **Verdict**: ⚠️ **APPROVED WITH CONDITIONS**

---

## Executive Summary

Third full-F3 holistic sweep, run immediately after the S1 refactor landed in commit `0690c27`. The refactor correctly removed all 6 Infrastructure-layer `tx.insert(auditLog)` sites and moved audit ownership to the Application layer (confirmed clean by grep). Typecheck + lint + full unit (235/235) + full integration (123/123 on live Neon) all pass.

However, a fresh read of the 6 refactored use cases surfaced **one new regression** that the tests did not catch: the `runInTenant(ctx, async tx => {...})` callbacks use `return err(...)` on sub-step failures instead of `throw`. In Drizzle, `db.transaction` only rolls back when the callback **throws**; a normal `return` (even of an `err` Result) **commits** the tx. The pre-refactor Infrastructure code relied on the adapter throwing on audit-insert failure, which rolled back the preceding repo write. The new code silently commits in the same failure scenario.

Severity: 🟡 **Warning**, not 🔴 Blocker — the regression surfaces only when `audit.recordInTx` fails after a successful repo write (a rare but possible compliance gap). The fix is mechanical: replace `return err(...)` with `throw new UseCaseAbort(...)` following the pattern already used by `archive-member.ts` and `change-plan.ts`.

No Blockers. F3 can technically ship as-is (same atomicity as pre-refactor for repo-only failures), but the audit-gap window is a reliability regression that should be closed in a short follow-up commit before `/speckit.ship`.

---

## Findings

| ID | Severity | File | Line(s) | Description | Recommendation |
|----|----------|------|---------|-------------|----------------|
| **W1** | 🟡 Warning (Principle VIII Reliability — audit atomicity regression) | `src/modules/members/application/use-cases/contact-crud.ts` | 133, 214, 271, 316 | 4 `runInTenant` callbacks use `return err(...)` on sub-step failures instead of `throw`. Drizzle's `db.transaction` COMMITS on a normal return (even of an `err` Result); it only rolls back on `throw`. If `audit.recordInTx` fails after `addInTx` / `updateInTx` / `removeInTx` / `promotePrimaryInTx` succeeds, the repo write commits without the matching audit row → compliance gap. | Replace `if (!step.ok) return step;` + `if (!auditResult.ok) return err(auditResult.error);` with `throw new UseCaseAbort(step.error)` inside the tx, catch outside `runInTenant` to map to typed `ContactCrudError`. Pattern already used in `archive-member.ts:ArchiveNotFoundError/TxAbort` + `change-plan.ts:TxAbort`. |
| **W1** | 🟡 Warning | `src/modules/members/application/use-cases/create-member.ts` | 311 (+ audit check branches) | Same pattern — `runInTenant` callback returns `err` instead of throwing. If the `contact_created` audit fails after `member_created` audit succeeds after the 2 inserts, all data commits without the `contact_created` evidence. | Use `throw new UseCaseAbort(...)` pattern. |
| **W1** | 🟡 Warning | `src/modules/members/application/use-cases/invite-colleague.ts` | 157, 164 (+ audit branch) | Same pattern. Worst case: `addInTx` succeeds, `linkUserInTx` fails (e.g., concurrent link from another flow) → tx commits orphan contact. The "one tx so all three land or none do" claim in the commit message is only true for internal DB errors that throw; it is NOT true for Result-returned failures. | `throw new UseCaseAbort(...)` in the 3 failure branches. |
| **W1** | 🟡 Warning | `src/modules/members/application/use-cases/member-self-update.ts` | 299 (+ audit branch) | Same pattern. Contact update can commit without the `contact_updated` audit if the audit-write fails. | `throw new UseCaseAbort(...)`. |

**All 4 instances of W1 are one conceptual bug** (atomicity model mismatch), appearing in 4 files touched by the S1 refactor.

---

## Cross-Cutting Sweep Results (this pass)

### Verification checks (clean)

| Check | Result |
|-------|--------|
| `tx.insert(auditLog) / db.insert(auditLog)` outside audit-adapter.ts | ✅ **0** (S1 goal achieved) |
| Application-layer imports from `@/modules/auth/infrastructure` | ✅ **0** (B1 goal achieved) |
| `actorUserId` / `requestId` params leaked into `ContactRepo` port signatures | ✅ 0 (removed by S1) |
| `runInTenant` still used in Infrastructure read-only methods | ✅ Yes — `listByMember` + `findById` (appropriate for read-only repos) |
| `MembersDeps` wiring completeness (`audit`, `invitations`, all ports) | ✅ Confirmed |
| ESLint `no-restricted-imports` rule enforcement | ⚠️ Still scoped only to `src/modules/*/domain/**` — does NOT cover `src/modules/*/application/**` (pre-existing gap flagged in round-2) |

### New regression checks (this pass)

| Check | Result |
|-------|--------|
| `runInTenant(ctx, async tx => { ... return err(...) })` — does Drizzle commit or rollback? | 🟡 **Commits** (see W1 finding) |
| Tests covering the audit-failure-after-repo-success path | ❌ None — the current test suite does not simulate this failure mode; both `audit.record` + `audit.recordInTx` stubs default to `ok(undefined)` |

### What's NOT a regression (honest comparison vs pre-S1)

| Scenario | Pre-S1 behavior | Post-S1 behavior | Net |
|----------|-----------------|------------------|-----|
| `addInTx` itself fails (unique-violation) | Repo returns err (no audit written) | Same — repo returns err, callback returns err, tx commits (nothing inserted) | **Equal** |
| `addInTx` succeeds, no audit written | N/A — audit was part of the same tx; if audit failed, tx threw and rolled back `add` | `addInTx` commits + audit row missing | **REGRESSION** — audit gap window |
| Connection drop / DB error mid-tx | Tx aborts, Drizzle re-throws | Same — still throws out of the `await` → rollback | **Equal** |
| `runInTenant` fails to set tenant GUC | Throws, rolls back | Same | **Equal** |

So the regression is *specifically* the audit-failure-after-repo-success path in 4 files — narrow but real.

---

## Constitution Compliance

| # | Principle | Status | Notes |
|---|-----------|--------|-------|
| I (NN) | Data Privacy & Security + Tenant Isolation | ✅ Pass | Unchanged |
| II (NN) | Test-First Development | ⚠️ Partial | W1 identified because of *absent* test coverage — no test exercises the audit-failure branch. Adding the throw + a fail-mode test would also close a TDD gap. |
| III (NN) | **Clean Architecture** | ✅ Pass | S1 correctly closed — 0 Infrastructure imports in Application |
| IV (NN) | PCI DSS | ✅ N/A | Unchanged |
| V | i18n | ✅ Pass | Unchanged |
| VI | Inclusive UX | ✅ Pass | Unchanged |
| VII | Performance & Observability | ⚠️ Partial | T158 staging traces human-gated |
| VIII | **Reliability** | ⚠️ **Partial (W1)** | Audit atomicity regression — tx does not roll back on Result-typed audit failure |
| IX | Code Quality | ✅ Pass | typecheck + lint clean |
| X | Simplicity | ✅ Pass | Unchanged |

Principle VIII partial is the W1 finding. Not NON-NEGOTIABLE, not a Blocker — but a visible reliability regression that should be closed.

---

## Test Results (this pass)

No new tests added; existing suites re-verified green post-S1:

| Suite | Result |
|-------|--------|
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| members unit (235) | **235/235 PASS** |
| members integration on live Neon (123) | **123/123 PASS** (+ 3 skipped) |

**Test gap**: no test simulates `audit.recordInTx` returning `err(...)` after the repo write succeeds. Adding such a test would (a) close W1 coverage, and (b) prevent future regressions of the same class. Each of the 4 affected use cases deserves one failure-mode test.

---

## Metrics

| Metric | Value |
|--------|-------|
| Commits on branch | 51 |
| Files changed since `58526ad` | 317 |
| Lines added | ~43,800 |
| Prior review rounds | 14 |
| Findings this pass | **0 Blocker / 1 Warning (W1, 4 sites) / 0 Suggestion** |
| Open blockers | 0 |
| Open warnings | 1 (W1) |
| Constitution principles | 9 full + 2 partial (VII T158 staging, VIII W1 audit atomicity) |

---

## Recommended Actions

### Before `/speckit.ship` (🟡 strongly recommended)

**W1 fix** (~30 min, 4 files, ~20 LOC net):
1. Define a `UseCaseAbort` sentinel class (or reuse the existing one from `src/modules/members/application/tx-abort.ts` if it already fits).
2. In each of the 4 use cases (`contact-crud.ts`, `create-member.ts`, `invite-colleague.ts`, `member-self-update.ts`):
   - Replace `if (!step.ok) return step;` with `if (!step.ok) throw new UseCaseAbort(step.error);`
   - Replace `if (!auditResult.ok) return err(auditResult.error);` with `if (!auditResult.ok) throw new UseCaseAbort(auditResult.error);`
   - Wrap the `await runInTenant(...)` call in try/catch; map `UseCaseAbort` → typed use-case error.
3. Add 1 failure-mode test per use case (4 new tests) that mocks `audit.recordInTx` returning `err`, asserts the use case returns `server_error`, AND asserts the repo mutation was rolled back (i.e., `repo.findById` returns `not_found` afterwards).

### Optional (post-ship)

4. Extend ESLint `no-restricted-imports` to `src/modules/*/application/**` (carry-over from round-2). Would also catch future B1-class regressions.
5. Consider extracting a shared `runInTenantWithResult<T, E>(ctx, fn): Promise<Result<T, E>>` helper to `src/lib/db.ts` that handles the throw-to-rollback pattern automatically. Would prevent this class of bug from recurring across all future tenant-scoped use cases.

---

## Verdict

⚠️ **APPROVED WITH CONDITIONS**

**Condition**: Close W1 before `/speckit.ship`. The regression is a real reliability weakening introduced by the S1 refactor — the pre-S1 Infrastructure code would have rolled back on audit failure (because the adapter's internal `tx.insert(auditLog)` threw on error, aborting the enclosing tx). Post-S1 the same failure mode silently commits.

The fix is small and follows an established pattern already used elsewhere in F3 (`archive-member.ts`, `change-plan.ts`). It should take under an hour including the 4 new failure-mode tests. After W1 is fixed, this becomes a clean **APPROVED**.

**Next step**: `/speckit.fixit.run close W1 audit atomicity regression from S1` — or manual fix following the recommended actions above. Re-run staff review afterwards to confirm closure.
