# Contract — `POST /api/admin/events/import`

**Phase 1 contract · Feature**: `013-csv-import-eventcreate-format`
**Extends**: F6 Phase 7 contract `specs/012-eventcreate-integration/contracts/csv-import-api.md` (all Phase 7 outcomes still in scope; this file documents the deltas + new outcomes only)

---

## Method & route

```
POST /api/admin/events/import
```

Runtime: Node.js (Drizzle pool access). Rate-limit: 5 imports/hour per (tenant, actor) — inherited from Phase 7.

## Request

**Content-Type**: `multipart/form-data`

| Form field | Type | Required | Notes |
|---|---|---|---|
| `file` | File (CSV) | Yes | UTF-8 (BOM allowed); ≤ 5 MiB; either EventCreate format or generic Phase 7 format |
| `event_id` | String (UUID) | **Yes (NEW)** | The F6 event the upload reconciles to. Admin must pre-create event before upload (FR-003 / Q1) |
| ~~`mode`~~ | — | — | DROPPED v1 per Clarifications post-critique Q5 (US3 match-preview cut). Request body has no `mode` field; all uploads go through commit path. |
| `force_proceed` | String | No | Bypasses the FR-019b event-mismatch safety net. **Accepted truthy values** (case-insensitive, trimmed): `"true"`, `"1"`, `"yes"`. Any other value (including `"false"`, `"0"`, `""`, absent) = safety net active (default safe). Normalisation done server-side: `["true","1","yes"].includes(value?.trim().toLowerCase())`. |

**Query params**: none

**Authentication**: F1 session cookie. **Authorization**: `admin` role only — `manager` returns 403, `member` returns 404 (surface disclosure per FR-035).

**Rate-limit headers**: `X-RateLimit-Remaining` / `Retry-After` (existing Phase 7 contract).

---

## Response outcomes

### 200 OK — `mode=commit` happy path (extends Phase 7)

```json
{
  "kind": "completed",
  "recordId": "01HXYZ...",                 // NEW — links to history page + error-CSV signed URL
  "sourceFormat": "eventcreate_csv",        // NEW — adapter mode detected (Q5/R2)
  "summary": {
    "rowsTotal": 84,
    "rowsProcessed": 78,
    "rowsAlreadyImported": 0,
    "rowsSkipped": 4,                       // NEW — Status filter (Cancelled/No Show/etc.)
    "errorRows": [
      { "rowNumber": 12, "reason": "row_failed: …", "failureStage": "event_upsert" },
      { "rowNumber": 47, "reason": "Skipped: Status=Waitlisted (not a recognized attending status)" }
    ],
    "rowsFailed": 2,
    "matchCounts": { "member_contact": 45, "member_domain": 15, "member_fuzzy": 3, "non_member": 12, "unmatched": 3 },
    "eventsCreated": 0,
    "eventsUpdated": 1,                     // selected event got new registrations
    "durationMs": 14_321,
    "timedOut": false
  },
  "errorCsvAvailable": true                 // NEW — convenience flag; true ↔ rowsFailed > 0 AND blob exists
}
```

### ~~200 OK — `mode=preview` match-preview~~ — DROPPED v1

Match-preview path removed per Clarifications Session 2026-05-15 post-critique Q5 (US3 cut for smoother UX). Admin sees match counts in the post-commit result card (existing Phase 7 behaviour).

### 200 OK — `event_mismatch_warning` (NEW per FR-019b)

When the system detects that the uploaded CSV's attendee fingerprint matches a prior import (within 30 days, same tenant, **different event**) AND the `force_proceed=true` form field is not set:

```json
{
  "kind": "event_mismatch_warning",
  "priorImports": [
    {
      "recordId": "01HXYZ...",
      "eventId": "ev_prior_…",
      "eventName": "SweCham AGM 2026",
      "uploadedAt": "2026-04-22T10:14:00Z"
    }
  ]
}
```

**Side effects**: ZERO. No `csv_import_records` row inserted; no audit events; no quota changes; no registrations created. The admin's UI shows a warning dialog. To proceed, admin re-submits the SAME form data + adds `force_proceed=true` — the second request bypasses the safety net and emits `csv_import_event_mismatch_overridden` audit before proceeding with the normal commit.

### 400 Bad Request — `event_not_selected` (NEW)

```json
{
  "type": "https://chamber-os.app/errors/csv-event-not-selected",
  "title": "Event not selected",
  "status": 400,
  "detail": "The 'event_id' field is required. Select an event from the dropdown before uploading.",
  "requestId": "req_…"
}
```

### 400 Bad Request — `event_not_found` (NEW)

```json
{
  "type": "https://chamber-os.app/errors/csv-event-not-found",
  "title": "Event not found",
  "status": 400,
  "detail": "Event 'ev_01XYZ' was not found in your chamber. Was it deleted?",
  "extras": { "eventId": "ev_01XYZ" }
}
```

### 403 Forbidden — `event_not_owned_by_tenant` (NEW, surface-disclosure: 404, timing-safe)

