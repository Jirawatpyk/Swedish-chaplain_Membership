---
name: Logger Redaction Coverage (src/lib/logger.ts REDACT_PATHS)
description: Canonical REDACT_PATHS list covers F1-F4 PII; depth-2 wildcard for recipient_email added; audit rows are a separate gap
type: project
---

File: `src/lib/logger.ts` — `REDACT_PATHS` exported constant, lines 45–131.

**F4-added redact paths (lines 98–131):**
- `member_legal_name_snapshot` / `*.member_legal_name_snapshot` / camelCase variants
- `member_address_snapshot` / `*.member_address_snapshot` / camelCase variants
- `signed_url_token` / `*.signed_url_token` / camelCase variants
- `pdf_binary` / `*.pdf_binary` / camelCase variants
- `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`
- `recipient_email`, `*.recipient_email`, `*.*.recipient_email` (depth-2 for audit event objects)

**Important distinction:**
- Logger redaction (REDACT_PATHS) protects log sinks — verified PASS for F4.
- Persisted `audit_log.payload` JSONB is NOT covered by logger redaction — this is a separate data-minimisation concern (see audit-payload-pii-pattern.md for the recurring gap).

**How to apply:** When a new PII field is introduced in F5+, add it to REDACT_PATHS in both snake_case and camelCase at top-level AND `*.field` (depth-1). For fields that can appear 2 levels deep in audit event objects, also add `*.*.field`. The test file `tests/unit/lib/logger-pii.test.ts` imports REDACT_PATHS directly — new fields get coverage automatically.
