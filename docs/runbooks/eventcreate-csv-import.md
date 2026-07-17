# Runbook — F6.1 EventCreate CSV Import Operations

**Feature**: `013-csv-import-eventcreate-format` (CSV Primary Path + EventCreate Format Adapter)
**Surfaces**: `/admin/events/import` (POST upload) · `/admin/events/import/history` (GET history) · `/admin/events/import/{recordId}/error-csv` (signed-URL redirect) · `/api/internal/retention/sweep-error-csv-blobs` (daily TTL cron)

**Audience**: On-call SRE + maintainer-on-duty.

---

## 1. Feature flags

Two flags, both validated by zod at boot (`src/lib/env.ts`):

| Flag | Default | Purpose |
|---|---|---|
| `FEATURE_F6_EVENTCREATE` | `true` | Master kill-switch. When `false`, all `/admin/events/import/**` routes return 404/503 + the cron route bypass — completely disables F6 webhook + CSV ingest. |
| `FEATURE_F6_EVENTCREATE_ADAPTER` | `true` | Sub-flag for the EventCreate format adapter. When `false`, every upload routes through the generic Phase 7 CSV path even if the header has the 6 EventCreate required columns. Used as the **rollback safety net** per Spec § Rollback Plan. |

**Flag-flip behaviour** (mid-import semantics, per Spec § Operational notes E14):
- Both flags are read **ONCE** per request at composition time (`src/lib/events-csv-import-deps.ts` for the sub-flag; route entry for the master).
- New requests after a flag-flip pick up the change immediately.
- In-flight imports complete with their original flag value (no graceful-stop mid-batch — partial-state inconsistency risk outweighs flip latency).
- Typical drain time: <60s for new requests; in-flight imports complete within `timeBudgetMs` (default 55s).

**Rollback trigger** (per Spec § Rollback Plan + SC-008):
- Flip `FEATURE_F6_EVENTCREATE_ADAPTER=false` when:
  - `>5 admin support issues attributable to F6.1` in the first 7 days post-launch, OR
  - `rate(eventcreate_csv_adapter_mode_detected_total{format="generic_csv"})` spikes unexpectedly on a tenant known to use EventCreate (signals capitalization drift).
- Flip the master `FEATURE_F6_EVENTCREATE=false` only if F6 webhook ingest is also failing.

---

## 2. Daily TTL sweep cron

**Endpoint**: `GET /api/internal/retention/sweep-error-csv-blobs` (native Vercel Cron triggers via GET since 2026-07-17; the handler also accepts POST — `export const GET = POST` — for the paused cron-job.org standby. Bearer-gated + dynamic-rendered, so the earlier crawler / browser-prefetch / edge-cache GET-idempotency concern does not apply)
**Authentication**: `Authorization: Bearer ${CRON_SECRET}` (≥16 chars; strict in ALL envs — no dev bypass).
**Runtime**: Node.js.

**Cadence**: Daily `0 22 * * *` UTC (= 05:00 Asia/Bangkok) via **native Vercel Cron** (`vercel.json`, since the 2026-07-17 Pro migration; previously cron-job.org). If needed, trigger manually (§ 2.2).

### 2.1 Healthy response

```json
{
  "ok": true,
  "candidatesScanned": 5,
  "sweptCount": 5,
  "skippedCount": 0,
  "cutoff": "2026-05-15T22:00:00Z",
  "durationMs": 1843
}
```

`sweptCount` = blobs successfully deleted from Vercel Blob + DB columns cleared.
`skippedCount` = rows where blob delete or DB update failed; retried on the next cron run (idempotent).

### 2.2 Manual recovery

If cron-job.org is offline OR shows ≥2 consecutive day failures (email alert per T058):

```powershell
# Replace YOUR_CRON_SECRET with the value from Vercel env.
curl -X POST `
     -H "Authorization: Bearer YOUR_CRON_SECRET" `
     https://swecham.zyncdata.app/api/internal/retention/sweep-error-csv-blobs
```

