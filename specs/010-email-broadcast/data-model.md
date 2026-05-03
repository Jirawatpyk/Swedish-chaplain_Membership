# F7 Email Broadcast — Phase 1 Data Model

**Branch**: `010-email-broadcast` | **Date**: 2026-04-29 | **Status**: Complete

This document specifies the F7 database schema (Drizzle ORM + Postgres), the state machine, RLS policies, indexes, audit-grant rows, and the validation rules sourced from spec.md FRs.

Migrations: **0064–0071** (numbered after F5's last `0063_audit_log_extend_retention_default_trigger.sql`; the original 0064–0069 batch was extended by 0070 in Clarifications session 5 Q14 to add the per-broadcast complaint-rate auto-halt column + 0071 in Q15 to add the GDPR Art. 7 acknowledgement timestamp column — both on F3's `members` table).

---

## 1. Tables

### 1.1 `broadcasts`

One row per E-Blast request across its full lifecycle.

```ts
// src/modules/broadcasts/infrastructure/schema.ts
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

export const broadcastSegmentTypeEnum = pgEnum('broadcast_segment_type', [
  'all_members',
  'tier',
  'event_attendees_last_90d',
  'custom',
]);

export const broadcastActorRoleEnum = pgEnum('broadcast_actor_role', [
  'member_self_service',  // Q12 self-service path (default)
  'admin_proxy',           // Q12 admin-on-behalf-of-member path
  'system',                // Auto-cancel cascade from F3 archival/erasure (FR-001a/T178a — added 2026-04-29 post-/speckit.analyze N1 remediation)
]);

export const broadcasts = pgTable(
  'broadcasts',
  {
    tenantId:                text('tenant_id').notNull(),
    broadcastId:             uuid('broadcast_id').defaultRandom().notNull(),

    // Originator (FR-005 + Clarifications Q12 dual-actor)
    requestedByMemberId:     uuid('requested_by_member_id').notNull(),                    // company member id (F3)
    requestedByMemberPlanIdSnapshot: uuid('requested_by_member_plan_id_snapshot').notNull(), // F2 plan id at submit time (snapshot — not FK)
    submittedByUserId:       uuid('submitted_by_user_id').notNull(),                      // F1 user who clicked Submit (== requestedBy in self-service path; admin user in proxy path)
    actorRole:               broadcastActorRoleEnum('actor_role').notNull(),

    // Content (Clarifications Q3 immutable after submit; Q4 sanitised)
    subject:                 text('subject').notNull(),                                   // ≤200 chars (FR-002f)
    bodyHtml:                text('body_html').notNull(),                                 // ≤200 KB sanitised HTML (FR-002a)
    bodySource:              text('body_source').notNull(),                               // Tiptap JSON or markdown source (member's "raw" input; persisted for re-edit on draft)
    fromName:                text('from_name').notNull(),                                 // computed: "<member.display_name> via <tenant.display_name>"
    replyToEmail:            text('reply_to_email').notNull(),                            // = members.primary_contact_email at submit time (FR-002 precondition `j` + Q11)

    // Recipient targeting (FR-015–FR-017 + FR-016a + Q7 + Q8)
    segmentType:             broadcastSegmentTypeEnum('segment_type').notNull(),
    segmentParams:           jsonb('segment_params'),                                     // e.g., { tierCodes: ['premium','large'] } for segment_type='tier'
    customRecipientEmails:   text('custom_recipient_emails').array(),                     // segment_type='custom' only; ≤100 entries; FR-015d-validated lowercase+trim
    estimatedRecipientCount: integer('estimated_recipient_count').notNull(),              // computed at submit-time; ≤5000 cap (FR-016a)

    // Lifecycle (FR-004 + FR-004a state machine)
    status:                  broadcastStatusEnum('status').notNull().default('draft'),
    submittedAt:             timestamp('submitted_at', { withTimezone: true }),
    approvedAt:              timestamp('approved_at', { withTimezone: true }),
    approvedByUserId:        uuid('approved_by_user_id'),                                 // F1 user; set on `submitted → approved`
    rejectedAt:              timestamp('rejected_at', { withTimezone: true }),
    rejectedByUserId:        uuid('rejected_by_user_id'),
    rejectionReason:         text('rejection_reason'),                                    // raw reason; audit row stores sha256 only (FR-012)
    scheduledFor:            timestamp('scheduled_for', { withTimezone: true }),          // future-dated send (US6)
    sendingStartedAt:        timestamp('sending_started_at', { withTimezone: true }),     // set on `approved → sending`
    sentAt:                  timestamp('sent_at', { withTimezone: true }),                // set on `sending → sent`
    cancelledAt:             timestamp('cancelled_at', { withTimezone: true }),
    cancelledByUserId:       uuid('cancelled_by_user_id'),
    cancellationReason:      text('cancellation_reason'),                                 // optional ≤500 chars
    failedToDispatchAt:      timestamp('failed_to_dispatch_at', { withTimezone: true }),
    failureReason:           text('failure_reason'),                                      // Resend error code + brief description (no PII / payload)

    // Quota accounting (FR-003 + FR-006 + FR-007; reservation derived from status)
    quotaYearConsumed:       integer('quota_year_consumed'),                              // null until `sending → sent`; set to currentQuotaYear(tenantTz, sentAt) at transition
    quotaConsumedAt:         timestamp('quota_consumed_at', { withTimezone: true }),

    // Resend integration
    resendAudienceId:        text('resend_audience_id'),                                  // populated at dispatch time
    resendBroadcastId:       text('resend_broadcast_id'),                                 // populated at dispatch time; UNIQUE for webhook lookup

    // Audit retention (Constitution v1.4.0 retention column)
    retentionYears:          smallint('retention_years').notNull().default(5),

    createdAt:               timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:               timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.broadcastId] }),

    // FR-002f: subject ≤ 200 chars
    subjectLengthCheck: check('broadcasts_subject_length', sql`char_length(${table.subject}) BETWEEN 1 AND 200`),

    // FR-002f: body ≤ 200 KB rendered HTML (octet_length is byte count)
    bodyHtmlSizeCheck: check('broadcasts_body_html_size', sql`octet_length(${table.bodyHtml}) BETWEEN 1 AND 200 * 1024`),

    // FR-016a: custom recipient cap at row level
    customRecipientCapCheck: check('broadcasts_custom_recipient_cap', sql`
      (segment_type != 'custom' AND custom_recipient_emails IS NULL)
      OR (segment_type = 'custom' AND array_length(custom_recipient_emails, 1) BETWEEN 1 AND 100)
    `),

    // FR-016a: estimated_recipient_count ≤ 5000
    estimatedRecipientCapCheck: check('broadcasts_estimated_recipient_cap', sql`${table.estimatedRecipientCount} BETWEEN 0 AND 5000`),

    // Clarifications Q3: content immutable after submit (DB-level defence — see § 4.1 trigger)
    // Clarifications Q10 / FR-004a: cancellable only from submitted/approved enforced by the
    // state-machine trigger in § 4.2 (any transition out of {sending|sent|cancelled|rejected|
    // failed_to_dispatch} is blocked by the empty `allowed_targets` array in those states).
    // Both invariants are realised as PL/pgSQL triggers, NOT inline CHECK constraints, because
    // they require comparing OLD.status to NEW.status — outside of CHECK's row-local scope.

    // FR-007: quota_year_consumed only set on `sent`
    quotaYearOnlyOnSentCheck: check('broadcasts_quota_year_only_on_sent', sql`
      (status = 'sent' AND quota_year_consumed IS NOT NULL AND quota_consumed_at IS NOT NULL)
      OR (status != 'sent' AND quota_year_consumed IS NULL AND quota_consumed_at IS NULL)
    `),

    // Constitution v1.4.0: retention default 5y for non-tax-document events
    retentionYearsCheck: check('broadcasts_retention_years', sql`${table.retentionYears} IN (5, 10)`),

    // Indexes
    tenantStatusMemberIdx: index('broadcasts_tenant_status_member_idx').on(table.tenantId, table.status, table.requestedByMemberId),
    tenantSubmittedAtIdx:  index('broadcasts_tenant_submitted_at_idx').on(table.tenantId, table.submittedAt.desc()).where(sql`status = 'submitted'`),
    tenantScheduledIdx:    index('broadcasts_tenant_scheduled_idx').on(table.tenantId, table.scheduledFor).where(sql`status = 'approved' AND scheduled_for IS NOT NULL`),
    resendBroadcastIdUniq: uniqueIndex('broadcasts_resend_broadcast_id_uniq').on(table.resendBroadcastId).where(sql`resend_broadcast_id IS NOT NULL`),
  }),
);
```

