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
  // F7.1a US1 (FR-008a/b) — added 2026-05-19 via migration 0169.
  // `partially_sent` is non-terminal (admin can retry up to 3 times,
  // see broadcasts.manual_retry_count CHECK 0..3); reachable from
  // `sending` when ≥1 batch reached terminal failed state after
  // exhausting per-batch retry budget.
  // `partial_delivery_accepted` is TERMINAL — entered when admin
  // clicks "Accept partial delivery" on a `partially_sent` broadcast;
  // sets broadcasts.partial_delivery_accepted_at + _by_user_id.
  'partially_sent',
  'partial_delivery_accepted',
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
    // TEXT (not uuid) — see migration 0074. F2 plan identity is the
    // composite (tenant_id, plan_id, plan_year) and `plan_id` is a TEXT
    // plan-code string ('corporate', 'regular'), not a uuid surrogate.
    requestedByMemberPlanIdSnapshot: text(
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

    // F7.1a US1 (FR-008a) — admin manual-retry budget per broadcast
    // (max 3 retries; CHECK enforced below). Default 0 for existing
    // and new F7 MVP rows alike.
    manualRetryCount: integer('manual_retry_count').notNull().default(0),

    // F7.1a US1 (FR-008c) — admin "Accept partial delivery" action
    // transitions a `partially_sent` broadcast to terminal without
    // further retry. NULL until accepted.
    partialDeliveryAcceptedAt: timestamp('partial_delivery_accepted_at', {
      withTimezone: true,
    }),
    partialDeliveryAcceptedByUserId: uuid('partial_delivery_accepted_by_user_id'),

    // F7.1a US7 (FR-022) — denormalised template provenance. The FK
    // SET NULL behaviour preserves the broadcast row when the source
    // template is deleted; the snapshot column retains the template
    // name for forensic audit (FR-023 / critique P9).
    startedFromTemplateId: uuid('started_from_template_id').references(
      () => broadcastTemplates.id,
      { onDelete: 'set null' },
    ),
    templateNameSnapshot: text('template_name_snapshot'),

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

    // F7.1a US1 (FR-008a) — admin manual-retry budget capped at 3 per broadcast
    check(
      'broadcasts_manual_retry_count_check',
      sql`${table.manualRetryCount} BETWEEN 0 AND 3`,
    ),

    // Indexes
    index('broadcasts_tenant_status_member_idx').on(
      table.tenantId,
      table.status,
      table.requestedByMemberId,
    ),
    // F7 US3 G2 — covering index for `listForMemberPaginated` (member
    // benefits page history table). Match the query shape exactly so
    // OFFSET pagination is O(perPage) regardless of tenant size.
    // Migration 0077.
    index('broadcasts_tenant_member_created_at_idx').on(
      table.tenantId,
      table.requestedByMemberId,
      table.createdAt.desc(),
      table.broadcastId.desc(),
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

// ---------------------------------------------------------------------------
// F7.1a (014-email-broadcast-advance) — 4 new tables + broadcasts extensions.
// Migrations: 0127–0134. See specs/014-email-broadcast-advance/data-model.md.
//
// IMPORTANT DEVIATIONS from data-model.md (documented in plan.md
// § Discoveries from exploration):
//   1. tenant_id is TEXT (matches F7 MVP convention above, F4, F3).
//      data-model.md § 2.2-2.4 incorrectly typed as uuid; we override.
//   2. broadcasts.broadcast_id is the surrogate (composite PK
//      `(tenant_id, broadcast_id)`), NOT `broadcasts.id`. data-model.md
//      § 2.2 mentioned `broadcasts.id` — that column does not exist.
//      The startedFromTemplateId FK references broadcastTemplates.id
//      directly (single-column PK on the templates table); RLS enforces
//      tenant isolation between broadcast and template rows.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. broadcast_templates (NEW — F7.1a US7, FR-020 / data-model § 2.4)
// ---------------------------------------------------------------------------

/**
 * Admin-authored template library, seeded with 5 starter templates ×
 * 3 locales = 15 rows per tenant at F7.1a ship (`0134_default_template_seed`).
 *
 * Locale semantics (data-model § 2.4): represents CONTENT locale (the
 * language the body is written in), NOT send locale. Cross-locale
 * authoring is permitted (Clarifications round 3 Q3).
 *
 * Soft-delete (`deletedAt`): preserves the audit trail FR-023 expects
 * the count of drafts that started-from a deleted template, so the row
 * must remain queryable after admin deletion.
 *
 * Single-column PK (`id`) — tenant isolation enforced by RLS+FORCE
 * (migration 0132) and the tenant+name+locale unique index.
 */
export const broadcastTemplates = pgTable(
  'broadcast_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),
    locale: text('locale', { enum: ['en', 'th', 'sv'] })
      .notNull()
      .default('en'),
    startedFromCount: integer('started_from_count').notNull().default(0),
    isSeeded: boolean('is_seeded').notNull().default(false),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('broadcast_templates_tenant_name_locale_uniq').on(
      table.tenantId,
      table.name,
      table.locale,
    ),
    check(
      'broadcast_templates_name_length_check',
      sql`length(${table.name}) > 0 AND length(${table.name}) <= 100`,
    ),
    check(
      'broadcast_templates_subject_length_check',
      sql`length(${table.subject}) > 0 AND length(${table.subject}) <= 200`,
    ),
    check(
      'broadcast_templates_body_length_check',
      sql`length(${table.bodyHtml}) <= 204800`,
    ),
    // Picker MRU + locale-cascade filter (Phase 5 T103)
    index('broadcast_templates_tenant_locale_updated_idx')
      .on(table.tenantId, table.locale, table.updatedAt.desc())
      .where(sql`deleted_at IS NULL`),
  ],
);

export type BroadcastTemplateRow = typeof broadcastTemplates.$inferSelect;
export type NewBroadcastTemplateRow = typeof broadcastTemplates.$inferInsert;

// ---------------------------------------------------------------------------
// 6. broadcast_batch_manifests (NEW — F7.1a US1, FR-002 / data-model § 2.2)
// ---------------------------------------------------------------------------

/**
 * One row per dispatch batch under a broadcast row. F7.1a US1 splits
 * broadcasts of >10k recipients (Resend per-audience cap) into N
 * parallel batches with concurrency cap 4. Each batch carries its own
 * provider audience id + idempotency key + per-batch delivery counters.
 *
 * Composite FK `(tenant_id, broadcast_id) → broadcasts(tenant_id, broadcast_id)`
 * matches F7 MVP composite-PK pattern (deviation from data-model.md §
 * 2.2 which wrote `broadcasts.id`). ON DELETE CASCADE so deleting a
 * broadcast also removes its manifests (no orphans).
 *
 * `status='cancelled'` (per data-model § 2.2 N1) is set by
 * cancelBroadcast (Phase 3 T163) when an admin halts mid-dispatch per
 * FR-004 — distinct from `'failed'` (provider rejection after retries).
 */
export const broadcastBatchManifests = pgTable(
  'broadcast_batch_manifests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    broadcastId: uuid('broadcast_id').notNull(),

    batchIndex: integer('batch_index').notNull(),
    recipientCount: integer('recipient_count').notNull(),
    recipientRangeStart: integer('recipient_range_start').notNull(),
    recipientRangeEnd: integer('recipient_range_end').notNull(),

    status: text('status', {
      enum: ['pending', 'sending', 'sent', 'failed', 'cancelled'],
    })
      .notNull()
      .default('pending'),

    providerAudienceId: text('provider_audience_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    retryCount: integer('retry_count').notNull().default(0),

    deliveredCount: integer('delivered_count').notNull().default(0),
    bouncedCount: integer('bounced_count').notNull().default(0),
    complainedCount: integer('complained_count').notNull().default(0),
    unsubscribedCount: integer('unsubscribed_count').notNull().default(0),

    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('broadcast_batch_manifests_tenant_broadcast_batch_uniq').on(
      table.tenantId,
      table.broadcastId,
      table.batchIndex,
    ),
    uniqueIndex('broadcast_batch_manifests_idempotency_key_uniq').on(
      table.tenantId,
      table.idempotencyKey,
    ),
    check(
      'broadcast_batch_manifests_recipient_range_check',
      sql`${table.recipientRangeEnd} >= ${table.recipientRangeStart}`,
    ),
    check(
      'broadcast_batch_manifests_retry_count_check',
      sql`${table.retryCount} >= 0 AND ${table.retryCount} <= 5`,
    ),
    check(
      'broadcast_batch_manifests_recipient_count_check',
      sql`${table.recipientCount} <= 10000`,
    ),
    // Status scan for cron dispatch + reconcile
    index('broadcast_batch_manifests_tenant_status_idx').on(
      table.tenantId,
      table.status,
    ),
  ],
);

export type BroadcastBatchManifestRow =
  typeof broadcastBatchManifests.$inferSelect;
export type NewBroadcastBatchManifestRow =
  typeof broadcastBatchManifests.$inferInsert;

// ---------------------------------------------------------------------------
// 7. tenant_image_source_allowlist (NEW — F7.1a US2, FR-010 / data-model § 2.3)
// ---------------------------------------------------------------------------

/**
 * Per-tenant `<img src>` hostname allowlist. Body-HTML sanitiser
 * (Phase 4 T070) checks every `<img>` source hostname against this
 * table; non-matching submissions are rejected with
 * `broadcast_body_image_source_unsafe` (audit).
 *
 * Defaults (chamber asset domain + Resend CDN) are seeded per tenant by
 * migration 0130 with `is_default=TRUE`. The ImageAllowlistPort.remove
 * (Phase 2 T022 interface, Phase 4 T072 impl) rejects removal when
 * `is_default=TRUE` to preserve the platform invariant.
 *
 * Hostname format CHECK enforces RFC-1035 lowercase ASCII with no
 * wildcards (FR-010) — explicit hosts only.
 */
export const tenantImageSourceAllowlist = pgTable(
  'tenant_image_source_allowlist',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    hostname: text('hostname').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('tenant_image_source_allowlist_tenant_hostname_uniq').on(
      table.tenantId,
      table.hostname,
    ),
    check(
      'tenant_image_source_allowlist_hostname_format_check',
      sql`${table.hostname} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'`,
    ),
  ],
);