The sweep is idempotent + re-running is safe. SLA target: blob deletion within 35 days max (5-day grace beyond the 30-day TTL; PDPA Section 37 minimization principle remains satisfied at 35 days).

### 2.3 Sweep failure modes

| Symptom | Diagnosis | Fix |
|---|---|---|
| 401 from cron-job.org | Bearer mismatch | Verify `CRON_SECRET` in Vercel env matches cron-job.org dashboard |
| 500 with `sweep_cron_failed` | DB or Blob outage during sweep | Check Vercel runtime logs; next cron run retries automatically |
| `skippedCount > 0` for many consecutive days | Persistent Blob 404s or DB RLS denial | Inspect pino warn log `f6_error_csv_sweep_blob_delete_failed` / `f6_error_csv_sweep_clear_failed` |
| Email alert "2 consecutive day failures" | Cron-job.org has not received a 200 in 2 days | Run manual recovery (§ 2.2); investigate why cron-job.org is unable to reach the endpoint |

---

## 3. Signed-URL leak response — and Vercel Blob `access:'public'` design caveat

### 3.0 Public-blob design trade-off (staff-review M-1 / 2026-05-16)

Vercel Blob's non-Enterprise tier does NOT support true private buckets. Error-CSV blobs are stored with `access:'public'` and an opaque `addRandomSuffix:true` capability-token URL. Any actor with access to the URL (DB read on `csv_import_records.error_csv_blob_url`, or the issued signed-URL redirect target) can fetch the underlying CSV during the **30-day TTL window** WITHOUT producing an audit-log entry. The 15-minute signed-URL expiry stamped in the `?expires=` query param is enforced at the route handler, not by Vercel Blob itself.

**Practical implications for admins**:
- Treat the `error_csv_blob_url` column as sensitive — anyone with DB query access to `csv_import_records` can read the corresponding error CSV directly until the 30-day TTL sweep runs.
- Do NOT upload CSVs containing strictly-confidential attendee lists where a 30-day public-URL window would be unacceptable. EventCreate "Guestlist" exports for chamber events meet the documented PDPA risk acceptance; high-confidentiality exports (e.g., medical/legal client lists if F6.1 is ever repurposed) do not.
- Escalation path if a wider customer mandates true private blob storage: revisit Vercel Blob Enterprise tier ($XX/month) or migrate to S3+presigned-URLs — tracked as F6.2 backlog.

### 3.1 If a signed URL for an error CSV is accidentally shared externally:

1. **Confirm the URL is still valid** (15-minute window from issuance). Look up the most recent `csv_import_error_csv_downloaded` audit row for the affected recordId:

   ```sql
   SELECT timestamp, actor_user_id, source_ip, payload
   FROM audit_log
   WHERE event_type = 'csv_import_error_csv_downloaded'
     AND payload->>'recordId' = '<RECORD_ID>'
   ORDER BY timestamp DESC
   LIMIT 1;
   ```

2. **If within the 15-minute window**: immediately rotate the blob URL by deleting the underlying Vercel Blob (forces the next access attempt to 404):

   ```sql
   UPDATE csv_import_records
      SET error_csv_blob_url = NULL,
          error_csv_expires_at = NULL
    WHERE record_id = '<RECORD_ID>';
   -- Then via the Vercel dashboard or CLI, delete the blob at the URL captured above.
   ```

3. **PDPA Section 37 breach notification**: if the leaked CSV contained ≥1 row of member PII (email + name), notify the DPO within 72h. The error CSV's row count is recorded in `csv_import_records.rows_failed`.

4. **Audit trail**: every download — both the legitimate admin click and any attacker re-click — is logged in `audit_log` with `event_type = 'csv_import_error_csv_downloaded'`. Use this to scope the blast radius.

---

## 3a. Error-CSV formula injection caveat (staff-review M-3 / 2026-05-16)

