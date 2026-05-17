# Phase 1 Data Model: F6 — EventCreate Integration

**Branch**: `012-eventcreate-integration` | **Date**: 2026-05-12

This document defines the F6-owned database tables, columns, constraints, indexes, RLS policies, state machines, value objects, and audit-log taxonomy. It is the source of truth that Drizzle schema (`src/modules/events/infrastructure/schema.ts`) and migration SQL (`drizzle/migrations/0127–0134_*.sql`) MUST match exactly.

All timestamps are `TIMESTAMPTZ` in UTC. RLS+FORCE policies are enabled on every F6 table per Constitution v1.4.0 Principle I clause 2. The application connects with the `chamber_app` role (no `BYPASS RLS`) and `SET LOCAL app.current_tenant` per request via `runInTenant(ctx, fn)`.

---

## 1. Tables

### 1.1 `events`

Holds one row per event imported from EventCreate (or future source). Identified per tenant by `(source, external_id)`.

```sql
CREATE TABLE events (
  tenant_id        TEXT NOT NULL,
  event_id         UUID NOT NULL DEFAULT gen_random_uuid(),

  -- Source identity
  source           TEXT NOT NULL DEFAULT 'eventcreate'
                     CHECK (source IN ('eventcreate')),  -- extensible via migration
  external_id      TEXT NOT NULL,

  -- Event metadata (last-write-wins on upsert per FR-010)
  name             TEXT NOT NULL,
  description      TEXT,
  start_date       TIMESTAMPTZ NOT NULL,
  end_date         TIMESTAMPTZ,
  location         TEXT,
  category         TEXT,            -- 'networking' | 'cultural' | 'workshop' | 'conference' | TEXT free
  eventcreate_url  TEXT,

  -- Benefit-classification flags (admin-toggleable per FR-019)
  is_partner_benefit BOOLEAN NOT NULL DEFAULT FALSE,
  is_cultural_event  BOOLEAN NOT NULL DEFAULT FALSE,

  -- Lifecycle (FR-019a)
  archived_at      TIMESTAMPTZ,           -- NULL = active; set by admin archive action

  -- Forward-compat (FR-011a)
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- unknown payload fields

  -- Audit timestamps
  imported_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (tenant_id, event_id)
);

CREATE UNIQUE INDEX events_tenant_source_external_unique
  ON events (tenant_id, source, external_id);

CREATE INDEX events_tenant_start_active_idx
  ON events (tenant_id, start_date DESC)
  WHERE archived_at IS NULL;

CREATE INDEX events_tenant_partner_benefit_idx
  ON events (tenant_id, is_partner_benefit)
  WHERE archived_at IS NULL;

CREATE INDEX events_tenant_cultural_event_idx
  ON events (tenant_id, is_cultural_event)
  WHERE archived_at IS NULL;

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE  ROW LEVEL SECURITY;
CREATE POLICY events_tenant_isolation ON events
  FOR ALL TO chamber_app
  USING      (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));
-- `FOR ALL TO chamber_app` + `WITH CHECK` are both required: USING
-- alone permits cross-tenant INSERT/UPDATE that WITH CHECK blocks.
-- Migration 0133 enforces both.
```

**Invariants**:

- `(tenant_id, source, external_id)` is the upsert key (FR-010).
- `archived_at` set → no new quota effects from this event's registrations until reactivated (FR-019a; no in-product reactivate in v1).
- `start_date` is the canonical event date for retention-sweep age calculation.
- `last_updated_at` reflects the last webhook delivery that touched this row (debugging signal).
- `metadata` MUST exclude any key that collides with the canonical column set (FR-011a).

---

### 1.2 `event_registrations`

Holds one row per attendee registration. Identified per tenant by `(event_id, external_id)` where `external_id` is the EventCreate attendee ID.

