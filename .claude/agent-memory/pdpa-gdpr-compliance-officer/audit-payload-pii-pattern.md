---
name: Audit Payload PII — Recurring Gap Pattern
description: Developers repeatedly store raw PII (especially recipient_email) in audit_log.payload, which has ≥10-year retention; requires pseudonymisation
type: project
---

**Recurring finding across F4 review:** `recipient_email` written raw into `audit_log.payload` JSONB for `invoice_pdf_resent`, `receipt_pdf_resent`, and `credit_note_pdf_resent` events.

File: `src/modules/invoicing/application/use-cases/resend-pdf.ts` lines 228, 243 (and credit-note ~line 300).

**Why this matters:** `audit_log` rows have ≥10-year retention for F4 (FR-029 basis). Storing raw email for 10 years for traceability purposes that could be served by a pseudonymous reference violates GDPR Art. 5(1)(c) data minimisation + Art. 5(1)(e) storage limitation. PDPA §23 purpose limitation also applies.

**Recommended remediation pattern:**
```
// Instead of: recipient_email: 'user@example.com'
// Use: rcpt_domain: 'example.com', rcpt_hash: HMAC_SHA256(email, tenant_secret)
```

**How to apply:** At every audit event that touches `recipient_email` or any email address in payload, flag as HIGH and require pseudonymisation. Logger redaction (REDACT_PATHS) covers the logging layer — this finding is specific to persisted DB rows in `audit_log.payload`.

**Note:** pino REDACT_PATHS already covers `recipient_email` at depth-2 (`*.*.recipient_email`) — the gap is only in persisted audit rows, not in logs.