The downloaded error CSV reproduces the FAILED ROWS VERBATIM per FR-021, including any cells that begin with `=`, `@`, `+`, or `-`. If opened in Microsoft Excel, Google Sheets, or LibreOffice Calc with default settings, those cells will be interpreted as formulas and may execute (including external calls like `=WEBSERVICE("...")`). This is intentional spec behaviour for the admin-only tool — admins repair the rows and re-upload — but admins MUST be informed of the risk.

**Operator instructions to attach to the F6.1 admin onboarding doc**:
1. After downloading an error CSV, open it in a text editor first (Notepad++, VS Code) to verify nothing surprising leads cells.
2. If opening in Excel/Sheets is necessary, disable automatic formula calculation BEFORE opening:
   - Excel: File → Options → Formulas → Workbook Calculation: Manual; or use `Get Data → From Text` import mode.
   - Sheets: File → Settings → Calculation → Iterative calculation: Off; or import via `File → Import → Replace data at selected cell` to preserve raw text.
3. After review and edit, save back to CSV (NOT XLSX) and re-upload.

No code change is required; the verbatim emit is per-spec. This caveat is now part of the F6.1 admin-facing release notes.

---

## 4. EventCreate header drift detection

The adapter requires exactly these 6 case-sensitive column names (`src/modules/events/infrastructure/eventcreate-csv-adapter.ts`):

```
Basic Info | Status | First Name | Last Name | Email | Attendee ID
```

EventCreate's product team has changed column names twice in the past 18 months. To detect drift:

### 4.1 Adapter-mode metric

`eventcreate_csv_adapter_mode_detected_total{tenant, format}` — incremented once per import. Watch for:

- **Unexpected `format=generic_csv` spike on a known EventCreate tenant**: capitalization or label drift; the adapter is silently falling through to Phase 7 strict schema (which then rejects the upload as `invalid_header`).
- **`format=eventcreate_csv` rate drop to 0**: EventCreate export schema broke entirely; rollback by flipping `FEATURE_F6_EVENTCREATE_ADAPTER=false`.

### 4.2 Unknown-columns aggregate log

Pino structured log `f6_eventcreate_adapter_unknown_columns` is emitted ONCE per import (NOT per row) when the EventCreate adapter accepts a header but encounters unknown column names (FR-012 tolerance). Payload:

```json
{
  "event": "f6_eventcreate_adapter_unknown_columns",
  "tenantId": "swecham",
  "distinctUnknownColumns": ["NewColumnName", "AnotherNew"],
  "unknownColumnCount": 2
}
```

Review this log weekly. When a column appears in ≥3 imports across distinct tenants, add it to `EVENTCREATE_KNOWN_COLUMNS` in the adapter (no spec/migration needed — purely defensive observability).

---

## 5. Concurrent operation invariants

Per Spec § Operational notes E-R2-2:

| Scenario | Behaviour | Lock |
|---|---|---|
| Same admin, same event, two concurrent imports | The second blocks until the first commits/rolls back | `pg_advisory_xact_lock('csv-import:'+tenantId+':'+eventId)` |
| Two admins, same tenant, different events | Run in parallel | Independent locks |
| Same import vs concurrent F6 admin edit on a registration | CSV wins per FR-019 (`re-upload always wins`); both changes audit-logged | App-layer race window; ~ms-scale |
| Cross-tenant concurrent operations | Always isolated by RLS+FORCE + branded `TenantId` at the app layer | n/a — independent locks |

Pool usage: at SC-006 envelope (1k rows × `batchConcurrency=3`), peak Drizzle connections = 3 per in-flight import. Two parallel imports on different events ≈ 6 connections (Neon Singapore default pool: 10). Three+ parallel imports may hit pool exhaustion — escalate to ops if observed.

---

## 6. Blob upload failure recovery

Per Spec § Edge Cases (research.md R6 / E2):

If `vercelBlob.put(...)` fails AFTER the import tx commits (rows are persisted), the admin sees:
- Result card with `errorCsvAvailable: false`
- Pino warn log `f6_csv_error_csv_blob_put_failed` (NOT a DB audit event)

