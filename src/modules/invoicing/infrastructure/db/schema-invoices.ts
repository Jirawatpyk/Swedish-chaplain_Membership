/**
 * T012 — Drizzle schema for `invoices` (F4 aggregate root).
 *
 * Migration: drizzle/migrations/0019_invoicing_tables.sql § invoices.
 *
 * Composite PK (tenant_id, invoice_id) matching F3 members convention.
 * Snapshot columns (tenant_identity_snapshot, member_identity_snapshot,
 * subtotal/vat/total satang, etc.) are locked by the
 * `invoices_enforce_immutability` trigger once `status != 'draft'`.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  uuid,
  smallint,
  integer,
  bigint,
  boolean,
  date,
  timestamp,
  numeric,
  char,
  jsonb,
  pgEnum,
  primaryKey,
  check,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'draft',
  'issued',
  'paid',
  'void',
  'credited',
  'partially_credited',
]);

// 054-event-fee-invoices — discriminator distinguishing the F4 membership
// invoice (member_id/plan_id/plan_year identity) from the new event-fee
// invoice (event_id/event_registration_id identity). Default 'membership'
// backfills every pre-existing row at migration time; the
// `invoices_subject_fields_ck` CHECK then guarantees each subject carries
// its required identity columns. See migration 0201 § invoice_subject.
export const invoiceSubjectEnum = pgEnum('invoice_subject', ['membership', 'event']);

// T166 — async receipt PDF state machine. Migration 0056.
export const receiptPdfStatusEnum = pgEnum('receipt_pdf_status_t', [
  'pending',
  'rendered',
  'failed',
]);

export const invoices = pgTable(
  'invoices',
  {
    tenantId: text('tenant_id').notNull(),
    invoiceId: uuid('invoice_id').notNull().defaultRandom(),
    // 054-event-fee-invoices — member/plan identity is now NULLABLE: it is
    // populated for `invoice_subject='membership'` rows and NULL for
    // `invoice_subject='event'` rows. The `invoices_subject_fields_ck`
    // CHECK enforces presence-per-subject. The immutability trigger still
    // locks these three columns once status != 'draft' (NULL stays NULL
    // for event invoices across the lifecycle → no false trip).
    memberId: uuid('member_id'),
    planYear: smallint('plan_year'),
    planId: text('plan_id'),

    // 054-event-fee-invoices — invoice subject discriminator + event linkage.
    // `invoiceSubject` defaults to 'membership' so existing rows backfill
    // cleanly; new event invoices set 'event' + the two event_* columns.
    invoiceSubject: invoiceSubjectEnum('invoice_subject').notNull().default('membership'),
    eventId: uuid('event_id'),
    eventRegistrationId: uuid('event_registration_id'),
    // VAT treatment: membership invoices are VAT-EXCLUSIVE (false); event
    // invoices may price VAT-inclusive (true) when the ticket price already
    // includes the 7% component. Defaults false to keep F4 behaviour intact.
    vatInclusive: boolean('vat_inclusive').notNull().default(false),

    // 054-event-fee-invoices (Task 7) — the non-draft snapshot CHECK
    // `invoices_non_draft_has_snapshots` (declared as a `check()` builder in the
    // table-constraints array below, mirroring the live predicate after migration
    // 0203) carves out the single MEMBERSHIP-only field `pro_rate_policy_snapshot`
    // for the event subject: `(pro_rate_policy_snapshot IS NOT NULL OR
    // invoice_subject = 'event')`. Every other field — including
    // `net_days_snapshot` (from tenant settings) and `member_identity_snapshot`
    // (the BUYER snapshot, populated for event too) — stays required for BOTH
    // subjects. Event invoices ARE §87-numbered + PDF'd, so the numbering + pdf_*
    // fields stay required. `issue-invoice` populates them all for event rows and
    // sets `pro_rate_policy_snapshot = NULL` for the event subject.

    status: invoiceStatusEnum('status').notNull().default('draft'),
    draftByUserId: uuid('draft_by_user_id').notNull(),

    fiscalYear: smallint('fiscal_year'),
    sequenceNumber: integer('sequence_number'),
    documentNumber: text('document_number'),

    issueDate: date('issue_date'),
    dueDate: date('due_date'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),

    currency: char('currency', { length: 3 }).notNull().default('THB'),
    subtotalSatang: bigint('subtotal_satang', { mode: 'bigint' }),
    vatRateSnapshot: numeric('vat_rate_snapshot', { precision: 5, scale: 4 }),
    vatSatang: bigint('vat_satang', { mode: 'bigint' }),
    totalSatang: bigint('total_satang', { mode: 'bigint' }),
    // Staff-review R2 R022 (2026-04-28): use raw SQL `0` instead of
    // BigInt literal `0n` because drizzle-kit 0.30.x cannot
    // JSON.serialize BigInt defaults when generating snapshots
    // (TypeError: Do not know how to serialize a BigInt). The DB
    // column is still `BIGINT NOT NULL DEFAULT 0` either way; only the
    // TS-side default representation changes.
    creditedTotalSatang: bigint('credited_total_satang', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),

    proRatePolicySnapshot: text('pro_rate_policy_snapshot'),
    netDaysSnapshot: smallint('net_days_snapshot'),

    tenantIdentitySnapshot: jsonb('tenant_identity_snapshot'),
    memberIdentitySnapshot: jsonb('member_identity_snapshot'),

    paymentMethod: text('payment_method'),
    paymentReference: text('payment_reference'),
    paymentNotes: text('payment_notes'),
    paymentRecordedByUserId: uuid('payment_recorded_by_user_id'),
    // R7-W5 — admin-entered payment date (separate from paid_at which
    // is the server-side mark-paid timestamp).
    paymentDate: date('payment_date'),

    voidReason: text('void_reason'),
    voidedByUserId: uuid('voided_by_user_id'),

    autoEmailOnIssue: boolean('auto_email_on_issue'),

    // Invoice PDF — frozen at issue time, never overwritten.
    pdfBlobKey: text('pdf_blob_key'),
    pdfSha256: char('pdf_sha256', { length: 64 }),
    pdfTemplateVersion: smallint('pdf_template_version'),
    // Receipt PDF — written by applyPayment (sync) or render-receipt-pdf
    // worker (async, T166), separate from invoice PDF so the invoice's
    // audit hash stays intact after payment (F4 final-review C1).
    // Permanently null for combined-mode tenants where the receipt IS
    // the invoice.
    receiptPdfBlobKey: text('receipt_pdf_blob_key'),
    receiptPdfSha256: char('receipt_pdf_sha256', { length: 64 }),
    receiptPdfTemplateVersion: smallint('receipt_pdf_template_version'),
    // T166 — async receipt PDF state. NULL for non-paid rows; one of
    // 'pending'|'rendered'|'failed' for paid rows. CHECK constraint
    // `invoices_paid_has_receipt_status` enforces invariant. See
    // migration 0056 + plan.md § Phase 9 sub-plan T166 for lifecycle.
    receiptPdfStatus: receiptPdfStatusEnum('receipt_pdf_status'),
    receiptPdfRenderAttempts: integer('receipt_pdf_render_attempts').notNull().default(0),
    receiptPdfLastError: text('receipt_pdf_last_error'),
    // T166 R1-C1 — pre-allocated receipt document number for the
    // separate-mode async render path. Persisted at `recordPayment`
    // time (under the same tx as the `paid` flip) so the worker reads
    // this back instead of re-allocating from
    // `tenant_document_sequences.receipt` — preventing §87 gap when the
    // worker retries. NULL for combined-mode + pre-T166 + non-paid rows.
    receiptDocumentNumberRaw: text('receipt_document_number_raw'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'invoices_pkey', columns: [table.tenantId, table.invoiceId] }),
    // 054-event-fee-invoices — subject-discriminated identity invariant.
    // A membership invoice MUST carry member_id + plan_id + plan_year; an
    // event invoice MUST carry event_id + event_registration_id. Defence-
    // in-depth on top of the Application-layer use-case validation so a
    // direct/regressed write can never persist an identity-less row.
    check(
      'invoices_subject_fields_ck',
      sql`(
        (invoice_subject = 'membership' AND member_id IS NOT NULL AND plan_id IS NOT NULL AND plan_year IS NOT NULL)
        OR
        (invoice_subject = 'event' AND event_registration_id IS NOT NULL AND event_id IS NOT NULL)
      )`,
    ),
    // 054-event-fee-invoices (Task 7) — non-draft snapshot completeness.
    // Mirrors the LIVE predicate after migration 0203 (hand-authored there in
    // the idempotent DO-block; declared here so the Drizzle schema reflects the
    // current DB shape). Every non-draft row must carry the full numbering +
    // snapshot + pdf set; the ONLY relaxation is the membership-only
    // `pro_rate_policy_snapshot`, which an event invoice legitimately leaves
    // NULL (pro-rating has no meaning for a ticket fee). `member_identity_snapshot`
    // stays REQUIRED for both subjects (the §86/4 buyer snapshot). Pre-0203 this
    // CHECK lived only in migration 0019/0024 SQL; the matching builder is added
    // now alongside `invoices_subject_fields_ck` (also 054) for schema fidelity.
    check(
      'invoices_non_draft_has_snapshots',
      sql`(
        status = 'draft'
        OR (
          subtotal_satang IS NOT NULL
          AND vat_rate_snapshot IS NOT NULL
          AND vat_satang IS NOT NULL
          AND total_satang IS NOT NULL
          AND fiscal_year IS NOT NULL
          AND sequence_number IS NOT NULL
          AND document_number IS NOT NULL
          AND issue_date IS NOT NULL
          AND due_date IS NOT NULL
          AND (pro_rate_policy_snapshot IS NOT NULL OR invoice_subject = 'event')
          AND net_days_snapshot IS NOT NULL
          AND tenant_identity_snapshot IS NOT NULL
          AND member_identity_snapshot IS NOT NULL
          AND pdf_blob_key IS NOT NULL
          AND pdf_sha256 IS NOT NULL
          AND pdf_template_version IS NOT NULL
        )
      )`,
    ),
    // 054-event-fee-invoices — one non-void event invoice per registration.
    // Predicate uses `status <> 'void'` because the void status value is
    // literally 'void' in `invoiceStatusEnum` (there is NO 'voided' value).
    // A voided event invoice frees the registration so a corrected invoice
    // can be re-issued. Membership invoices have NULL event_registration_id
    // so the partial WHERE never indexes them.
    uniqueIndex('invoices_event_registration_uniq')
      .on(table.tenantId, table.eventRegistrationId)
      .where(sql`invoice_subject = 'event' AND status <> 'void'`),
    // FK DECISION (054-event-fee-invoices, Task 3+4):
    //   `(tenant_id, event_registration_id)` → `event_registrations
    //   (tenant_id, registration_id) ON DELETE RESTRICT` — a tenant-aware
    //   COMPOSITE FK (the F6 PK is exactly `(tenant_id, registration_id)`,
    //   so the composite cannot reference a cross-tenant registration:
    //   defence-in-depth on top of RLS). The constraint is HAND-AUTHORED
    //   in the migration SQL (idempotent DO-block, mirroring 0125) rather
    //   than declared here as a `foreignKey()` builder, because:
    //     (1) the F6 `event_registrations` table lives in the events
    //         bounded context and is NOT in `drizzle.config.ts`'s schema
    //         list — drizzle-kit cannot introspect it, so a builder-level
    //         FK would either be dropped from generation or force an
    //         Infrastructure cross-context import (Principle III smell);
    //     (2) the project already hand-authors all cross-module / RLS /
    //         CHECK DDL the same way (see drizzle.config.ts F9 note + 0125).
    //   The cross-tenant integration test (Task 5) + RLS remain the
    //   primary isolation guarantees; this FK is referential-integrity
    //   defence-in-depth.
  ],
);

export type InvoiceRow = typeof invoices.$inferSelect;
export type NewInvoiceRow = typeof invoices.$inferInsert;