```sql
CREATE TABLE event_registrations (
  tenant_id        TEXT NOT NULL,
  registration_id  UUID NOT NULL DEFAULT gen_random_uuid(),

  event_id         UUID NOT NULL,
  external_id      TEXT NOT NULL,           -- EventCreate attendee ID

  -- Attendee identity (subject to differentiated retention per FR-032)
  attendee_email       TEXT NOT NULL,
  attendee_email_lower TEXT GENERATED ALWAYS AS (lower(attendee_email)) STORED,
  attendee_name        TEXT NOT NULL,
  attendee_company     TEXT,

  -- Match resolution (FR-012)
  match_type           TEXT NOT NULL
                         CHECK (match_type IN ('member_contact','member_domain','member_fuzzy','non_member','unmatched')),
  matched_member_id    UUID,                -- nullable
  matched_contact_id   UUID,                -- nullable

  -- Ticket info (record-only from EventCreate; F6 does not process payment)
  ticket_type          TEXT,
  ticket_price_thb     INTEGER,             -- minor units NOT used; THB integer
  payment_status       TEXT NOT NULL DEFAULT 'paid'
                         CHECK (payment_status IN ('paid','pending','refunded','free')),

  -- Quota accounting flags (FR-015 / FR-016 / FR-017 / FR-018)
  counted_against_partnership    BOOLEAN NOT NULL DEFAULT FALSE,
  counted_against_cultural_quota BOOLEAN NOT NULL DEFAULT FALSE,

  -- Forward-compat (FR-011a)
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Retention + lifecycle (FR-032)
  registered_at         TIMESTAMPTZ NOT NULL,
  imported_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pii_pseudonymised_at  TIMESTAMPTZ,        -- set by daily sweep when non-member > 2y

  PRIMARY KEY (tenant_id, registration_id),

  FOREIGN KEY (tenant_id, event_id) REFERENCES events(tenant_id, event_id)
);

CREATE UNIQUE INDEX event_regs_tenant_event_external_unique
  ON event_registrations (tenant_id, event_id, external_id);

CREATE INDEX event_regs_tenant_event_registered_idx
  ON event_registrations (tenant_id, event_id, registered_at DESC);

CREATE INDEX event_regs_tenant_matched_member_idx
  ON event_registrations (tenant_id, matched_member_id)
  WHERE matched_member_id IS NOT NULL;

CREATE INDEX event_regs_tenant_email_lower_idx
  ON event_registrations (tenant_id, attendee_email_lower);

CREATE INDEX event_regs_tenant_needs_relink_idx
  ON event_registrations (tenant_id, match_type)
  WHERE match_type IN ('unmatched','non_member');

CREATE INDEX event_regs_pseudonymise_eligibility_idx
  ON event_registrations (tenant_id, registered_at)
  WHERE match_type IN ('non_member','unmatched') AND pii_pseudonymised_at IS NULL;

ALTER TABLE event_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_registrations FORCE  ROW LEVEL SECURITY;
CREATE POLICY event_regs_tenant_isolation ON event_registrations
  FOR ALL TO chamber_app
  USING      (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));
-- `FOR ALL TO chamber_app` + `WITH CHECK` required — see events policy.
```

**Invariants**:

- `(tenant_id, event_id, external_id)` is the registration idempotency key (FR-011).
- `match_type = 'non_member' | 'unmatched'` → `matched_member_id IS NULL` AND `matched_contact_id IS NULL` AND `counted_against_* = FALSE` (FR-013). (Round-6 B8 staff-review fix 2026-05-13: contact-id arm enforced in migration 0136; original 0128 constraint enforced member-id only.)
- `payment_status = 'refunded'` → on first refund delivery, any `counted_against_* = TRUE` flag MUST be flipped to FALSE in the same tx and the member's quota incremented (FR-018).
- `pii_pseudonymised_at IS NOT NULL` → `attendee_email`, `attendee_name`, `attendee_company` are deterministic SHA-256 salted hashes (per-tenant salt); `attendee_email_lower` is implicitly the hash's lowercase (still works as a search key for tenant-internal hash-lookup but not as a re-identification vector).
- `metadata` MUST exclude any key that collides with the canonical column set.

---

### 1.3 `tenant_webhook_configs`

Per-tenant, per-source webhook credentials.

```sql
CREATE TABLE tenant_webhook_configs (
  tenant_id              TEXT NOT NULL,
  source                 TEXT NOT NULL CHECK (source IN ('eventcreate')),

  webhook_secret_active  TEXT NOT NULL,        -- 32-byte random, base64url encoded
  webhook_secret_grace   TEXT,                 -- prev active secret retained 24h post-rotation
  grace_rotated_at       TIMESTAMPTZ,          -- when active moved to grace

  enabled                BOOLEAN NOT NULL DEFAULT TRUE,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_received_at       TIMESTAMPTZ,
  last_rotated_at        TIMESTAMPTZ,

  PRIMARY KEY (tenant_id, source)
);

CREATE INDEX tenant_webhook_configs_grace_idx
  ON tenant_webhook_configs (tenant_id, source)
  WHERE webhook_secret_grace IS NOT NULL;

ALTER TABLE tenant_webhook_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_webhook_configs FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_webhook_configs_tenant_isolation ON tenant_webhook_configs
  FOR ALL TO chamber_app
  USING      (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));
-- `FOR ALL TO chamber_app` + `WITH CHECK` required — see events policy.
```

**Invariants**:

- `webhook_secret_active` is the only secret revealed to admin (one-time, FR-024).
- `webhook_secret_grace` is NULL initially and after >24h (cleared by daily cron).
- `grace_rotated_at` is non-NULL iff `webhook_secret_grace` is non-NULL.
- `last_received_at` updates atomically with every successfully-verified webhook receipt (signal of integration health).
- `enabled = FALSE` → webhook handler returns 503 + `Retry-After` per FR-033.

---

### 1.4 `eventcreate_idempotency_receipts` (new in F6)

