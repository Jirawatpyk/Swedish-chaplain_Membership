# F6 Manual Erasure Runbook

**Status**: PARTIALLY SUPERSEDED — Phase 10 T110 shipped the **per-registration**
admin erase (`/admin/events/{eventId}/registrations/{registrationId}/erase`)
ONLY. The FR-032a by-email **cross-event** sweep was NOT built, so § 2's raw-SQL
enumeration below remains the ONLY cross-event erasure path. This runbook stays
LIVE for cross-event DSRs until the by-email admin surface ships.
**Owner**: Maintainer + DPO
**Last reviewed**: 2026-07-07 (scoped the interim/superseded claims to the
per-registration surface after T110 shipped only the single-row erase — the
cross-event by-email sweep is still unbuilt)

## Purpose

GDPR Art. 17 + PDPA §33 grant data subjects a right to erasure with a **30-day
response window** for European residents and "without undue delay" for Thai
residents. (§30 covers right to access; F6 erasure operates under §33.) F6's admin erasure tool (FR-032a) is scheduled for Phase 10 T110.
Until that tool ships, this runbook covers the manual procedure for handling
an erasure request against F6-managed PII (attendee_email, attendee_name,
attendee_company stored in `event_registrations`).

## Eligible records

F6 erasure covers attendee data the chamber ingested via EventCreate webhook
or CSV import:

- `event_registrations.attendee_email`
- `event_registrations.attendee_email_lower` (STORED generated column — auto-derives)
- `event_registrations.attendee_name`
- `event_registrations.attendee_company` (nullable; only if attendee is identifiable as employee)
- `event_registrations.matched_member_id` / `matched_contact_id` (if attendee was a chamber member, erasure of MEMBER data is handled by F3 erasure flow; F6 only clears the LINK)

**Out of scope** (do not erase via this runbook):
- F1 user identity (use F1 erasure flow)
- F3 member directory entries (use F3 erasure flow)
- F4 invoices / receipts (regulatory retention overrides — Thai RD §87/3 = 5 years)
- audit_log rows (compliance retention overrides; audit summaries are PII-redacted at emit per `src/lib/logger.ts` REDACT_PATHS)

## Lawful basis to refuse

Erasure MAY be refused under GDPR Art. 17(3) / PDPA §28 grounds:
- (b) compliance with legal obligation (F4 tax-document retention)
- (e) establishment, exercise, or defence of legal claims
- Public interest in archiving (F6 audit_log)

**Document refusal reasoning in writing.** Notify the requester within 30 days.

## Procedure

### 1. Receive request (Day 0)

- Source: email to DPO contact (see `docs/compliance/processing-records.md`)
- Required identification: at minimum email address used at the EventCreate
  registration. Verify via reply-to-known-email or chamber-member-portal
  if the requester is also a chamber member.

### 2. Locate records (Day 1–3)

> **⚠️ This cross-event enumeration is STILL manual and mandatory.** Phase 10
> T110 shipped only the SINGLE per-registration admin erase
> (`/admin/events/{eventId}/registrations/{registrationId}/erase`), which
> erases one registration an admin already has open in the attendee table.
> There is NO admin surface that enumerates every registration sharing an
> attendee email ACROSS events — the FR-032a by-email cross-event sweep was
> never built. Until it ships, the raw-SQL query below is the ONLY way to find
> a data subject's full registration set, and it MUST be run to completeness:
> a partial enumeration leaves residual PII and breaches GDPR Art. 17 / PDPA
> §33 / SC-012 (the 30-day response window).

Run as `neondb_owner` role from Neon SQL editor (BYPASS RLS — super-admin
scope for cross-tenant DSR processing):

```sql
-- Lookup by attendee email (case-insensitive via the STORED generated column)
SELECT
  registration_id,
  tenant_id,
  event_id,
  attendee_email,
  attendee_name,
  match_type,
  matched_member_id,
  registered_at,
  pii_pseudonymised_at
FROM event_registrations
WHERE attendee_email_lower = lower($1)  -- $1 = requester's email
ORDER BY registered_at DESC;
```

Note tenant_id values returned — DSR is processed scoped to ONE tenant at
a time (PDPA §28 cross-border + the chamber that ingested the data is the
controller).

### 3. Quota credit-back (per row, Day 3–7)

If any row has `counted_against_partnership = TRUE` OR
`counted_against_cultural_quota = TRUE`, the matched member is owed a
quota refund. Manual procedure:

