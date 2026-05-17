# Contract: F6 Audit Port

**File**: `src/modules/events/application/ports/audit-port.ts`
**Pattern**: Closed TypeScript union — adding events requires a compile-time change.
**FR refs**: FR-009, FR-032 (audit retention), FR-035 (role violation audit), spec.md § Edge Cases (cross-tenant probe high severity)

This contract codifies the **43** audit event types F6 emits (original spec scoped ~35; extended to 43 via migrations 0135 + 0140-series F6.1 CSV + 0144 `event_created` + R6-W5 staff-review fix). The full canonical list lives at `src/modules/events/application/ports/audit-port.ts:76-171`; this doc adds the **payload shape** per event, which is the binding contract for downstream observers (alerts, reports, retention sweeper).

All events use the existing `audit_log` table (introduced in F1, extended F2..F8). Default retention 5 years. F6 does **not** introduce new audit-log columns — it writes into the existing structured-payload column added by F2. All events carry the standard envelope:

```ts
interface AuditEnvelope<T extends F6AuditEventType, P> {
  eventId: AuditEventId;          // ULID, server-generated → 'id' column
  eventType: T;                   // → 'event_type' enum column (extended by F6 migration 0132)
  tenantId: TenantId;             // → 'tenant_id' column (added by F2 migration 0007 — nullable; F1 cross-tenant events stay NULL)
  actorType: 'system' | 'admin' | 'manager' | 'member' | 'zapier_webhook' | 'csv_import' | 'cron';
                                  // → encoded into 'actor_user_id' value (real UUID for human roles; sentinel string for system/zapier/cron)
  actorUserId: UserId | null;     // → 'actor_user_id' column (TEXT; null for system / zapier_webhook / cron contexts)
  occurredAt: ISOTimestamp;       // → 'timestamp' column
  retentionYears: 5;              // → 'retention_years' column (F6 default; F5 introduced this column via migration 0038)
  summary: string;                // → 'summary' column (TEXT ≤500 chars; human-readable description for log-line readability)
  payload: P;                     // → 'payload jsonb' column (added by F2 migration 0007; canonical structured-payload carrier)
}
```

**Severity** is **NOT** a top-level field (the `audit_log` table has no `severity` column). It is carried inside `payload.severity` as a string discriminator — `'info' | 'warn' | 'error' | 'critical'`. Alert rules (research.md R10) query `payload->>'severity'` from Postgres or the equivalent JSON path in the metric label. Every individual event definition below lists its conventional severity inline — at the implementation layer, that value is written into the `payload jsonb` object alongside the event-specific fields.

**Payload encoding**: per F2 migration `0007_audit_log_f2_extension.sql` (which added `payload jsonb` + `tenant_id text` columns to the F1-introduced `audit_log` table), F6's audit emitter writes the **canonical structured payload** into `audit_log.payload jsonb`. The legacy `audit_log.summary text NOT NULL` column from F1 carries a **short human-readable description** (≤500 chars) for log-line readability — F6's emitter populates it with a one-line synopsis (e.g., `"webhook receipt verified — eventcreate event_abc123 attendee jane@…"`). Long-form structured data (CSV row excerpts in `csv_import_row_failed`, error stacks in `webhook_rolled_back`, etc.) lives in `payload` with no length limit. Alert rules + observability dashboards + retention queries all read from `payload jsonb` via `->>'field'` paths (same pattern as F4 `audit_log_overdue_once_per_day` index at `audit_log(tenant_id, (payload->>'invoice_id'), ...)` per `specs/007-invoices-receipts/data-model.md:432`).

---

## 1. Webhook ingest events (8)

### `webhook_receipt_verified`

Emitted on successful end-to-end ingest (201 OK). One per delivery.

```ts
payload: {
  requestId: string;
  source: 'eventcreate' | 'eventcreate_csv';
  eventExternalId: string;
  attendeeExternalId: string;
  processingOutcome: ProcessingOutcome;
  matchedMemberId: MemberId | null;
  registrationId: RegistrationId;
  eventCreated: boolean;
  ingestLatencyMs: number;
  graceSecretUsed: boolean;
}
severity: 'info'
```

### `webhook_signature_rejected`

Emitted on HMAC mismatch (401). Severity `warn`; burst → alert #1 (≥10/min sustained).

