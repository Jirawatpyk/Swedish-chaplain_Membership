# Contract: CSV Import

**Endpoint**: `POST /api/admin/events/import` (also covered in `admin-events-api.md`; this doc focuses on CSV format + processing semantics)
**FR refs**: FR-026, FR-027, FR-028, FR-029, SC-006

This contract specifies the CSV format consumed by the import path (primary ingest for non-EventCreate tenants per Session 2026-05-12 round 3 Q1; backfill / outage-recovery for EventCreate tenants). The same matching + quota logic as the webhook handler is applied (FR-027); the same `event_registrations` rows are produced; the same audit events are emitted. Idempotency is per-row via a hash of `(tenant_id, event_external_id, attendee_email_lower, registered_at)` stored in F6-owned `eventcreate_idempotency_receipts` with `source = 'eventcreate_csv'` (see data-model § 1.4).

---

## Required headers

| Header | Notes |
|--------|-------|
| `Cookie` (F1 session) | admin role only — FR-035 |
| `Content-Type: multipart/form-data; boundary=...` | Standard browser form upload |

---

## CSV format

UTF-8 (BOM tolerated and stripped), `\n` or `\r\n` line endings, comma-separated, optionally double-quoted fields with `""` escape. First row MUST be the header row.

### Required columns (in any order)

| Column | Type | Notes |
|--------|------|-------|
| `event_external_id` | string | EventCreate event ID; required for upsert key |
| `event_name` | string ≤ 500 | Required |
| `event_start` | ISO 8601 with TZ offset (e.g., `2026-06-21T18:00:00+07:00`) | Required |
| `attendee_email` | RFC 5322 email | Required |
| `attendee_name` | string ≤ 200 | Required |

### Optional columns

| Column | Type | Default | v1 status |
|--------|------|---------|-----------|
| `event_category` | `'networking'` / `'cultural'` / `'workshop'` / `'conference'` / free text | null | ✅ honoured |
| `event_end` | ISO 8601 | null | 🟡 **v1.1 backlog** — accepted by parser, dropped at event-upsert (event-end-date is webhook-only metadata in v1) |
| `event_location` | string ≤ 500 | null | 🟡 **v1.1 backlog** — accepted by parser, dropped at event-upsert |
| `event_url` | URL | null | 🟡 **v1.1 backlog** — accepted by parser, dropped at event-upsert |
| `is_partner_benefit` | `'true'` / `'false'` | `'false'` | 🟡 **v1.1 backlog** — intentionally DROPPED in v1 because the field is admin-toggle-controlled via FR-019; surfacing it from CSV would create dual-source-of-truth ambiguity. Use the admin toggle UI after import. |
| `is_cultural_event` | `'true'` / `'false'` | `'false'` | 🟡 **v1.1 backlog** — same rationale as `is_partner_benefit` |
| `attendee_company` | string ≤ 200 | null | ✅ honoured |
| `attendee_external_id` | string | falls back to synthesized `csv_${sha256(event_external_id, attendee_email_lower, registered_at).slice(0,32)}` when absent | ✅ honoured (E1 verification fix 2026-05-14 — preserves webhook-equivalent IDs when CSV is exported from same EventCreate dataset) |
| `ticket_type` | string ≤ 100 | null | ✅ honoured |
| `ticket_price_thb` | non-negative integer | null | ✅ honoured |
| `payment_status` | `'paid'` / `'pending'` / `'refunded'` / `'free'` | `'paid'` | ✅ honoured |
| `registered_at` | ISO 8601 | falls back to `event_start` | ✅ honoured |

**v1.1 backlog rationale** (5 columns marked 🟡): These columns are documented in the contract for forward-compatibility — tenants exporting CSVs from EventCreate or another source may include them harmlessly without breaking the parser. v1 silently drops the values during use-case mapping. Reasons:
- `event_end` / `event_location` / `event_url`: webhook payloads carry these in `event.endDate` / `event.location` / `event.eventCreateUrl` and the event-upsert preserves them; CSV v1 doesn't thread these through. A v1.1 sweep can extend `ProcessAttendeeInTxInput.event` if a real tenant ask emerges.
- `is_partner_benefit` / `is_cultural_event`: admin-toggle-controlled fields per FR-019. Surfacing them from CSV creates a confusing UX where an admin sees "is_partner_benefit=true" in their export but the actual flag is governed by an in-app toggle. Defer until product validates the cross-flow semantics.

### Example

```csv
event_external_id,event_name,event_start,event_category,is_cultural_event,attendee_email,attendee_name,attendee_company,ticket_type,registered_at
event_001,Midsummer 2026,2026-06-21T18:00:00+07:00,cultural,true,jane@fogmaker.com,Jane Andersson,Fogmaker International AB,Member Free,2026-06-01T10:23:15Z
event_001,Midsummer 2026,2026-06-21T18:00:00+07:00,cultural,true,lars@abb.com,Lars Larsson,ABB Thailand,Non-Member,2026-06-02T14:10:00Z
event_001,Midsummer 2026,2026-06-21T18:00:00+07:00,cultural,true,visitor@gmail.com,External Visitor,,Walk-In,2026-06-02T18:00:00Z
```

---

## Processing semantics