### 1.2 `broadcast_deliveries`

One row per Resend delivery event (per recipient × per broadcast). Insert-only; never updated.

**Retention** (Privacy checklist CHK027): **5 years** matching the F7 audit-event default retention (FR-033 — F7 events are NOT tax-document events). At SaaS scale (~360M events/year per plan.md § Scale/Scope) the 5-year ceiling is ~1.8B rows; partition by `(tenant_id, event_timestamp)` quarterly is the F7.x scale path noted in § 8 of this document. SweCham single-tenant scale (~50k events/year × 5y = 250k rows) is trivial and does NOT require partitioning.

**Member-erasure cascade** (GDPR Art. 17 / PDPA §33 — Round 3 PDPA review M-3 fix):
- `recipient_member_id` → set to **NULL** (orphaned reference; the row is retained for regulatory record-of-processing per Art. 6(1)(c) + Art. 30).
- `recipient_email_lower` → **REPLACED** with a one-way `sha256(tenant_id ‖ ':' ‖ original_email_lower)` digest (24-hex prefix matching the audit `recipientEmailHashed` shape in `process-webhook-event.ts hashRecipient`). The plaintext email is NOT preserved post-erasure. Consequence: aggregate forensic queries (e.g. "how many bounces did this domain produce?") still work via the hash, but reverse-resolution to a real address is impossible — satisfies Art. 17 erasure while preserving Art. 30 record-keeping. The transformation is performed by the F3 `eraseMember` use-case as part of the F7 cascade adapter (separate from the F3 archival cascade in `cancel-in-flight-broadcasts-for-member.ts` which only cancels in-flight rows).
- `resend_event_id`, `status`, `event_timestamp`, `bounce_reason`, `complaint_class` → unchanged (these carry no PII and are needed for sender-reputation analytics).
- F9 implementation note: the erasure-time hash MUST use the same `(tenant_id, email_lower)` salt as the live `hashRecipient` so post-erasure rows hash-match earlier audit rows from the same recipient — without that invariant, complaint-rate dashboards lose continuity at the erasure boundary.

Lawful basis for retention post-erasure: Art. 6(1)(c) legal obligation under PDPA §39 + GDPR Art. 30 record retention.