```ts
payload: {
  requestId: string | null;       // null if header missing
  sourceIp: string;
  signatureLastFour: string | null;
  timestampSkewSeconds: number | null;
  bodyLengthBytes: number;
}
severity: 'warn'
```

### `webhook_replay_rejected`

Emitted on timestamp skew >5min (401).

```ts
payload: {
  requestId: string | null;
  sourceIp: string;
  receivedTimestamp: number;
  serverTimestamp: number;
  skewSeconds: number;
}
severity: 'warn'
```

### `webhook_duplicate_rejected`

Emitted on `X-Request-ID` repeat within 7d (409). **No side effects.**

```ts
payload: {
  requestId: string;
  originalProcessedAt: ISOTimestamp;
  sourceIp: string;
}
severity: 'info'
```

### `webhook_malformed_rejected`

Emitted on zod validation failure on required fields (400).

```ts
payload: {
  requestId: string;
  sourceIp: string;
  errors: ReadonlyArray<{ path: string; message: string }>;
}
severity: 'warn'
```

### `webhook_rolled_back`

Emitted in a SEPARATE post-rollback tx when the primary ACID unit (FR-037) fails. **Critical signal for observability** — also a likely SC-003 SLO trigger.

**Dual-write fallback (per research.md R6 update)**: if the separate audit-tx ALSO fails (e.g., DB is fully unavailable), the emitter MUST additionally write a structured `pino.fatal(...)` line to stderr with `event: 'webhook_rolled_back'` and an `audit_secondary_tx_failure: true` discriminator field. Vercel Fluid Compute captures stderr as runtime logs even when the DB is unreachable, so the failure is **never invisible** at the observability layer. The pino.fatal call is wrapped in try/catch — a stderr write failure does not crash the handler.

```ts
payload: {
  requestId: string;
  source: 'eventcreate' | 'eventcreate_csv';
  failureStage: 'event_upsert' | 'registration_insert' | 'idempotency_receipt' | 'quota_decrement' | 'audit_emit' | 'unknown';
  errorMessage: string;        // already PII-scrubbed via pino redactList
  errorStack: string | null;   // only in dev environment
  audit_secondary_tx_failure?: boolean;  // true when the DB write of THIS audit row also failed
                                          //  and the entry survives only as a stderr log
}
severity: 'error'
```

### `webhook_secret_grace_used`

Emitted IN ADDITION to the success/failure event when the grace key verified (not the active key). Operational signal that the rotation is mid-migration.

```ts
payload: {
  requestId: string;
  graceSecretAgeHours: number;
}
severity: 'info'
```

### `webhook_test_invoked`

Emitted when admin presses "Test webhook" (FR-023).

```ts
payload: {
  actorUserId: UserId;
  testRequestId: string;
  durationMs: number;
}
severity: 'info'
```

---

## 2. Match resolution events (5)

Each emitted as a sibling to `webhook_receipt_verified` (one match-resolution event per processed registration).

### `attendee_matched_member_contact`

```ts
payload: {
  registrationId: RegistrationId;
  matchedMemberId: MemberId;
  matchedContactId: ContactId;
  matchedOnEmail: AttendeeEmail;
}
severity: 'info'
```

### `attendee_matched_member_domain`

```ts
payload: {
  registrationId: RegistrationId;
  matchedMemberId: MemberId;
  emailDomain: string;
}
severity: 'info'
```

### `attendee_matched_member_fuzzy`

```ts
payload: {
  registrationId: RegistrationId;
  matchedMemberId: MemberId;
  attendeeCompanyOriginal: string;
  matchedMemberCompanyNormalised: string;
  levenshteinDistance: number;
}
severity: 'info'
```

### `attendee_non_member`

```ts
payload: {
  registrationId: RegistrationId;
  attendeeEmail: AttendeeEmail;     // retained until 2y pseudonymisation
}
severity: 'info'
```

### `attendee_unmatched`

Ambiguous fuzzy match (>1 winner).

```ts
payload: {
  registrationId: RegistrationId;
  attendeeCompanyOriginal: string;
  candidateMemberIds: ReadonlyArray<MemberId>;
  candidateLevenshteinDistances: ReadonlyArray<number>;
}
severity: 'info'
```

