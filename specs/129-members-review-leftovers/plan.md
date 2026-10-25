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
