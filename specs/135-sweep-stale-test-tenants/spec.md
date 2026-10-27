# 135 — Sweep stale test tenants in the integration globalSetup

**Size**: M (test infrastructure: a shared module, the operator script, the globalSetup; no product code, no migration, no flag).
**Status**: building on `135-sweep-stale-test-tenants`, 27 Oct 2026.
**Source**: follow-up to #666. Its pre-push hook was blocked for hours by leaked test tenants on the shared Neon dev branch. The maintainer chose this as a follow-up on 27 Oct 2026; plan approved in plan mode.

## Why

Integration runs leak `test-*` tenants: a worker dies before `afterAll`, or a `cleanup()` fails and the error is swallowed. Platform crons (the redact crons) enumerate every tenant in `tenant_invoice_settings` and sweep them one per round trip, so each leaked tenant slows every test that drives one.

On 2026-10-27 the dev branch held 168 such tenants, and every case of `redact-expired-member-invoices` timed out at 60 s under the hook. Measured after the manual clean the same morning, 75 more were already stale, 82 tenants on 10-26 alone.

Test users have an automatic stale sweep (#638); tenants had only the manual `scripts/cleanup-leaked-test-tenants.ts`.

## Done when

1. **The globalSetup sweeps stale test tenants.** `tests/integration-global-setup.ts`, after the users sweep, deletes the rows of `test-*` tenants whose newest row is older than 6 h, through `sweepLeakedTestTenants` in `scripts/lib/leaked-test-tenants.ts`. It logs one line with the counts and the duration.
2. **It is safe on a shared branch.**
   - It never issues `ALTER TABLE … DISABLE TRIGGER`.
   - It takes only the slugs `createTestTenant` generates (`GENERATED_TEST_SLUG`), never a fixed-slug fixture.
   - A tenant with a row younger than 6 h is untouched. A non-`test` slug is never a candidate.
   - A tenant it cannot fully drain (the refund ↔ credit-note cycle, a delete-guarded table) is skipped once an earlier drain removed its `tenant_invoice_settings` row, and counted in the log line.
   - It stops starting tenants after a 20 s budget, and runs each tenant under a lock and statement timeout.
   - A sweep failure is logged with its SQLSTATE and the run goes on.
   - The options are one pinned constant, `AUTOMATIC_SWEEP_OPTIONS`.
3. **The operator script still works.** `scripts/cleanup-leaked-test-tenants.ts` calls the same module with the trigger disable allowed, and its dry-run and apply output keep their shape.
4. **Tests.**
   - Integration on dev (`tests/integration/test-infra/leaked-test-tenants.test.ts`): a dry run deletes nothing; apply removes the stale tenant and keeps the fresh one; `swecham` is never eligible.
   - Unit (`tests/unit/scripts/leaked-test-tenants.test.ts`): the trigger-disable statements and the stuck-cycle rule.
5. **Docs.** `docs/changelog.md`, a `docs/retro.md` line, the script header, the dev-branch memory note.

## Out of scope

- Finding and fixing each test file that leaks.
- `audit_log` rows, which are undeletable by design.
- Tenants whose tables carry no `created_at`, whose age cannot be known.

## Open questions

None.