```ts
export const broadcastDeliveryStatusEnum = pgEnum('broadcast_delivery_status', [
  'sent',          // email.sent — Resend accepted from us
  'delivered',     // email.delivered — recipient mailbox accepted
  'bounced',       // email.bounced — hard bounce
  'soft_bounced',  // email.delivery_delayed — soft bounce (retried by Resend)
  'complained',    // email.complained — recipient marked as spam
]);

export const broadcastDeliveries = pgTable(
  'broadcast_deliveries',
  {
    tenantId:           text('tenant_id').notNull(),
    deliveryId:         uuid('delivery_id').defaultRandom().notNull(),

    broadcastId:        uuid('broadcast_id').notNull(),                                 // FK to broadcasts(broadcast_id) — but composite PK so logical FK only
    resendEventId:      text('resend_event_id').notNull(),                              // Resend's webhook event id (idempotency primitive)
    resendMessageId:    text('resend_message_id').notNull(),                            // Resend's per-recipient message id

    recipientEmailLower: text('recipient_email_lower').notNull(),                        // lowercase + trim normalised (FR-026)
    recipientMemberId:  uuid('recipient_member_id'),                                    // resolved by lookup at event time; nullable for non-member recipients (custom segment)
    recipientMemberLookupAttemptedAt: timestamp('recipient_member_lookup_attempted_at', { withTimezone: true }),

    status:             broadcastDeliveryStatusEnum('status').notNull(),
    eventTimestamp:     timestamp('event_timestamp', { withTimezone: true }).notNull(), // from Resend payload
    errorMessage:       text('error_message'),                                          // populated on bounce/complaint (Resend reason code + message; no PII)
    bounceType:         text('bounce_type'),                                            // 'hard' | 'soft' (split for FR-027 routing)

    createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.deliveryId] }),

    // FR-025: webhook idempotency primitive
    resendEventIdUniq: uniqueIndex('broadcast_deliveries_resend_event_id_uniq').on(table.tenantId, table.resendEventId),

    // Per-broadcast aggregation index
    broadcastStatusIdx: index('broadcast_deliveries_broadcast_status_idx').on(table.tenantId, table.broadcastId, table.status),

    // Recipient lookup for member detail timeline
    recipientLookupIdx: index('broadcast_deliveries_recipient_lookup_idx').on(table.tenantId, table.recipientEmailLower),
  }),
);
```

### 1.3 `marketing_unsubscribes`

Tenant-scoped suppression list. Natural composite PK (FR-018 + Clarifications Q8 invariant: tenant-scoped).

**Retention** (Privacy checklist CHK026): **indefinite** per GDPR Art. 21 "right to object" + PDPA §32 — once a recipient unsubscribes, that record MUST be retained forever to honour the suppression. Rows are NOT deleted on member-erasure (Art. 17): if the underlying member is deleted, the suppression record retains the email_lower + reason + unsubscribed_at but the `member_id` foreign-key reference is set to NULL (orphaned suppression). This preserves the regulatory invariant "we will not contact this email again" while honouring the member's erasure right for member-side PII. Deletion of suppression rows is reserved for `swecham_super` ops role only (compliance-officer-driven re-subscription edge case — out of MVP UI; capability preserved for legal-counsel-mandated deletion under Art. 17 if the regulatory authority orders it).

```ts
export const marketingUnsubscribeReasonEnum = pgEnum('marketing_unsubscribe_reason', [
  'recipient_initiated',     // public unsubscribe page (FR-029)
  'hard_bounce',             // auto-suppression on Resend hard bounce (FR-027)
  'complaint',               // auto-suppression on Resend complaint (FR-027)
  'admin_added',             // future: admin can manually suppress (out of MVP — placeholder)
]);

export const marketingUnsubscribes = pgTable(
  'marketing_unsubscribes',
  {
    tenantId:        text('tenant_id').notNull(),
    emailLower:      text('email_lower').notNull(),                                     // lowercase + trim normalised
    memberId:        uuid('member_id'),                                                 // resolved by lookup at insertion; nullable for non-members

    reason:          marketingUnsubscribeReasonEnum('reason').notNull(),
    reasonText:      text('reason_text'),                                               // optional free-text from public unsubscribe page (≤500 chars)
    sourceBroadcastId: uuid('source_broadcast_id'),                                     // null for hard_bounce/complaint (those come from delivery events not broadcasts directly)
    sourceTokenHash: text('source_token_hash'),                                         // sha256(token); null for non-token sources

    unsubscribedAt:  timestamp('unsubscribed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.emailLower] }),

    // Member-side lookup for "show me everyone who unsubscribed from my plan-tier broadcasts"
    memberLookupIdx: index('marketing_unsubscribes_member_lookup_idx').on(table.tenantId, table.memberId).where(sql`member_id IS NOT NULL`),

    // Time-series query for ops dashboard
    unsubscribedAtIdx: index('marketing_unsubscribes_unsubscribed_at_idx').on(table.tenantId, table.unsubscribedAt.desc()),
  }),
);
```

### 1.3a New columns on F3 `members` table (Clarifications Q14 + Q15)

F7 adds **two new columns to F3's `members` table** (cross-feature schema extension, lands in F7 migrations):

```ts
// Extensions to src/modules/members/infrastructure/schema.ts
// Migration 0070 (Clarifications Q14, B):
broadcastsHaltedUntilAdminReview: boolean('broadcasts_halted_until_admin_review').notNull().default(false),
// Migration 0071 (Clarifications Q15, B):
broadcastsAcknowledgedAt: timestamp('broadcasts_acknowledged_at', { withTimezone: true }),
```

**Column 1 — `broadcasts_halted_until_admin_review`** (Q14, B): Set to `true` when a single broadcast triggers the per-broadcast complaint-rate breach (>5%) per SC-005 (b). Cleared by admin action (emits `broadcast_member_dispatch_resumed` audit event). FR-002 precondition `e` extended: submission requires `broadcasts_halted_until_admin_review = false` for the originating member. Manager-role users CANNOT clear the flag (admin-only; same auth pattern as approve/reject/cancel per FR-014). Migration **0070**.

