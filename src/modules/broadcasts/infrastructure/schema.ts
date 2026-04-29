/**
 * T020 — Drizzle schema for F7 Email Broadcast tables.
 *
 * Migrations: drizzle/migrations/{0064_create_broadcasts, 0065_create_broadcast_deliveries,
 * 0066_create_marketing_unsubscribes, 0067_create_broadcast_segment_definitions,
 * 0068_seed_default_segment_definitions, 0069_audit_log_extend_retention_default_trigger,
 * 0070_alter_members_add_broadcasts_halted_until_admin_review,
 * 0071_alter_members_add_broadcasts_acknowledged_at,
 * 0072_alter_broadcast_actor_role_enum_add_system}.sql.
 *
 * 4 pgTable definitions matching data-model.md § 1.1–1.4 verbatim.
 * Inferred insert/select Row types live HERE (Infrastructure layer) and
 * MUST NOT leak into Application or Domain (Constitution Principle III —
 * NON-NEGOTIABLE). Repository adapters translate between these DTOs and
 * the Domain's `Broadcast`, `BroadcastDelivery`, `MarketingUnsubscribe`,
 * `BroadcastSegmentDefinition` aggregates.
 *
 * Tenant isolation: every table uses `tenant_id text` scoped by RLS+FORCE
 * policies declared in migrations 0064–0067 (NOT in this file —
 * Drizzle has no first-class RLS expression). Cross-tenant leak is
 * guarded by Postgres at the storage layer; the Application's
 * `runInTenant(ctx, fn)` re-binds `app.current_tenant` for every tx.
 *
 * NOTE: this module is Infrastructure. It MUST NOT be exported from
 * `src/modules/broadcasts/index.ts` barrel — ESLint barrel-guard rule
 * enforces Domain-type-only exports.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums (5)
// ---------------------------------------------------------------------------

/**
 * 8-state broadcast lifecycle (FR-004 + FR-004a state machine).
 *
 * Happy path: draft → submitted → approved → sending → sent
 * Side branches: submitted/approved → cancelled/rejected
 *               sending → failed_to_dispatch
 *
 * Terminal states (no outbound transitions): sent, rejected, cancelled,
 * failed_to_dispatch. State-machine enforcement is via PL/pgSQL trigger
 * (data-model § 4.2) at DB layer + `broadcast-status-transitions.ts`
 * policy at Domain layer (defence in depth).
 */
export const broadcastStatusEnum = pgEnum('broadcast_status', [
  'draft',
  'submitted',
  'approved',
  'sending',
  'sent',
  'rejected',
  'cancelled',
  'failed_to_dispatch',
]);

/**
 * Recipient targeting taxonomy (FR-015).
 * - all_members: tenant-wide blast
 * - tier: subset of members on specific membership plan tiers (params.tierCodes)
 * - event_attendees_last_90d: F6 stub-port (FR-015a) returning [] until F6 ships
 * - custom: bring-your-own list ≤100 entries; FR-015d-validated against tenant graph
 */
export const broadcastSegmentTypeEnum = pgEnum('broadcast_segment_type', [
  'all_members',
  'tier',
  'event_attendees_last_90d',
  'custom',
]);

/**
 * Submission origin (Q12 dual-actor + FR-005 + N1 remediation 2026-04-29).
 * - member_self_service: default — member composes + clicks Submit themselves
 * - admin_proxy: admin uses /admin/broadcasts/proxy-submit on member's behalf
 *                (member's quota is consumed; admin user_id is recorded for audit)
 * - system: auto-cancel cascade from F3 archival/erasure (T178a) + future
 *           system-initiated state mutations (e.g., complaint-rate auto-halt,
 *           scheduled-send cron transitions). Migration 0072 adds via
 *           `ALTER TYPE ... ADD VALUE IF NOT EXISTS 'system';`.
 */
export const broadcastActorRoleEnum = pgEnum('broadcast_actor_role', [
  'member_self_service',
  'admin_proxy',
  'system',
]);

