---
name: F4 Phase 10 Audit Findings 2026-04-22
description: Conditional pass audit of F4 invoicing module Phase 10 ship — BLOCKER sharp in app layer, HIGH receipt prefix missing
type: project
---

F4 Phase 10 audit (2026-04-22) returned CONDITIONAL PASS with:

**BLOCKER**: `sharp` imported directly in `src/modules/invoicing/application/use-cases/upload-tenant-logo.ts:22`. Constitution Principle III NON-NEGOTIABLE violation. Fix: create `ImageReEncodePort` in application/ports, move sharp to `sharp-image-reencode-adapter.ts` in infrastructure.

**HIGH**: `receipt_number_prefix` column does not exist in any migration (0019–0031) or `schema-tenant-invoice-settings.ts`, despite being declared in `TenantInvoiceSettingsView` port and referenced in `record-payment.ts:201` with `?? 'RE'` fallback. All separate-mode receipts silently use prefix 'RE' regardless of tenant config.

**CONFIRMED PASSING**:
- §86/4 mandatory fields all present in invoice-template.tsx
- §86/10 credit note: original invoice reference + reason in cnRefBlock
- §87 advisory lock: `pg_advisory_xact_lock(hashtext(lockKey))` with correct (tenant, docType, fiscalYear) scope
- Fiscal year: Asia/Bangkok via @js-joda in src/lib/fiscal-year.ts
- VAT: BigInt satang, 7% = 700/10000, total-level rounding, fast-check property test
- Buddhist Era: display-only beYear() in PDF, no BE in DB
- FR-038 tax-ID snapshot immutability: confirmed in record-payment + issue-credit-note
- SC-003 deterministic render: mulberry32 PRNG + Date proxy + renderChain mutex
- RLS+FORCE: 5/5 F4 tables in migration 0019
- FEATURE_F4_INVOICING, BLOB_READ_WRITE_TOKEN, CRON_SECRET all validated in src/lib/env.ts

**Open question**: Thai numerals (๐–๙) — advisory from RD but not §86/4 statutory — escalate to human Thai accounting reviewer.

**Why**: Ship blocker on BLOCKER-1 per Constitution Principle III. HIGH-1 is a silent misconfiguration that makes separate-mode receipt prefix non-configurable.

**How to apply**: Re-audit after BLOCKER-1 + HIGH-1 are fixed. Check that `ImageReEncodePort` is properly defined and `sharp-image-reencode-adapter.ts` exists before re-signing.
