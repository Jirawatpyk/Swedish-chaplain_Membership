# 126 — Plan

## Approach

- **#1/#3**: delete the bulk `change_plan` arm, its schema params, the `plans` dep and the route's `plan_not_found` arm. A future bulk plan change must reuse `changePlan`.
- **#2**: extract the single archive/undelete cascades into `application/use-cases/archive-cascade.ts` (`revokeMemberAccessInTx`, `runPostArchiveCascades`, `runRenewalsRestoreCascade`); `archiveMember`, `undeleteMember` and both bulk arms call them.
- **#4/#5/#9**: `application/use-cases/plan-change-core.ts` `validatePlanChange` (pure) + `domain/policies/member-type-scope-policy.ts`. `changePlan` gains `contactRepo` + `clock` deps (primary DOB, today) and an archived check on the locked row.
- **#8**: `createMember` takes `planAdvisoryLock` (already in `buildMembersDeps`) and re-checks deletion under it.
- **#6**: use-case gate + `deleted_at IS NULL` on the repo update's SELECT and UPDATE.
- **#7** (D-026): `InTxHook<T>` on every mutating `PlanRepo` / `ScheduledPlanChangeRepo` method; `AuditPort.recordInTx`; `auditInTx(...)` builds the hook and throws `PlanAuditAbort` on failure. Unit doubles: `tests/unit/plans/application/in-tx-hook-mocks.ts`.

## Complexity Tracking

None. No new dependency, table or flag.

## Evidence

RED runs (each committed before its fix):

| Finding | RED commit | Failing line |
|---|---|---|
| #1/#3 | `93e14deea` | `bulk-action-change-plan.test.ts` — `TypeError: Cannot read properties of undefined (reading 'getPlan')` (the schema accepted `change_plan`) |
| #2 | `9a3b3d6ab` | `bulk-action-archive-cascade.test.ts` — `expected "spy" to be called 2 times, but got 0 times` (revokeAllForInTx); `expected -1 to be greater than 2` (cycle cancel / restore after commit) |
| #4/#5/#9/#10 | `9b873fba3` | `change-plan-guards.test.ts` — `expected { ok: true, value: { …(2) } } to deeply equal { ok: false, …(1) }` (archived, locked-archived, over-age); `expected true to be false` (individual on company plan, partnership exit); `expected "spy" to be called with arguments: [ ObjectContaining{…}, Any<String> ]` (errKind) |
| #5/#8 | `9b873fba3` | `create-member-plan-guards.test.ts` (live Neon) — `expected { ok: true, value: { …(2) } } to deeply equal { ok: false, …(1) }` (plan deleted after snapshot); `expected true to be false` (individual on company plan) |
| #6 | `a33fad27d` | `update-deleted-plan.test.ts` (live Neon) — `expected { ok: true, value: { …(21) } } to deeply equal { ok: false, …(1) }` |
| #7 | `27ec92fa0` | `audit-in-tx-rollback.test.ts` (live Neon) — `expected 9900000 to be 3600000` (update), `expected true to be false` (activate), `expected 2027-06-15T00:00:00.000Z to be null` (soft-delete), `expected null not to be null` (undelete), `expected { …(22) } to be undefined` (create, clone), `expected [ { …(15) } ] to have a length of +0 but got 1` (schedule); `cancel-audit-failed-row-rolls-back.test.ts` — `expected 'cancelled' to be 'pending'` |

GREEN: see § Verify in the PR (unit, contract, live-Neon integration paths, typecheck, lint).
