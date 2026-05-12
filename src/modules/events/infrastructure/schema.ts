/**
 * T014 — Drizzle schema for F6 EventCreate Integration tables.
 *
 * Migrations:
 *   - 0127 events
 *   - 0128 event_registrations
 *   - 0129 tenant_webhook_configs
 *   - 0130 events indexes
 *   - 0131 event_registrations indexes
 *   - 0132 audit_event_type enum extension (35 new F6 values)
 *   - 0133 RLS+FORCE policies (events + event_registrations + tenant_webhook_configs)
 *   - 0134 eventcreate_idempotency_receipts (with RLS inline)
 *
 * 4 `pgTable` declarations mirroring the migrations exactly. Inferred
 * insert/select types live HERE (Infrastructure layer) and MUST NOT leak
 * into Application or Domain (Constitution Principle III). Repository
 * adapters translate between these DTOs and Domain aggregates
 * (`EventAggregate`, `EventRegistrationAggregate`,
 * `TenantWebhookConfigAggregate`).
 *
 * Tenant isolation: every table uses `tenant_id text` scoped by RLS+FORCE
 * (see migrations 0133 + 0134). Application connects via `chamber_app`
 * role with `SET LOCAL app.current_tenant` per request — same pattern as
 * F2–F8 modules.
 *
 * NOTE: this module is Infrastructure. It MUST NOT be exported from
 * `src/modules/events/index.ts` barrel — ESLint barrel-guard rule
 * enforces Domain-type-only exports.
 *
 * STORED generated column: Drizzle does not yet provide a first-class
 * primitive for `GENERATED ALWAYS AS (...) STORED` columns. The migration
 * declares it; the schema below declares the column as a regular `text`
 * field (read-only at the app layer — INSERT/UPDATE must NEVER set it).
 * Repository adapters omit `attendee_email_lower` from every write
 * statement; the column is materialised by Postgres on insert/update of
 * `attendee_email`.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// 1. events  (migration 0127)
// ---------------------------------------------------------------------------

export const events = pgTable(
  'events',
  {
    tenantId: text('tenant_id').notNull(),
    eventId: uuid('event_id').notNull().defaultRandom(),

    source: text('source').notNull().default('eventcreate'),
    externalId: text('external_id').notNull(),

    name: text('name').notNull(),
    description: text('description'),
    startDate: timestamp('start_date', { withTimezone: true }).notNull(),
    endDate: timestamp('end_date', { withTimezone: true }),
    location: text('location'),
    category: text('category'),
    eventcreateUrl: text('eventcreate_url'),

    isPartnerBenefit: boolean('is_partner_benefit').notNull().default(false),
    isCulturalEvent: boolean('is_cultural_event').notNull().default(false),

    archivedAt: timestamp('archived_at', { withTimezone: true }),

    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    importedAt: timestamp('imported_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.eventId] }),
    // Migration 0130 indexes — declared here for query-builder hints +
    // drizzle-kit introspection alignment. The migration is the source
    // of truth for index DDL.
    tenantSourceExternalUniq: uniqueIndex(
      'events_tenant_source_external_unique',
    ).on(t.tenantId, t.source, t.externalId),
    tenantStartActiveIdx: index('events_tenant_start_active_idx').on(
      t.tenantId,
      t.startDate,
    ),
    tenantPartnerBenefitIdx: index('events_tenant_partner_benefit_idx').on(
      t.tenantId,
      t.isPartnerBenefit,
    ),
    tenantCulturalEventIdx: index('events_tenant_cultural_event_idx').on(
      t.tenantId,
      t.isCulturalEvent,
    ),
  }),
);

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;

// ---------------------------------------------------------------------------
// 2. event_registrations  (migration 0128)
// ---------------------------------------------------------------------------

export const eventRegistrations = pgTable(
  'event_registrations',
  {
    tenantId: text('tenant_id').notNull(),
    registrationId: uuid('registration_id').notNull().defaultRandom(),

    eventId: uuid('event_id').notNull(),
    externalId: text('external_id').notNull(),

    attendeeEmail: text('attendee_email').notNull(),
    // STORED generated column — read-only at the app layer; never include
    // in INSERT/UPDATE. Drizzle does not have a first-class generated-column
    // primitive yet, so we declare the field shape only and rely on the
    // migration DDL to materialise the value.
    attendeeEmailLower: text('attendee_email_lower').notNull(),
    attendeeName: text('attendee_name').notNull(),
    attendeeCompany: text('attendee_company'),

    matchType: text('match_type').notNull(), // CHECK enforced at DB
    matchedMemberId: uuid('matched_member_id'),
    matchedContactId: uuid('matched_contact_id'),

    ticketType: text('ticket_type'),
    ticketPriceThb: integer('ticket_price_thb'),
    paymentStatus: text('payment_status').notNull().default('paid'),

    countedAgainstPartnership: boolean('counted_against_partnership')
      .notNull()
      .default(false),
    countedAgainstCulturalQuota: boolean('counted_against_cultural_quota')
      .notNull()
      .default(false),

    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    piiPseudonymisedAt: timestamp('pii_pseudonymised_at', {
      withTimezone: true,
    }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.registrationId] }),
    // Migration 0131 indexes.
    tenantEventExternalUniq: uniqueIndex(
      'event_regs_tenant_event_external_unique',
    ).on(t.tenantId, t.eventId, t.externalId),
    tenantEventRegisteredIdx: index('event_regs_tenant_event_registered_idx').on(
      t.tenantId,
      t.eventId,
      t.registeredAt,
    ),
    tenantMatchedMemberIdx: index('event_regs_tenant_matched_member_idx').on(
      t.tenantId,
      t.matchedMemberId,
    ),
    tenantEmailLowerIdx: index('event_regs_tenant_email_lower_idx').on(
      t.tenantId,
      t.attendeeEmailLower,
    ),
    tenantNeedsRelinkIdx: index('event_regs_tenant_needs_relink_idx').on(
      t.tenantId,
      t.matchType,
    ),
    pseudonymiseEligibilityIdx: index(
      'event_regs_pseudonymise_eligibility_idx',
    ).on(t.tenantId, t.registeredAt),
  }),
);

export type EventRegistrationRow = typeof eventRegistrations.$inferSelect;
export type NewEventRegistrationRow = typeof eventRegistrations.$inferInsert;

// ---------------------------------------------------------------------------
// 3. tenant_webhook_configs  (migration 0129)
// ---------------------------------------------------------------------------

export const tenantWebhookConfigs = pgTable(
  'tenant_webhook_configs',
  {
    tenantId: text('tenant_id').notNull(),
    source: text('source').notNull(),

    webhookSecretActive: text('webhook_secret_active').notNull(),
    webhookSecretGrace: text('webhook_secret_grace'),
    graceRotatedAt: timestamp('grace_rotated_at', { withTimezone: true }),

    enabled: boolean('enabled').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastReceivedAt: timestamp('last_received_at', { withTimezone: true }),
    lastRotatedAt: timestamp('last_rotated_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.source] }),
    graceIdx: index('tenant_webhook_configs_grace_idx').on(
      t.tenantId,
      t.source,
    ),
  }),
);

export type TenantWebhookConfigRow =
  typeof tenantWebhookConfigs.$inferSelect;
export type NewTenantWebhookConfigRow =
  typeof tenantWebhookConfigs.$inferInsert;

// ---------------------------------------------------------------------------
// 4. eventcreate_idempotency_receipts  (migration 0134)
// ---------------------------------------------------------------------------

export const eventcreateIdempotencyReceipts = pgTable(
  'eventcreate_idempotency_receipts',
  {
    tenantId: text('tenant_id').notNull(),
    source: text('source').notNull(), // CHECK enforced at DB
    requestId: text('request_id').notNull(),

    processedAt: timestamp('processed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Default `now() + INTERVAL '7 days'` lives at the DB; Drizzle's
    // `.default()` accepts a `sql` expression so we mirror it here for
    // schema introspection accuracy. Callers can also pass an explicit
    // expiry via `INSERT … VALUES (… , <explicit_ttl>)`.
    ttlExpiresAt: timestamp('ttl_expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + INTERVAL '7 days'`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.source, t.requestId] }),
    ttlIdx: index('eventcreate_idempotency_receipts_ttl_idx').on(t.ttlExpiresAt),
  }),
);

export type EventcreateIdempotencyReceiptRow =
  typeof eventcreateIdempotencyReceipts.$inferSelect;
export type NewEventcreateIdempotencyReceiptRow =
  typeof eventcreateIdempotencyReceipts.$inferInsert;