**Column 2 — `broadcasts_acknowledged_at`** (Q15, B): Nullable timestamp; populated when the member dismisses the one-time portal banner ("Your tier includes marketing broadcasts from chamber members. You may unsubscribe at any time."). Emits `member_acknowledged_broadcasts_terms` audit event on first set. The column is NOT a precondition for receiving broadcasts (lawful basis remains contract performance per PDPA §24 + GDPR Art. 6(1)(b)) — it is evidence-strengthening for GDPR Art. 7 "demonstrable consent" defence. Banner appears on first member-portal sign-in post-F7-launch + on F7 benefits-page first-visit until acknowledged. Manager + admin roles do NOT see the banner (member-role only). Migration **0071**.

**Retention for `broadcasts_acknowledged_at`** (Privacy checklist CHK028): **indefinite while the member row exists** — the column is part of the `members` row and is deleted alongside the member on Art. 17 erasure. If a tenant materially changes its marketing terms (F12 white-label customisation), an admin SHOULD reset `broadcasts_acknowledged_at` to NULL via a migration or admin tool to force re-acknowledgement under the new terms (preserves the GDPR Art. 7 invariant that consent must reflect current terms). The audit-log row `member_acknowledged_broadcasts_terms` carries the original timestamp + banner_locale and is retained at **10-year** retention (migration 0084, Round 3 PDPA M-2 — promoted from the 5-year F7 default to match the indefinite-consent horizon under PDPA §35 + GDPR Art. 7 written-consent record requirement; retention is enforced at DB layer by the BEFORE-INSERT trigger in `audit_log_default_retention_for_f4_tax_docs` so raw-SQL inserts cannot silently downgrade).

### 1.4 `broadcast_segment_definitions`

Read-model snapshot of segment configurations. Used by audit + admin display ("which segment was this broadcast targeting?"). Mostly populated by the seed migration 0068; admins MAY add custom-named segments in F7.1.

```ts
export const broadcastSegmentDefinitions = pgTable(
  'broadcast_segment_definitions',
  {
    tenantId:           text('tenant_id').notNull(),
    definitionId:       uuid('definition_id').defaultRandom().notNull(),
    segmentType:        broadcastSegmentTypeEnum('segment_type').notNull(),
    displayLabelI18nKey: text('display_label_i18n_key').notNull(),                    // e.g., 'broadcasts.segment.allMembers' resolves at render time
    params:             jsonb('params'),                                              // e.g., { tierCodes: ['premium'] } for prebuilt tier segments

    // Default presets seeded by 0068; tenants MAY hide via this flag without deleting
    enabled:            boolean('enabled').notNull().default(true),

    createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:          timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.definitionId] }),
    tenantTypeIdx: index('broadcast_segment_defs_tenant_type_idx').on(table.tenantId, table.segmentType),
  }),
);
```

---

## 2. Row-Level Security (Constitution v1.4.0 Principle I clause 2)

Every table above has `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + a single tenant-scoping policy:

```sql
-- Migrations 0064-0067 each end with:
ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcasts FORCE ROW LEVEL SECURITY;
CREATE POLICY broadcasts_tenant_isolation ON broadcasts
  USING (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));

-- Same shape for broadcast_deliveries, marketing_unsubscribes, broadcast_segment_definitions.
```

**Bypass contexts** (documented in plan.md § Complexity Tracking):

1. **Webhook signature verification** (`/api/webhooks/resend-broadcasts`): the handler runs the signature verify + idempotency upsert under `swecham_super` role until `resend_broadcast_id → broadcasts(tenant_id)` lookup resolves the tenant. Then the tx re-enters `runInTenant(ctx, ...)` for downstream writes. Narrowest possible window.
2. **Public unsubscribe page** (`/unsubscribe/[token]`): the handler runs the HMAC verify under `swecham_super` until the token payload yields `tenant_id`. Then re-enters `runInTenant(ctx, ...)`.

Both bypasses are auditable via existing `swecham_super` access logs and are scoped to the minimum set of operations.

---

## 3. State machine (FR-004 + FR-004a + Clarifications Q3 + Q10)

```
                        ┌───────────────┐
                        │     draft     │  ← FR-001 (mutable; member-private)
                        └───────────────┘
                                │
                                │ submit-broadcast (FR-002 + FR-002a + FR-015d + FR-016a)
                                │ reserves quota slot
                                ▼
                        ┌───────────────┐         reject-broadcast
                        │   submitted   │ ──────────────────────────►   ┌───────────────┐
                        └───────────────┘  (FR-012; releases reservation) │   rejected    │
                                │                                           └───────────────┘
                                │ approve-broadcast (FR-011)
                                │
                ┌───────────────┴────────────────┐
                │                                 │
        approve & send-now              approve & schedule
                │                                 │
                ▼                                 ▼
        ┌───────────────┐                 ┌───────────────┐
        │   approved    │                 │   approved    │  status=approved + scheduled_for set
        │  (immediate)  │                 │  (scheduled)  │  cron handler picks up at scheduled_for
        └───────┬───────┘                 └───────┬───────┘
                │                                 │
                │ dispatch-to-resend             │ cron-dispatch-scheduled (US6)
                │ (FR-019 + FR-020)              │
                │                                 │
                └────────────┬────────────────────┘
                             │
                             ▼
                     ┌───────────────┐
                     │    sending    │  ← cancellation cutoff (FR-004a / Q10): no more cancel from here
                     └───────────────┘
                             │
                ┌────────────┴────────────┐
                │                          │
                │ all delivery events      │ Resend dispatch failure
                │ received OR 24h timeout  │ after retry budget (FR-021/022)
                │                          │
                ▼                          ▼
        ┌───────────────┐           ┌───────────────┐
        │     sent      │           │ failed_to_    │
        │ (consumes     │           │   dispatch    │
        │  quota)       │           │ (releases     │
        └───────────────┘           │  reservation) │
                                    └───────────────┘

         ┌───────────────────────────────────────┐
         │ cancel-broadcast (FR-004a + Q10):     │
         │  submitted → cancelled                 │
         │  approved → cancelled                  │
         │  (releases quota reservation)         │
         │ Rejected with broadcast_cancel_too_late│
         │  from {sending, sent, cancelled,       │
         │  rejected, failed_to_dispatch}         │
         └───────────────────────────────────────┘