/**
 * Resend webhook event taxonomy (FR-024 + FR-027).
 * - sent: email.sent — Resend accepted from us
 * - delivered: email.delivered — recipient mailbox accepted
 * - bounced: email.bounced — hard bounce (auto-suppression cascade)
 * - soft_bounced: email.delivery_delayed — Resend retries internally
 * - complained: email.complained — recipient marked as spam
 *               (auto-suppression cascade; SC-005 (b) per-broadcast >5%
 *                rate triggers complaint_rate_per_broadcast_breach + auto-halt)
 */
export const broadcastDeliveryStatusEnum = pgEnum('broadcast_delivery_status', [
  'sent',
  'delivered',
  'bounced',
  'soft_bounced',
  'complained',
]);

/**
 * Suppression reason taxonomy (FR-018 + FR-027 + FR-029).
 * - recipient_initiated: public unsubscribe page click (one-click HMAC token)
 * - hard_bounce: auto-suppressed on Resend hard bounce delivery event
 * - complaint: auto-suppressed on Resend complaint delivery event
 * - admin_added: deferred to F7.1; included in MVP enum for forward-compat
 */
export const marketingUnsubscribeReasonEnum = pgEnum(
  'marketing_unsubscribe_reason',
  ['recipient_initiated', 'hard_bounce', 'complaint', 'admin_added'],
);

// ---------------------------------------------------------------------------
// 1. broadcasts
// ---------------------------------------------------------------------------

/**
 * One row per E-Blast request across its full lifecycle (data-model § 1.1).
 *
 * Composite PK (tenant_id, broadcast_id) matching F3+F4 convention.
 * Content fields (subject, bodyHtml, segmentType, etc.) are immutable
 * after submit per Q3 — enforced by `broadcasts_immutable_after_submit_fn`
 * trigger (data-model § 4.1) at DB + Application-layer `submit-broadcast.ts`
 * use case.
 */
