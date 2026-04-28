# F5 Complexity Tracking Addendum (post-fix-it review-20260428-102639.md)

**Status**: Active addendum to `plan.md § Complexity Tracking`
**Authored**: 2026-04-28
**Reason**: Spec-artefact files (`plan.md`) are NOT modified by `/speckit-fixit-run`. This addendum captures the Complexity Tracking entries surfaced by the staff review. Reviewers MUST treat these as if they lived in `plan.md § Complexity Tracking` for the Constitution Check.

---

## CT-1 (W2 closure) — `receipt-pdf-reconcile` cron cross-tenant scan

**Where**: `src/app/api/internal/cron/receipt-pdf-reconcile/route.ts:131-150`

**Constitution Principle**: I (Tenant Isolation, NON-NEGOTIABLE) — clause 3 (cross-tenant ops paths must be authorised + documented).

**Deviation**: The reconcile cron's top-level `db.select(...).from(invoices)` query bypasses RLS (no `app.current_tenant` set). Each row's writes rebind to `runInTenant(asTenantContext(row.tenantId))`.

**Authorised because**:
- Cron is gated by `CRON_SECRET` Bearer (≥16 chars, no dev bypass).
- Mirrors the existing `sweep-stale-pending-refunds` precedent (CT entry already in `plan.md`).
- Header docstring (lines 51-55) describes the bypass + rebind contract.

**Rejected simpler alternative**: One sweep per tenant, via `runInTenant` for every tenant on every tick. Rejected because it requires N×K queries where K = configured tenants — for a 5-min cadence cron, that adds N×K×288 queries/day for what should be a single index scan.

**Mitigation in place**:
- Every state-changing write (`UPDATE invoices`, `INSERT outbox`, `INSERT audit_log`) runs inside `runInTenant`.
- Forensic trail: `payments.receipt_pdf_reconcile.re_enqueued` log line + `pdf_render_permanently_failed` audit row both carry `tenantId`.

---

## CT-2 (S6 closure) — `initiate-payment` Stripe call inside `withTx`

**Where**: `src/modules/payments/application/use-cases/initiate-payment.ts:516`

**Constitution Principle**: Reliability — long-held DB transactions vs network latency.

**Deviation**: `processorGateway.createPaymentIntent(...)` (network call, SDK timeout 10s) executes INSIDE `paymentsRepo.withTx(...)`. Holds advisory lock + DB connection during the Stripe round-trip.

**Authorised because**: Single-source-of-truth for `(tenant, invoiceId, attempt_seq) ↔ Stripe PaymentIntent.id` mapping. If Stripe call moved out of tx (two-phase initiate), a partial-completion fault between Phase A (DB row) and Phase B (Stripe call) would leave a half-recorded payment row with no PI to reconcile.

**Rejected simpler alternative**: Two-phase initiate (write pending row → release tx → call Stripe → second short tx to fold processor_payment_intent_id). Rejected because:
- Indistinguishable on the wire from a real concurrent-initiate race (would defeat the three-layer guard).
- Requires a recovery cron to clean up half-written rows.
- Net effort ~3-5 days for a path that already meets SLO-F5-001 budget (p95 < 1.2s with 38 ms headroom).

**Mitigation in place**: Stripe SDK 10s timeout < advisory-lock contention threshold. Lock auto-releases on rollback if Stripe call throws.

---

## CT-3 (W8 closure) — `processor_events` retention undefined

**Where**: `src/modules/payments/infrastructure/schema.ts:166-181`

**Constitution Principle**: Data Privacy & Security — GDPR Art. 5(1)(e) storage limitation; PDPA storage minimisation.

**Deviation**: `processor_events` table has no documented retention period. RLS `FOR DELETE USING (false)` blocks all DELETEs from the app role. Rows accumulate indefinitely.

**Mitigated for ship because**:
- Table stores only `payload_sha256` (32 bytes hash), event metadata, and outcome — no PII bodies.
- Each row is ~500 bytes; 100 events/day for 1 tenant = ~18 MB/year. F9 audit-purge job (deferred) will add a maintenance-role DELETE bypass.

**Rejected simpler alternative**: Add maintenance-role DELETE policy in F5 itself. Rejected because: F9 is the canonical audit-purge surface; building two purge mechanisms doubles operational risk.

**Decision (pre-F9)**: Documented retention policy = **5 years** (matches operational audit events). Implementation deferred to F9 audit-purge job per `data-transfers.md § 4`.

---

## CT-4 (S4 closure) — Receipt-PDF reconcile cron thundering-herd

**Where**: `src/app/api/internal/cron/receipt-pdf-reconcile/route.ts` + outbox dispatcher

**Constitution Principle**: Reliability — bounded concurrency / no fan-out storms.

**Risk**: Stripe outage of N minutes → during the outage, member webhooks queue at Stripe; on recovery, Stripe replays N×events_per_min webhooks in a burst. The receipt-pdf reconcile cron picks up `failed` rows on its 5-min tick. If N is large, a single sweep can re-enqueue hundreds of outbox rows simultaneously, saturating Vercel Blob upload bandwidth and Resend rate limits.

**Mitigation NOT yet implemented (post-ship S4)**:
- Add `LIMIT 50` to the reconcile query so each cron tick processes at most 50 stuck rows.
- Add `receipt_pdf_pending_count > 20 for any tenant` alert to detect backlog buildup.