```

**Quota reservation derivation** (FR-003 — the "reserved" state is NOT stored, it's derived):

```sql
-- Reserved count for member M in current quota year:
SELECT COUNT(*) FROM broadcasts
WHERE tenant_id = $1
  AND requested_by_member_id = $2
  AND status IN ('submitted', 'approved');
  -- Note: NOT filtered by year — reservations are pre-`sent` so quota year is not yet pinned.
  -- The reservation counts against the year the broadcast WILL consume (which is determined at sent-time).
  -- For UI display, we approximate as "current calendar year reservations" because reservations near year-boundary
  -- are tagged with FR-007 warning microcopy.

-- Consumed count for member M in quota year Y:
SELECT COUNT(*) FROM broadcasts
WHERE tenant_id = $1
  AND requested_by_member_id = $2
  AND status = 'sent'
  AND quota_year_consumed = $3;
```

---

## 4. Triggers (DB-level invariants — defence in depth)

### 4.1 `broadcasts_immutable_after_submit_trigger` (Clarifications Q3 + FR-004)

```sql
-- Migration 0064 trailing block:
CREATE OR REPLACE FUNCTION broadcasts_immutable_after_submit_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status != 'draft' THEN
    -- Mutating content fields after the row leaves draft status is forbidden.
    IF NEW.subject IS DISTINCT FROM OLD.subject
       OR NEW.body_html IS DISTINCT FROM OLD.body_html
       OR NEW.body_source IS DISTINCT FROM OLD.body_source
       OR NEW.segment_type IS DISTINCT FROM OLD.segment_type
       OR NEW.segment_params IS DISTINCT FROM OLD.segment_params
       OR NEW.custom_recipient_emails IS DISTINCT FROM OLD.custom_recipient_emails
       OR NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for THEN
      RAISE EXCEPTION 'broadcast_immutable_after_submit'
        USING ERRCODE = 'check_violation',
              HINT    = 'Cancel and create a new draft to change content (FR-004 + Clarifications Q3).';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER broadcasts_immutable_after_submit
  BEFORE UPDATE ON broadcasts
  FOR EACH ROW
  EXECUTE FUNCTION broadcasts_immutable_after_submit_fn();
```

The Application layer also rejects these mutations (use-case precondition); the DB trigger is defence in depth.

### 4.2 `broadcasts_state_machine_trigger` (FR-004 + FR-004a)

```sql
CREATE OR REPLACE FUNCTION broadcasts_state_machine_fn()
RETURNS TRIGGER AS $$
DECLARE
  allowed_targets text[];
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;  -- no transition; allow non-status updates (e.g., resend_audience_id population)
  END IF;

  CASE OLD.status
    WHEN 'draft'              THEN allowed_targets := ARRAY['submitted', 'cancelled'];
    WHEN 'submitted'          THEN allowed_targets := ARRAY['approved', 'rejected', 'cancelled'];
    WHEN 'approved'           THEN allowed_targets := ARRAY['sending', 'cancelled', 'failed_to_dispatch'];
    WHEN 'sending'            THEN allowed_targets := ARRAY['sent', 'failed_to_dispatch'];
    WHEN 'sent'               THEN allowed_targets := ARRAY[]::text[];
    WHEN 'rejected'           THEN allowed_targets := ARRAY[]::text[];
    WHEN 'cancelled'          THEN allowed_targets := ARRAY[]::text[];
    WHEN 'failed_to_dispatch' THEN allowed_targets := ARRAY[]::text[];
  END CASE;

  IF NOT (NEW.status::text = ANY (allowed_targets)) THEN
    RAISE EXCEPTION 'broadcast_invalid_state_transition'
      USING ERRCODE = 'check_violation',
            DETAIL  = format('cannot transition broadcast from %s to %s', OLD.status, NEW.status),
            HINT    = 'See FR-004 + FR-004a state machine.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER broadcasts_state_machine
  BEFORE UPDATE OF status ON broadcasts
  FOR EACH ROW
  EXECUTE FUNCTION broadcasts_state_machine_fn();
```

### 4.3 `broadcasts_updated_at_trigger`

```sql
CREATE OR REPLACE FUNCTION broadcasts_set_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER broadcasts_set_updated_at
  BEFORE UPDATE ON broadcasts
  FOR EACH ROW
  EXECUTE FUNCTION broadcasts_set_updated_at_fn();
```

(Standard updated_at trigger; same pattern as F1+F2+F3+F4+F5.)

### 4.4 `broadcast_deliveries_append_only_trigger`

```sql
CREATE OR REPLACE FUNCTION broadcast_deliveries_append_only_fn()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'broadcast_deliveries_append_only'
    USING ERRCODE = 'check_violation',
          HINT    = 'broadcast_deliveries rows are insert-only (audit trail).';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER broadcast_deliveries_no_update
  BEFORE UPDATE ON broadcast_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_deliveries_append_only_fn();

CREATE TRIGGER broadcast_deliveries_no_delete
  BEFORE DELETE ON broadcast_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_deliveries_append_only_fn();
