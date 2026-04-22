---
name: F4 Phase 10 Reliability Review (2026-04-21)
description: Patterns, gaps, and confirmed-correct paths found in F4 Phase 10 (T106/T107/T109/T120–T122/T126) review on branch 007-invoices-receipts, git range 0a1df68^..HEAD.
type: project
---

## Confirmed-correct patterns

- Outbox dispatcher (`outbox-dispatch/route.ts`): CRON_SECRET via Bearer, FOR UPDATE SKIP LOCKED per-row re-lock inside db.transaction(), permanent-fail dual-emit (generic + F4-specific) both in-transaction, exponential backoff 60s/5m/30m/3h/12h, per-row txError isolation (batch continues on one failure), F4 kill-switch filters invoice_auto_email at query time.
- `renderAndUploadPdf` helper correctly rethrows via caller-supplied `wrap(kind, reason)` — aborts enclosing withTx for all 4 render sites (issueInvoice G, recordPayment H, issueCreditNote G, issueCreditNote J2 re-annotation).
- `resend-pdf` use case: Result<T,E> discipline respected; cross-tenant probe audit emitted on not-found for both invoice + credit-note paths; member-ownership guard emits probe on mismatch.
- Resend routes: per-document rate-limit (shared key between admin + portal), zod input validation, typed error → HTTP status mapping, no forbidden fields in log calls.
- `content-disposition.ts` T121: CR/LF stripped to '_' (header injection defense), quote/backslash stripped, non-ASCII stripped; UTF-8 percent-encoded form preserved in filename*.
- Migration 0031: adds `tenant_invoice_settings_cross_tenant_probe` enum value with duplicate-safe DO BLOCK. Single-statement enum ADD VALUE does not lock table rows.
- T120 cross-tenant probe in PATCH /api/tenant-invoice-settings: emits audit before returning 403; logger.warn call does not log userId in a forbidden-field position.
- `derive-overdue.ts`: pure derive is no-op on non-issued invoices; `maybeEmitOverdueDetected` never throws (catch-and-log in adapter); ON CONFLICT DO NOTHING prevents double-emit.

## Gaps found in Phase 10

- **T122 incomplete across 3 call sites**: `issueInvoice` emits `pdf_render_failed` audit post-rollback (correct). `recordPayment` and `issueCreditNote` (both G+J2 paths) do NOT emit the audit on pdf_render_failed — only log via pino. Four sites were claimed as T122-complete; two are not (record-payment.ts:330-343, issue-credit-note.ts:520-533).
- **`content-disposition.ts` silent strip (no log)**: strips CRLF/non-ASCII without emitting a log event. For defense-in-depth the project brief requires logging when stripping occurs; callers cannot detect stripping happened.
- **`resend-pdf` audit emits are fire-and-forget**: outbox enqueue + audit both called without being wrapped in a shared transaction. If audit.emit throws after outbox.enqueue succeeds, the email fires but audit is lost — violates "audit-before-success" pillar rule for this surface.
- **`tenant_invoice_settings_cross_tenant_probe` audit is also fire-and-forget**: `makeF4AuditPort().emit(null, ...)` in PATCH handler is awaited but not guarded; if it throws, the 403 is never returned (unhandled rejection bubbles to 500).

## How to apply in future reviews

- Always verify T122 post-rollback audit emit in ALL withTx catch blocks, not just issueInvoice.
- Check whether resend-pdf outbox + audit are co-transactional; they are explicitly documented as NOT transactional in the use-case comment, but the audit pillar requires scrutiny.
- content-disposition helpers: confirm log-on-strip requirement from project brief.