1. **Stream-parse** the file as `multipart/form-data` payload (FR-026). Max upload size 5 MiB.
2. **Validate header row** — every required column must be present. Missing required column → 400 with field-level error report; the upload is rejected outright (no partial processing).
3. **Process rows in batches of 100** — each batch is its own DB transaction; one bad row in a batch fails that row only (row-level error) and the remaining 99 rows in the batch still commit.
4. **For each row**:
   a. Zod-validate against `CsvRowSchema` (see `data-model.md` § 10). Invalid → push to `errorRows` and skip.
   b. Compute idempotency hash `sha256(tenant_id || event_external_id || attendee_email_lower || registered_at)`.
   c. `INSERT INTO eventcreate_idempotency_receipts (tenant_id, source='eventcreate_csv', request_id=<hash>, processed_at, ttl_expires_at) ON CONFLICT DO NOTHING RETURNING request_id`. Empty → row already processed in a prior import → increment `rowsAlreadyImported` counter for the result summary; skip side effects silently (idempotent).
   d. Upsert event row keyed by `(tenant_id, 'eventcreate', event_external_id)`.
   e. Insert registration row keyed by `(tenant_id, event_id, attendee_external_id_or_derived)`.
   f. Apply matching + quota effect (same logic as webhook).
   g. Audit-emit appropriate match + quota events.
5. **Return** the result summary with `rowsProcessed`, `eventsCreated`, `eventsUpdated`, per-match-type counts, and `errorRows[]`.

Total processing time MUST stay under 60s for 1,000 rows (SC-006). If exceeded, the function returns 504 Gateway Timeout and the partial state remains (idempotency makes re-import safe).

### Webhook-equivalence guarantee (E15)

The CSV path produces an event + registration state **functionally equivalent** to the same input arriving via the webhook path. The integration test `tests/integration/events/csv-webhook-equivalence.test.ts` asserts this guarantee by:

1. **Setup**: a fixture of 100 attendees across 5 events covering all 5 match_types + both quota effects.
2. **Path A** (webhook): for each attendee, the test issues an HMAC-signed POST to `/api/webhooks/eventcreate/v1/<tenant>` with the canonical payload. After all 100 requests, the test snapshots `events` + `event_registrations` rows for this tenant.
3. **Path B** (CSV): in a fresh tenant fixture with identical seed data, the test uploads a 100-row CSV with the same attendee data. After import, the test snapshots `events` + `event_registrations` rows.
4. **Equivalence assertion**: a hash-and-compare over selected columns of both snapshots:
   - `events`: `tenant_id, source, external_id, name, start_date, end_date, location, category, is_partner_benefit, is_cultural_event, archived_at` (modulo `imported_at`, `last_updated_at`, `metadata.fingerprint`)
   - `event_registrations`: `tenant_id, event_id, external_id, attendee_email_lower, attendee_name, attendee_company, match_type, matched_member_id, ticket_type, ticket_price_thb, payment_status, counted_against_partnership, counted_against_cultural_quota` (modulo `registration_id`, `imported_at`, `metadata.fingerprint`)
   - **Audit log**: same sequence of event types in same order (modulo `id`, `timestamp`, modulo path-discriminator fields like `processing_outcome.sourceIp` which differ between webhook and CSV).

5. **Test passes** if the hashes match. Test fails if any column is different in a way the equivalence rule above doesn't excuse. Excluded columns are explicitly enumerated to avoid false positives on bookkeeping timestamps.

### v1 scope note (X2)

The current v1 CSV import scope is **drag-drop upload → preview with auto-detected column mapping → confirm → process → result report**. The column-mapping UI (the preview step where admin can remap columns) adds ~3 tasks to F6 (`csv-mapping-form.tsx` + mapping-state Redux/zustand + remap E2E test). Alternative scope: ship with a **hard-coded column-name contract** (no preview, no remapping — the CSV must use the exact column names listed above) — saves ~3 tasks for a small UX downgrade (admin must align their CSV headers). The maintainer chose the full mapping UI scope for v1 to maximise tenant-side flexibility; if implementation pressure mounts, the column-mapping UI is a clean candidate to defer to F6.1.

---

## Response shapes

See `admin-events-api.md` § POST /api/admin/events/import for the 200 + 413 + 429 envelopes. Additional cases:

### 400 Bad Request — header validation failed

```jsonc
{
  "type": "https://chamber-os.app/errors/csv-header-invalid",
  "title": "CSV header row is invalid",
  "status": 400,
  "missingColumns": ["attendee_email", "event_start"]
}
```

### 504 Gateway Timeout

Returned by Vercel Fluid Compute if processing exceeds the function execution time limit. Body:

```jsonc
{
  "type": "https://chamber-os.app/errors/csv-timeout",
  "title": "CSV import exceeded time budget",
  "status": 504,
  "detail": "Import partially completed. Re-upload the same CSV — already-processed rows are idempotent and will be skipped."
}
```

---

## Audit events

| Outcome | Audit event(s) |
|---------|----------------|
| Whole import (success or partial) | `csv_import_completed` (with row counts payload) |
| Each invalid row | `csv_import_row_failed` (with row number + reason) |
| Each matched registration | one of `attendee_matched_*` / `attendee_non_member` / `attendee_unmatched` |
| Each quota change | `quota_*_decremented` (zero per-row when registration was idempotency-skipped) |
| Cross-tenant probe | `cross_tenant_probe` (high severity) |
| Manager attempted | `role_violation_blocked` |
