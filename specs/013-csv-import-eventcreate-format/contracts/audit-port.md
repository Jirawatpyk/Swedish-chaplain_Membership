# Contract — F6 audit-port extension

**Phase 1 contract · Feature**: `013-csv-import-eventcreate-format` · Extends [F6 audit-port](../../012-eventcreate-integration/contracts/audit-port.md)

---

## New audit event types

### 1. `csv_import_error_csv_downloaded`

Emitted on every successful signed-URL generation in `GET /api/admin/events/import/{recordId}/error-csv`.

**Severity**: `info` (PII access — logged for accountability but not alerting)

**Retention**: 5 years (F6 default).

**Payload**:

```typescript
{
  readonly severity: Severity;            // 'info'
  readonly actorUserId: UserId;
  readonly recordId: CsvImportRecordId;
  readonly downloadedAt: Date;
  readonly sourceIp: string;              // first hop from X-Forwarded-For
}
```

**Why audit-logged**: PDPA / GDPR audit trail for any PII access. The error CSV contains attendee emails + names + companies — even though the admin already had access to the original data via the upload, the re-download is a discrete access event that auditors expect to see.

---

### 2. `csv_import_cross_tenant_probe`

Emitted when the signed-URL route receives a request for a `recordId` that exists in another tenant (cross-tenant probe attempt).

**Severity**: `high` (Constitution Principle I clause 4 — high-severity security event)

**Retention**: 5 years.

**Payload**:

```typescript
{
  readonly severity: Severity;            // 'high'
  readonly actorUserId: UserId;            // the probing admin
  readonly probedRecordId: string;         // the recordId that doesn't belong to actor's tenant
  readonly sourceIp: string;
  readonly probedAt: Date;
}
```

**Why audit-logged**: tenant-isolation security incident — admin tried to access another tenant's data. SRE alerts on `rate > 0`. The audit row enables the security team to trace which admin / which IP / which timestamps, and is the basis for further investigation if a pattern emerges.

---

### ~~3. `csv_import_refund_review_signalled`~~ — DROPPED v1

Removed per Clarifications Session 2026-05-15 post-critique Q2 — F4 cross-cutting feature dropped due to insufficient volume (~1-3 cases/year at SweCham scale). Cancellation detection still happens in F6 (re-upload state change) + emits existing F6 audit events; admin manually reconciles F4 invoices.

---

### 3. `csv_import_event_mismatch_overridden` (NEW per FR-019c)

Emitted when an admin overrides the FR-019b event-mismatch warning by re-submitting the upload form with `force_proceed=true`. Provides forensic trail for the case where the safety net was triggered but the admin proceeded anyway.

**Severity**: `warn` (admin override of a safety prompt — not a security event but worth elevated visibility for post-launch tuning)

**Retention**: 5 years.

**Payload**:

```typescript
{
  readonly severity: Severity;            // 'warn'
  readonly actorUserId: UserId;            // the admin who clicked "Continue anyway"
  readonly recordId: CsvImportRecordId;    // the new import record (just committed)
  readonly currentEventId: string;         // event the admin chose to import to
  readonly priorRecordIds: ReadonlyArray<CsvImportRecordId>;  // prior matching imports that triggered the warning
  readonly priorEventIds: ReadonlyArray<string>;              // events those prior imports targeted
  readonly overriddenAt: Date;
}
```

**Why audit-logged**: gives operators visibility into how often the safety net fires + how often admin overrides — feeds the tuning decision on whether to tighten the 30-day window, raise warning prominence, or relax. Without this audit, the safety net is a black hole.

---

## Extended payload — `csv_import_completed`

Phase 7 payload extended with ONE new optional field:

```typescript
csv_import_completed: {
  // ... all existing Phase 7 fields unchanged ...
  readonly sourceFormat?: 'eventcreate_csv' | 'generic_csv';   // NEW — adapter detection result (R2/Q5)
};
```

**Backward compatibility**: optional field. Historical Phase 7 audit rows with no `sourceFormat` are interpreted as `generic_csv` for analytics purposes (Phase 7 did not have an EventCreate adapter).

---

## Total F6 audit event count after this feature

- Phase 7 baseline: 11 event types
- This feature adds: **3** new event types — `csv_import_error_csv_downloaded`, `csv_import_cross_tenant_probe`, `csv_import_event_mismatch_overridden`. The originally-planned `csv_import_refund_review_signalled` was dropped at the post-critique Q2 review (F4 cross-cutting removed).
- **Total after merge: 14 F6 audit event types**

All 14 use the F6 default retention of 5 years. No tax-document overlap (F4's 10-year retention does not apply to F6 events).

---

## Constitution Principle I clause 4 — high-severity security events list

Updated list of high-severity events emitted by F6 surfaces (cross-tenant access logging):

| Event | Surface | Trigger |
|---|---|---|
| `webhook_signature_rejected` (existing — Phase 6) | Webhook route | Bad HMAC OR cross-tenant probe via webhook URL |
| `webhook_cross_tenant_probe` (existing — Phase 6) | Webhook route | tenant-mismatch in signed payload |
| `csv_import_cross_tenant_probe` (**NEW — this feature**) | Signed-URL route | recordId belongs to another tenant |
| `role_violation_blocked` (existing — F1) | Any admin route | manager / member accessing admin route |

All four MUST be considered when authoring SRE alerts. Rate threshold: `> 0` for cross-tenant probes; `> 5/hour` for role violations (admins occasionally land on wrong page).
