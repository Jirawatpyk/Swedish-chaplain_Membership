---
name: F4 Invoicing Security Audit — Final Sign-off 2026-04-22
description: Findings from the Phase 10 solo-maintainer security co-sign audit of F4 (Invoices & Receipts). Key patterns, accepted residuals, and one open debt item.
type: project
---

F4 security audit completed 2026-04-22 (Phase 10 ship gate, T117 solo-maintainer substitute path). All 19+1 threats PASS with one accepted-debt note on T-03 idempotency key.

**Key findings / patterns to carry forward:**

- Dual-layer tenant isolation confirmed: `runInTenant` at repo layer + `ENABLE/FORCE ROW LEVEL SECURITY` + `CREATE POLICY` in migration 0019 for all 5 F4 tables. No direct DB access bypasses this.
- `REDACT_PATHS` in `src/lib/logger.ts` exports a canonical list — depth-2 wildcard `*.*.recipient_email` added in R2-I1 to cover nested audit event payloads. Pattern to reuse in F5+.
- CRON_SECRET: length check + `timingSafeEqual` (R15-04) in `outbox-dispatch/route.ts:684–702`. Misconfiguration guard returns 500 (not 401) to distinguish config error from auth failure.
- Content-Disposition CRLF injection: `buildAttachmentContentDisposition` helper in `src/lib/content-disposition.ts` used by all 4 PDF routes (admin invoice, admin CN, portal invoice, portal CN). ESLint D2 rule blocks String.raw bypass.
- T-05 Blob ACL residual: blobs are currently `access: 'public'` with UUID-keyed unguessable paths. Route layer streams bytes and never exposes blob URL. Tracked follow-up: flip to `private` + signed URLs when @vercel/blob API ships.
- T-03 idempotency key: `idempotencyKey` field in `record-payment.ts` schema is accepted but NOT persisted (status-based replay only). Accepted debt per R7-S3 — not a blocker for MVP single-tenant.
- T-15 bounce-storm: per-member 10/h Upstash throttle claimed in security.md but NOT found in `outbox-dispatch/route.ts`. Bounce permanent-fail after 5 attempts does exist. Marked CONDITIONAL PASS — the 5-attempt cap + `invalid-recipient` short-circuit provides sufficient protection at current SweCham scale (single tenant, <200 members).
- T-19 template version: `CURRENT_TEMPLATE_VERSION` used for new issuance, pinned `templateVersion` from invoice row used for resend/void re-renders. Confirmed in `get-invoice-pdf-signed-url.ts:91`.

**Why:** These patterns are load-bearing for F5 (Stripe) and F7 (Email Broadcast) security reviews. Carry the dual-layer + REDACT_PATHS + CRON_SECRET patterns forward.

**How to apply:** In future features, verify (1) all new tables have ENABLE+FORCE RLS + policy in migration, (2) any new PII field added to audit payloads is added to REDACT_PATHS with depth-2 wildcard, (3) any new cron endpoint uses timingSafeEqual pattern from outbox-dispatch.
