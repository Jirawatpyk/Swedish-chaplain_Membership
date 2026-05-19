# Contract — `GET /api/admin/events/import/[recordId]/error-csv`

**Phase 1 contract · Feature**: `013-csv-import-eventcreate-format`

---

## Method & route

```
GET /api/admin/events/import/{recordId}/error-csv
```

Runtime: Node.js · Cache: no-store · This endpoint generates a fresh 15-minute signed URL on every call and emits an audit event.

## Path params

| Param | Type | Constraint |
|---|---|---|
| `recordId` | UUID | Must be a `csv_import_records.record_id` owned by the current tenant |

## Request

**Authentication**: F1 session cookie. **Authorization**: admin only.

No body, no query params.

## Response 307 Temporary Redirect (happy path)

```
HTTP/1.1 307 Temporary Redirect
Location: https://blob.vercel-storage.com/tenants/{slug}/csv-import-errors/{recordId}.csv?token=<signed-15min>
Cache-Control: no-store
```

The browser follows the redirect to Vercel Blob's signed-URL endpoint, which streams the CSV content. The signed URL expires after **15 minutes**; admin must re-click to get a fresh URL.

**Side effect**: BEFORE returning the redirect, the route MUST emit a `csv_import_error_csv_downloaded` audit event with:
- `actorUserId`: from session
- `recordId`: from path param
- `downloadedAt`: now()
- `sourceIp`: from request headers (X-Forwarded-For first IP)

The audit emit + signed-URL generation MUST be transactional — if audit fails, the route returns 500 and no signed URL is issued. This is the strict-audit invariant per R6 / FR-021.

## Response 4xx / 5xx

### 404 Not Found

Returned when:
- `recordId` does not exist in `csv_import_records` (within current tenant — RLS enforces)
- `recordId` exists but belongs to another tenant (surface-disclosure: same 404)
- `record.error_csv_blob_url IS NULL` (no errors in that import, OR TTL swept the blob already)

All three cases return the same body — admins should not distinguish "wrong record" from "expired blob" from "cross-tenant probe":

```json
{
  "type": "https://chamber-os.app/errors/error-csv-not-available",
  "title": "Error CSV not available",
  "status": 404,
  "detail": "The error CSV for this import has either been removed or never existed. Re-run the import to generate fresh error rows."
}
```

For cross-tenant probe: same response body, but a **`csv_import_cross_tenant_probe`** audit event fires with high severity.

### 401 Unauthorized — missing session
### 403 Forbidden — manager role (admin route)
### 503 Service Unavailable — kill-switch

### 500 Internal Server Error — `error_csv_signing_failure`

When Vercel Blob is unreachable or signed-URL generation fails:

```json
{
  "type": "https://chamber-os.app/errors/internal",
  "title": "Internal Server Error",
  "status": 500,
  "detail": "Could not generate download link. Try again in a moment; if this persists, contact support with this request ID.",
  "requestId": "req_…"
}
```

NO audit event emitted in this failure path (the audit emit is gated on successful signed-URL generation per the strict-audit invariant).

**Operational visibility on 500 path** (closes plan-validation S-01): the route MUST emit a pino structured log at level `error` with event name `f6_error_csv_signing_failure`, containing `{recordId, tenantId, actorUserId, blobUrlExists: boolean, err: <message>, requestId}` — this is an **operational log** (stderr → Vercel Fluid Compute capture → OTel correlator), NOT a DB audit event. Operators alert on `rate > 0` of this log event to detect Vercel Blob outages independently of the absent audit signal. Distinct from the audit-trail invariant — failing to sign a URL is a transport-level event the SRE team needs visibility into, but it doesn't represent a PII access event worth a 5-year audit row.

---

## Audit events emitted

| Event | When | Payload |
|---|---|---|
| `csv_import_error_csv_downloaded` | Successful 307 redirect path | `{ actorUserId, recordId, downloadedAt, sourceIp }` |
| `csv_import_cross_tenant_probe` | 404 path where `recordId` exists in another tenant | High-severity per Constitution Principle I clause 4 |

## Contract test inventory

`tests/contract/events/error-csv-signed-url-api.test.ts` covers:

1. 307 happy path — assert redirect Location header points to signed URL, assert audit emit fires with correct payload
2. 404 record-not-found (own tenant) — no audit emit
3. 404 cross-tenant — audit `csv_import_cross_tenant_probe` emits with HIGH severity
4. 404 blob-already-swept (TTL passed) — distinguish from record-not-found internally but identical response body
5. 500 signed-URL generation failure — assert NO audit emit (strict invariant)
6. 401 missing session
7. 403 manager / 404 member RBAC matrix
8. 503 kill-switch

Estimated: **~10 contract tests**.

---

## Cross-tenant integration test (Constitution Principle I clause 3)

`tests/integration/events/error-csv-cross-tenant-isolation.test.ts`:
- Setup: 2 tenants A + B, each runs a CSV import that produces error rows + Blob
- Tenant A admin attempts to GET Tenant B's `/recordId/error-csv` → 404 + cross-tenant audit emit
- Tenant B admin GETs own record → 307 + own audit emit
- Verify Blob URLs are not shared / leakable cross-tenant

Mandatory for ship — Review-Gate blocker per Principle I clause 3.