**Admin recovery**: re-run the same import. Idempotency receipts dedupe the row INSERTs (no double-counting); the second run retries the blob upload. If the upload still fails, the admin can re-export from EventCreate + use the generic-CSV path (or skip the error-CSV download entirely — the rows are committed regardless).

**No retry queue**: F6.1 does not introduce a background job system for Blob retries. Re-run is admin-driven.

---

## 7. Event-mismatch override audit review

FR-019b safety net detects when a CSV uploaded to event A has the same attendees as a recent (≤30d) prior import to event B. On detection, the admin sees a warning dialog + the option to "Continue anyway".

When the admin overrides, `csv_import_event_mismatch_overridden` audit fires at `warn` severity. Review this audit weekly to tune the safety net:

```sql
SELECT
  COUNT(*) AS overrides_count,
  COUNT(DISTINCT actor_user_id) AS distinct_admins,
  COUNT(DISTINCT tenant_id) AS distinct_tenants,
  MIN(timestamp) AS first_seen,
  MAX(timestamp) AS last_seen
FROM audit_log
WHERE event_type = 'csv_import_event_mismatch_overridden'
  AND timestamp > NOW() - INTERVAL '30 days';
```

If overrides exceed 10/month on the SweCham tenant, the safety net is too sensitive — consider tightening the 30-day window OR adding an "ignore this mismatch for X days" suppression.

---

## 8. Cross-tenant probe alerts

`csv_import_cross_tenant_probe` audit fires at `critical` severity on TWO surfaces:

1. **POST /api/admin/events/import** — `event_id` form field belongs to another tenant.
2. **GET /api/admin/events/import/{recordId}/error-csv** — `recordId` belongs to another tenant.

Constitution Principle I clause 4 requires SRE alerts on `rate > 0`. The expected baseline is ZERO probes per month at SweCham scale. Any probe → investigate immediately:

```sql
SELECT timestamp, tenant_id, actor_user_id, source_ip, payload
FROM audit_log
WHERE event_type = 'csv_import_cross_tenant_probe'
  AND timestamp > NOW() - INTERVAL '24 hours'
ORDER BY timestamp DESC;
```

A handful of probes with the same actor_user_id may indicate accidental cross-tenant URL sharing (e.g., a bookmark from a multi-tenant maintainer). Sustained probes from a single IP or actor → escalate to security + consider disabling the actor's admin role pending review.

---

## 9. Rollback procedure

If F6.1 must be rolled back entirely (rare; only if data integrity issue detected):

1. **Drain incoming work**: flip `FEATURE_F6_EVENTCREATE_ADAPTER=false` in Vercel env. New requests immediately use generic Phase 7 path.
2. **Wait 60s** for in-flight imports to complete (per E14 mid-import semantics).
3. **Investigate root cause** via:
   - `f6_csv_*` pino logs in Vercel runtime logs.
   - `csv_import_records` rows with `outcome IN ('timeout', 'partial_failure', 'unexpected_error')`.
   - F6 audit-log entries.
4. **If rollback is permanent**: also flip `FEATURE_F6_EVENTCREATE=false` to disable both webhook ingest + CSV import surfaces. Admin UI will show 404 on the import page.

**Data integrity guarantee**: rolling back the flags does NOT mutate or remove rows already imported. Re-enabling F6.1 later re-exposes the same surfaces with the same data.

---

## 10. Migration safety

F6.1 migrations 0139–0141 + 0144 + 0160 are additive only (CREATE TABLE / ALTER TABLE ADD COLUMN / ALTER TYPE ADD VALUE / ALTER CONSTRAINT extending allowlists). Rollback = drop table / drop column / shrink allowlist back. Postgres enum values cannot be dropped without an offline rebuild; the slot stays harmlessly populated if the TS surface is removed.

---

## 11. Pending → Attending sync via re-upload (Option B+, 2026-05-18)

