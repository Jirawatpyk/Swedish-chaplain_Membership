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
  index,
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
    // 0212) carves out the MEMBERSHIP-only field `pro_rate_policy_snapshot`
    // for the event subject: `(pro_rate_policy_snapshot IS NOT NULL OR
    // invoice_subject = 'event')`. Since 0212 (064 Task 9, beta) the
    // invoice-stream numbering pair is ALSO conditionally exempt for an event
    // row carrying `receipt_document_number_raw` (as-paid no-TIN S105 receipt).
    // Every other field — including `net_days_snapshot` (from tenant settings)
    // and `member_identity_snapshot` (the BUYER snapshot, populated for event
    // too) — stays required for BOTH subjects, and the pdf_* triplet stays
    // required on every non-draft row. `issue-invoice` populates them all for
    // event rows and sets `pro_rate_policy_snapshot = NULL` for the event
    // subject.

    status: invoiceStatusEnum('status').notNull().default('draft'),
    draftByUserId: uuid('draft_by_user_id').notNull(),

    // 088 L1 — this is the BILL / issue-time fiscal year by design (derived
    // from the ISSUE date in `issueInvoice`). It is NOT the §87 fiscal year of
    // the payment-time `RC` tax receipt: for a cross-year sale (bill FY2025 →
    // paid FY2026) the RC is `RC-2026-…` while `fiscal_year` stays 2025. The
    // RC's true §87 fiscal year lives on the RC number string
    // (`receipt_document_number_raw`, `RC-{FY}-…`) AND in the
    // `tax_receipt_issued` audit payload's `fiscal_year`. Any future §87 RC-
    // register / ภพ.30 report (T065b, unbuilt) MUST bucket RC receipts by THAT
    // payment fiscal year, never by this column. The current readers of this
    // column (F9 YTD-paid-revenue KPI + the invoice list `fiscalYear` filter)
    // are intentionally on the bill/issue-FY basis — leave them unchanged.
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
    // 064-event-invoice-paid-flow (Task 2) — WHAT the main PDF actually is,
    // persisted at issue time: §86/4 'invoice', combined §86/4+§105ทวิ
    // 'receipt_combined', or §105 'receipt_separate'. NULL on draft ONLY
    // (no main PDF yet) — `invoices_non_draft_has_doc_kind` enforces
    // presence on every non-draft row, and `invoices_pdf_doc_kind_valid`
    // pins the value set. Migration 0211 backfilled pre-existing rows
    // (054 no-TIN event rows → 'receipt_separate'; all other non-draft →
    // 'invoice'). Downstream (J2 credit-note annotation re-render) reads
    // this instead of re-deriving, so a receipt-titled original can never
    // be overwritten by an invoice-titled re-render.
    pdfDocKind: text('pdf_doc_kind'),
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

    // 088-invoice-tax-flow-redesign (T006, migration 0231) — the pre-payment
    // ใบแจ้งหนี้'s NON-§87 bill number (e.g. SC-2026-000123), allocated at
    // issue from the `bill` stream. Disjoint from sequence_number /
    // document_number so it can NEVER enter invoices_tenant_fiscal_seq_unique
    // (SC-003); has its own per-tenant partial unique index
    // invoices_tenant_bill_raw_uniq below. NULL for drafts + all pre-088 rows.
    // Written once in the draft→issued UPDATE, then locked by
    // invoices_enforce_immutability (migration 0231, mirrors document_number).
    billDocumentNumberRaw: text('bill_document_number_raw'),

    // 088-invoice-tax-flow-redesign (T055, migration 0234, US8 / § F.8) —
    // per-invoice VAT treatment (case-by-case, NOT per-member). 'standard' =
    // VAT 7% (membership + all defaults); 'zero_rated_80_1_5' = VAT 0% embassy /
    // int'l-org zero-rate (§80/1(5)). NOT NULL DEFAULT 'standard' → every
    // pre-088 row backfills cleanly; the value DRIVES the VAT rate (FR-025).
    // Pinned at issue, then locked by invoices_enforce_immutability (0234).
    vatTreatment: text('vat_treatment').notNull().default('standard'),
    // MFA (Protocol Dept) certificate particulars — REQUIRED when zero-rated
    // (fail-closed, invoices_zero_rate_cert_required CHECK below + app layer).
    // NULL on every standard row. Also pinned/locked at issue (0234).
    zeroRateCertNo: text('zero_rate_cert_no'),
    zeroRateCertDate: date('zero_rate_cert_date'),
    // Optional Vercel-Blob key of the cert scan (tax-document class, 10y,
    // admin-only — reference only, NOT appended to the PDF).
    zeroRateCertBlobKey: text('zero_rate_cert_blob_key'),

    // 054-event-fee-invoices (code-review HIGH-3) — retryable PDF-blob purge
    // marker for the 10-year non-member event-buyer PII redaction sweep.
    // Set to now() ONLY by the redact-expired-event-buyers cron AFTER it has
    // successfully purged every PDF-blob key on the row (invoice + receipt
    // bytes), in a SEPARATE UPDATE under the `app.allow_pii_redaction` GUC.
    // NULL is the natural state for every non-redacted row AND for a row whose
    // DB snapshot was tombstoned but whose blob purge has not yet completed
    // (e.g. a crash between commit and purge). The cron's eligibility predicate
    // re-selects redacted-but-NULL rows so the purge is retried until it lands,
    // closing the GDPR Art.17 gap where PII PDF bytes could otherwise persist
    // on Blob forever. Locked by `invoices_enforce_immutability` on the normal
    // path; EXEMPT under the redaction GUC (migration 0206), alongside
    // `member_identity_snapshot`.
    piiBlobPurgedAt: timestamp('pii_blob_purged_at', { withTimezone: true }),

    // Bug 10 — void §86/4 PDF re-stamp reconcile marker (migration 0270). Set on
    // a Phase-2 blob_upload-leg failure; the void-pdf-reconcile cron re-renders
    // + re-uploads the VOID overlay until the served doc carries it. `attempts`
    // is SQL-incremented (race-safe); `parked_at` is reserved for genuine
    // corruption (transient infra retries indefinitely — never abandon a
    // voided tax document un-stamped).
    voidPdfReconcilePendingAt: timestamp('void_pdf_reconcile_pending_at', {
      withTimezone: true,
    }),
    voidPdfReconcileAttempts: smallint('void_pdf_reconcile_attempts')
      .notNull()
      .default(0),
    voidPdfReconcileParkedAt: timestamp('void_pdf_reconcile_parked_at', {
      withTimezone: true,
    }),

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
    //
    // speckit-review hardening (FIX A, migration 0208) — TIGHTENED so the
    // discriminator also FORBIDS the opposite subject's columns and couples
    // `vat_inclusive`, making illegal states un-representable:
    //   membership ⇒ event_id IS NULL AND event_registration_id IS NULL
    //                AND vat_inclusive = false  (membership is VAT-EXCLUSIVE)
    //   event      ⇒ plan_id IS NULL AND plan_year IS NULL
    // (vat_inclusive is unconstrained for the event subject — a ticket may be
    // priced VAT-inclusive or VAT-exclusive.) Mirrors the live predicate after
    // migration 0208 exactly.
    check(
      'invoices_subject_fields_ck',
      sql`(
        (invoice_subject = 'membership'
          AND member_id IS NOT NULL AND plan_id IS NOT NULL AND plan_year IS NOT NULL
          AND event_id IS NULL AND event_registration_id IS NULL AND vat_inclusive = false)
        OR
        (invoice_subject = 'event'
          AND event_registration_id IS NOT NULL AND event_id IS NOT NULL
          AND plan_id IS NULL AND plan_year IS NULL)
      )`,
    ),
    // 054-event-fee-invoices (Task 7) — non-draft snapshot completeness.
    // Mirrors the LIVE predicate after migration 0212 (hand-authored there in
    // the idempotent DO-block; declared here so the Drizzle schema reflects the
    // current DB shape). Every non-draft row must carry the full snapshot +
    // pdf set; TWO conditional relaxations exist:
    //   (1) 0203 — the membership-only `pro_rate_policy_snapshot`, which an
    //       event invoice legitimately leaves NULL (pro-rating has no meaning
    //       for a ticket fee);
    //   (2) 0212 (064 Task 9, beta numbering) — the invoice-stream pair
    //       `sequence_number` + `document_number` must BOTH be NULL on the
    //       relaxed leg, which applies ONLY when `invoice_subject = 'event'
    //       AND receipt_document_number_raw IS NOT NULL`: an as-paid no-TIN
    //       event invoice is a S105 receipt numbered from the RECEIPT
    //       stream, and `invoices_tenant_fiscal_seq_unique` has no stream
    //       discriminator, so a receipt number must never occupy
    //       `sequence_number` — and a half-pair (a S87 sequence slot
    //       consumed without a document number) must never slip through.
    // `member_identity_snapshot` stays REQUIRED for both subjects (the S86/4
    // buyer snapshot). Pre-0203 this CHECK lived only in migration 0019/0024
    // SQL; the matching builder exists for schema fidelity.
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
          AND (
            (sequence_number IS NOT NULL AND document_number IS NOT NULL)
            OR (bill_document_number_raw IS NOT NULL
                AND sequence_number IS NULL AND document_number IS NULL)
            OR (receipt_document_number_raw IS NOT NULL
                AND sequence_number IS NULL AND document_number IS NULL)
          )
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
    // 064-event-invoice-paid-flow (Task 9) — numbering presence on non-draft
    // rows. Mirrors the LIVE predicate after migration 0212 (originally
    // migration 0019; relaxed by 0212 with the same conditional receipt-stream
    // leg as `invoices_non_draft_has_snapshots` above). Declared here for
    // schema fidelity — pre-0212 this CHECK lived only in migration SQL.
    check(
      'invoices_draft_has_no_number',
      sql`(
        status = 'draft'
        OR sequence_number IS NOT NULL
        OR bill_document_number_raw IS NOT NULL
        OR (invoice_subject = 'event' AND receipt_document_number_raw IS NOT NULL)
      )`,
    ),
    // 064-event-invoice-paid-flow (Task 2) — pdf_doc_kind invariants.
    // Mirror the LIVE predicates after migration 0211 exactly (same
    // schema-fidelity treatment as `invoices_non_draft_has_snapshots`
    // above): the value set is pinned, and every non-draft row must say
    // what its main PDF is (drafts have no main PDF → NULL).
    check(
      'invoices_pdf_doc_kind_valid',
      sql`(
        pdf_doc_kind IS NULL
        OR pdf_doc_kind IN ('invoice','receipt_combined','receipt_separate')
      )`,
    ),
    check(
      'invoices_non_draft_has_doc_kind',
      sql`(status = 'draft' OR pdf_doc_kind IS NOT NULL)`,
    ),
    // 088-invoice-tax-flow-redesign (T055, migration 0234, US8 / § F.8.2) —
    // mirror the LIVE predicates so the Drizzle schema reflects the DB shape.
    // (a) accepted-value gate; (b) fail-closed cert-required-when-zero-rated;
    // (c) US8 review fix — membership can never be zero-rated (FR-023 layer 3).
    check(
      'invoices_vat_treatment_valid',
      sql`vat_treatment IN ('standard', 'zero_rated_80_1_5')`,
    ),
    check(
      'invoices_zero_rate_cert_required',
      sql`vat_treatment <> 'zero_rated_80_1_5' OR zero_rate_cert_no IS NOT NULL`,
    ),
    check(
      'invoices_membership_is_standard',
      sql`invoice_subject <> 'membership' OR vat_treatment = 'standard'`,
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
    // 064-event-invoice-paid-flow (Task 10, migration 0213) — receipt-number
    // uniqueness backstop. receipt_document_number_raw carries S87
    // RECEIPT-stream numbers from two writers (recordPayment separate-mode +
    // issueEventInvoiceAsPaid no-TIN beta); the invoice stream has
    // invoices_tenant_fiscal_seq_unique as its duplicate backstop but the
    // receipt stream had none. Partial: NULL rows (drafts, combined-mode)
    // stay outside; per-tenant scope (tenants legitimately share raws).
    uniqueIndex('invoices_tenant_receipt_raw_uniq')
      .on(table.tenantId, table.receiptDocumentNumberRaw)
      .where(sql`receipt_document_number_raw IS NOT NULL`),
    // 088-invoice-tax-flow-redesign (T006, migration 0231) — per-tenant
    // uniqueness backstop for the NON-§87 bill number. Mirrors the receipt-raw
    // index above; partial (NULL drafts/pre-088 rows stay outside), per-tenant
    // (tenants legitimately share raws). Disjoint from
    // invoices_tenant_fiscal_seq_unique so a bill number can never collide with
    // a §87 tax number (SC-003).
    uniqueIndex('invoices_tenant_bill_raw_uniq')
      .on(table.tenantId, table.billDocumentNumberRaw)
      .where(sql`bill_document_number_raw IS NOT NULL`),
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
    // Bug 10 — the void-pdf-reconcile cron scans only actionable rows.
    index('invoices_void_pdf_reconcile_pending_idx')
      .on(table.voidPdfReconcilePendingAt)
      .where(
        sql`void_pdf_reconcile_pending_at IS NOT NULL AND void_pdf_reconcile_parked_at IS NULL`,
      ),
  ],
);

export type InvoiceRow = typeof invoices.$inferSelect;
export type NewInvoiceRow = typeof invoices.$inferInsert;
