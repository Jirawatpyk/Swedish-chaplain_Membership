import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * F1 Auth & RBAC schema (T022, data-model.md § 7).
 *
 * Six tables:
 *   - users                     — credential set + role + status
 *   - sessions                  — active authenticated presence
 *   - password_reset_tokens     — single-use 1h tokens
 *   - invitations               — single-use 7d tokens
 *   - audit_log                 — APPEND-ONLY compliance trail
 *   - email_delivery_events     — Resend webhook tracking (NOT audit)
 *
 * `audit_log` enforces append-only via DB grants in
 * drizzle/migrations/0001_audit_log_grants.sql (T024). The Drizzle layer
 * additionally only exposes an `append()` method on the audit repo (T067) —
 * defense in depth.
 *
 * Index strategy mirrors data-model.md § 6 (volume estimates).
 */

// --- Enums --------------------------------------------------------------------

export const roleEnum = pgEnum('role', ['admin', 'manager', 'member']);

export const userStatusEnum = pgEnum('user_status', [
  'pending',
  'active',
  'disabled',
]);

export const auditEventTypeEnum = pgEnum('audit_event_type', [
  // --- F1 identity events (17) ---
  'sign_in_success',
  'sign_in_failure',
  'sign_out',
  'password_reset_requested',
  'password_reset_completed',
  'password_reset_failed',
  'password_changed',
  'account_created',
  'account_disabled',
  'account_reenabled',
  'role_changed',
  'lockout_triggered',
  'lockout_cleared',
  'session_forcibly_ended',
  'concurrent_sessions_revoked',
  'manager_denied_write',
  'invitation_redemption_failed',
  // --- F2 plan + fee-config events (10) — added by migration 0007 ---
  'plan_created',
  'plan_updated',
  'plan_cloned',
  'plan_activated',
  'plan_deactivated',
  'plan_soft_deleted',
  'plan_undeleted',
  'plan_not_found',
  'plan_cross_tenant_probe',
  'fee_config_updated',
  // --- F3 member + contact events (23) — added by migration 0010 ---
  'member_created',
  'member_updated',
  'member_plan_changed',
  'member_primary_contact_changed',
  'member_status_changed',
  'member_archived',
  'member_undeleted',
  'contact_created',
  'contact_updated',
  'contact_removed',
  'member_self_updated',
  'member_self_update_forbidden',
  'member_cross_tenant_probe',
  'plan_bundle_changed',
  'member_contact_email_changed',
  'user_sessions_revoked',
  'email_verification_sent',
  'email_verification_consumed',
  'email_change_notification_sent_to_old_address',
  'member_email_change_reverted',
  'email_verification_resent',
  'email_dispatch_failed',
  'invitation_bounced',
  'bulk_action_rate_limit_exceeded',
  // --- Round-3 review N-I3 — added by migration 0014 ---
  'member_portal_invite_queued',
  // --- F4 invoicing events (16) — added by migration 0020 ---
  'invoice_draft_created',
  'invoice_draft_updated',
  'invoice_draft_deleted',
  'invoice_issued',
  'invoice_paid',
  'invoice_voided',
  'invoice_overdue_detected',
  'credit_note_issued',
  'tenant_invoice_settings_updated',
  'invoice_pdf_resent',
  'receipt_pdf_resent',
  'credit_note_pdf_resent',
  'invoice_pdf_regenerated',
  'invoice_cross_tenant_probe',
  'credit_note_cross_tenant_probe',
  'tenant_invoice_settings_cross_tenant_probe',
  'pdf_render_failed',
  'auto_email_delivery_failed',
  // --- Hybrid A+B duplicate-email handling — added by migration 0032 ---
  'contact_linked_to_user',
  // --- F3 R4 verify-fix Types-#6 (2026-05-02) — preferred_locale write
  //     path emits this audit event (admin + member-self routes). ---
  'member_preferred_locale_changed',
  // --- F5 online-payment events (16) — added by migration 0040 ---
  'payment_initiated',
  'payment_succeeded',
  'payment_failed',
  'payment_canceled',
  'payment_method_switched',
  'payment_auto_refunded_stale_invoice',
  'payment_auto_refunded_concurrent_manual_mark',
  'payment_environment_mismatch',
  'payment_cross_tenant_probe',
  'refund_initiated',
  'refund_succeeded',
  'refund_failed',
  'out_of_band_refund_detected',
  'webhook_signature_rejected',
  'webhook_api_version_mismatch',
  'tenant_payment_settings_updated',
  'online_payment_toggled',
  // --- F5 rate-limit event types added by migration 0043 ---
  'payment_initiate_rate_limited',
  'payment_cancel_rate_limited',
  // --- F5 webhook ops-visibility event types added by migration 0046 ---
  // (audit 2026-04-25 findings #10 + #13)
  'webhook_unknown_intent',
  'webhook_payment_already_canceled',
  // --- F5 confirm-step retrieve-failure trail added by migration 0047 ---
  //     (Review I-14 — F5 Phase 3 R3 closeout)
  'payment_processor_retrieve_failed',
  // --- F5 confirm-step invoice_not_found trail added by migration 0048 ---
  //     (Review S5 — F5 Phase 3 R2 closeout)
  'payment_invoice_not_found',
  // --- F5 stale-pending-refund sweep added by migration 0050 (T130a) ---
  'stale_pending_refund_detected',
  // --- F5 confirm-step terminal-state ack added by migration 0052 (H-11
  //     review 2026-04-27) — emitted on illegal_transition and
  //     invariant_violation_duplicate_succeeded ack paths instead of
  //     reusing payment_processor_retrieve_failed. ---
  'payment_acknowledged_terminal_state',
  // --- F5 chargeback path added by migration 0053 (R2 C-1 — 2026-04-27).
  //     Emitted by processWebhookEvent on `charge.dispute.created`. ---
  'dispute_created',
  // --- T166 async receipt PDF added by migration 0057 (F5 Phase 9 polish). ---
  //     `receipt_rendered` fires from the worker once bytes land + status
  //     flips to 'rendered' (10y retention, tax-doc-touching).
  //     `pdf_render_permanently_failed` fires from reconcile cron when a
  //     row exhausts its retry budget (5y retention, ops event).
  'receipt_rendered',
  'pdf_render_permanently_failed',
  // --- F8 Phase 2 Wave C T029a (migration 0095) — Wave B carry-overs.
  //     `member_plan_manually_changed` is F3's specific-vs-generic
  //     event for the F8 supersede listener; the four `plan_change_*`
  //     events drive the F2 scheduled-plan-change lifecycle audit
  //     trail (Wave B G1 verify-run remediation). ---
  'member_plan_manually_changed',
  'plan_change_scheduled',
  'plan_change_superseded',
  'plan_change_cancelled',
  'plan_change_applied',
  // --- F8 Phase 5 Wave K24 (migration 0110) — `renewal_lapsed` finally
  //     wired by `lapseCyclesOnGraceExpiry` use-case (T115a deferred-to-
  //     Phase-5 branch). Catalogue entry existed at Phase 1 setup but
  //     the pgEnum ADD VALUE was never shipped — K24 closes the gap. ---
  'renewal_lapsed',
  // --- F8 Phase 6 Wave F (migration 0111) — 6 at-risk events for
  //     User Story 4 (At-Risk Member Detection). Emit sites: T154
  //     compute-at-risk-score, T155 snooze-at-risk-member, T156
  //     record-at-risk-outreach, T161 at-risk-recompute per-tenant
  //     route. Spec FR-029 + FR-031 + FR-032 + FR-033 + FR-035. ---
  'at_risk_score_recomputed',
  'at_risk_score_threshold_crossed',
  'at_risk_snoozed',
  'at_risk_outreach_recorded',
  'at_risk_skipped_below_min_tenure',
  'at_risk_compute_partial_failure',
  // --- F8 Phase 7 (migration 0116) — 11 tier-upgrade events for
  //     User Story 5 (Auto Tier-Upgrade Suggestions). Emit sites:
  //     T179 evaluate-tier-upgrade (cron) · T180 accept · T181 dismiss ·
  //     T183 apply-pending (F4 invoice-paid hook) · T184 supersede
  //     listener · T185 reconcile-pending-applications. Spec FR-037..
  //     FR-042 + research.md R7 pending lifecycle. ---
  'tier_upgrade_suggested',
  'tier_upgrade_accepted',
  'tier_upgrade_pending_member_notified',
  'tier_upgrade_pending_admin_verification_due',
  'tier_upgrade_applied_at_renewal',
  'tier_upgrade_pending_superseded_by_manual_change',
  'tier_upgrade_dismissed',
  'tier_upgrade_already_at_target',
  'tier_upgrade_tenant_disabled',
  'tier_upgrade_skipped_no_thresholds_configured',
  'tier_upgrade_pending_orphan_detected',
  // --- F8 Phase 7 T188a (migration 0118) — renewal-schedule rescheduled
  //     audit emitted by `rescheduleOnPlanChangeInTx` when an F2 manual
  //     plan-change shifts the member's tier-bucket and the not-yet-
  //     fired schedule steps change cadence. ---
  'renewal_schedule_rescheduled',
  // --- F8 Phase 7 review-fix Round 1 (migration 0119) — 3 new silent-
  //     skip audit events that close observability gaps surfaced by the
  //     /speckit.review pass. Forensic chain is now explicit when:
  //     (a) member has no primary contact email at accept time
  //         → tier_upgrade_pending_member_notify_skipped (I-ERR-1)
  //     (b) Resend retry-budget exhausted on tier-upgrade approval email
  //         → tier_upgrade_pending_member_notify_failed (I-ERR-2)
  //     (c) reschedule listener could not resolve old/new tier-bucket
  //         → renewal_schedule_reschedule_skipped (S-2-errors)
  'tier_upgrade_pending_member_notify_skipped',
  'tier_upgrade_pending_member_notify_failed',
  'renewal_schedule_reschedule_skipped',
  // --- F8 Phase 7 review-fix Round 2 (migration 0120) — 2 silent-failure
  //     closure audits surfaced by Round 2 review:
  //     IMP-6 catalogue-row-dropped (TierBucket parse failure at adapter)
  //     SUG-6 apply-post-paid-failed (F4 committed; F8 apply threw)
  'tier_upgrade_catalogue_row_dropped',
  'tier_upgrade_apply_post_invoice_paid_failed',
]);

