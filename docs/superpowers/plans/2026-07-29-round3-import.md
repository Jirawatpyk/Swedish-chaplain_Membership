# Round-3 Production Data Import — Plan (2026-07-29)

**Branch:** `round3-finalized-member-import`
**Operator decisions (2026-07-29):** wipe prod business data + fresh import · document numbers minted by OUR system streams (SC-/RC-), originals kept as references only · scope = latest-year invoices + latest rolling-member invoice · mockup contact emails on a no-MX subdomain (`@pending.swecham.zyncdata.app`) · anchor = invoice date (= membership start, Round-2 convention) · overdue members lapse per system rules · one Swedish AB row with a mis-labelled TH country corrected by a generic rule.

> Operational detail + PII (company lists, per-row notes) lives in `docs/import/ROUND3_PLAN.md`
> (gitignored). This committed plan is PII-free by design.

## Source

One workbook (gitignored under `docs/import/Round 3/`), sheet `Finalized Member`:
252 rows = 1 row per historical invoice (two series), 150 distinct companies.
`ReceiptList` sheet maps receipt numbers → tax-invoice dates (reference only).

## Shape

- **Members (150):** grouped per company, latest row wins; per-member
  `plan_year` = calendar year of the member's anchor (fiscal year starts Jan);
  status from the sheet (111 active / 39 inactive); synthesized unique mockup
  emails; country defaults for `N/A` rows by explicit rules (recorded in the
  report); Student tier → `thai-alumni` plan.
- **Invoices (125):** latest-year series in full (110) + the latest prior-year
  invoice for the 15 still-covered rolling members. paid 99 / issued 14 / void 12.
  Driven through the REAL use-cases (`createInvoiceDraft` → `issueInvoice` →
  `recordPayment` | `voidInvoice`) with a per-document injected `ClockPort` so
  issue dates, due dates, §87 fiscal years, and SC-/RC- numbers are all
  historically correct. `renewalSignal.unitPriceSatang` freezes the sheet price
  (suppresses registration-fee auto-line + pro-rating); `coverageWindow` =
  `[anchor, anchor+12mo)` half-open. All member emails suppressed.
- **Renewal cycles (active members only):** paid → `upcoming` with period ==
  coverage + `anchored_at`/`anchor_invoice_id` stamped (next payment classifies
  as renewal); issued → `awaiting_payment` + `linked_invoice_id` set. Inactive
  members get no cycle.
- **Wipe:** new tenant-scoped script (FK-safe order mirroring
  `clear-test-data.ts`; cycles before invoices), keeps audit_log /
  processor_events / admins / plans / tenant settings; resets
  `tenant_document_sequences` + `tenant_member_sequences` so numbering restarts
  at 1. System actors untouched; `seed:system-actors:prod` re-run as safety.
- **Plan catalogue:** `plan_year` 2024 seeded inactive (FK-only; 19 inactive
  members have 2024 anchors). 2025/2026 already exist.

## New tooling (all dry-run by default, `--commit`/`--apply` to write)

| Script | Purpose |
|---|---|
| `scripts/import-round3/finalized-sheet.ts` | fixed-index reader + transform (duplicate-header safe, local-date safe) |
| `scripts/import-round3-members.ts` | member import CLI (reuses validate/commitMembers with `createCycles:false`, per-member planYear) |
| `scripts/import-round3/invoice-import-core.ts` + `scripts/import-round3-invoices.ts` | invoice/receipt/void import via real use-cases + cycle creation/anchoring; idempotent + resumable |
| `scripts/import-round3/wipe-core.ts` + `scripts/wipe-tenant-business-data.ts` | guarded tenant business-data wipe (`CONFIRM_WIPE=<tenant>`) |
| `scripts/seed-2024-plans-swecham.ts` | FK-only 2024 catalogue clone (inactive) |
| `scripts/verify-round3-import.ts` | read-only post-import assertions |

`commitMembers` gained backward-compatible options `{ createCycles?, planYearOf? }`.
Scripts touching module barrels run with `TSX_TSCONFIG_PATH=tsconfig.scripts.json`
(`server-only` stub — the barrel chain otherwise kills tsx at import time).

## Prod execution order (operator-gated)

1. `FEATURE_F8_RENEWALS=false` + redeploy (freezes every renewals cron)
2. Neon PITR backup branch
3. wipe `--commit` → seed-2024 `--apply` → member import `--commit` → invoice import `--commit`
4. `verify-round3-import` + mapping report review
5. `FEATURE_F8_RENEWALS=true` + redeploy · `pnpm seed:system-actors:prod`

## Tests

Unit: sheet transform (25+), invoice helpers (26), wipe plan/guards (32), verify
helpers (18) — all green. Integration (live dev Neon): invoice importer
end-to-end incl. minted numbers/coverage/cycles/audit + idempotent re-run (2),
wipe fixture incl. survivors + idempotence (4) — all green. `pnpm lint` +
`pnpm typecheck` clean.

## Known/accepted consequences (operator-acknowledged)

- Due dates derive from issue date + tenant net-days (sheet due dates not
  reproducible field-for-field); paid/void docs unaffected in practice.
- A handful of long-overdue members will be lapsed by the first cron run after
  F8 is re-enabled (system truth; comeback flow recovers them on payment).
- `paid_at`/`voided_at` carry import-time server timestamps (tax registers read
  `payment_date`/`issue_date`, which are historical).
- Old orphaned invoice PDF blobs from the pre-wipe era remain in Blob storage —
  follow-up sweep tracked separately.
