# Contract — `GET /api/admin/events/import/history`

**Phase 1 contract · Feature**: `013-csv-import-eventcreate-format`

---

## Method & route

```
GET /api/admin/events/import/history?page=<int>&perPage=<int>&eventId=<uuid>&actorUserId=<uuid>
```

Runtime: Node.js · Cache: no-store (admin operational data) · Rate-limit: inherits F1 admin-route default

## Request

**Query params** (all optional, all combinable):

| Param | Type | Default | Constraint |
|---|---|---|---|
| `page` | integer | `1` | ≥ 1 |
| `perPage` | integer | `30` | 1 ≤ perPage ≤ 100 |
| `eventId` | UUID | none | Filter to one event |
| `actorUserId` | UUID | none | Filter to one admin |

**Authentication**: F1 session cookie. **Authorization**: admin only. Manager → 403; member → 404.

## Response 200 OK

```json
{
  "records": [
    {
      "recordId": "01HXYZ...",
      "uploadedAt": "2026-05-15T03:14:22Z",
      "actor": { "userId": "usr_…", "displayName": "Patsy Songkroh" },
      "event": { "eventId": "ev_…", "name": "SweCham AGM 2026", "startDate": "2026-03-20T18:00:00+07:00" },
      "sourceFormat": "eventcreate_csv",
      "originalFilename": "EventCreate_Guestlist-swecham-annual-general-meeting-2026.csv",
      "originalSizeBytes": 29337,
      "counts": {
        "total": 84,
        "processed": 78,
        "alreadyImported": 0,
        "skipped": 4,
        "failed": 2
      },
      "outcome": "completed",
      "durationMs": 14_321,
      "errorCsvAvailable": true,
      "errorCsvExpiresAt": "2026-06-14T03:14:22Z"
    }
  ],
  "pagination": {
    "page": 1,
    "perPage": 30,
    "totalRecords": 87,
    "totalPages": 3
  }
}
```

Records are returned in **reverse chronological order** by `uploadedAt`.

`errorCsvAvailable` is `true` ↔ (`failed > 0` AND `errorCsvExpiresAt > now()` AND `error_csv_blob_url IS NOT NULL`). Once expired or swept, the field flips to `false` automatically.

## Response 4xx

- **400 Bad Request** — invalid query params (page < 1, perPage > 100, malformed UUID)
- **401 Unauthorized** — missing session
- **403 Forbidden** — manager role (admin route)
- **404 Not Found** — member role (surface disclosure)
- **503 Service Unavailable** — kill-switch `FEATURE_F6_EVENTCREATE=false`

## Audit events

This route does NOT emit audit events on list / pagination. The `csv_import_error_csv_downloaded` event fires only at the separate signed-URL endpoint when admin clicks the download link.

## Contract test inventory

`tests/contract/events/csv-import-history-api.test.ts` covers:

1. 200 happy path with multiple records, asserts reverse-chrono order
2. 200 with `eventId` filter — only that event's imports
3. 200 with `actorUserId` filter — only that admin's imports
4. 200 with pagination boundaries (page=1, page=N, page beyond last)
5. 200 with `errorCsvExpiresAt` in the past → `errorCsvAvailable: false`
6. 400 invalid `page=0` / `perPage=101`
7. 401 missing session
8. 403 manager / 404 member RBAC matrix
9. 503 kill-switch
10. Tenant isolation: cross-tenant probe (Tenant A admin asks for Tenant B's records → only sees own; covered by integration test)

Estimated: **~12 contract tests** including tenant-isolation integration.
