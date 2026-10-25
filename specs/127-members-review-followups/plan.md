# 127 — Plan

## Approach

- **#1** — `restore-cycle-for-member.ts`. In the restore tx:
  - `findLatestCycleForMemberInTx`;
  - `findMembershipInvoiceInTx(…, { forUpdate: true })` (a new optional flag, row lock);
  - `createCycleInTx` at the cancelled cycle's `periodFrom` (no anchoring);
  - then `carryInvoiceToRestoredCycleInTx`: `clearStaleLinkedInvoiceInTx` → `linkInvoiceAndReconcileFrozenPlanInTx` (the billed snapshot) → `transitionStatus(upcoming→awaiting_payment)` → the `renewal_orphan_invoice_relinked` audit.

  The design was from `financial-integrity-reviewer` (see the PR).
- **#2** — `mark-cycle-complete-from-invoice-paid.ts`: the net condition becomes `status === 'cancelled' || isMembershipLapsed(…)`.
- **#3** — `update-member.ts`:
  - the schema gains the override fields;
  - a pre-tx read of the member's plan (`PlanLookupPort`), then a scope check against the locked row;
  - route 422 `member_type_warning`.

  In `edit-member-client.tsx`, `overrideStepRef` and `fieldOverrideRef` remember which step's 422 opened the dialog. `override-warning-message.ts` gains two keys.
- **#4** — a comment and a pinning unit case in `plan-change-core.ts`.
- **#5** — `bulk-action.ts` completion log; `maxDuration` on the bulk route; the accepted risk recorded in security.md.

## Evidence

RED runs, each committed before its fix:

| Item | RED commit | Failing line |
|---|---|---|
| #1 | `7fbabbd02` | `f3-undelete-restore.test.ts` (live Neon) — `expected 'upcoming' to be 'awaiting_payment'` |
| #2 | `5aba79e2e` | `mark-cycle-complete-from-invoice-paid.test.ts` — `expected undefined to be defined` (no `payment_on_terminated_member` audit) |
| #3 use case | `4bdc6e138` | `update-member-type-scope.test.ts` — `expected true to be false` (refusal, retry), `expected false to be true` (override fields rejected) |
| #3 route | `60a363f92` | `update-member.test.ts` — `expected 500 to be 422` |
| #3 form | `f7870b361` | `edit-member-client-field-override.test.tsx` — `expected undefined to be 'individual'` (the override re-sent a plan payload) |
| #3 copy (D-023) | `cf4a90534` | `override-warning-message.test.ts` — `expected 'warnings.generic' to be 'warnings.memberTypeCompanyOnly'` |
| #5 | `9c99bb7f2` | `bulk-action-archive-cascade.test.ts` — `expected "spy" to be called with arguments` (completion log) |
| review 1–3 | `41f481ebf` | `f3-undelete-restore.test.ts` (live Neon) — the 6-month-term carry left the restored cycle linked off-period |
| review 4 | `53326f4bd` | `update-member-type-scope.test.ts` — `expected "spy" to not be called` (`getPlan` on an echoed type) |
| review 5 | `d23081cff` | `bulk-action-archive-cascade.test.ts` — `expected "spy" to be called with arguments` (`cascadesRun`) |
| review 6 | `3609b43d7` | `edit-member-client-field-override.test.tsx` — `expected {…} to not have property "override_reason_code"` |

GREEN gates (25 Oct):
- `pnpm check` EXIT 0;
- `pnpm test:coverage` 1,800 files, EXIT 0;
- live Neon: `f3-undelete-restore` and `f3-archival-cascade` (11 tests), plus the payment-path renewals files (`confirm-lazy-transition`, `create-next-cycle-on-paid`, `mark-paid-offline`, `payment-on-terminated-net`, `rolling-anchor-payment`, `self-service-renewal-tx`: 46 tests with restore);
- `migration-0209-post-apply` 18/18.

Verify on the branch server (:3410, Neon dev, a throwaway `zz-probe-127` spec, dummy member removed):
- `PATCH legal_entity_type=individual` on a company-scope plan → 422 `member_type_warning`;
- with `override_reason_code` → 200, stored `individual`, and the `member_updated` audit carries `board_approved`;
- echoing the same type with another field → 200.

Item #1 was not probed in the app: it needs an issued §86/4, which cannot be deleted afterwards on the shared dev branch. Its live-Neon integration test drives the real `archiveMember` → `undeleteMember` path.