When `event_id` exists but belongs to a different tenant (cross-tenant probe attempt), the route returns **404** with the same body as `event_not_found` — admin should not be able to distinguish "exists in another tenant" from "doesn't exist". The cross-tenant probe event IS audit-logged with high severity (Constitution Principle I clause 4).

**Timing-safe response** (closes critique E8): both `event_not_found` and `event_not_owned_by_tenant` MUST take effectively the same wall-clock time (±10ms variance). Implementation: fetch event row by `id` WITHOUT tenant filter (single query), THEN check tenant ownership in application code. Both paths execute the same DB query work; only the post-fetch branch differs. This prevents timing-attack enumeration of event IDs across tenants. The contract test asserts the timing invariant by measuring p95 latency of both 404 paths over ≥50 requests and asserting their delta < 10ms.

### 400 Bad Request — `csv-header-invalid` (Phase 7 — unchanged)

When `mode=commit` and neither EventCreate (6-column presence per R2) nor generic Phase 7 header is detected:

```json
{
  "type": "https://chamber-os.app/errors/csv-header-invalid",
  "title": "CSV header row is invalid",
  "status": 400,
  "detail": "Could not detect format. Required for EventCreate: Basic Info, Status, First Name, Last Name, Email, Attendee ID. Required for generic: event_external_id, event_name, event_start, attendee_email, attendee_name.",
  "missingColumns": []   // empty array when format-detection fails entirely; populated for partial generic
}
```

### 400 Bad Request — `csv-parser-error` (Phase 7 — R-S03/R-S02 fix unchanged)

UTF-8 encoding errors, invalid quoting, etc. The use-case message is surfaced as detail (e.g., "parser error: invalid_utf8 — re-save as UTF-8 without BOM").

### 413 Payload Too Large — pre-parse + post-parse (Phase 7 — both branches unchanged)

### 415 Unsupported Media Type (Phase 7 — unchanged)

### 429 Too Many Requests (Phase 7 — unchanged)

### 504 Gateway Timeout — `csv-timeout` (Phase 7 — unchanged; emit `csv_import_completed` with `timedOut: true` per R-S02 fix)

### 503 Service Unavailable — kill-switch (Phase 7 — unchanged when `FEATURE_F6_EVENTCREATE=false`)

### 500 Internal Server Error — `unexpected_error` (Phase 7 — unchanged)

---

## Contract test inventory (drives RED phase tasks)

The contract test file `tests/contract/events/csv-import-eventcreate-format.test.ts` MUST cover at minimum:

1. **200 commit happy path EventCreate format** — upload Grant Thornton fixture, mock `runImportCsvMock` to return `completed`, assert response shape including `recordId`, `sourceFormat: 'eventcreate_csv'`, `errorCsvAvailable: false`
2. **200 commit happy path generic format** — upload Phase 7 synthetic CSV, assert `sourceFormat: 'generic_csv'`
3. ~~200 preview path~~ — DROPPED (US3 cut)
4. **200 commit with error rows** — assert `errorCsvAvailable: true` when `rowsFailed > 0`
5. **400 event_not_selected** — omit `event_id` form field → 400 with the new problem-detail type
6. **400 event_not_found** — `event_id` is a valid UUID but no row exists → 400
7. **404 event_not_owned_by_tenant** — `event_id` exists under another tenant → 404 (surface disclosure) + audit emit assertion
8. **400 csv-header-invalid (no format detected)** — upload a CSV with random columns → 400 with empty `missingColumns`
9. **400 csv-parser-error (UTF-16 BOM)** — surface parser hint per R-S02
10. **413 pre-parse + post-parse** — Phase 7 R-S03 fix
11. **415 wrong content-type** — Phase 7 unchanged
12. **429 rate-limit exhausted** — Phase 7 unchanged
13. **504 timeout** — Phase 7 R-S02 fix unchanged
14. **503 kill-switch** — Phase 7 unchanged
15. **403/404 RBAC matrix** — manager/member roles per FR-035
16. **Multipart parsing edge cases** (omitFileField / malformedBody / etc.) — Phase 7 unchanged

Estimated: **~20 contract tests** (Phase 7 has 16; +4 new = 20).

---

## Audit events emitted by this contract

| Event type | When emitted | Notes |
|---|---|---|
| `csv_import_completed` | Every commit-mode response (including timeout + partial_failure) | Payload now carries `sourceFormat` (extension per Q5) |
| `csv_import_row_failed` | Per-row failure | Phase 7 — unchanged |
| `csv_import_error_csv_downloaded` | NEW — emitted by the separate signed-URL route, NOT this contract | See `error-csv-signed-url-api.md` |
| ~~`csv_import_refund_review_signalled`~~ | — | DROPPED v1 per Clarifications Session 2026-05-15 post-critique Q2 (F4 cross-cutting feature removed) |
| `role_violation_blocked` | Non-admin RBAC violation | Phase 7 — unchanged |
| `eventcreate_csv_adapter_unknown_columns` | Pino structured log (NOT audit DB event) on every EventCreate-format upload that contained columns outside the recognized set | NEW — per-upload aggregate, not per row |

No payment audit events (Principle IV n/a).
