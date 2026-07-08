/**
 * F8 Phase 2 Wave C · T018 — Drizzle schema for `renewal_cycles`.
 *
 * Aggregate root for the F8 bounded context. Pairs with migration
 * `drizzle/migrations/0087_f8_create_renewal_cycles_table.sql`.
 *
 * RLS+FORCE policies + CHECK constraints + triggers (`sync_expires_at`,
 * `set_updated_at`) live in the SQL migration only — drizzle-kit does
 * not emit them from the TypeScript schema (same pattern as F2, F4, F7).
 *
 * Source of truth: data-model.md § 2.1.
 *
 * Domain entity (Wave D T034) + Application port (Wave E T041) +
 * Drizzle adapter (Wave G T054 / Phase 5+ when use-cases land) consume
 * this schema. No adapter ships in Wave C — only the schema is needed
 * so the cross-tenant integration test (Wave F T052) can seed rows
 * via `db.insert(renewalCycles)` against the real table.
 */
import {
  decimal,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';

export const renewalCycles = pgTable(
  'renewal_cycles',
  {
    tenantId: text('tenant_id').notNull(),
    cycleId: uuid('cycle_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    memberId: uuid('member_id').notNull(),

    // 7-state machine. CHECK constraint at DB level lives in
    // `0087_*.sql`. Domain narrows further via value-object
    // `cycle-status.ts` (Wave D T031).
    status: text('status').notNull().default('upcoming'),

    periodFrom: timestamp('period_from', { withTimezone: true }).notNull(),
    periodTo: timestamp('period_to', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    cycleLengthMonths: smallint('cycle_length_months').notNull().default(12),

    // Frozen-plan snapshot (FR-021a — never overwritten after cycle creation).
    tierAtCycleStart: text('tier_at_cycle_start').notNull(),
    // T149 follow-up (migration 0113): TEXT to match `membership_plans.plan_id`
    // (TEXT slug like 'regular'/'premium'). Was `uuid` in 0087 — mismatch let
    // seeds write `gen_random_uuid()` orphans that broke the F2 plan-name lookup.
    planIdAtCycleStart: text('plan_id_at_cycle_start').notNull(),
    frozenPlanPriceThb: decimal('frozen_plan_price_thb', {
      precision: 12,
      scale: 2,
    }).notNull(),
    frozenPlanTermMonths: smallint('frozen_plan_term_months').notNull(),
    frozenPlanCurrency: text('frozen_plan_currency').notNull().default('THB'),

    // pending_admin_reactivation lifecycle anchor.
    enteredPendingAt: timestamp('entered_pending_at', { withTimezone: true }),

    // F4 lifecycle FKs.
    linkedInvoiceId: uuid('linked_invoice_id'),
    // Rolling-anchor refactor (design 2026-07-08, migration 0238).
    // `anchoredAt` is the discriminator: "this cycle has been anchored to
    // a real payment" (set by the re-anchor use-case AND by the R4
    // backfill script). NULL = still the provisional `registration_date`
    // anchor from onboarding. `anchorInvoiceId` is a forensic reference to
    // the anchoring invoice — NULL for backfilled pre-system payments.
    // Deliberately a SEPARATE column from `linkedInvoiceId`: the anchoring
    // invoice never occupies `linkedInvoiceId`, so the member's next
    // renewal can still link cleanly through the `linkInvoice` I1 guard.
    anchoredAt: timestamp('anchored_at', { withTimezone: true }),
    anchorInvoiceId: uuid('anchor_invoice_id'),
    linkedCreditNoteId: uuid('linked_credit_note_id'),

    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedReason: text('closed_reason'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'renewal_cycles_pk',
      columns: [table.tenantId, table.cycleId],
    }),
    // F3 composite FK (tenant_id, member_id) → members.
    memberFk: foreignKey({
      name: 'renewal_cycles_member_fk',
      columns: [table.tenantId, table.memberId],
      foreignColumns: [members.tenantId, members.memberId],
    }).onDelete('restrict'),
    // F4 composite FKs.
    linkedInvoiceFk: foreignKey({
      name: 'renewal_cycles_linked_invoice_fk',
      columns: [table.tenantId, table.linkedInvoiceId],
      foreignColumns: [invoices.tenantId, invoices.invoiceId],
    }),
    // Rolling-anchor refactor (migration 0238) — ON DELETE SET NULL: the
    // anchor is a forensic reference, not a lifecycle-critical link, so an
    // invoice hard-delete (e.g. GDPR erasure retention sweep) should clear
    // the pointer rather than block or cascade.
    anchorInvoiceFk: foreignKey({
      name: 'renewal_cycles_anchor_invoice_fk',
      columns: [table.tenantId, table.anchorInvoiceId],
      foreignColumns: [invoices.tenantId, invoices.invoiceId],
    }).onDelete('set null'),
    linkedCreditNoteFk: foreignKey({
      name: 'renewal_cycles_linked_credit_note_fk',
      columns: [table.tenantId, table.linkedCreditNoteId],
      foreignColumns: [creditNotes.tenantId, creditNotes.creditNoteId],
    }),
    pipelineIdx: index('renewal_cycles_pipeline_idx').on(
      table.tenantId,
      table.status,
      table.expiresAt,
    ),
    memberIdx: index('renewal_cycles_member_idx').on(
      table.tenantId,
      table.memberId,
    ),
    // Serves the lapsed-badge batch query: DISTINCT ON (member_id)
    // ORDER BY member_id, created_at DESC, cycle_id DESC. The index covers
    // (tenant_id, member_id, created_at DESC) but NOT cycle_id, so the
    // `cycle_id DESC` tiebreak still does a tiny per-member in-memory sort —
    // it is an index-ordered scan, NOT a pure skip-scan with zero Sort. The
    // residual sort is negligible (a handful of cycles per member); adding
    // cycle_id to the index was judged not worth a new migration (S2
    // speckit-review).
    memberRecencyIdx: index('renewal_cycles_member_recency_idx').on(
      table.tenantId,
      table.memberId,
      table.createdAt.desc(),
    ),
    eligibilityIdx: index('renewal_cycles_eligibility_idx')
      .on(table.tenantId, table.status, table.expiresAt)
      .where(sql`status IN ('upcoming','reminded','awaiting_payment')`),
    // Partial UNIQUE — enforces invariant L135 at DB layer ("at most one
    // active cycle per member"). Terminal states excluded from the
    // constraint so the audit trail can carry historical cycles.
    activeMemberUniq: uniqueIndex('renewal_cycles_active_member_uniq')
      .on(table.tenantId, table.memberId)
      .where(sql`status NOT IN ('lapsed','cancelled','completed')`),
  }),
);

export type RenewalCycleRow = typeof renewalCycles.$inferSelect;
export type RenewalCycleInsert = typeof renewalCycles.$inferInsert;
