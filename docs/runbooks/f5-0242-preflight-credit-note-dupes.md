# Ship-day pre-flight — migration 0242 `credit_notes` unique index (RR-4)

**Gate class:** BLOCKING. Run before deploying migration `0242_credit_notes_source_refund_uniq.sql`.

## Why

`0242` adds `CREATE UNIQUE INDEX credit_notes_source_refund_id_uniq ON credit_notes (tenant_id, source_refund_id) WHERE source_refund_id IS NOT NULL`. A **non-concurrent** `CREATE UNIQUE INDEX` **fails the entire migration** if any duplicate `(tenant_id, source_refund_id)` already exists — and prod **auto-migrates on Vercel deploy** (`vercel-build` runs `run-migrations.ts`), so a pre-existing duplicate = a **broken / stop-the-line deploy**.

The double-credit-note bug that 0242 fixes (CRITICAL-1) is exactly the scenario that could have produced such a duplicate, so this check is not theoretical.

## Pre-flight query — run against BOTH the `dev` Neon branch AND prod

```sql
SELECT tenant_id, source_refund_id, COUNT(*) AS n
FROM credit_notes
WHERE source_refund_id IS NOT NULL
GROUP BY tenant_id, source_refund_id
HAVING COUNT(*) > 1;
```

- **0 rows** → safe to apply `0242`.
- **≥1 row** → a duplicate credit note exists for a single refund. Before the migration:
  1. Identify the duplicate credit notes (`SELECT credit_note_id, credit_note_number, issue_date, total_satang FROM credit_notes WHERE tenant_id = '…' AND source_refund_id = '…'`).
  2. Void/reverse the extra CN via the standard F4 credit-note void path (do **not** hard-delete a §87-numbered tax document).
  3. Reconcile the `tenant_document_sequences` counter if a number was consumed by the voided CN (§87 no-gaps).
  4. Re-run the query until it returns 0 rows, then apply `0242`.

## Risk read (2026-07-11)

- **prod:** LOW — wiped clean 2026-06-24 and re-wiped 2026-07-10; F5 refunds are low-volume admin-initiated, so few (if any) `source_refund_id` rows exist.
- **`dev` Neon branch:** HIGHER — accumulated refund integration-test rows may include a duplicate from the pre-fix code path. Clean dev before `pnpm db:migrate` locally, or the local apply of 0242 will fail.

## Notes

- `CREATE INDEX CONCURRENTLY` is **not** usable here — drizzle-kit wraps each migration in a transaction, and `CONCURRENTLY` cannot run inside one. The non-concurrent build takes a brief `SHARE` lock (milliseconds on the small/wiped table).
- RLS/grants on `credit_notes` are unaffected by an index add.