EventCreate-Status semantics in TSCC's real workflow are not 1:1 with payment lifecycle. A registrant can be `Pending` because:

- They registered, transferred money, but the host has not verified the bank slip yet;
- They registered for a free-with-approval event and the host has not approved yet;
- Auto-status never advanced because the host forgot.

Admins do **NOT** know in advance when EventCreate will flip Status. Chamber-OS handles this by mirroring EventCreate's `Status` column directly into `event_registrations.payment_status` (per **spec.md § FR-007**, Option B+). Pending rows persist with `payment_status='pending'` and become available to F7 broadcasts + F8 at-risk scoring immediately.

When the host eventually verifies payment in EventCreate and flips Status from `Pending → Attending`, the admin simply re-exports the CSV and re-uploads. The receipt-duplicate state-change probe in `maybeApplyStateChange` detects the divergence:

1. Receipt for the row already exists (same `(event_external_id, email_lower, ts, attendee_external_id)` rowHash);
2. The persisted registration's `payment_status='pending'` differs from the incoming `'paid'`;
3. The probe applies an UPDATE in the same savepoint and emits `csv_import_row_state_changed`;
4. The summary's `rowsStateChanged` increments by 1 (NOT `rowsAlreadyImported`).

Quota counting (per **FR-019**) is strict — only `payment_status ∈ {paid, free}` contributes. So a `pending → paid` flip ALSO promotes the row into the quota count atomically in the same UPDATE. No separate admin action needed.

**What admins should NOT do**: hand-edit the CSV to force `Status=Attending` before the host has verified payment in EventCreate. The system mirrors actual EventCreate state; the next legitimate re-upload from EventCreate will reverse the hand-edit. Use EventCreate's host UI to flip Status instead, then re-upload.

---

## 12. F7 + F8 cross-module impact (Option B+ no-op)

F7 (Email Broadcast) and F8 (Renewal / At-Risk Scoring) shipped before Option B+. The new `payment_status` values (`pending`, `waitlisted`, `no_show`) introduced 2026-05-18 are **transparent** to both modules — verified via grep over `src/modules/broadcasts/` and `src/modules/renewals/` finding zero direct filters on `event_registrations.payment_status`.

Observed behaviour change without any F7/F8 code edits:

- **F7 broadcasts** target members by `RecipientSegment` (member-level criteria — tier, archived flag, marketing-consent). Member rows are unchanged. Pre-Option B+, `Pending` registrants existed only in EventCreate and were invisible to F7. Post-Option B+, those members now have F6 event registrations attached → analytics/segments that reference event participation light up earlier in the registration lifecycle. No quota or finance side-effects.
- **F8 at-risk scoring** consumes the F6→F8 bridge (`getEventAttendeesByMember`). That bridge returns ALL registrations regardless of `payment_status`, so Pending registrations now contribute to engagement signals immediately when the CSV is uploaded — closer to the spec intent of "registration as a signal of interest."

If a future F7 segment or F8 weight wants to distinguish "paid attendee" from "registered (pending payment)", filter at the consumer site:

```ts
const confirmedAttendees = registrations.filter(
  (r) => r.paymentStatus === 'paid' || r.paymentStatus === 'free',
);
```

No schema or port-interface change is required.

---

## Appendix: reference paths

- Route handlers: `src/app/api/admin/events/import/**` · `src/app/api/internal/retention/sweep-error-csv-blobs/route.ts`
- Use-cases: `src/modules/events/application/use-cases/{import-csv,list-csv-import-records,generate-error-csv-signed-url,sweep-expired-error-csv-blobs}.ts`
- Adapters: `src/modules/events/infrastructure/{eventcreate-csv-adapter,vercel-blob-error-csv-store,drizzle-csv-import-records-repo}.ts`
- Composition: `src/lib/events-csv-import-deps.ts`
- Spec: `specs/013-csv-import-eventcreate-format/`
- Audit-port: `src/modules/events/application/ports/audit-port.ts` (14 F6 event types, 5y retention)