```

`marketing_unsubscribes` allows DELETE only via `swecham_super` (admin re-subscription edge case — out of MVP UI; the DB-level capability is preserved for compliance ops).

---

## 5. Audit-grant rows (Constitution Principle VIII + retention column)

F7 emits **43 new audit event types** (FR-033 enumerated 27 originally; 5 more added during clarify sessions Q11/Q12; +1 R2 — `broadcast_resend_resource_missing`; +3 Q14+Q15 — `broadcast_complaint_rate_per_broadcast_breach` + `broadcast_member_dispatch_resumed` + `member_acknowledged_broadcasts_terms`; +1 R3-NEW-1 — `broadcast_member_halted_pending_review`; +2 Phase 8 verify-fix R3 — `broadcast_dispatch_idempotency_conflict_pre_send` + `broadcast_dispatch_failure_notif_skipped_no_email`; +1 R5-S1 — `broadcast_resend_audience_drift` (F7.1-IMP5 path); +1 R5-S1 — `broadcast_resend_drift_check_unverifiable`; +2 R6 staff-review — `broadcast_delivery_recorded` (B1 audit-trail semantic fix) + `broadcast_subject_empty` (W-R3 align audit event type with Result kind) — see `audit-port.ts:32–97` taxonomy for full provenance). All inserted into the existing `audit_log` table (introduced by F1 + extended by F2/F3/F4/F5). Retention column populated per the F4-introduced `retention_years` column with default 5 years (no F4 tax-document overlap).

Migration 0069 extends the existing `audit_log_retention_default_trigger_fn` (introduced by F5 migration 0055 / F4 migration 0039) to map F7 event types → 5-year retention:

```sql
-- Migration 0069
CREATE OR REPLACE FUNCTION audit_log_retention_default_trigger_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.retention_years IS NULL THEN
    NEW.retention_years := CASE
      -- F4 tax-document events (10y) — unchanged from F5 migration 0055
      WHEN NEW.event_type IN (
        'invoice_issued','invoice_voided','invoice_paid','invoice_credited','invoice_partially_credited',
        'credit_note_issued','receipt_pdf_rendered'
      ) THEN 10
      -- All F7 events — default 5y (no tax-document overlap)
      WHEN NEW.event_type LIKE 'broadcast_%' OR NEW.event_type IN (
        'member_missing_primary_contact'
      ) THEN 5
      -- Fallback for any other event
      ELSE 5
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Full F7 event-type list** (27 events; payload examples in `contracts/`):

| # | Event type | Severity | Payload includes |
|---|------------|----------|-------------------|
| 1 | `broadcast_drafted` | info | broadcast_id, member_id, user_id, segment_type |
| 2 | `broadcast_submitted` | info | broadcast_id, member_id, actor_role, segment_type, estimated_count |
| 3 | `broadcast_quota_blocked` | warning | broadcast_id (null), member_id, plan_id, used, reserved |
| 4 | `broadcast_empty_segment_blocked` | warning | broadcast_id (null), segment_type, resolved_count=0 |
| 5 | `broadcast_rate_limit_exceeded` | warning | member_id, attempts_in_window |
| 6 | `broadcast_not_in_plan` | warning | member_id, plan_id |
| 7 | `broadcast_immutable_after_submit` | warning | broadcast_id, attempted_field |
| 8 | `broadcast_subject_too_long` | warning | broadcast_id (null), submitted_length |
| 9 | `broadcast_body_too_large` | warning | broadcast_id (null), submitted_size_bytes |
| 10 | `broadcast_body_unsafe_html` | high | broadcast_id (null), forbidden_constructs_count |
| 11 | `broadcast_audience_too_large` | warning | broadcast_id (null), resolved_count, cap=5000 |
| 12 | `broadcast_custom_recipient_unknown` | warning | broadcast_id (null), unresolved_count |
| 13 | `broadcast_member_missing_primary_contact_email` | warning | member_id (null broadcast_id), profile_edit_deep_link |
| 13a | `broadcast_member_halted_pending_review` | warning | member_id, halted_at, attempted_submission_at, attempted_subject |
| 14 | `member_missing_primary_contact` | info | member_id, broadcast_id, segment_type |
| 15 | `broadcast_approved` | info | broadcast_id, admin_user_id, decision, scheduled_for |
| 16 | `broadcast_rejected` | info | broadcast_id, admin_user_id, rejection_reason_hash |
| 17 | `broadcast_cancelled` | info | broadcast_id, actor_id, actor_role, reason |
| 18 | `broadcast_cancel_too_late` | warning | broadcast_id, attempted_by, current_state |
| 19 | `broadcast_send_started` | info | broadcast_id, resend_broadcast_id, scheduled_for, actual_send_at, delay_seconds |
| 20 | `broadcast_send_timeout_completed` | warning | broadcast_id, expected_count, received_count |
| 21 | `broadcast_sent` | info | broadcast_id, delivered, bounced, complained, suppressed |
| 22 | `broadcast_quota_consumed` | info | broadcast_id, member_id, year, count=1 |
| 23 | `broadcast_failed_to_dispatch` | high | broadcast_id, resend_error_code, retry_count |
| 23a | `broadcast_resend_resource_missing` | high | broadcast_id, resend_broadcast_id, detected_at_timeout=true |
| 24 | `broadcast_concurrent_action_blocked` | warning | broadcast_id, attempting_actor, holding_actor |
| 25 | `broadcast_cross_member_probe` | high | attempting_member_id, target_broadcast_id |
| 26 | `broadcast_cross_tenant_probe` | high | attempting_tenant_id, target_tenant_id, surface |
| 27 | `broadcast_unsubscribed` | info | broadcast_id, email_hash, member_id, source_token_hash |
| 28 | `broadcast_unsubscribe_token_invalid` | warning | failure_reason, source_ip |
| 29 | `broadcast_suppression_applied` | info | broadcast_id, suppressed_count |
| 30 | `broadcast_complaint_received` | high | broadcast_id, recipient_email_hash, member_id |
| 30a | `broadcast_complaint_rate_per_broadcast_breach` | high | broadcast_id, member_id, complaint_rate, threshold=0.05, recipients_at_breach |
| 30b | `broadcast_member_dispatch_resumed` | info | member_id, admin_user_id, halted_at, resumed_at, halt_duration_seconds |
| 30c | `member_acknowledged_broadcasts_terms` | info | member_id, user_id, acknowledged_at, banner_locale |
| 31 | `broadcast_webhook_signature_rejected` | high | source_ip, failure_reason |
| 32 | `broadcast_sent_with_expired_member_plan` | warning | broadcast_id, member_id, plan_id_at_submit, plan_id_at_send |

