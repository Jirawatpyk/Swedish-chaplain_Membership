---
name: F4 Architecture Patterns and Recurring Violations
description: Patterns observed in F4 invoicing module — correct infra layering, known violations, and port patterns
type: project
---

**Recurring violation pattern**: Native binary / OS-level libraries (`sharp`, file I/O, native crypto beyond node:crypto) tend to leak into Application use-cases. Check every use-case for direct imports of: sharp, @react-pdf/renderer, @vercel/blob, drizzle-orm, next. Only `@js-joda/core` and `@js-joda/timezone` are permitted in Domain (pure timezone utility).

**Correct port pattern in F4**:
- BlobStoragePort (application/ports/blob-storage-port.ts) — correct: infra uses vercel-blob-adapter.ts
- PdfRenderPort (application/ports/pdf-render-port.ts) — correct: infra uses react-pdf-render-adapter.ts
- ImageReEncodePort — MISSING as of 2026-04-22 audit; `sharp` is currently imported directly in upload-tenant-logo.ts

**VAT calculation pattern** (confirmed correct):
- Total-level rounding: subtotal (integer satang sum) × vatRate as bigint fraction
- VatRate: 0.0700 stored as 4dp decimal string, numerator=700, denominator=10000
- Money.multiplyByFraction: half-away-from-zero, BigInt only
- Credit note VAT: proportional split = originalVat × (creditTotal / originalTotal)
- Full credit reproduces original VAT exactly (no drift)

**Fiscal year pattern** (confirmed correct):
- src/lib/fiscal-year.ts uses ZonedDateTime.ofInstant(Instant.parse(utcIso), BANGKOK_ZONE)
- FiscalYear brand type 2000..2100
- Never use new Date() or Date.now() for fiscal year calculation

**Buddhist Era pattern** (confirmed correct):
- beYear() in invoice-template.tsx: CE + 543, display-only
- DB: Postgres `date` (YYYY-MM-DD Gregorian), `timestamp with timezone` (UTC)
- No BE found in any DB column or audit payload

**Snapshot immutability pattern** (confirmed correct):
- member_identity_snapshot + tenant_identity_snapshot frozen at issue time
- record-payment and issue-credit-note reuse loaded snapshot, never re-fetch live member
- DB trigger invoices_enforce_immutability prevents overwrite after draft→issued

**Advisory lock scope** (confirmed correct):
- Key: `invoicing:{tenantId}:{documentType}:{fiscalYear}`
- pg_advisory_xact_lock (exclusive, auto-released on commit/rollback)
- Retry on deadlock belongs at caller withTx, not inside allocator