```sql
-- For each registration_id with quota counted:
UPDATE event_registrations
SET counted_against_partnership = FALSE,
    counted_against_cultural_quota = FALSE
WHERE registration_id = $1 AND tenant_id = $2;
```

Record the credit-back in audit_log:

```sql
INSERT INTO audit_log
  (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
VALUES
  ('quota_credit_back_refund'::audit_event_type,
   'system:manual-erasure',
   'manual erasure DSR — quota credited back',
   'dsr-' || $3,  -- $3 = DSR ticket id
   jsonb_build_object(
     'severity', 'warn',
     'registrationId', $1,
     'memberId', $2,
     'scope', $4,  -- 'partnership' or 'cultural'
     'allotmentAfter', 0,  -- computed manually
     'dsr_request_id', $3
   ),
   $2,  -- tenant_id
   5);
```

### 4. Pre-erasure audit (Day 7)

Record the intent to erase (PDPA §28 audit-trail requirement):

```sql
INSERT INTO audit_log
  (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
VALUES
  ('pii_erasure_requested'::audit_event_type,
   'system:manual-erasure',
   'manual erasure DSR — pre-deletion audit',
   'dsr-' || $1,
   jsonb_build_object(
     'severity', 'warn',
     'actorUserId', 'maintainer-manual',
     'registrationId', $2,
     'reasonText', $3,  -- 'GDPR Art. 17 erasure request'
     'attendeeEmailLastFour', right($4, 4)  -- last 4 chars only
   ),
   $5,  -- tenant_id
   5);
```

### 5. Hard delete (Day 7–14)

```sql
-- Run as neondb_owner. BEFORE running, copy the row to encrypted offline
-- storage for the 30-day window in case the requester disputes / reverses.
DELETE FROM event_registrations
WHERE registration_id = $1 AND tenant_id = $2
RETURNING registration_id;
```

If the deletion blocks on FK constraints (none expected — F6
event_registrations has no inbound FK), investigate and document.

### 6. Post-erasure audit (Day 14)

```sql
INSERT INTO audit_log
  (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
VALUES
  ('pii_erasure_completed'::audit_event_type,
   'system:manual-erasure',
   'manual erasure DSR — deletion complete',
   'dsr-' || $1,
   jsonb_build_object(
     'severity', 'warn',
     'actorUserId', 'maintainer-manual',
     'registrationId', $2,
     'quotaReversals', jsonb_build_object('partnership', $3, 'cultural', $4),
     'completedWithinSecondsOfRequest', $5
   ),
   $6,  -- tenant_id
   5);
```

### 7. Notify requester (Day 14–28)

Reply via the same channel the DSR arrived on. Provide:

- Confirmation of deletion (registration_id + redacted email)
- Quota credit-back acknowledgement (if applicable)
- Audit trail row IDs (the two audit_log row IDs from steps 4 + 6)
- Note that audit trail rows are retained 5 years per PDPA §28 + GDPR Art. 30
  (PII-redacted summary, last-4 email digits only — NOT a full retention
  of the deleted PII)

### 8. Close the case (Day 28–30)

- Mark the DSR ticket as closed
- Add the DSR id to `docs/compliance/processing-records.md` § DSR Log
- Securely destroy the 30-day offline backup from Step 5

## Edge cases

### Requester is also a chamber member

The chamber-member F3 erasure flow (Phase 4+) handles the parent member +
contact rows. THIS runbook is invoked IN ADDITION for any F6
`event_registrations` rows linked to that member. Run F3 erasure first,
then F6 manual erasure for cleanup.

### Tenant has been deleted

If `tenant_id` in step 2 corresponds to a tenant slug no longer in
`tenant_webhook_configs`, the tenant has been de-onboarded. PII may still
exist in `event_registrations`. Run the erasure anyway — the tenant
controller relationship persists for PDPA §28 + GDPR Art. 30 retention
periods.

### Pseudonymised rows (`pii_pseudonymised_at IS NOT NULL`)

These rows already have salted-hash pseudonyms instead of raw PII. GDPR
Art. 11 anonymisation arguably exempts them, but PDPA §28 retains the
link for forensic + quota purposes. Recommend: skip erasure with a note
in the DSR ticket that the row is already pseudonymised; original PII
is unrecoverable (deterministic SHA-256 + per-deployment salt).

### Pre-existing rows with `counted_against_* = TRUE` past Phase 10 T113