---

## 3. Quota events (5)

### `quota_partnership_decremented`

```ts
payload: {
  registrationId: RegistrationId;
  memberId: MemberId;
  eventId: EventId;
  perEventAllotmentBefore: number;
  perEventAllotmentAfter: number;   // = before − 1
}
severity: 'info'
```

### `quota_cultural_decremented`

```ts
payload: {
  registrationId: RegistrationId;
  memberId: MemberId;
  eventId: EventId;
  fiscalYear: number;             // e.g., 2026
  annualAllotmentBefore: number;
  annualAllotmentAfter: number;   // = before − 1
}
severity: 'info'
```

### `quota_credit_back_refund`

```ts
payload: {
  registrationId: RegistrationId;
  memberId: MemberId;
  scope: 'partnership' | 'cultural';
  allotmentAfter: number;         // post credit-back
}
severity: 'info'
```

### `quota_credit_back_archive`

Same shape as `quota_credit_back_refund` but `scope` is mandatory per registration.

### `quota_over_quota_warning`

Emitted when a registration would normally consume quota but the quota is exhausted (FR-017). Registration is persisted with `counted_against_* = FALSE`.

```ts
payload: {
  registrationId: RegistrationId;
  memberId: MemberId;
  eventId: EventId;
  scope: 'partnership' | 'cultural';
  allotmentAtIngest: 0;           // always 0 for over-quota
}
severity: 'warn'
```

---

## 4. Admin action events (10)

### `registration_relinked`

```ts
payload: {
  actorUserId: UserId;
  registrationId: RegistrationId;
  previousMatchedMemberId: MemberId | null;
  newMatchedMemberId: MemberId | null;
  previousMatchType: MatchType;
  newMatchType: MatchType;
  quotaImpact: {
    creditedBackFor: MemberId | null;
    decrementedFor: MemberId | null;
    scopes: Array<'partnership' | 'cultural'>;
  };
}
severity: 'info'
```

### `event_archived`

```ts
payload: {
  actorUserId: UserId;
  eventId: EventId;
  registrationsAffected: number;
  quotaReversals: { partnership: number; cultural: number };
}
severity: 'info'
```

### `event_partner_benefit_toggled` / `event_cultural_event_toggled`

```ts
payload: {
  actorUserId: UserId;
  eventId: EventId;
  flagName: 'is_partner_benefit' | 'is_cultural_event';
  flagBefore: boolean;
  flagAfter: boolean;
  registrationsReevaluated: number;
}
severity: 'info'
```

### `webhook_secret_generated`

```ts
payload: {
  actorUserId: UserId;
  secretLastFour: string;
}
severity: 'info'
```

### `webhook_secret_rotated`

```ts
payload: {
  actorUserId: UserId;
  previousSecretLastFour: string;
  newSecretLastFour: string;
  graceActiveUntil: ISOTimestamp;
}
severity: 'warn'   // security-relevant action
```

### `ingest_disabled_tenant_admin` / `ingest_disabled_super_admin`

```ts
payload: {
  actorUserId: UserId | null;     // null for super-admin system action
  enabledBefore: boolean;
  enabledAfter: boolean;
  reason: string;
}
severity: 'warn'
```

### `csv_import_completed`

```ts
payload: {
  actorUserId: UserId;
  rowsProcessed: number;
  eventsCreated: number;
  eventsUpdated: number;
  matchCounts: Record<MatchType, number>;
  errorRowCount: number;
  durationMs: number;
}
severity: 'info'
```

### `csv_import_row_failed`

One emitted per bad row.

```ts
payload: {
  actorUserId: UserId;
  rowNumber: number;
  reason: string;
  rawRowExcerpt: string;            // first 200 chars, PII-redacted
}
severity: 'warn'
```

---

## 5. Privacy + compliance events (4)

### `pii_erasure_requested`

```ts
payload: {
  actorUserId: UserId;
  registrationId: RegistrationId;
  reasonText: string;
  attendeeEmailLastFour: string;   // last 4 chars only
}
severity: 'warn'
```

### `pii_erasure_completed`

```ts
payload: {
  actorUserId: UserId;
  registrationId: RegistrationId;
  quotaReversals: { partnership: number; cultural: number };
  completedWithinSecondsOfRequest: number;
}
severity: 'warn'
```

