---
paths:
  - "src/modules/insights/**"
  - "tests/**/insights/**"
---

# Insights (F9 home dashboard, spec 124 invoice dashboard)

Read-only figures over other modules' data. Money figures: review with `financial-integrity-reviewer` + `financial-reporting-analyst`.

- **Cross-module reads go through the owning barrels only** (`invoicesTable`, `creditNotesTable`, `invoiceTaxPointSql` from `@/modules/invoicing`; `paymentsTable`, `refundsTable`, `STALE_REFUND_ESCALATION_AGE_MS` from `@/modules/payments`) — infra-to-infra schema sharing, read-only, every statement in `runInTenant` with an explicit `tenant_id` on every table it names; `tests/unit/insights/invoice-dashboard-source-adapter-sql-shape.test.ts` enforces the second wall.
- **Read barrel tables inside the function, never at module load** (`tables()` in `invoice-dashboard-source-adapter.ts`): a module-scope read makes every suite that partially `vi.mock`s the invoicing or payments barrel crash on import, and nothing else flags it.
- **`today` and `now` come from the caller**, computed once per request; no `now()` / `CURRENT_DATE` in dashboard SQL, so a figure and its drill-down agree.
- **The tax point is `invoiceTaxPointSql`, shared with the ภ.พ.30 register and migration 0318's expression index**; never retype it (`tests/unit/invoicing/invoice-tax-point-migration-guard.test.ts` fails on drift).