F6-owned idempotency-receipt table. Stores one row per uniquely-identifying-key (`X-Request-ID` for webhook deliveries; SHA-256 row-hash for CSV row imports). 7-day TTL sweep runs daily to keep the table bounded.

**Why F6-owns-its-own**: F5 introduced `processor_events` for Stripe webhook idempotency, but that table's schema is Stripe-specific (PK is the Stripe event id `evt_…`, columns shaped for Stripe). Reusing it for EventCreate webhooks would require an awkward schema generalisation. Per Constitution Principle III (Clean Architecture / bounded contexts), each integration owns its own idempotency surface. F6 introduces a clean F6-scoped table; future generalisation into a shared `webhook_idempotency_receipts` table can be considered if a 4th integration arrives.

```sql
CREATE TABLE eventcreate_idempotency_receipts (
  tenant_id        TEXT NOT NULL,
  source           TEXT NOT NULL
                     CHECK (source IN ('eventcreate_webhook','eventcreate_csv')),
  request_id       TEXT NOT NULL,                  -- X-Request-ID (webhook) OR sha256 row-hash (CSV)
  processed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ttl_expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',

  PRIMARY KEY (tenant_id, source, request_id)
);

CREATE INDEX eventcreate_idempotency_receipts_ttl_idx
  ON eventcreate_idempotency_receipts (ttl_expires_at)
  WHERE ttl_expires_at < NOW() + INTERVAL '1 day';
-- partial index keeps cleanup queries small

ALTER TABLE eventcreate_idempotency_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventcreate_idempotency_receipts FORCE  ROW LEVEL SECURITY;
CREATE POLICY eventcreate_idempotency_receipts_tenant_isolation
  ON eventcreate_idempotency_receipts
  FOR ALL TO chamber_app
  USING      (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));
-- `FOR ALL TO chamber_app` + `WITH CHECK` required — see events policy.
```

**Invariants**:

- `(tenant_id, source, request_id)` is the dedup key — duplicate INSERT returns conflict, handler converts to HTTP 409 (FR-004) for webhook, or silent-skip for CSV.
- `ttl_expires_at` defaults to +7 days but the daily TTL-sweep cron deletes expired rows opportunistically.
- The table grows ~10k rows/yr/tenant at design envelope (~50k webhooks/yr + ~10k CSV rows/yr) before sweep. Sweep keeps it bounded at ~200 rows in flight.

**TTL sweep cron**: a new cron-job.org entry triggers `/api/internal/retention/sweep-eventcreate-idempotency` daily (Bearer-auth via `CRON_SECRET`); handler iterates tenants (super-admin enumeration → `runInTenant` per tenant) and deletes rows where `ttl_expires_at < NOW()`. Same iteration pattern as the PII-pseudonymisation sweep (research.md R9).

---

## 2. Drizzle schema mapping

The Drizzle schema in `src/modules/events/infrastructure/schema.ts` mirrors the SQL above 1:1. Key type mappings:

| SQL type | Drizzle type | Notes |
|----------|--------------|-------|
| `TIMESTAMPTZ` | `timestamp({ withTimezone: true, mode: 'string' })` | Storage is UTC; app converts in Domain layer |
| `JSONB` | `jsonb<Record<string, unknown>>()` | Strongly-typed via Domain VO at boundary |
| `UUID DEFAULT gen_random_uuid()` | `uuid().defaultRandom()` |  |
| `TEXT CHECK (...)` | `text({enum: ['v1','v2',...] as const})` + zod-validated at boundary | Defence in depth |
| `BOOLEAN DEFAULT FALSE` | `boolean().notNull().default(false)` |  |
| `INTEGER` | `integer()` | THB is plain integer (not minor units — Thai baht has no widely-used sub-unit in commerce) |

Inferred types (`InferSelectModel<typeof events>`, etc.) live in `infrastructure/` only — never imported into `application/` or `domain/` per Principle III. Application uses Domain value-objects (`EventAggregate`, `EventRegistration`, etc.) and mappers in `infrastructure/` translate Drizzle rows ↔ Domain VOs.

---

## 3. State machines

### 3.1 Event lifecycle

```
                  (webhook ingest)
   [NEW]───────────────► [ACTIVE: archived_at IS NULL]
                                │
                                │ admin archive (FR-019a)
                                ▼
                       [ARCHIVED: archived_at IS NOT NULL]
                                │
                                │ (no v1 unarchive; new webhook
                                │  delivery with same external_id
                                │  creates registrations but event
                                │  stays archived per FR-019a)
                                ▼
                       [ARCHIVED — registrations still flow,
                        quota-neutral]
```

Webhook deliveries to an archived event upsert event metadata as normal but `apply-quota-effect` short-circuits (FR-019a) so new registrations land with `counted_against_* = FALSE`.

### 3.2 Registration match-type transitions

