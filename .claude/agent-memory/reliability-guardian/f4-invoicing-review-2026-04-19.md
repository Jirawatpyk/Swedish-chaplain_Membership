---
name: F4 Invoicing Reliability Review (2026-04-19)
description: Key patterns, gaps, and confirmed-correct paths found in the F4 invoice/receipt MVP code review on branch 007-invoices-receipts.
type: project
---

## Confirmed-correct patterns

- `TxAbort<E>` throw-carrier pattern is sound — PDF fail + Blob fail + audit fail all throw inside withTx, which rolls back the Drizzle transaction, preventing sequence-number consumption. Integration tests (a)(b)(g)(h)(h-replay) confirm on live Neon.
- Two-layer tenant isolation: `runInTenant` sets `SET LOCAL ROLE chamber_app` + `SET LOCAL app.current_tenant`; `postgresSequenceAllocator` has explicit RLS-state assertion in non-prod; `audit-adapter` correctly accepts a TenantTx and falls back to bare `db` only for read-path cross-tenant probes.
- Sequence allocator protocol: advisory lock (hashtext of stream key) → INSERT ON CONFLICT DO NOTHING → SELECT FOR UPDATE → UPDATE; retry on 40P01/40001 up to 3x with exponential backoff.
- Snapshot immutability trigger (`invoices_enforce_immutability`) blocks UPDATE of pricing/identity columns post-draft at DB level.
- Money stored as `bigint` satang (BIGINT columns), not float/double.
- Fiscal year uses `@js-joda` Asia/Bangkok ZonedDateTime — correct DST-independent boundary derivation.
- Overflow guard: `DocumentNumber.of()` rejects seq > 999,999 and the use case throws `IssueInvoiceInternalError` to roll back the tx.
- Outbox enqueue runs inside same transaction as state change (resendEmailOutboxAdapter receives `tx` and uses it).
- `audit.emit(tx, ...)` is in-transaction (not fire-and-forget) for all state transitions reviewed.
- Receipt PDF split: migration 0024 adds `receipt_pdf_*` columns with backfill; `applyPayment` writes RECEIPT columns not invoice columns.

## Gaps / watch points found

- **Lock ordering comment vs code mismatch (MEDIUM)**: The doc comment says order is (1) invoice FOR UPDATE → (2) member FOR UPDATE → (3) advisory. Actual code is: (A) settings read → (C1) invoice FOR UPDATE → (C2) draft load → (B) member FOR UPDATE → (E) advisory. So member lock FOLLOWS invoice lock, matching comment intent, BUT step C2 (findDraftById) executes a second SELECT on invoices BETWEEN the FOR UPDATE and the member lock — this extra round-trip inside the critical section is not a deadlock risk but adds latency.
- **`applyDraftUpdate` missing status guard**: `drizzle-invoice-repo.ts` `applyDraftUpdate()` UPDATE has no `WHERE status='draft'` clause — an admin calling update-draft on an already-issued invoice would silently update `auto_email_on_issue`, `plan_id`, `plan_year` which ARE NOT protected by the immutability trigger. The trigger only blocks snapshot/pricing columns.
- **Outbox locale hardcoded 'en'**: `resendEmailOutboxAdapter` inserts `locale: 'en'` unconditionally — Thai-locale members get English emails at dispatch time unless the dispatcher derives locale from member data.
- **`audit-adapter` null-tx fallback uses bare `db`**: When `txUnknown` is null, the adapter falls back to `db` (superuser, bypasses RLS) rather than opening a fresh `runInTenant`-scoped read. This is documented as intentional for cross-tenant-probe paths, but the path is not exercised by tests in this file.
- **`idempotencyKey` accepted but ignored** in `record-payment.ts` — documented as Phase 10 polish but creates a double-apply risk on retry if the same payment is submitted twice with the same key; the status-based guard (`status='issued'` check) prevents double-apply but does NOT distinguish "same payment acknowledged" from "a different second payment".
- **Receipt sequence allocates but `receiptNumberPrefix` can be null** — fallback to 'RE' is in use-case code, not enforced by DB constraint or settings validation; a misconfigured tenant silently gets 'RE' prefix.
- **0021 partial index NOT CONCURRENTLY**: `audit_log_overdue_once_per_day` uses `CREATE UNIQUE INDEX IF NOT EXISTS` (no CONCURRENTLY) — fine on an empty table but will lock `audit_log` on a populated prod table during re-run.

**Why:** lock ordering gap noted in R3-E1 (spec level) but actual code was not verified at spec-critique time.
**How to apply:** In future reviews of F4 issue-invoice path, confirm `applyDraftUpdate` has status guard; confirm audit-adapter null-tx path is covered by a cross-tenant integration test.