The retention sweep (Phase 10 T113) sets `pii_pseudonymised_at` at 2y
for non-member rows. Member-linked rows persist 5y per FR-032. After 5y,
the entire row should be archived to cold storage or hard-deleted via a
separate retention runbook (TBD Phase 10+).

## F6.1 — CSV-import error-blob cascade (added staff-review H-5 2026-05-16)

If the requester's email/name appears in a row that failed validation during a CSV import, the failed row may persist in a Vercel Blob error CSV for up to 30 days after the import (FR-021). The 30-day TTL sweep cron deletes blobs automatically, but a DSR may require deletion BEFORE the natural TTL.

### Locate matching blobs (Day 1–3 extension)

In addition to the F6 query in § 2, run:

```sql
SELECT
  cir.record_id,
  cir.tenant_id,
  cir.event_id,
  cir.uploaded_at,
  cir.error_csv_blob_url,
  cir.error_csv_expires_at
FROM csv_import_records cir
WHERE cir.tenant_id = '<TENANT_SLUG>'
  AND cir.error_csv_blob_url IS NOT NULL
  AND cir.error_csv_expires_at > NOW()
  AND cir.uploaded_at > '<DSR_DATE> - INTERVAL ''30 days'''
  AND cir.event_id IN (<EVENT_IDS_FROM_F6_QUERY>)
ORDER BY cir.uploaded_at DESC;
```

The result lists every error-CSV blob that COULD contain the requester's row. Without parsing the blob bytes (which would itself defeat minimisation), erase ALL matching blobs to comply — the alternative (download + parse + redact + re-upload) is operationally infeasible at chamber scale and violates the storage-limitation principle.

### Erase the blob + clear DB columns (Day 7–14 extension)

For each row above:

```bash
# 1) Delete the Vercel Blob via the project script
#
# Staff-review H-NEW-1 (2026-05-16): use the project's SDK-backed script
# rather than `vercel blob` CLI — the latter has confusing subcommand
# naming (`delete` not `del`) and the `--token` flag refers to CLI auth
# not the SDK's BLOB_READ_WRITE_TOKEN, so wrong-token executions can
# silently no-op while appearing to succeed. The script exits non-zero
# on any failure and treats `blob_not_found` as idempotent success
# (the daily TTL sweep may have already cleared the blob).
#
# Prereq: env loaded — either `.env.local` is populated locally or
# run `vercel env pull .env.local` first.
#
# Staff-review L-R3v2-7 (2026-05-16): VERIFY that VERCEL_BLOB_API_URL
# is NOT set in `.env.local` before running this script in production.
# That env var is an @vercel/blob SDK test-only override that redirects
# del() to an arbitrary host. `vercel env pull` will NOT include it
# (it's not a project env var), so a clean pull is safe. But a stale
# `.env.local` from a local dev session that tested against a Vercel
# Blob emulator could leak the production BLOB_READ_WRITE_TOKEN to
# that emulator if the script is run with the override still active.
# Quick check: `grep VERCEL_BLOB_API_URL .env.local` MUST return zero
# lines before invocation.

pnpm tsx scripts/erase-error-blob.ts "<error_csv_blob_url>"

# Expected stdout on success:
#   Deleting blob: /<tenant>/csv-import-errors/<recordId>.csv-<suffix>
#   OK — blob deleted.
#   Next step: clear csv_import_records.error_csv_blob_url + emit
#   csv_import_error_csv_manually_erased audit per runbook § F6.1.
#
# Or, on idempotent re-run / already-swept:
#   OK — blob already absent (blob_not_found). Idempotent success.
#
# DO NOT proceed to step 2 if the script exits non-zero. Diagnose the
# Blob API error first.
```

```sql
-- 2) Clear the DB pointer + emit audit event
UPDATE csv_import_records
   SET error_csv_blob_url = NULL,
       error_csv_expires_at = NULL,
       updated_at = NOW()
 WHERE tenant_id = '<TENANT_SLUG>'
   AND record_id = '<RECORD_ID>';

-- 3) Emit erasure audit (manual until F6.1.1 ships an admin UI)
INSERT INTO audit_log (
  tenant_id, actor_user_id, actor_type, event_type, severity,
  occurred_at, summary, payload, retention_years
)
VALUES (
  '<TENANT_SLUG>',
  '<DPO_USER_ID>',
  'admin',
  'csv_import_error_csv_manually_erased',
  'info',
  NOW(),
  'Manual erasure of error CSV blob in response to DSR <TICKET_ID>',
  jsonb_build_object(
    'recordId', '<RECORD_ID>',
    'eventId', '<EVENT_ID>',
    'dsrTicketId', '<TICKET_ID>',
    'reason', 'gdpr_art_17'
  ),
  5
);
```