export const broadcasts = pgTable(
  'broadcasts',
  {
    tenantId: text('tenant_id').notNull(),
    broadcastId: uuid('broadcast_id').defaultRandom().notNull(),

    // Originator (FR-005 + Q12 dual-actor)
    requestedByMemberId: uuid('requested_by_member_id').notNull(),
    requestedByMemberPlanIdSnapshot: uuid(
      'requested_by_member_plan_id_snapshot',
    ).notNull(),
    submittedByUserId: uuid('submitted_by_user_id').notNull(),
    actorRole: broadcastActorRoleEnum('actor_role').notNull(),

    // Content (Q3 immutable after submit; Q4 sanitised at Application layer)
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),
    bodySource: text('body_source').notNull(),
    fromName: text('from_name').notNull(),
    replyToEmail: text('reply_to_email').notNull(),

    // Recipient targeting (FR-015–FR-017 + FR-016a + Q7 + Q8)
    segmentType: broadcastSegmentTypeEnum('segment_type').notNull(),
    segmentParams: jsonb('segment_params'),
    customRecipientEmails: text('custom_recipient_emails').array(),
    estimatedRecipientCount: integer('estimated_recipient_count').notNull(),

    // Lifecycle (FR-004 + FR-004a state machine)
    status: broadcastStatusEnum('status').notNull().default('draft'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedByUserId: uuid('approved_by_user_id'),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectedByUserId: uuid('rejected_by_user_id'),
    rejectionReason: text('rejection_reason'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    sendingStartedAt: timestamp('sending_started_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledByUserId: uuid('cancelled_by_user_id'),
    cancellationReason: text('cancellation_reason'),
    failedToDispatchAt: timestamp('failed_to_dispatch_at', {
      withTimezone: true,
    }),
    failureReason: text('failure_reason'),

    // Quota accounting (FR-003 + FR-006 + FR-007)
    quotaYearConsumed: integer('quota_year_consumed'),
    quotaConsumedAt: timestamp('quota_consumed_at', { withTimezone: true }),

    // Resend integration
    resendAudienceId: text('resend_audience_id'),
    resendBroadcastId: text('resend_broadcast_id'),

    // Audit retention (Constitution v1.4.0 retention column)
    retentionYears: smallint('retention_years').notNull().default(5),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'broadcasts_pkey',
      columns: [table.tenantId, table.broadcastId],
    }),

    // FR-002f: subject ≤ 200 chars
    check(
      'broadcasts_subject_length',
      sql`char_length(${table.subject}) BETWEEN 1 AND 200`,
    ),

    // FR-002f: body ≤ 200 KB rendered HTML (octet_length is byte count)
    check(
      'broadcasts_body_html_size',
      sql`octet_length(${table.bodyHtml}) BETWEEN 1 AND 200 * 1024`,
    ),

    // FR-016a: custom recipient cap at row level
    check(
      'broadcasts_custom_recipient_cap',
      sql`(segment_type != 'custom' AND custom_recipient_emails IS NULL)
       OR (segment_type = 'custom' AND array_length(custom_recipient_emails, 1) BETWEEN 1 AND 100)`,
    ),

    // FR-016a: estimated_recipient_count ≤ 5000
    check(
      'broadcasts_estimated_recipient_cap',
      sql`${table.estimatedRecipientCount} BETWEEN 0 AND 5000`,
    ),

    // FR-007: quota_year_consumed only set on `sent`
    check(
      'broadcasts_quota_year_only_on_sent',
      sql`(status = 'sent' AND quota_year_consumed IS NOT NULL AND quota_consumed_at IS NOT NULL)
       OR (status != 'sent' AND quota_year_consumed IS NULL AND quota_consumed_at IS NULL)`,
    ),

    // Constitution v1.4.0: retention default 5y for non-tax-document events
    check(
      'broadcasts_retention_years',
      sql`${table.retentionYears} IN (5, 10)`,
    ),

    // Indexes
    index('broadcasts_tenant_status_member_idx').on(
      table.tenantId,
      table.status,
      table.requestedByMemberId,
    ),
    index('broadcasts_tenant_submitted_at_idx')
      .on(table.tenantId, table.submittedAt.desc())
      .where(sql`status = 'submitted'`),
    index('broadcasts_tenant_scheduled_idx')
      .on(table.tenantId, table.scheduledFor)
      .where(sql`status = 'approved' AND scheduled_for IS NOT NULL`),
    uniqueIndex('broadcasts_resend_broadcast_id_uniq')
      .on(table.resendBroadcastId)
      .where(sql`resend_broadcast_id IS NOT NULL`),
  ],
);

export type BroadcastRow = typeof broadcasts.$inferSelect;
export type NewBroadcastRow = typeof broadcasts.$inferInsert;

// ---------------------------------------------------------------------------
// 2. broadcast_deliveries
// ---------------------------------------------------------------------------

/**
 * One row per Resend delivery event (per recipient × per broadcast).
 * Insert-only; never updated. Idempotency via UNIQUE
 * (tenant_id, resend_event_id) — FR-025 webhook replay safety.
 *
 * Retention: 5y matching F7 audit-event default (data-model § 1.2).
 * On member-erasure (Art. 17), `recipient_member_id` is set to NULL but
 * the row is retained for record-of-processing per PDPA §39 +
 * GDPR Art. 30.
 */
export const broadcastDeliveries = pgTable(
  'broadcast_deliveries',
  {
    tenantId: text('tenant_id').notNull(),
    deliveryId: uuid('delivery_id').defaultRandom().notNull(),

    broadcastId: uuid('broadcast_id').notNull(),
    resendEventId: text('resend_event_id').notNull(),
    resendMessageId: text('resend_message_id').notNull(),

    recipientEmailLower: text('recipient_email_lower').notNull(),
    recipientMemberId: uuid('recipient_member_id'),
    recipientMemberLookupAttemptedAt: timestamp(
      'recipient_member_lookup_attempted_at',
      { withTimezone: true },
    ),

    status: broadcastDeliveryStatusEnum('status').notNull(),
    eventTimestamp: timestamp('event_timestamp', {
      withTimezone: true,
    }).notNull(),
    errorMessage: text('error_message'),
    bounceType: text('bounce_type'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'broadcast_deliveries_pkey',
      columns: [table.tenantId, table.deliveryId],
    }),

    // FR-025: webhook idempotency primitive
    uniqueIndex('broadcast_deliveries_resend_event_id_uniq').on(
      table.tenantId,
      table.resendEventId,
    ),

    // Per-broadcast aggregation index
    index('broadcast_deliveries_broadcast_status_idx').on(
      table.tenantId,
      table.broadcastId,
      table.status,
    ),

    // Recipient lookup for member detail timeline
    index('broadcast_deliveries_recipient_lookup_idx').on(
      table.tenantId,
      table.recipientEmailLower,
    ),
  ],
);

