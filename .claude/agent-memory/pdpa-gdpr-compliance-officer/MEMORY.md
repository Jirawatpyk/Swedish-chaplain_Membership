# DPO Agent Memory Index

- [F4 Lawful Basis & Retention](f4-lawful-basis-retention.md) — Tax docs use legal-obligation basis (§87/3 + GDPR Art. 6(1)(c)), distinct from F1–F3 contractual-necessity; 10-yr floor
- [Audit Payload PII Pattern](audit-payload-pii-pattern.md) — Recurring gap: recipient_email persisted raw in audit_log.payload on resend events; requires pseudonymisation
- [F4 Cross-Border Transfers](f4-cross-border.md) — Singapore hosting deviation documented F1 plan.md; PDPA §28 + GDPR SCCs cover Vercel+Neon+Upstash; inherited by all F-stream features
- [Logger Redaction Coverage](logger-redaction-coverage.md) — REDACT_PATHS in src/lib/logger.ts covers F4 PII; depth-2 wildcard *.*.recipient_email added R2-I1
- [DSR Coverage Status](dsr-coverage-status.md) — F4 partial portal access only; full DSR (Art.15/20) deferred to F9; erasure carve-out for legal-obligation docs documented
