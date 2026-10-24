# 126 — Plan

## Approach

- **#1/#3**: delete the bulk `change_plan` arm, its schema params, the `plans` dep and the route's `plan_not_found` arm. A future bulk plan change must reuse `changePlan`.
- **#2**: extract the single archive/undelete cascades into `application/use-cases/archive-cascade.ts` (`revokeMemberAccessInTx`, `runPostArchiveCascades`, `runRenewalsRestoreCascade`); `archiveMember`, `undeleteMember` and both bulk arms call them.
- **#4/#5/#9**: `application/use-cases/plan-change-core.ts` `validatePlanChange` (pure) + `domain/policies/member-type-scope-policy.ts`. `changePlan` gains `contactRepo` + `clock` deps (primary DOB, today) and an archived check on the locked row.
- **#8**: `createMember` takes `planAdvisoryLock` (already in `buildMembersDeps`) and re-checks deletion under it.
- **#6**: use-case gate + `deleted_at IS NULL` on the repo update's SELECT and UPDATE.
- **#7** (D-027): `InTxHook<T>` on every mutating `PlanRepo` / `ScheduledPlanChangeRepo` method; `AuditPort.recordInTx`; `auditInTx(...)` builds the hook and throws `PlanAuditAbort` on failure. Unit doubles: `tests/unit/plans/application/in-tx-hook-mocks.ts`.

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

GREEN: unit + contract 497 files / 5,117 tests; `pnpm test:coverage` 1,790 files, EXIT 0; `pnpm check` EXIT 0; `check:audit-events` and `check:multi-tenant` OK; live-Neon integration: all 23 `tests/integration/plans/*` (110 passed, 1 pre-existing skip), the touched members files, and the renewals plan-change files (`tier-upgrade-pending` 17/17 solo).

Verify (24 Oct, branch server on :3410 against the Neon dev branch — :3400 was another session's; throwaway `zz-probe-126` spec, dummies removed afterwards):
- **#2** — a dummy member whose primary contact is linked to a dummy portal user with a live session: `/portal` loads; the admin's `POST /api/members/bulk {action:'archive'}` → 200 `{updated_count:1, audit_event_count:2}`; the user's sessions → 0, one `user_sessions_revoked` audit row; the same cookie on `/portal` now lands on `/portal/sign-in`.
- **#6** — a soft-deleted dummy plan: `PATCH /api/plans/{year}/{id} {annual_fee_minor_units:1}` → 404 `not_found`; the fee stays 100000.
- No error or warn line in the server log during the run.