export const emailChangeTokenTypeEnum = pgEnum('email_change_token_type', [
  'verification',
  'revert',
]);

export const notificationTypeEnum = pgEnum('notification_type', [
  'member_invitation',
  'email_verification',
  'email_change_revert',
  'email_verification_resent',
  // --- F4 migration 0023: invoice auto-email (issue / pay / void /
  // credit note + PDF resend variants). The physical column accepts
  // all F4 auto-email variants; the notification dispatcher routes
  // them via `context_data.event_type`. ---
  'invoice_auto_email',
  // --- T166 migration 0058: async receipt PDF render task. Not an
  // email — the dispatcher routes this to `renderReceiptPdf` use-case
  // under `runInTenant(payload.tenantId)`. Worker idempotency lives
  // in the use-case (`receipt_pdf_status='pending'` guard). ---
  'receipt_pdf_render',
  // --- F7 migration 0073 (US2): admin-review lifecycle notifications.
  // Enum values exist in Postgres but no use-case enqueues them in MVP
  // (admin-review currently emits AUDIT only — no member email yet).
  // Listed here to keep the TS union in parity with pg_enum. ---
  'broadcast_approved_notification',
  'broadcast_rejected_notification',
  'broadcast_cancelled_notification',
  // --- F7 migration 0079 (US5): delivery summary email at sending →
  // sent transition (webhook + 24h reconcile). Enqueued by
  // `enqueueDeliverySummaryEmail`; rendered by F4 dispatcher's
  // `broadcast_delivered_notification` branch. ---
  'broadcast_delivered_notification',
  // --- F7 migration 0080 (US6 / Phase 8): dispatch-failure transactional
  // email enqueued from `enqueueDispatchFailureNotification` when the
  // 1-hour retry budget is exhausted OR a permanent failure transitions
  // the broadcast to `failed_to_dispatch` (FR-021 / AS2). ---
  'broadcast_failed_to_dispatch_notification',
]);