export type TenantImageSourceAllowlistRow =
  typeof tenantImageSourceAllowlist.$inferSelect;
export type NewTenantImageSourceAllowlistRow =
  typeof tenantImageSourceAllowlist.$inferInsert;

// ---------------------------------------------------------------------------
// 8. tenant_broadcast_settings (NEW per discovery — F7.1a US1 / data-model § 2.5)
// ---------------------------------------------------------------------------

/**
 * Per-tenant dispatch settings. Currently houses only the
 * `dispatch_concurrency_cap` (FR-002 — tenant-configurable in 1-8
 * range; default 4) that the BatchDispatcher (Phase 3 T046) reads.
 *
 * NOTE: data-model.md § 2.5 phrases this as "EXTEND F7 MVP" but the
 * table did NOT exist in F7 MVP (grep across src/modules/broadcasts/**
 * + drizzle/migrations/** confirms zero occurrences). F7.1a CREATES
 * the table in migration 0131 — documented in plan.md Risk R2. Future
 * F7.1b enhancements (per-tenant complaint thresholds, throttle
 * overrides, etc.) would add columns here.
 *
 * One row per tenant — `tenant_id` is the primary key.
 */
export const tenantBroadcastSettings = pgTable(
  'tenant_broadcast_settings',
  {
    tenantId: text('tenant_id').primaryKey(),
    dispatchConcurrencyCap: integer('dispatch_concurrency_cap')
      .notNull()
      .default(4),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'tenant_broadcast_settings_dispatch_concurrency_cap_check',
      sql`${table.dispatchConcurrencyCap} BETWEEN 1 AND 8`,
    ),
  ],
);

export type TenantBroadcastSettingsRow =
  typeof tenantBroadcastSettings.$inferSelect;
export type NewTenantBroadcastSettingsRow =
  typeof tenantBroadcastSettings.$inferInsert;