(36 entries — full F7 audit catalogue post-Clarifications-session-5. 27 events were enumerated in spec FR-033's original list, plus 4 added during clarify sessions Q11/Q12 + 4 added during data-modelling for completeness (`broadcast_send_timeout_completed` per FR-028, `broadcast_concurrent_action_blocked` per US2 AS6, `broadcast_complaint_received` per FR-027, `broadcast_sent_with_expired_member_plan` per US6 AS5). Round 1 audit pass 2026-04-29 added `broadcast_member_missing_primary_contact_email` (Q11/FR-002 precondition `j`) → 32 entries. Round 2 critique 2026-04-29 added `broadcast_resend_resource_missing` (R2-NEW-3) → 33 entries. Clarifications session 5 (2026-04-29) Q14 added `broadcast_complaint_rate_per_broadcast_breach` + `broadcast_member_dispatch_resumed` → 35 entries. Clarifications session 5 Q15 added `member_acknowledged_broadcasts_terms` for the GDPR Art. 7 portal banner acknowledgement → 36 entries. Critique Round 3 R3-NEW-1 added `broadcast_member_halted_pending_review` for the FR-002 precondition `k` rejection (Q14 narrative → FR text propagation gap) → final **37 entries**.)

---

## 6. Validation rules (sourced from FRs)

| Field / rule | Source FR | Layer | Implementation |
|--------------|-----------|-------|----------------|
| Subject 1–200 chars | FR-002f | Domain VO + zod + DB CHECK | `Subject.fromString(s)` returns `Result<Subject, SubjectError>` |
| Body 1–200 KB after sanitisation | FR-002f | Application + DB CHECK | post-sanitise size check |
| Body strict-allowlist sanitised | FR-002a / Q4 | Application | `HtmlSanitizerPort` |
| Sanitiser diff = 0 (no forbidden constructs) | FR-002 precondition `g` | Application | `sanitised === input` strict equality |
| Custom-list ≤100 entries | FR-015 + FR-002 precondition `i` + FR-016a | Application + DB CHECK | array_length check |
| Custom-list each entry resolves to tenant graph | FR-015d / Q9 | Application | `validate-custom-recipients.ts` |
| Custom-list email format valid (RFC 5321) | FR-015d / Q9 | Application | `email-validator` |
| Estimated recipient count ≤ 5000 | FR-016a / Q7 | Application + DB CHECK | computed at submit; CHECK on row |
| Originating member's `primary_contact_email` non-null | FR-002 precondition `j` / Q11 | Application | `MembersBridgePort.getMemberPrimaryContact` non-null |
| Originating member NOT halted pending admin review | FR-002 precondition `k` / Q14 + R3-NEW-1 | Application | `MembersBridgePort.getMember(ctx, requested_by_member_id).broadcasts_halted_until_admin_review === false` |
| 10-submissions-per-rolling-24h rate limit | FR-002d | Application | Upstash Redis bucket |
| Tenant has F7 enabled | FR-002e | Application | env flag check |
| Member's plan has `eblast_per_year > 0` | FR-002a + FR-009 | Application | `PlansBridgePort.getPlanForMember` |
| Member's quota ≥ 1 remaining | FR-002b + FR-003 + FR-008 | Application | `compute-quota-counter.ts` |
| Resolved segment ≥ 1 non-suppressed recipient | FR-002c + FR-017 | Application | resolver returns array length |
| Cancellable only from `submitted` or `approved` | FR-004a / Q10 | Domain policy + DB trigger | `CANCELLABLE_STATES` constant |
| Content immutable after submit | FR-004 / Q3 | DB trigger + Application | trigger `broadcasts_immutable_after_submit` |
| State transition follows FR-004 graph | FR-004 | DB trigger + Domain policy | trigger `broadcasts_state_machine` |
| Webhook event idempotent on `resend_event_id` | FR-025 | DB UNIQUE | `broadcast_deliveries_resend_event_id_uniq` |
| Suppression tenant-scoped | FR-018 / Q8 | DB primary key | `(tenant_id, email_lower) PK` |
| Quota year computed at sent-time | FR-007 | Application | `currentQuotaYear(tenantTz, sentAt)` |
| Quota counter never negative | FR-008 | Application + Domain VO | `QuotaCounter` invariant |

---

## 7. Migrations

### 7.1 Migration order

1. **0064** — `create_broadcasts.sql` — table + enums + indexes + RLS + triggers (immutable_after_submit, state_machine, updated_at).
2. **0065** — `create_broadcast_deliveries.sql` — table + enum + indexes + RLS + append-only triggers.
3. **0066** — `create_marketing_unsubscribes.sql` — table + enum + indexes + RLS.
4. **0067** — `create_broadcast_segment_definitions.sql` — table + indexes + RLS.
5. **0068** — `seed_default_segment_definitions.sql` — seeds SweCham's default segment presets (`all_members`, `tier:premium`, `tier:large`, `tier:regular`, `tier:diamond`, `tier:platinum`, `tier:gold`, `event_attendees_last_90d`, `custom`). Idempotent (ON CONFLICT DO NOTHING).
6. **0069** — `audit_log_extend_retention_default_trigger.sql` — extends the audit retention trigger to map F7 event types to 5y default.
7. **0070** — `members_add_broadcasts_halted_flag.sql` — adds `broadcasts_halted_until_admin_review boolean default false` column to F3's `members` table (Clarifications Q14, B — per-broadcast >5% complaint-rate auto-halt invariant). Idempotent (`ADD COLUMN IF NOT EXISTS`). RLS on `members` is unchanged (existing F3 policy covers the new column).
8. **0071** — `members_add_broadcasts_acknowledged_at.sql` — adds `broadcasts_acknowledged_at timestamp with time zone` (nullable) column to F3's `members` table (Clarifications Q15, B — GDPR Art. 7 acknowledgement banner). Idempotent. RLS unchanged.

### 7.2 Backfill

No backfill required — F7 introduces fresh tables. The retention column extension is forward-only (existing rows already have explicit retention_years values from F4/F5 backfill in migration 0039 + 0051).

### 7.3 Rollback strategy

In emergency:

1. `FEATURE_F7_BROADCASTS=false` env-var flip kills the feature flag (compose surface returns 503; cron handler skips processing). No-code-deploy mitigation. Same pattern as F4/F5.
2. If schema-level rollback needed: migrations 0064–0069 are all `CREATE`-only; rollback is `DROP TABLE` in reverse order — but the 0069 trigger amendment must be reverted to its 0063 form first to avoid orphan event-type references.
3. Resend account: leaving the audience and broadcast resources in Resend is harmless (no further dispatch occurs while flag is off); manual cleanup via Resend dashboard is post-incident operational work.

---

## 7a. GDPR Art. 17 erasure cascade (Privacy checklist CHK015 — consolidated rules)

When a member exercises their **right to erasure** (GDPR Art. 17 + PDPA §33) via the F3 member-erasure path (or admin-initiated erasure), the F7 cascade behaviour is:

| Table | Member-related columns | Cascade rule on Art. 17 erasure | Lawful basis for retention |
|-------|------------------------|---------------------------------|---------------------------|
| `broadcasts` | `requested_by_member_id`, `submitted_by_user_id`, `requested_by_member_plan_id_snapshot`, `reply_to_email` | `requested_by_member_id` and `submitted_by_user_id` SET NULL; plan_id_snapshot retained (snapshot, not PII); `reply_to_email` SET NULL (orphaned). The broadcast row itself is RETAINED for audit/legal-obligation per FR-033 5-year retention. | GDPR Art. 6(1)(c) legal obligation (record-of-processing per Art. 30 + PDPA §39) |
| `broadcast_deliveries` | `recipient_member_id`, `recipient_email_lower` | `recipient_member_id` SET NULL; `recipient_email_lower` SET to a one-way-hashed sentinel (`erased:` + sha256(email_lower)) — preserves the row for delivery-audit-trail purposes while making the original email unrecoverable. | GDPR Art. 6(1)(c) record retention; PDPA §39 |
| `marketing_unsubscribes` | `member_id`, `email_lower`, `reason_text` | `member_id` SET NULL; `email_lower` **PRESERVED** as-is (suppression intent is per-email, not per-member; preserving it honours Art. 21 right-to-object indefinitely). `reason_text` SET NULL (free-text could contain personal information). | GDPR Art. 21 right-to-object MUST be honoured indefinitely (even after Art. 17 erasure of the member identity) |
| `members.broadcasts_halted_until_admin_review` | (whole column on member row) | Deleted alongside the member row via F3's standard erasure path. | N/A — column lives on member row, follows member-row lifecycle |
| `members.broadcasts_acknowledged_at` | (whole column on member row) | Deleted alongside the member row. | N/A |
| `audit_log` (F7 events) | `member_id` references in payload | `member_id` SET to the sentinel `'erased:' + sha256(member_id)` to preserve traceability without exposing the original id. | GDPR Art. 6(1)(c) audit retention |

**Operational notes**:
- The cascade SHOULD run as a single transaction with row-level locks held on all affected tables to prevent concurrent broadcast submissions during erasure.
- Audit emits a new `member_erasure_completed` event at the F3 erasure boundary (not an F7 event — F3 owns the erasure use-case; F7 is invoked as a cross-feature cascade contributor).
- The 5-year retention of `broadcasts` rows post-erasure is justified by PDPA §39 + GDPR Art. 30 record-of-processing requirements; the sentinel-hashing approach satisfies the data-minimisation balance (Art. 5(1)(c)) — the member identity is unrecoverable but the audit trail of "a broadcast was authored at time T" is preserved.
- A request for erasure that the chamber denies (e.g., contractual-retention-period not yet elapsed for billing-related broadcasts) MUST be logged + responded to per Art. 17 with the legal basis for refusal.

**Right of access (Art. 15)** complementary surface:
- Member queries their own broadcasts via `/portal/broadcasts/[id]` (US3) and own delivery summaries.
- Bulk export of all F7 PII for a single member is F9 GDPR-export scope.

**Right of portability (Art. 20)**:
- F9 GDPR-export endpoint will surface F7 data as JSON: `{ broadcasts: [...], deliveries_received: [...], suppression: [...], acknowledgement_at: "..." }`.
- F7 ships the underlying schema; F9 ships the export endpoint.

## 8. Index sizing estimate (5-year SaaS target)

At ~ 360M `broadcast_deliveries` events/year × 5 years = ~1.8B rows. The composite PK + 3 indexes total ≈ 200 bytes per row × 1.8B = ~360 GB of index storage. **Partitioning by `tenant_id` + `event_timestamp` quarterly is the F7.x scale path** — explicitly noted as future work; MVP relies on Neon's automatic vacuum + the `(tenant_id, broadcast_id, status)` partial-index optimisation for hot queries. SweCham scale (~50k events/year × 5 years = 250k rows total) is trivial.

---

## Phase 1a close-out

Schema, RLS, state machine, triggers, audit catalogue, validation map, and migration plan are complete. Phase 1b (contracts/) is next.