```
   [match_type assigned at ingest]
            │
            │ admin relink (FR-014)
            ▼
   [match_type rewritten + quota credit-back-and-recompute]
            │
            │ (re-relink possible — no terminal state)
            ▼
   [same loop]
```

There is no "archive registration" state — registrations either exist or are erased via FR-032a (delete + cascade).

### 3.3 Registration payment_status transitions

```
   [paid | pending | free]  (from initial ingest)
          │
          │ subsequent webhook with payment_status = 'refunded'
          ▼
   [refunded]  (quota credited back, audit emitted)
          │
          │ (no further transitions in v1; admin erasure
          │  is orthogonal to status)
```

### 3.4 Webhook receipt outcome (no DB state; lives in audit log only)

```
   request arrives
       │
       ├─► timestamp skew >5min ───► [webhook_replay_rejected]
       │
       ├─► signature mismatch     ───► [webhook_signature_rejected]
       │
       ├─► X-Request-ID duplicate ───► [webhook_duplicate_rejected]
       │
       ├─► body validation fails  ───► [webhook_malformed_rejected]
       │
       ├─► primary tx rolls back  ───► [webhook_rolled_back]
       │
       └─► commit                 ───► [webhook_receipt_verified]
                                       (with processing_outcome:
                                        matched | non_member | unmatched)
```

---

## 4. Audit event taxonomy (canonical)

See `research.md` R13 for the original ~35-event list with retention years. Final canonical taxonomy is **43 events** (original 35 enumerated in migration 0132 + 8 added via subsequent migrations 0135 `webhook_secret_force_expired` + 0140-series F6.1 CSV events + R6-W5 staff-review fix `webhook_ingest_precondition_failed`). Codified in `src/modules/events/application/ports/audit-port.ts:76-171` as a closed union type so adding a new event type requires a TypeScript change (compile-time enforcement).

```ts
export type F6AuditEventType =
  // Webhook ingest (8)
  | 'webhook_receipt_verified'
  | 'webhook_signature_rejected'
  | 'webhook_replay_rejected'
  | 'webhook_duplicate_rejected'
  | 'webhook_malformed_rejected'
  | 'webhook_rolled_back'
  | 'webhook_secret_grace_used'
  | 'webhook_test_invoked'
  // Match resolution (5)
  | 'attendee_matched_member_contact'
  | 'attendee_matched_member_domain'
  | 'attendee_matched_member_fuzzy'
  | 'attendee_non_member'
  | 'attendee_unmatched'
  // Quota effects (5)
  | 'quota_partnership_decremented'
  | 'quota_cultural_decremented'
  | 'quota_credit_back_refund'
  | 'quota_credit_back_archive'
  | 'quota_over_quota_warning'
  // Admin actions (10)
  | 'registration_relinked'
  | 'event_archived'
  | 'event_partner_benefit_toggled'
  | 'event_cultural_event_toggled'
  | 'webhook_secret_generated'
  | 'webhook_secret_rotated'
  | 'ingest_disabled_super_admin'
  | 'ingest_disabled_tenant_admin'
  | 'csv_import_completed'
  | 'csv_import_row_failed'
  // Privacy + compliance (4)
  | 'pii_erasure_requested'
  | 'pii_erasure_completed'
  | 'pii_pseudonymised'
  | 'pii_pseudonymisation_sweep_run'
  // Security (3)
  | 'cross_tenant_probe'
  | 'role_violation_blocked'
  | 'webhook_rate_limit_exceeded';
```

All events use the existing `audit_log` table from F1 (extended through F8). Default retention 5 years (no F4-style 10-year overlap; F6 is not a tax-document surface).

**Schema enforcement**: `audit_log.event_type` is a **Postgres enum** (`audit_event_type`, introduced in F1, extended by F4 via the idempotent `DO $$ BEGIN ALTER TYPE … ADD VALUE 'X'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;` pattern). Adding F6's 35 event types requires **migration 0132** to extend the enum with 35 separate DO-blocks (Postgres restriction: each ADD VALUE must be its own statement). The TypeScript `F6AuditEventType` closed-union provides compile-time taxonomy enforcement; the Postgres enum provides DB-level enforcement. Both layers must stay in sync — adding a new event type requires both a TypeScript edit AND a migration. **Without migration 0132, every F6 audit emit raises `invalid input value for enum audit_event_type`** and the strict-transactional ingest (FR-037) rolls back on every webhook.

### 4.1 Audit query patterns + JSON-path index decision (R9 T151 CHK024 closure)

**Question**: Does F6 need Postgres partial indexes on `audit_log.payload` JSONB column for high-cardinality forensic queries (e.g., lookup-by-`event_external_id`, lookup-by-`request_id`, lookup-by-`attendee_email_hash`)?

**Answer**: **No new F6-specific JSONB indexes at v1.** F6 reuses existing indexes only:

