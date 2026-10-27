# Plan: 135 — sweep stale test tenants in the integration globalSetup

Agreed in plan mode on 27 Oct 2026, together with the D-030 follow-up (#670).

## Approach

- Extract table discovery and the per-tenant drain from `scripts/cleanup-leaked-test-tenants.ts` into `scripts/lib/leaked-test-tenants.ts`. It imports only `postgres`, so tsx and vitest both load it.
- The operator script calls the module with `allowTriggerDisable: true`.
- The globalSetup calls it with `AUTOMATIC_SWEEP_OPTIONS` inside a try/catch that only logs:
  - 6 h age filter, generated slugs only;
  - `allowTriggerDisable: false`, `skipUndrainable: true`;
  - a 20 s budget and per-tenant lock and statement timeouts.
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

## Review round 1 → fixes

- **`/code-review high 671`**, 4 Low:
  - guarded tenants were retried every run;
  - no timeouts;
  - no real-sweep test of the skip;
  - the script used its own prod guard.

  RED e68ffb9e7, fix 04fea2f9e.
- **reliability-guardian**, 3 Medium plus 5 Low:
  - no time budget or lock timeout;
  - a TOCTOU on fixed-slug fixtures;
  - guarded tenants retried.
- **senior-tester**, NOT SHIP-READY:
  - the ENABLE TRIGGER statement was unpinned, so mutant M2 survived;
  - one-sided cycle cases were missing;
  - the skip wiring was untested;
  - the spec had drifted.
- RED for the reliability and senior-tester findings: 19e57bf21. The budget and generated-slug cases failed with `expected undefined to deeply equal [...]` and `expected ['test-sweep-fixed-slug'] ...`. Fix: d79385f5f.
  - Only generated slugs (`GENERATED_TEST_SLUG`) are swept automatically, so a fixed-slug fixture that a live run may rewrite is never touched.
  - A 20 s budget (`skippedBudget`), plus a per-tenant `lock_timeout` of 5 s and `statement_timeout` of 30 s.
  - An undrainable tenant is skipped only once its `tenant_invoice_settings` row is gone. The rule is the same for the cycle and for guarded tables.
  - The deleted count is recorded only after the savepoint (and any trigger re-enable) holds.
  - The globalSetup log gives the SQLSTATE on failure and counts deferred and undrainable tenants.
  - Tests:
    - the three trigger statements pinned with `toEqual`;
    - one-sided cycle cases;
    - `GENERATED_TEST_SLUG`;
    - `AUTOMATIC_SWEEP_OPTIONS` pinned;
    - the skip wiring through a fake client (a skipped tenant opens no transaction);
    - a `testing-*` slug to exercise the regex;
    - test tenants 2 h old with a 1 h filter, so another run's 6 h sweep cannot take them.
- GREEN: unit 12/12; integration 5/5; `tsc` and eslint clean; `pnpm check` exit 0.
- Not covered by a test: the globalSetup catch path. It is hygiene code, and reading it shows it logs and continues.

## Review round 2 → fixes

- **reliability-guardian.** M-2 and M-3 are closed. M-1 was only partly closed: the discovery reads and the `UPDATE users` were unbounded on a pooled URL, because the pooler drops session connection parameters. Fix:
  - every discovery read now runs in its own short transaction under `SET LOCAL lock_timeout` / `statement_timeout` (`bounded`);
  - the users sweep runs in a `sql.begin` with `SET LOCAL`;
  - the `connection:` block is removed;
  - the budget now counts discovery;
  - comments now say what the budget does and does not cap, and that a guarded tenant stays in the broadcasts gauges' loop.
- **senior-tester** (NOT SHIP-READY: M10 and M11 survived):
  - `AUTOMATIC_SWEEP_OPTIONS` is now pinned whole with `toEqual`;
  - the fake client runs `begin` / `savepoint` bodies, so the drain is exercised: `SET LOCAL` on all 5 transactions, no `ALTER` on the automatic path, and a delete counted only when its savepoint held (a failed re-enable counts nothing);
  - unit cases for the slug pattern and the budget;
  - a `test-sweep-fixedslug` negative for the regex;
  - the spec's test list corrected.
- **GREEN:** unit 15/15 (13 before this round's additions), integration 5/5, `tsc` and eslint clean.

## Review round 3 → fixes

- **reliability-guardian.** M-1R is closed. Two new MEDIUM findings:
  - With discovery counted in the budget, a slow discovery could defer every tenant, so a growing backlog would never shrink. Fix: a run always drains at least one tenant.
  - The bounded `UPDATE users` could now throw and abort the whole integration run. Fix: it is caught and logged with its SQLSTATE, and the run continues.
- **senior-tester: SHIP-READY.** M10, M11 and the count-after-savepoint finding were all killed by mutation. Remaining mutants and their fixes:
  - **B2:** `SET LOCAL` was sent outside a transaction. The fake client now records `BEGIN`, and every `SET LOCAL lock_timeout` must directly follow one.
  - **B3:** the budget did not count discovery. A `Date.now` spy now proves it does.
  - **M13:** the negative case used a 9-character suffix. It now uses `test-sweep-fixedabc`, an 8-character non-hex suffix.
  - **C2:** the deleted count was never asserted as a positive. `deletedPerTable.get('members')` is now pinned at 2.
- **GREEN:**
  - unit 16/16;
  - integration 5/5: the budget case now seeds two tenants and expects one drained and one deferred;
  - `tsc` and eslint clean.