export const outboxStatusEnum = pgEnum('outbox_status', [
  'pending',
  'sent',
  'permanently_failed',
]);

export const emailDeliveryEventTypeEnum = pgEnum('email_delivery_event_type', [
  'sent',
  'delivered',
  'delivery_delayed',
  'bounced',
  'complained',
  'opened',
  'clicked',
]);

// --- users --------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    role: roleEnum('role').notNull(),
    status: userStatusEnum('status').notNull().default('pending'),
    // password_hash is NULL while status = 'pending' (account not yet redeemed)
    passwordHash: text('password_hash'),
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
    lastPasswordChangedAt: timestamp('last_password_changed_at', {
      withTimezone: true,
    }),
    failedSignInCount: integer('failed_signin_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    // F3 US3.b.2 — sign-in is refused when email_verified = false. Flipped
    // to false by the change-contact-email atomic txn (FR-012a) and back
    // to true when the verification endpoint consumes the 24h token
    // (US3.b.3). Default TRUE so existing F1 rows remain sign-in-able.
    emailVerified: boolean('email_verified').notNull().default(true),
    // F3 US3.b.3 — flipped to TRUE by the revert-contact-email use case
    // (FR-012b). F1 sign-in refuses while TRUE; the reset-password flow
    // flips it back to FALSE on successful password change.
    requiresPasswordReset: boolean('requires_password_reset')
      .notNull()
      .default(false),
  },
  (table) => [
    // Case-insensitive uniqueness on email (spec FR-001 / Q2)
    uniqueIndex('users_email_lower_unique').on(sql`lower(${table.email})`),
    // Composite index for the "at-least-one-active-admin" check (FR-011)
    index('users_role_status_idx').on(table.role, table.status),
  ],
);