**Rejected simpler alternative**: No bound — let it burst. Rejected because Vercel Blob has a 10 req/s default cap per project; a 200-row burst would 429 80% of the calls.

**Decision**: Document risk + alert here; ship without the LIMIT (safety wall is `MAX_RENDER_ATTEMPTS=3` × outbox-dispatcher's existing throttle). Add the LIMIT in a post-T166 follow-up if the alert fires in the first 30 days.

---

## CT-5 (W18-derived) — Payment-method tax retention mapping

**Where**: `src/modules/payments/application/ports/audit-port.ts:F5_AUDIT_RETENTION_YEARS`

**Constitution Principle**: Data Privacy & Security — appropriate retention per Thai RC §87/3 + GDPR Art. 5(1)(e).

**Decision (post-fix W7)**:
- `payment_succeeded` → 10y (settlement record, tax-document-adjacent).
- `payment_initiated` / `payment_failed` / `payment_canceled` → 5y (pre-settlement ops; not directly cited in any tax document).

**Rejected simpler alternative**: All payment events at 10y for safety. Rejected because GDPR Art. 5(1)(e) requires storage limitation — over-retention without a stated lawful basis is itself a breach. The 4-tier split documents the basis per event-type.

**Source of truth**: `data-model.md § 7.1` retention table + `audit-port.ts` map. Both must agree (compile-time enforced by `Record<F5AuditEventType, 5 | 10>`).

---

## CT-5b (W12 REVERSAL — applied 2026-04-28 evening) — `0062_drop_invoice_pending_check.sql`

**Where**: `drizzle/migrations/0062_drop_invoice_pending_check.sql`

**Reason**: The CHECK constraint added in 0061 (W12 closure) was over-strict. It enforced `receipt_pdf_status='pending' → receipt_document_number_raw IS NOT NULL` for ALL invoices, but combined-mode invoices legitimately have `receipt_document_number_raw=NULL` while transiting `pending` (combined-mode = receipt IS the invoice; no separate sequence). The CHECK cannot reference `tenant_invoice_settings.receipt_numbering_mode` from another table, so SQL-layer scoping to separate-mode is impossible.

**Empirical detection**: `T166-12` perf benchmark at n=100 caught this regression on the first re-run (combined-mode seed rows failed the new CHECK with `PostgresError: new row for relation "invoices" violates check constraint "invoices_pending_has_receipt_doc_num"`).

**Replacement guard**: Application-layer at `render-receipt-pdf.ts:168-177` — when separate-mode worker observes `receiptDocumentNumberRaw=null`, it throws `RenderReceiptInternalError({kind: 'data_corruption'})` which short-circuits the dispatcher retry ladder (S8 closure). Combined-mode is unaffected because the worker takes a different code path (line 165: `let receiptDocNum = loaded.documentNumber`).

**Lesson**: Don't add CHECK constraints that depend on cross-table state. Single-table invariants only.

---

## CT-6 (W9/W10/W11 closure) — Historical migration drift acknowledgement

**Where**: `drizzle/migrations/0033_*.sql`, `0039_*.sql`, `0055_*.sql`

**Findings from review**:
- `0033_payments_initial.sql:150-151` — `payments_processor_payment_intent_id_uniq` shipped as global UNIQUE; later narrowed to partial in `0054`. Apps applying 0033→0054 have a transient window where the index is global.
- `0039_audit_log_add_retention_years.sql:55-68` — `DISABLE TRIGGER` / `UPDATE` / `ENABLE TRIGGER` separated by `-->statement-breakpoint` → drizzle-kit runs each in its own tx. If `ENABLE TRIGGER` tx fails, append-only invariant breaks.
- `0055_audit_log_retention_default_trigger.sql:23-38` — Trigger function lacks `SET search_path = ''` (subject to extension-poisoning if search_path is manipulated).

**Decision**: All three migrations have already been applied to dev + prod databases. Editing the SQL files now would not change the deployed schema (drizzle-kit hashes are sticky). The risks are theoretical:
- (W11) — applied window is closed (0054 already in journal).
- (W9) — `ENABLE TRIGGER` failure during 0039 backfill never observed in dev or prod logs; covered by an explicit smoke check in the F4 audit-retention-backfill test.
- (W10) — search_path attack requires extension privileges that the app role does not have.

**Future migration template**: New migration files MUST:
- Use a single transaction for DISABLE/UPDATE/ENABLE TRIGGER triplets (no `-->statement-breakpoint` between them).
- Set `SET search_path = ''` in any new `LANGUAGE plpgsql` function.
- Use partial UNIQUE indexes when shipping a new constraint that may need exception clauses later.

These checks belong in `drizzle-migration-reviewer` agent's checklist, not as new migration files.

---

## CT-7 (W4 closure-pending) — perf benchmark sample-size plan

**Where**: `specs/009-online-payment/perf-results-t166-2026-04-28.md`

**Open question**: Current async-PDF benchmark used n=30 samples, no documented warmup. T148/T149 used n=100 + 5-warmup. With n=30, p95 = 2nd-highest observation; one cold-start outlier shifts it a full slot.

**Decision**: Re-run benchmark with n=100 + 5-warmup before `/speckit.ship`. This is a manual step (`RUN_PERF=1 pnpm test:integration`) blocked on maintainer initiation, not a code edit.

**Tracking**: Open item in `post-ship-tasks.md` if not done before ship.

