# 129 — Plan

## Approach
- **#1, #2** — `update-member.ts`:
  - an `overrideApplied` flag set in the in-tx scope check, which gates the audit spread;
  - a new error `concurrent_change` replacing `server_error/plan_changed_concurrently`;
  - the route maps it to 409 `conflict`;
  - `edit-member-client.tsx` handles 409 `conflict` on the field step (change-plan never returns `conflict`).
- **#3** — the `renewal_orphan_invoice_relinked` port payload gains the optional `source_cycle_id`, which the carry in `restore-cycle-for-member.ts` sets.
- **#4** —
  - `OverrideReasonDialog` takes `finalFocus`;
  - the edit client records the opener (`document.activeElement`) when the 422 opens the dialog, the `user-list-table.tsx` `dialogFinalFocus` pattern;
  - the cancel toast reads a `savedSomethingRef`.
- **#5** — docs only.

## Evidence

RED runs, each committed before its fix:

| Item | RED commit | Failing line |
|---|---|---|
| #1, #2 | `933b10924` | `update-member-type-scope.test.ts`: `expected { …(5) } to not have property "override_reason_code"`, `expected 'server_error' to be 'concurrent_change'`; `update-member.test.ts` (contract): `expected 500 to be 409`; `edit-member-client-field-override.test.tsx`: `expected "spy" to be called with arguments` (concurrentChange toast) |
| #4 | `b9c3cd51d` | `edit-member-client-field-override.test.tsx`: `expected undefined to be <button>` (finalFocus), `expected "spy" to be called with arguments` (overrideCancelled toast); the copy shares the GREEN commit under D-023 |
| #3 | `164df150d` | `f3-undelete-restore.test.ts` (live Neon): `expected undefined to be '<cancelled cycle id>'` (`source_cycle_id`) |