// --- sessions -----------------------------------------------------------------

export const sessions = pgTable(
  'sessions',
  {
    // 32-byte crypto-random hex (64 chars). Generated by session repo (T066).
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    // createdAt + 12 h (Domain ABSOLUTE_LIFETIME_MS, FR-008/Q3)
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    sourceIp: inet('source_ip').notNull(),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.userId),
    // For the (future) reaper job that deletes expired sessions
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

// --- password_reset_tokens ----------------------------------------------------

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // createdAt + 1 h (FR-005, Q3)
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [index('password_reset_tokens_user_id_idx').on(table.userId)],
);

// --- invitations --------------------------------------------------------------

export const invitations = pgTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      // RESTRICT — cannot delete an admin while their unredeemed invites exist
      .references(() => users.id, { onDelete: 'restrict' }),
    intendedRole: roleEnum('intended_role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // createdAt + 7 days (FR-009, Q3)
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [index('invitations_user_id_idx').on(table.userId)],
);

// --- audit_log (APPEND-ONLY — see migration 0001) -----------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    eventType: auditEventTypeEnum('event_type').notNull(),
    // UUID, 'anonymous', or 'system:bootstrap' — string column instead of FK
    // because actor may not be a real user (failed sign-in for unknown email).
    actorUserId: text('actor_user_id').notNull(),
    targetUserId: uuid('target_user_id'),
    sourceIp: inet('source_ip'),
    // ≤ 500 chars — enforced at the application layer (audit-repo append).
    summary: text('summary').notNull(),
    requestId: text('request_id').notNull(),
    // F2 extensions (added by migration 0007, nullable for F1 row compat):
    //   - `payload` — typed JSONB diff for plan_* / fee_config_updated events.
    //     F1 rows remain NULL. Validated via auditPayloadSchema before insert.
    //   - `tenantId` — scopes F2 plan events to their originating tenant slug.
    //     F1 identity events stay NULL (cross-tenant visibility preserved by
    //     the permissive RLS policy on audit_log).
    payload: jsonb('payload'),
    tenantId: text('tenant_id'),
  },
  (table) => [
    index('audit_log_timestamp_idx').on(sql`${table.timestamp} DESC`),
    index('audit_log_actor_idx').on(table.actorUserId),
    index('audit_log_target_idx').on(table.targetUserId),
    index('audit_log_event_type_idx').on(table.eventType),
    // F2: speeds up tenant-scoped audit queries + RLS policy hit
    index('audit_log_tenant_id_idx').on(table.tenantId),
  ],
);

// --- email_delivery_events (operational, NOT compliance audit) ---------------

export const emailDeliveryEvents = pgTable(
  'email_delivery_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    eventType: emailDeliveryEventTypeEnum('event_type').notNull(),
    // Resend message ID — correlation key, unique per outbound email
    messageId: text('message_id').notNull(),
    // Recipient email, lower-cased
    toEmail: text('to_email').notNull(),
    // Svix de-dup ID — UNIQUE so duplicate webhook deliveries are idempotent
    svixId: text('svix_id').notNull(),
    relatedTokenId: text('related_token_id'),
    relatedUserId: uuid('related_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // F8 Phase 4 Wave I4 (migration 0106) — Resend's bounce.type field
    // ('permanent' | 'transient'). NULL on non-bounced events. F8's
    // BounceEventQuery adapter (FR-012a threshold computation) reads
    // this column. TEXT (not enum) for forward compatibility.
    bounceType: text('bounce_type'),
  },
  (table) => [
    index('email_delivery_events_message_id_idx').on(table.messageId),
    uniqueIndex('email_delivery_events_svix_unique').on(table.svixId),
    index('email_delivery_events_to_email_idx').on(table.toEmail),
    index('email_delivery_events_created_at_idx').on(sql`${table.createdAt} DESC`),
  ],
);