### `pii_pseudonymised`

Emitted one per registration row at the daily sweep (FR-032).

```ts
payload: {
  registrationId: RegistrationId;
  matchTypeAtPseudonymisation: 'non_member' | 'unmatched';
  ageAtSweepDays: number;
  registeredAt: ISOTimestamp;
}
severity: 'info'
```

### `pii_pseudonymisation_sweep_run`

Emitted once per cron pass.

```ts
payload: {
  rowsScanned: number;
  rowsPseudonymised: number;
  durationMs: number;
  passDate: string;        // YYYY-MM-DD
}
severity: 'info'
```

---

## 6. Security events (3)

### `cross_tenant_probe`

Emitted whenever a request's resolved tenant context disagrees with the secret-verified tenant (URL says X, secret verifies as Y) OR a query is detected attempting cross-tenant access at the application layer. **High severity** — alerts on every occurrence.

```ts
payload: {
  probedTenantId: TenantId;     // tenant from URL
  signedTenantId: TenantId;     // tenant from secret verify
  sourceIp: string;
  requestId: string | null;
  attemptedRoute: string;
}
severity: 'critical'
```

### `role_violation_blocked`

Emitted when manager attempts a mutating route OR member attempts any admin route (FR-035).

```ts
payload: {
  actorUserId: UserId;
  actorRole: 'manager' | 'member';
  attemptedRoute: string;
  attemptedAction: string;
  blockedAt: 'app_layer' | 'middleware';
}
severity: 'warn'
```

### `webhook_rate_limit_exceeded`

Emitted when FR-005 60 req/min cap is hit.

```ts
payload: {
  requestId: string | null;
  sourceIp: string;
  currentRpmObserved: number;
  retryAfterSeconds: number;
}
severity: 'info'
```

---

## Application-layer port shape

```ts
// src/modules/events/application/ports/audit-port.ts

import type { ULID } from '../../../shared/branded';

export type F6AuditEventType =
  // ... (see data-model.md § 4 for full union)
  ;

export interface F6AuditEntry<T extends F6AuditEventType = F6AuditEventType> {
  eventType: T;
  tenantId: TenantId;
  actorType: 'system' | 'admin' | 'manager' | 'member' | 'zapier_webhook' | 'csv_import' | 'cron';
  actorUserId: UserId | null;
  payload: AuditPayloadFor<T>;     // discriminated union — payload shape derived from eventType;
                                   // ALL payloads include a `severity` field per the event-specific shape
                                   // (encoded as JSON, written to the existing `audit_log.summary` column —
                                   //  see § Payload encoding above; no schema migration needed)
}

export interface F6AuditPort {
  emit<T extends F6AuditEventType>(entry: F6AuditEntry<T>): Promise<Result<AuditEventId, AuditEmitError>>;
  emitRolledBack(entry: F6AuditEntry<'webhook_rolled_back'>): Promise<Result<AuditEventId, AuditEmitError>>;
  //                                  ^ runs in a separate transaction (FR-037).
  //                                  Dual-write semantics: on AuditEmitError, the implementation
  //                                  ALSO calls `pino.fatal({...payload, audit_secondary_tx_failure: true})`
  //                                  to stderr so the rollback is never invisible — Vercel runtime logs
  //                                  capture stderr even when the DB is unreachable. The pino call is
  //                                  wrapped in try/catch; a stderr write failure does not crash the handler.
}
```

Discriminated payload type via TypeScript template-literal mapped types — each event-type maps to its specific payload shape, giving compile-time enforcement that callers pass the correct payload for the event they're emitting.

---

## Observability cross-references

Per FR-036 (research.md R10):

- **Metric** `eventcreate_webhook_receipts_total{signature_outcome="rejected"}` counts `webhook_signature_rejected` events
- **Metric** `eventcreate_partnership_quota_decrement_total` counts `quota_partnership_decremented` events
- **Alert** `signature-rejection burst` fires off `eventcreate_webhook_receipts_total{signature_outcome="rejected"}` rate
- **Alert** `match-rate degradation` reads aggregate `attendee_matched_*` ÷ total over rolling 24h per tenant

Audit events are the canonical source; metrics are derived.