export type BroadcastDeliveryRow = typeof broadcastDeliveries.$inferSelect;
export type NewBroadcastDeliveryRow = typeof broadcastDeliveries.$inferInsert;

// ---------------------------------------------------------------------------
// 3. marketing_unsubscribes
// ---------------------------------------------------------------------------

/**
 * Tenant-scoped suppression list. Natural composite PK
 * (tenant_id, email_lower) — FR-018 + Q8 invariant.
 *
 * Retention: indefinite per GDPR Art. 21 + PDPA §32. Rows are NEVER
 * deleted on member-erasure (Art. 17): `member_id` is set to NULL but
 * the suppression record is retained — preserves the regulatory
 * invariant "we will not contact this email again" while honouring
 * the member's erasure right for member-side PII.
 */
export const marketingUnsubscribes = pgTable(
  'marketing_unsubscribes',
  {
    tenantId: text('tenant_id').notNull(),
    emailLower: text('email_lower').notNull(),
    memberId: uuid('member_id'),

    reason: marketingUnsubscribeReasonEnum('reason').notNull(),
    reasonText: text('reason_text'),
    sourceBroadcastId: uuid('source_broadcast_id'),
    sourceTokenHash: text('source_token_hash'),

    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'marketing_unsubscribes_pkey',
      columns: [table.tenantId, table.emailLower],
    }),

    // Member-side lookup ("show me everyone who unsubscribed from my plan-tier broadcasts")
    index('marketing_unsubscribes_member_lookup_idx')
      .on(table.tenantId, table.memberId)
      .where(sql`member_id IS NOT NULL`),

    // Time-series query for ops dashboard
    index('marketing_unsubscribes_unsubscribed_at_idx').on(
      table.tenantId,
      table.unsubscribedAt.desc(),
    ),
  ],
);

export type MarketingUnsubscribeRow =
  typeof marketingUnsubscribes.$inferSelect;
export type NewMarketingUnsubscribeRow =
  typeof marketingUnsubscribes.$inferInsert;

// ---------------------------------------------------------------------------
// 4. broadcast_segment_definitions
// ---------------------------------------------------------------------------

/**
 * Read-model snapshot of segment configurations (data-model § 1.4).
 * Mostly populated by seed migration 0068; admins MAY add custom-named
 * segments in F7.1.
 */
export const broadcastSegmentDefinitions = pgTable(
  'broadcast_segment_definitions',
  {
    tenantId: text('tenant_id').notNull(),
    definitionId: uuid('definition_id').defaultRandom().notNull(),
    segmentType: broadcastSegmentTypeEnum('segment_type').notNull(),
    displayLabelI18nKey: text('display_label_i18n_key').notNull(),
    params: jsonb('params'),

    enabled: boolean('enabled').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'broadcast_segment_definitions_pkey',
      columns: [table.tenantId, table.definitionId],
    }),
    index('broadcast_segment_defs_tenant_type_idx').on(
      table.tenantId,
      table.segmentType,
    ),
  ],
);

export type BroadcastSegmentDefinitionRow =
  typeof broadcastSegmentDefinitions.$inferSelect;
export type NewBroadcastSegmentDefinitionRow =
  typeof broadcastSegmentDefinitions.$inferInsert;