// --- email_change_tokens (F3 US3.b.2 — FR-012a dual-token flow) --------------

/**
 * Single-use tokens issued by the FR-012a atomic contact-email-change
 * transaction. Two types:
 *   - `verification` — sent to the NEW address. Consumption flips
 *     `users.email_verified` back to TRUE. 24-hour lifetime. Honours a
 *     5-minute activation delay from issuance (spec § FR-012a) —
 *     consumption endpoints reject `now() < activated_at`.
 *   - `revert` — sent to the OLD address. Consumption atomically rolls
 *     back the email change and flags the user for a password reset
 *     (FR-012b, US3.b.3). 48-hour lifetime. Activated immediately.
 *
 * The `id` column stores the sha256 hex digest of the token value;
 * the plaintext lives only in the email body. Consumption endpoints
 * hash the presented token and look up by id — same shape as F1
 * password_reset_tokens.
 */
export const emailChangeTokens = pgTable(
  'email_change_tokens',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: emailChangeTokenTypeEnum('type').notNull(),
    oldEmail: text('old_email').notNull(),
    newEmail: text('new_email').notNull(),
    activatedAt: timestamp('activated_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('email_change_tokens_user_idx').on(table.userId),
    // Partial index matches the migration's active-token scan
    index('email_change_tokens_active_idx')
      .on(table.userId, table.type)
      .where(sql`consumed_at IS NULL`),
  ],
);

// --- notifications_outbox (F3 migration 0011 — after-commit email dispatch) ---

/**
 * Transactional outbox for email sends. Written inside the domain
 * transaction; drained by a Vercel Cron (every 60s) that dispatches
 * via Resend and flips status. Covers F3 notification types today
 * (member_invitation, email_verification, email_change_revert,
 * email_verification_resent); future auth flows (password-reset)
 * may migrate here — that's why the table lives in the auth-shared
 * schema file rather than members.
 *
 * Retry policy (spec § Security 4.2): up to 5 attempts with
 * exponential backoff. On attempt 5 failure, status flips to
 * `permanently_failed` and an `email_dispatch_failed` audit event
 * is emitted. Admin can trigger a fresh token + new row via the
 * "Re-send verification" action (FR-012c).
 *
 * `tenantId` is NOT NULL since migration 0098 (F8 Phase 10A) — that
 * migration deleted ~10 pre-launch orphan rows, set the column NOT
 * NULL, and enabled FORCE RLS with a `tenant_id = current_setting(...)`
 * policy. Every auth flow (F1 invitation, password-reset) now passes
 * the inviter / requester chamber slug so the row is both visible to
 * the per-tenant dispatcher and accountable to the inviter's tenant.
 */
export const notificationsOutbox = pgTable(
  'notifications_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    notificationType: notificationTypeEnum('notification_type').notNull(),
    toEmail: text('to_email').notNull(),
    locale: text('locale').notNull(),
    contextData: jsonb('context_data').notNull(),
    status: outboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text('last_error'),
    sentMessageId: text('sent_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Dispatcher drain query: pending + ready-to-retry, ordered by next_retry_at.
    index('outbox_dispatch_idx').on(table.status, table.nextRetryAt),
    // Tenant-scoped operational queries + RLS policy hit.
    index('outbox_tenant_idx').on(table.tenantId),
    // OutboxHealthBadge permanent-failed lookup — see migration 0018.
    // Partial index (WHERE status='permanently_failed') keeps it small.
    index('outbox_permanent_updated_idx')
      .on(table.updatedAt)
      .where(sql`${table.status} = 'permanently_failed'`),
  ],
);

// --- Inferred types (for repo translators in src/modules/auth/infrastructure/db/*-repo.ts) ---

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
export type PasswordResetTokenInsert = typeof passwordResetTokens.$inferInsert;
export type InvitationRow = typeof invitations.$inferSelect;
export type InvitationInsert = typeof invitations.$inferInsert;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;
export type EmailDeliveryEventRow = typeof emailDeliveryEvents.$inferSelect;
export type EmailDeliveryEventInsert = typeof emailDeliveryEvents.$inferInsert;
export type NotificationsOutboxRow = typeof notificationsOutbox.$inferSelect;
export type NotificationsOutboxInsert = typeof notificationsOutbox.$inferInsert;
export type EmailChangeTokenRow = typeof emailChangeTokens.$inferSelect;
export type EmailChangeTokenInsert = typeof emailChangeTokens.$inferInsert;
