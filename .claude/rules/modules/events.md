---
paths:
  - "src/modules/events/**"
  - "src/app/*/admin/events/**"
  - "src/app/api/webhooks/eventcreate/**"
  - "tests/**/events/**"
---

# Events (F6 `012-eventcreate-integration`)

- No CRUD event management — events live in EventCreate; we import attendees (Zapier webhook → attendee import → benefit quota). Strategy: `docs/event-integration-analysis.md`.
- Table `csv_import_records` + per-row `attendee_pdpa_consent_text` on `event_registrations` · streaming parser at `src/modules/events/infrastructure/streaming-csv-importer.ts` · error-rows CSV to a private Vercel Blob bucket, TTL-swept. No payment data (Principle IV n/a).