### Post-erasure verification

```sql
SELECT COUNT(*) AS remaining_blobs
FROM csv_import_records
WHERE tenant_id = '<TENANT_SLUG>'
  AND error_csv_blob_url IS NOT NULL
  AND uploaded_at > '<DSR_DATE> - INTERVAL ''30 days'''
  AND event_id IN (<EVENT_IDS>);
-- MUST return 0
```

### Notes

- The audit event `csv_import_error_csv_manually_erased` is admitted by the Postgres `audit_event_type` enum (migration 0155, staff-review L-R3v2-6 2026-05-16) but is NOT in the TypeScript application-port taxonomy (`src/modules/events/application/ports/audit-port.ts`) — it is a DSR-time manual emit via raw SQL INSERT only, never emitted programmatically. The manual INSERT in step 3 above WILL succeed once migration 0155 is applied. Track in DPO log alongside the F6 erasure events.
- The natural 30-day TTL sweep cron will deliver the same outcome if the DSR can wait — only act manually when the DSR response deadline forces it. **Deadline reference** (staff-review M-NEW-4 2026-05-16): PDPA §30 grants 30 days from receipt, extendable by 30 days with written notice; GDPR Art. 12(3) grants 1 month, extendable to 3 months total with notification to the data subject within the first month. Chamber-OS defaults to the PDPA 30-day clock as the tighter constraint for Thailand-resident subjects.
- The `attendee_fingerprint` on `csv_import_records` is a SHA-256 first-16-hex truncation. **Staff-review M-NEW-6 (2026-05-16) — legal-position caveat**: the fingerprint is not reversible by a third party, but the chamber (as controller) can re-derive it from a known email in O(1) time. EDPB guidance on pseudonymisation (`Art. 11 GDPR`) distinguishes general-public inference (disproportionate effort, exemption applies) from controller-assisted inference (not disproportionate, exemption does NOT clearly apply). For a TARGETED DSR where the requester's email is known, the Art. 11 exemption is legally borderline — DPO should consult counsel on whether to zero-out `csv_import_records.attendee_fingerprint` alongside the `event_registrations` erasure. The lowest-risk path is to wait for the 30-day natural sweep window (after which the fingerprint is no longer queried by the safety-net code path); if the DSR clock requires earlier action, NULL the column explicitly.

---

## Deprecation

Phase 10 T110 shipped the **per-registration** admin erase
(`/admin/events/{eventId}/registrations/{registrationId}/erase`). It
supersedes the manual SINGLE-ROW steps (§ 3 quota credit-back, § 4–6 audit +
delete) **for a registration an admin already has open** — running the same
logic with audit-log emission + quota credit-back automation.

It does **NOT** supersede § 2's cross-event enumeration. There is still no
admin surface that finds every registration sharing an attendee email across
events (the FR-032a by-email cross-event sweep is unbuilt). Until that
by-email surface ships, § 2's raw-SQL enumeration remains the only
GDPR/PDPA-compliant way to locate a data subject's full registration set, and
this runbook stays LIVE for that step.

## Audit

This runbook is invoked via the chamber's DSR intake flow. Quarterly
DPO review should confirm:

1. All DSRs received in the period have a closed ticket
2. Each closed ticket has corresponding `pii_erasure_requested` +
   `pii_erasure_completed` audit_log rows
3. The applicable response deadline was met (staff-review L-R3v2-8
   2026-05-16: previously this read "30-day GDPR deadline" which
   conflated the two regimes). The two applicable clocks are:
   - **PDPA §30** (Thailand-resident subjects): 30 days from receipt,
     extendable by 30 days with written notice to the data subject.
   - **GDPR Art. 12(3)** (EU/EEA-resident subjects): 1 month from
     receipt, extendable to 3 months total with notification within
     the first month.
   Chamber-OS defaults to the tighter PDPA clock for dual-jurisdiction
   subjects, matching the deadline reference in §F6.1 above.
4. Quota credit-backs were correctly attributed

## Related documents

- `docs/compliance/processing-records.md` § F6 EventCreate Ingest
- `docs/compliance/dpia-template.md`
- `docs/runbooks/breach-notification.md` (for incidents where erasure
  fails or PII is leaked during processing)
- F6 spec.md FR-032 (retention) + FR-032a (admin erasure tool — Phase 10)
