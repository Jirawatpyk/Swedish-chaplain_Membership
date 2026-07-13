/**
 * F3 Members — Drizzle schema.
 *
 * Single table: `members` (aggregate root; contacts live in a sibling
 * schema file co-located in the same bounded context). See data-model.md § 1.1.
 *
 * **RLS policies, pg_trgm extension, CONCURRENTLY indexes, and the
 * `last_activity_at` denorm trigger are NOT expressed here** — drizzle-kit
 * cannot emit them. They are hand-appended to the generated SQL migration
 * `drizzle/migrations/0009_members_contacts.sql` as raw SQL blocks, mirroring
 * the F2 pattern. See plan.md § Storage + data-model.md § 2 / § 3.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// --- Enums --------------------------------------------------------------------

export const memberStatusEnum = pgEnum('member_status', [
  'active',
  'inactive',
  'archived',
]);

// --- members ------------------------------------------------------------------

export const members = pgTable(
  'members',
  {
    // Tenancy (MTA+STD — F2 pattern, no FK to a tenants table yet)
    tenantId: text('tenant_id').notNull(),

    // Identity — UUID v4 generated client-side by Domain (via crypto.randomUUID)
    memberId: uuid('member_id').notNull(),

    // Legal entity
    companyName: text('company_name').notNull(),
    legalEntityType: text('legal_entity_type'),
    country: char('country', { length: 2 }).notNull(),
    taxId: text('tax_id'),

    // 088-invoice-tax-flow-redesign (US3 / FR-008, migration 0232) — §86/4
    // Head-Office / Branch buyer particular, admin-managed. `is_head_office`
    // defaults true (สำนักงานใหญ่); a branch carries a 5-digit RD `branch_code`.
    // The pairing is enforced by `members_branch_pairing_ck` (head office ⇒ NULL
    // code; branch ⇒ `^[0-9]{5}$`). Pinned into the immutable buyer identity
    // snapshot at issue; the §86/4 branch LINE renders only for a VAT-registrant
    // juristic buyer (never `buyerHasTin`). Scrubbed by `scrubPiiInTx` (§86/4
    // business quasi-identifier) — see scrub-pii-column-coverage.test.ts.
    isHeadOffice: boolean('is_head_office').notNull().default(true),
    branchCode: char('branch_code', { length: 5 }),
    website: text('website'),
    description: text('description'),
    foundedYear: integer('founded_year'),
    // Turnover in THB (integer THB, no decimals — spec Q5 / FR-006).
    // bigint needed because SweCham Premium turnover band goes >100M THB.
    turnoverThb: bigint('turnover_thb', { mode: 'number' }),
    // 058 / PR-B — ทุนจดทะเบียน (registered capital). A SEPARATE field from
    // `turnoverThb`, which gates the F2 plan turnover band + F8 tier upgrades.
    registeredCapitalThb: bigint('registered_capital_thb', { mode: 'number' }),

    // Plan binding — composite FK to membership_plans (tenant_id, plan_id, plan_year)
    // expressed at the migration layer; Drizzle cannot emit composite FKs from
    // this column-level declaration.
    planId: text('plan_id').notNull(),
    planYear: integer('plan_year').notNull(),

    // Registration
    registrationDate: date('registration_date').notNull().defaultNow(),
    registrationFeePaid: boolean('registration_fee_paid').notNull().default(false),

    // Activity denorm — updated by an AFTER INSERT ON audit_log trigger
    // (see migration 0009). NULL until the first audit event touches this member.
    // INVARIANT: the trigger fires ONLY when the audit payload carries the
    // snake_case key `member_id` (NEW.payload ? 'member_id'). Audit events that
    // use camelCase `memberId` will NOT bump this column — keep every new
    // member-scoped audit payload on `member_id` or the member silently stops
    // rising in the directory's last-activity sort.
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),

    // Admin-only free text — redacted from member-self GET responses in Application.
    notes: text('notes'),

    // Postal address (optional, structured). The 2-letter `country` lives
    // above (ISO 3166-1 alpha-2); these columns hold the street-level parts.
    // Added 2026-05-29 (migration 0195). All nullable — existing members
    // carry no address.
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    province: text('province'),
    postalCode: text('postal_code'),
    // 058 / PR-B — แขวง/ตำบล. Sits BETWEEN address_line2 and city in a Thai
    // address. Task 2 threads this onto the §86/4 buyer address via
    // composeBuyerAddress — a Bangkok address reading "เขตคลองเตย
    // กรุงเทพมหานคร 10110" with no แขวง is not a complete address. `city`
    // holds the district (อำเภอ/เขต).
    subDistrict: text('sub_district'),

    // State
    status: memberStatusEnum('status').notNull().default('active'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),

    // F7 — per-broadcast complaint-rate auto-halt flag (Clarifications Q14 /
    // SC-005 (b)). When `true`, member submissions fail FR-002 precondition
    // `k` with `broadcast_member_halted_pending_review`. Cleared by admin
    // action via the F3 barrel `setMemberHalt` use-case (emits
    // `broadcast_member_dispatch_resumed` audit). Manager role denied —
    // admin-only same as approve/reject/cancel per FR-014.
    broadcastsHaltedUntilAdminReview: boolean('broadcasts_halted_until_admin_review')
      .notNull()
      .default(false),

    // F7 — GDPR Art. 7 demonstrable-consent timestamp (Clarifications Q15).
    // Populated when member dismisses the one-time portal acknowledgement
    // banner ("Your tier includes marketing broadcasts...; you may
    // unsubscribe at any time"). Emits `member_acknowledged_broadcasts_terms`
    // audit on first set. NOT a precondition for receiving broadcasts —
    // lawful basis remains contract performance per PDPA §24 + GDPR
    // Art. 6(1)(b). Indefinite retention while member row exists.
    broadcastsAcknowledgedAt: timestamp('broadcasts_acknowledged_at', {
      withTimezone: true,
    }),

    // F7 / R4 (verify-fix Types-#6, 2026-05-02) — preferred locale for
    // member-facing transactional emails (broadcast approved/rejected/
    // cancelled/delivered/failed_to_dispatch + future F3+F4 surfaces).
    // NULL = use tenant default locale at notification time. Admin can
    // set per-member via the F3 member edit screen (TODO post-F12
    // white-label phase). Allowed values enforced by CHECK in migration
    // 0082 — must be one of `en|th|sv` to match `Locale` union.
    preferredLocale: text('preferred_locale'),

    // F8 Phase 2 Wave C T025 — renewal opt-out + email-bounce + at-risk +
    // auto-reactivate-blocked override. Migration `0094`.
    renewalRemindersOptedOut: boolean('renewal_reminders_opted_out')
      .notNull()
      .default(false),
    renewalRemindersOptedOutAt: timestamp('renewal_reminders_opted_out_at', {
      withTimezone: true,
    }),
    emailUnverified: boolean('email_unverified').notNull().default(false),
    emailUnverifiedAt: timestamp('email_unverified_at', { withTimezone: true }),
    riskScore: smallint('risk_score'),
    // 'healthy' | 'warning' | 'at-risk' | 'critical' (DB CHECK).
    riskScoreBand: text('risk_score_band'),
    riskScoreFactors: jsonb('risk_score_factors'),
    riskScoreLastComputedAt: timestamp('risk_score_last_computed_at', {
      withTimezone: true,
    }),
    riskSnoozedUntil: timestamp('risk_snoozed_until', { withTimezone: true }),
    blockedFromAutoReactivation: boolean('blocked_from_auto_reactivation')
      .notNull()
      .default(false),
    blockedFromAutoReactivationAt: timestamp(
      'blocked_from_auto_reactivation_at',
      { withTimezone: true },
    ),
    blockedFromAutoReactivationSetByUserId: uuid(
      'blocked_from_auto_reactivation_set_by_user_id',
    ),
    blockedFromAutoReactivationReason: text(
      'blocked_from_auto_reactivation_reason',
    ),

    // Audit metadata
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    // F-member-number — human-readable display identifier.
    // .notNull() is safe now that migration 0209 has applied to live Neon:
    // the column is backfilled (every row 1..N per tenant), SET NOT NULL,
    // and carries a positive CHECK + per-tenant UNIQUE index.
    // See design doc §6 and migration 0094 idempotency comment.
    memberNumber: integer('member_number').notNull(),

    // COMP-1 Member Erasure — set by `eraseMember` inside the atomic scrub tx.
    // NULL = never erased. Presence marks the row anonymised; the
    // reconciliation sweep (US2) re-selects on `erased_at IS NOT NULL` with an
    // incomplete cascade (supported by the partial `members_erased_at_idx`
    // below, delivered in migration 0226). Status is intentionally NOT changed
    // by erasure.
    erasedAt: timestamp('erased_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      name: 'members_pkey',
      columns: [table.tenantId, table.memberId],
    }),
    // Directory filter (status + plan). Partial WHERE `archived_at IS NULL`
    // would be nice but status already encodes archive state.
    index('members_tenant_status_plan_idx').on(
      table.tenantId,
      table.status,
      table.planId,
    ),
    // Year filter
    index('members_tenant_year_idx').on(table.tenantId, table.planYear),
    // Directory ORDER BY last_activity_at DESC (E10)
    index('members_tenant_last_activity_idx').on(
      table.tenantId,
      sql`${table.lastActivityAt} DESC NULLS LAST`,
    ),
    // F7 Q14 — fast list of halted members (admin queue red banner)
    index('members_tenant_broadcasts_halted_idx')
      .on(table.tenantId)
      .where(sql`broadcasts_halted_until_admin_review = true`),
    // F7 Q15 — banner-eligible members (members who haven't acknowledged yet)
    index('members_tenant_broadcasts_unack_idx')
      .on(table.tenantId, table.memberId)
      .where(sql`broadcasts_acknowledged_at IS NULL`),
    // COMP-1 US2d — reconciler sweep candidate index (delivered in migration
    // 0226). `findStuckErasuresInTx` selects `erased_at IS NOT NULL` and orders
    // `erased_at ASC` (oldest-erasure-first, nearest the Art.12 deadline). The
    // partial WHERE keeps it sparse over only the erased rows.
    index('members_erased_at_idx')
      .on(table.erasedAt)
      .where(sql`erased_at IS NOT NULL`),
    // Note: pg_trgm GIN index on company_name is added via raw SQL in the
    // migration (drizzle-kit cannot emit `USING GIN (col gin_trgm_ops)`).
  ],
);

// --- Inferred row types (Infrastructure → Application translation) ------------

export type MemberRow = typeof members.$inferSelect;
export type MemberInsert = typeof members.$inferInsert;
