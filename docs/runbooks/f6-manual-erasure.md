# F6 Manual Erasure Runbook

**Status**: INTERIM — applies until Phase 10 T110 (admin erasure UI) ships
**Owner**: Maintainer + DPO
**Last reviewed**: 2026-05-12 (Issue H-PDPA-2 from full-scope review)

## Purpose

GDPR Art. 17 + PDPA §30 grant data subjects a right to erasure with a **30-day
response window** for European residents and "without undue delay" for Thai
residents. F6's admin erasure tool (FR-032a) is scheduled for Phase 10 T110.
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

## Deprecation

This runbook is **superseded** when Phase 10 T110 ships the admin erasure
UI. The UI runs the same logic with audit-log emission and quota
credit-back automation. Until then, this manual procedure is the only
GDPR/PDPA-compliant path.

## Audit

This runbook is invoked via the chamber's DSR intake flow. Quarterly
DPO review should confirm:

1. All DSRs received in the period have a closed ticket
2. Each closed ticket has corresponding `pii_erasure_requested` +
   `pii_erasure_completed` audit_log rows
3. The 30-day GDPR deadline was met for EU residents
4. Quota credit-backs were correctly attributed

## Related documents

- `docs/compliance/processing-records.md` § F6 EventCreate Ingest
- `docs/compliance/dpia-template.md`
- `docs/runbooks/breach-notification.md` (for incidents where erasure
  fails or PII is leaked during processing)
- F6 spec.md FR-032 (retention) + FR-032a (admin erasure tool — Phase 10)
