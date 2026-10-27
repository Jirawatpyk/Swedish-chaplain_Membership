# Plan: 135 — sweep stale test tenants in the integration globalSetup

Agreed in plan mode on 27 Oct 2026, together with the D-030 follow-up (#670).

## Approach

- Extract table discovery and the per-tenant drain from `scripts/cleanup-leaked-test-tenants.ts` into `scripts/lib/leaked-test-tenants.ts`. It imports only `postgres`, so tsx and vitest both load it.
- The operator script calls the module with `allowTriggerDisable: true`.
- The globalSetup calls it with `apply: true`, a 6 h age filter, `allowTriggerDisable: false` and `skipStuckOnCycle: true`, inside a try/catch that only logs.
- Not taken:
  - fixing every leaking file: worker kills and swallowed cleanups recur, as the users leak showed;
  - a pre-check on `tenant_invoice_settings`: a clean run already costs ~0, so it is not worth a second code path.

## Evidence

- **Measured before building:** 78 rows in `tenant_invoice_settings`, of which 75 were `test-*` and all older than 6 h; 82 test tenants created on 10-26; the three measurement queries took 391 ms.
- **RED** e7bd759f2: both new test files failed with `Failed to resolve import "../../../scripts/lib/leaked-test-tenants"`.
- **GREEN:**
  - unit 5/5;
  - integration `tests/integration/test-infra/leaked-test-tenants.test.ts` 3/3.
- **First run with the new globalSetup:** `swept 66/87 leaked test tenant(s) older than 6 h in 99236 ms; 21 left rows`, 1 m 44 s in total.
- **Second run:** no sweep line, because nothing was eligible and the stuck ones were skipped; 4.7 s in total.
- `tsc` and eslint are clean on the touched files.
