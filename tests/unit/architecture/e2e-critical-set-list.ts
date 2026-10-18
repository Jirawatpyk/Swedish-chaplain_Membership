/**
 * The budgeted `@critical` e2e set (spec 123 slice 2, DW-7; plan.md § Critical
 * set). One list, imported by `e2e-critical-set.test.ts` (the tagged specs must
 * equal it) and `e2e-ci-workflows.test.ts` (every entry needs a duration
 * baseline in `.github/ci/e2e-critical-baselines.json`).
 *
 * Dropped after run 39100353012 (budget): member-nav (202 s per project) and
 * renewal-pipeline-dashboard (118 / 168 s) were the slowest additions and put
 * the projected job over 25 minutes. Both also failed there on CI-only causes
 * (F7 is off in CI; a 5 s wall-clock assertion from a US runner).
 */
export const CRITICAL_SET: readonly string[] = [
  'admin-journey.spec.ts',
  'critical-invoice-issue.spec.ts',
  'critical-member-profile.spec.ts',
  'f9-dashboard.spec.ts',
  'member-sign-in.spec.ts',
  'members-directory-search.spec.ts',
  'payment-promptpay-happy-path.spec.ts',
  'portal-invoices.spec.ts',
  'staff-sign-in.spec.ts',
];