| Query pattern | Source-of-truth index | Use case |
|---|---|---|
| Look up audits for a specific member | F3 migration 0009 — `audit_log ((payload->>'member_id'))` | Member timeline / cross-feature member-detail page (already present from F3) |
| Look up audits by event-type + actor | F1 migration 0001 — `audit_log (event_type, actor_user_id, timestamp)` composite | Standard audit queries (admin "what happened?" timeline) |
| Idempotency-unique forensic events | F4 migration 0021 — `audit_log_overdue_once_per_day` UNIQUE index | F4-specific (NOT reused by F6 — F6's idempotency lives in `eventcreate_idempotency_receipts`, NOT audit_log) |

**Rationale for deferring F6-specific JSONB indexes**:
1. **Single-tenant scale**: SweCham ~131 members × ~50 events/yr × ~100 attendees/event ≈ 5,000 F6 audit rows/yr — fits in Postgres shared_buffers; full-scan acceptable for post-incident forensics.
2. **F6 idempotency is structural (separate table)**: `eventcreate_idempotency_receipts` handles webhook + CSV idempotency at the DB-row level. No F4-style "once-per-day" audit-row UNIQUE index needed.
3. **Forensic queries are post-incident, not real-time**: SREs investigating a `cross_tenant_probe` or `webhook_signature_rejected` event run ad-hoc queries via Vercel Postgres dashboard — query latency budget is "human-tolerable" (~5-30s), not "dashboard-real-time" (<500ms).
4. **F3 member-id index is already sufficient for the most-common cross-feature query** (member timeline including F6 attendance audits).

**Trigger for revisiting**: add F6-specific JSONB partial indexes IF any of:
- F6 audit row count exceeds **100,000** (multi-tenant scale OR high-volume tenant) — measurable via `SELECT count(*) FROM audit_log WHERE event_type LIKE 'webhook_%' OR event_type LIKE 'attendee_%' OR event_type LIKE 'csv_import_%'`.
- A forensic query repeatedly used during incident response exceeds **5s p95 wall-clock** — measurable via Neon slow-query log.
- A real-time admin dashboard surface (NOT post-incident forensic) needs sub-second audit query (e.g., "show last 100 webhook signature rejections" widget).

**Recommended F6.2 backlog indexes** (DDL ready when triggers fire):
```sql
-- Forensic lookup: webhook deliveries for a specific event_external_id
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_f6_event_external_id
  ON audit_log ((payload->>'event_external_id'))
  WHERE event_type IN ('webhook_receipt_verified', 'webhook_rolled_back',
                       'webhook_duplicate_rejected', 'webhook_test_invoked');

-- Forensic lookup: audit trail for a specific webhook delivery (request_id)
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_f6_request_id
  ON audit_log ((payload->>'request_id'))
  WHERE event_type LIKE 'webhook_%';
```

**Decision documented**: 2026-05-17 (R9 T151 CHK024 closure). Revisit at multi-tenant onboarding or `EVENTCREATE_AUDIT_ROW_COUNT_OVER_100K` alert (to be added at F6.2 if triggered).

---

## 5. Domain value objects (Clean Architecture)

These are pure TypeScript types in `src/modules/events/domain/`. Zero framework imports.

```ts
// match-type.ts
export type MatchType =
  | 'member_contact'
  | 'member_domain'
  | 'member_fuzzy'
  | 'non_member'
  | 'unmatched';

// payment-status.ts
export type PaymentStatus = 'paid' | 'pending' | 'refunded' | 'free';

// source.ts
export type Source = 'eventcreate'; // extensible

// webhook-outcome.ts (for audit event payloads)
export type WebhookOutcome =
  | { kind: 'verified'; processingOutcome: ProcessingOutcome }
  | { kind: 'signature_rejected' }
  | { kind: 'replay_rejected'; skewSeconds: number }
  | { kind: 'duplicate_rejected'; requestId: string }
  | { kind: 'malformed_rejected'; errors: ReadonlyArray<{ path: string; message: string }> }
  | { kind: 'rolled_back'; reason: string }
  | { kind: 'grace_used' };

export type ProcessingOutcome =
  | 'matched_member_contact'
  | 'matched_member_domain'
  | 'matched_member_fuzzy'
  | 'non_member'
  | 'unmatched';

// event.ts (aggregate)
export interface EventAggregate {
  readonly tenantId: TenantId;
  readonly eventId: EventId;
  readonly source: Source;
  readonly externalId: ExternalEventId;
  readonly name: string;
  readonly description: string | null;
  readonly startDate: Date;
  readonly endDate: Date | null;
  readonly location: string | null;
  readonly category: string | null;
  readonly eventcreateUrl: string | null;
  readonly isPartnerBenefit: boolean;
  readonly isCulturalEvent: boolean;
  readonly archivedAt: Date | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly importedAt: Date;
  readonly lastUpdatedAt: Date;
}

// event-registration.ts (aggregate)
export interface EventRegistrationAggregate {
  readonly tenantId: TenantId;
  readonly registrationId: RegistrationId;
  readonly eventId: EventId;
  readonly externalId: ExternalAttendeeId;
  readonly attendee: Attendee;
  readonly match: MatchResolution;
  readonly ticket: Ticket;
  readonly quotaEffect: QuotaEffect;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly registeredAt: Date;
  readonly importedAt: Date;
  readonly piiPseudonymisedAt: Date | null;
}

export interface Attendee {
  readonly email: AttendeeEmail;
  readonly name: string;
  readonly company: string | null;
}

export interface MatchResolution {
  readonly type: MatchType;
  readonly matchedMemberId: MemberId | null;
  readonly matchedContactId: ContactId | null;
}

export interface Ticket {
  readonly type: string | null;
  readonly priceThb: number | null;
  readonly paymentStatus: PaymentStatus;
}

export interface QuotaEffect {
  readonly countedAgainstPartnership: boolean;
  readonly countedAgainstCulturalQuota: boolean;
}

// tenant-webhook-config.ts (aggregate)
export interface TenantWebhookConfigAggregate {
  readonly tenantId: TenantId;
  readonly source: Source;
  readonly activeSecret: WebhookSecret;
  readonly graceSecret: WebhookSecret | null;
  readonly graceRotatedAt: Date | null;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly lastReceivedAt: Date | null;
  readonly lastRotatedAt: Date | null;
}
```

**Branded types** used throughout (declared in `src/modules/tenants/domain/branded-types.ts` and extended in `src/modules/events/domain/branded-types.ts`):

```ts
export type EventId            = string & { readonly __brand: 'EventId' };
export type RegistrationId     = string & { readonly __brand: 'RegistrationId' };
export type ExternalEventId    = string & { readonly __brand: 'ExternalEventId' };
export type ExternalAttendeeId = string & { readonly __brand: 'ExternalAttendeeId' };
export type AttendeeEmail      = string & { readonly __brand: 'AttendeeEmail' };
export type WebhookSecret      = string & { readonly __brand: 'WebhookSecret' };
```

---

## 6. Relationship diagram

```
┌─────────────────┐                    ┌──────────────────────────┐
│  tenants        │  (F1)              │  members  (F3)           │
│  - tenant_id    │                    │  - tenant_id             │
└────────┬────────┘                    │  - member_id             │
         │                             │  - email_domain          │
         │                             │  - normalised_co_name    │
         │                             │  (no stored quota cols   │
         │                             │   — usage computed on-   │
         │                             │   read from              │
         │                             │   event_registrations)   │
         │                             └────────┬─────────────────┘
         │                                      │
         │                                      │ (matched_member_id, nullable)
         │                                      │
         │      ┌──────────────────────────┐    │
         ▼      │  events                  │    │
         tenant_id  - tenant_id            │    │
         ┌────► - event_id (PK)            │    │
         │      - source                   │    │
         │      - external_id              │    │
         │      - is_partner_benefit       │    │
         │      - is_cultural_event        │    │
         │      - archived_at              │    │
         │      - metadata (jsonb)         │    │
         │      └──────────┬───────────────┘    │
         │                 │ tenant_id+event_id │
         │                 │                    │
         │      ┌──────────▼───────────────┐    │
         │      │  event_registrations     │◄───┘
         │      │  - tenant_id             │
         │      │  - registration_id (PK)  │
         │      │  - event_id (FK)         │
         │      │  - external_id           │
         │      │  - attendee_email + name │
         │      │  - match_type            │
         │      │  - matched_member_id     │
         │      │  - matched_contact_id    │
         │      │  - counted_against_*     │
         │      │  - payment_status        │
         │      │  - metadata (jsonb)      │
         │      │  - pii_pseudonymised_at  │
         │      └──────────────────────────┘
         │
         │      ┌──────────────────────────┐
         └────► │  tenant_webhook_configs  │
                │  - tenant_id (PK1)       │
                │  - source (PK2)          │
                │  - webhook_secret_active │
                │  - webhook_secret_grace  │
                │  - grace_rotated_at      │
                │  - enabled               │
                └──────────────────────────┘

                ┌──────────────────────────────────┐
                │ eventcreate_idempotency_receipts │  (F6-owned; new table)
                │  - tenant_id                     │
                │  - source ∈ {eventcreate_webhook,│
                │              eventcreate_csv}    │
                │  - request_id                    │
                │  - processed_at                  │
                │  - ttl_expires_at                │
                └──────────────────────────────────┘

                ┌──────────────────────────┐
                │  contacts  (F3)          │  ← (matched_contact_id, nullable)
                │  - tenant_id             │
                │  - contact_id            │
                │  - member_id (parent)    │
                │  - email                 │
                └──────────────────────────┘
```

---

## 7. Migrations sequencing (drizzle/migrations/0127–0137)

| # | File | Purpose | DDL type |
|---|------|---------|----------|
| 0127 | `0127_f6_events_table.sql` | `CREATE TABLE events` + PK + CHECKs + `events_set_last_updated_at_fn` trigger function (search-path-hardened at creation) | inside tx |
| 0128 | `0128_f6_event_registrations_table.sql` | `CREATE TABLE event_registrations` + PK + FK + CHECKs + STORED generated `attendee_email_lower` column | inside tx |
| 0129 | `0129_f6_tenant_webhook_configs_table.sql` | `CREATE TABLE tenant_webhook_configs` + PK + CHECK (grace-key biconditional) | inside tx |
| 0130 | `0130_f6_events_indexes.sql` | 4 indexes on `events` | **non-CONCURRENTLY, inside tx** (round-6 W9 doc fix 2026-05-13: previous "CONCURRENTLY, outside tx" claim was factually wrong; F3/F8 precedent runs CREATE INDEX on empty tables inside the Drizzle migration tx — `AccessExclusiveLock` is sub-second at table creation time, no zero-downtime concern) |
| 0131 | `0131_f6_registrations_indexes.sql` | 6 indexes on `event_registrations` incl. `event_regs_tenant_email_lower_idx` (powers Phase 4 admin q-search) | non-CONCURRENTLY, inside tx |
| 0132 | `0132_f6_audit_event_types.sql` | Extend the `audit_event_type` **Postgres enum** with 35 new F6 event types via the F4 precedent pattern (`DO $$ BEGIN ALTER TYPE audit_event_type ADD VALUE 'X'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;` per event — idempotent, forward-only). Postgres requires each `ALTER TYPE … ADD VALUE` in its own statement (cannot run inside a multi-statement tx with other DDL), so the migration file contains 35 sequential DO-blocks. Forward-only: Postgres does not support `DROP VALUE` for an enum. Per F4 migration 0011 precedent. | outside tx (per-DO-block) |
| 0133 | `0133_f6_rls_force_policies.sql` | `ENABLE`/`FORCE` RLS + tenant-isolation policy on `events` + `event_registrations` + `tenant_webhook_configs` (3 tables; `eventcreate_idempotency_receipts` gets its own RLS+FORCE inline in 0134) | inside tx |
| 0134 | `0134_f6_eventcreate_idempotency_receipts.sql` | Create `eventcreate_idempotency_receipts` table (F6-owned; see § 1.4) — composite PK `(tenant_id, source, request_id)` + CHECK on source + TTL `ttl_expires_at` column + **full** index on `ttl_expires_at` for sweep (round-6 W9 doc fix 2026-05-13: previous "partial index `WHERE ttl_expires_at < NOW() + INTERVAL '1 day'`" claim was wrong; `now()` is STABLE not IMMUTABLE and Postgres rejects STABLE expressions in partial-index predicates per commit `785534f4`) + RLS+FORCE + tenant-isolation policy. **F6-owned**, not a reuse of F5's `processor_events` (Stripe-specific). | inside tx |
| 0135 | `0135_f6_force_expire_grace_audit.sql` | Add `webhook_secret_force_expired` enum value (gap closed in follow-up — original 0132 missed the `forceExpireGraceSecret` use-case audit event). | outside tx (DO-block) |
| 0136 | `0136_f6_event_registrations_non_member_no_contact_check.sql` | **Round-6 staff-review B8 fix (2026-05-13)** — tighten `event_registrations_non_member_no_quota` CHECK to also forbid `matched_contact_id` on non_member/unmatched rows. Closes data-integrity hole left by 0128's original constraint. | inside tx |
| 0137 | `0137_f6_webhook_ingest_precondition_failed_audit.sql` | **Round-6 staff-review W5 fix (2026-05-13)** — add `webhook_ingest_precondition_failed` enum value so pre-tx config-load failures stop polluting the `webhook_rolled_back` taxonomy. | outside tx (DO-block) |

All migrations are reversible (down migrations included) EXCEPT enum extensions (0132, 0135, 0137) which are forward-only per Postgres restriction. Indexes are created non-CONCURRENTLY because the tables are empty at creation time — `AccessExclusiveLock` is sub-second and zero-downtime is not a concern. The CONCURRENTLY pattern is reserved for index additions to populated tables in later phases.

---

## 8. Cross-module dependencies

- **F2 (Plans)**: read-only consumer of `getMemberPlanForBucket(memberId)` from F2's barrel (introduced in F8). F6 calls this in `apply-quota-effect.ts` to determine the matched member's plan + ticket allotments. No F2 schema change required. **Quota usage is NOT stored anywhere** — it is computed on-read from `event_registrations` boolean flags (`SUM(counted_against_partnership)` per `(matched_member_id, event_id)` for partnership; `SUM(counted_against_cultural_quota)` per `(matched_member_id, fiscal year)` for cultural). The computed-on-read source is serialised against concurrent ingest races by an advisory lock per research.md R5 (`pg_advisory_xact_lock('eventcreate-quota:' || tenant_id || ':' || matched_member_id || ':' || event_id)`).
- **F3 (Members + Contacts)**: read-only consumer of `members.email_domain`, `members.normalised_company_name`, `contacts.email` for match resolution. No F3 schema change required.
- **F8 (Renewals)**: F6 provides the `EventAttendeesPort` implementation. F8's at-risk score formula reads attendance counts via this port. The port is feature-flag-gated by `FEATURE_F6_EVENTCREATE` at the composition root; F8 sees the stub (empty array, `isAvailable() === false`) when the flag is off.

No F6 → other-module write paths exist; the data flow is one-way (F6 consumes F2 + F3 read-only; F8 consumes F6 via the port).

> **Phase 4 port-shape note** (verify-finding F5, 2026-05-12): the Phase 4 admin events list + detail uses **offset+pageSize+totalCount** pagination on `EventsRepository.list()` + `RegistrationsRepository.findByEventId()` (mirrors F4 invoice-list + F8 pipeline precedent). The original port draft had a `pageToken` cursor; Phase 4 switched to offset to satisfy the wire-contract `contracts/admin-events-api.md` requirement that `pagination.totalCount` be returned on every page. Cursor-style pagination is preserved as a future affordance — at SweCham scale (<200 events/year, <500 attendees/event) offset is sub-50ms with the migration-0130 indexes; cursor switch would land if a tenant exceeds ~10k events.

---

## 9. Forward-compat surfaces (post-MVP affordances explicitly designed in)

- **`events.metadata` + `event_registrations.metadata` JSONB**: preserves unknown EventCreate payload fields per FR-011a so new fields don't break ingest. Admin UI may surface these in a "Raw payload" debug panel in a future release.
- **`events.source` extensibility**: the CHECK constraint allows only `'eventcreate'` today, but the column shape supports adding `'eventbrite'` etc. via a migration without table-level changes.
- **`tenant_webhook_configs.source`** same as above.
- **Schema versioned endpoint path** (`/v1/`): explicit per FR-001; future `v2` deploys side-by-side without disturbing live Zaps.
- **Audit event taxonomy** is a closed TS union — adding a new event requires a TypeScript change but no DB migration.

---

## 10. Validation rules (zod schemas — Application layer)

The canonical webhook payload schema in `src/modules/events/domain/eventcreate-payload.ts`:

```ts
import { z } from 'zod';

export const EventCreatePayloadV1 = z.object({
  eventType: z.enum(['attendee.registered', 'purchase.completed']),
  tenantSlug: z.string().min(1),  // informational; tenant resolved from URL path (FR-006)

  event: z.object({
    externalId: z.string().min(1),
    name: z.string().min(1).max(500),
    description: z.string().max(5000).optional().nullable(),
    startDate: z.string().datetime({ offset: true }),     // ISO 8601 with TZ offset
    endDate: z.string().datetime({ offset: true }).optional().nullable(),
    location: z.string().max(500).optional().nullable(),
    category: z.string().max(100).optional().nullable(),
    isMemberDiscounted: z.boolean().optional(),
    isPartnerBooth: z.boolean().optional(),
    eventCreateUrl: z.string().url().optional().nullable(),
  }).passthrough(),  // FR-011a — preserve unknown fields into events.metadata

  attendee: z.object({
    externalId: z.string().min(1),
    email: z.string().email().max(320),
    fullName: z.string().min(1).max(200),
    companyName: z.string().max(200).optional().nullable(),
    ticketType: z.string().max(100).optional().nullable(),
    ticketPricePaid: z.number().int().nonnegative().optional().nullable(),
    paymentStatus: z.enum(['paid', 'pending', 'refunded', 'free']).default('paid'),
    registeredAt: z.string().datetime(),
    metadata: z.record(z.unknown()).optional(),
  }).passthrough(),  // FR-011a
});

export type EventCreatePayloadV1 = z.infer<typeof EventCreatePayloadV1>;
```

CSV import row schema in the same file:

```ts
export const CsvRowSchema = z.object({
  event_external_id: z.string().min(1),
  event_name: z.string().min(1),
  event_start: z.string().datetime({ offset: true }),
  event_category: z.string().optional(),
  attendee_email: z.string().email(),
  attendee_name: z.string().min(1),
  attendee_company: z.string().optional(),
  ticket_type: z.string().optional(),
  ticket_price_thb: z.coerce.number().int().nonnegative().optional(),
  payment_status: z.enum(['paid', 'pending', 'refunded', 'free']).default('paid'),
  registered_at: z.string().datetime().optional(),  // defaults to event_start if missing
});
```

Both schemas reject extra fields at the Application boundary only when those fields collide with the canonical column set; unknowns are otherwise preserved via `.passthrough()` per FR-011a.
