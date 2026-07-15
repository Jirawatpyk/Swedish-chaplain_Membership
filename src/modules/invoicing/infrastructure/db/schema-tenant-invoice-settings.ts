/**
 * T012 — Drizzle schema for `tenant_invoice_settings` (F4).
 *
 * Migration: drizzle/migrations/0019_invoicing_tables.sql § tenant_invoice_settings.
 *
 * Kept in Infrastructure layer (Principle III): Domain + Application
 * must NEVER import this file; they work through a
 * `TenantSettingsRepoPort` interface + adapter. ESLint barrel guard
 * enforces.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  char,
  numeric,
  bigint,
  smallint,
  integer,
  boolean,
  timestamp,
  pgEnum,
  check,
} from 'drizzle-orm/pg-core';

export const proRatePolicyEnum = pgEnum('pro_rate_policy', ['none', 'monthly', 'daily']);
export const numberingResetCadenceEnum = pgEnum('numbering_reset_cadence', ['yearly', 'perpetual']);

export const tenantInvoiceSettings = pgTable(
  'tenant_invoice_settings',
  {
    tenantId: text('tenant_id').primaryKey(),

    vatRate: numeric('vat_rate', { precision: 5, scale: 4 }).notNull(),
    // Staff-review R2 R022 (2026-04-28): use raw SQL `0` instead of
    // BigInt literal `0n` because drizzle-kit 0.30.x cannot
    // JSON.serialize BigInt defaults when generating snapshots
    // (TypeError: Do not know how to serialize a BigInt). The DB
    // column is still `BIGINT NOT NULL DEFAULT 0` either way; only the
    // TS-side default representation changes.
    registrationFeeSatang: bigint('registration_fee_satang', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    // R7 consolidation (migration 0026) — tenant currency migrated
    // from F2 `tenant_fee_config.currency_code`. ISO 4217, 3 upper-
    // case letters enforced at DB level + at Application validation.
    // F2 plan module reads this via the new `TenantTaxPolicyPort`.
    currencyCode: text('currency_code').notNull().default('THB'),

    legalNameTh: text('legal_name_th').notNull(),
    legalNameEn: text('legal_name_en').notNull(),
    // 064 — the tenant's SHORT / brand name (e.g. "SweCham"), printed as the
    // prefix on the §86/4 membership line ("SweCham Regular Corporate Membership
    // Fee 2026 (…)"). Nullable — when unset the prefix is simply omitted. Distinct
    // from the full registered `legal_name_*` (which prints in the document header).
    brandName: text('brand_name'),
    taxId: text('tax_id').notNull(),
    registeredAddressTh: text('registered_address_th').notNull(),
    registeredAddressEn: text('registered_address_en').notNull(),

    invoiceNumberPrefix: text('invoice_number_prefix').notNull(),
    invoiceNumberResetCadence: numberingResetCadenceEnum('invoice_number_reset_cadence')
      .notNull()
      .default('yearly'),
    receiptNumberingMode: text('receipt_numbering_mode').notNull().default('combined'),
    // Receipt-number prefix for the §86/4 RC-role receipt register. Nullable —
    // when null the record-payment / issue-event-invoice-as-paid use cases fall
    // back to 'RC' (088 US7; disjoint from the §105 'receipt_105' register's
    // hardcoded 'RE'). 'RE' is reserved and rejected by the settings update path.
    // Added by migration 0142.
    receiptNumberPrefix: text('receipt_number_prefix'),
    creditNoteNumberPrefix: text('credit_note_number_prefix').notNull(),

    fiscalYearStartMonth: smallint('fiscal_year_start_month').notNull().default(1),

    defaultNetDays: smallint('default_net_days').notNull().default(30),
    proRatePolicy: proRatePolicyEnum('pro_rate_policy').notNull().default('monthly'),

    logoBlobKey: text('logo_blob_key'),
    autoEmailEnabled: boolean('auto_email_enabled').notNull().default(true),
    billingReplyToEmail: text('billing_reply_to_email'),
    billingFromName: text('billing_from_name'),
    tenantLogoCount: integer('tenant_logo_count').notNull().default(0),

    // 088-invoice-tax-flow-redesign (US5 / T039 / FR-012 / data-model § F.7) —
    // tenant-configurable withholding-tax (WHT) footer note. Rendered on
    // `invoice_subject='membership'` documents ONLY (both the ใบแจ้งหนี้ bill AND
    // the §86/4 tax receipt), NEVER event documents. NULL ⇒ render nothing. The
    // text is PINNED into the immutable `TenantIdentitySnapshot` at issue
    // (FR-011) — the template reads the snapshot, never live settings.
    whtNoteTh: text('wht_note_th'),
    whtNoteEn: text('wht_note_en'),

    // 088 US5 / T039 (§ C.2 / § F.7) — seller §86/4 Head-Office/Branch particular
    // pinned into the tenant snapshot at issue. `seller_is_head_office=true` =
    // สำนักงานใหญ่ (TSCC default); `false` = a branch identified by the 5-digit RD
    // `seller_branch_code`. The pairing CHECK below mirrors the member branch
    // pairing (migration 0232) + the update-tenant-invoice-settings superRefine.
    sellerIsHeadOffice: boolean('seller_is_head_office').notNull().default(true),
    sellerBranchCode: char('seller_branch_code', { length: 5 }),

    // 088 US5 / T039 (FR-022 / § F.7) — offline-payment bank block, rendered on
    // the ใบแจ้งหนี้ (bill) ONLY (never the paid §86/4 tax receipt). All NULL by
    // default ⇒ no bank block. Structured fields (NOT one free-text blob) so the
    // template lays out a clean bilingual payment box + the free-text
    // `payment_instructions_*` line carries any extra cheque/fee note. Pinned
    // into the tenant snapshot at issue (immutable, FR-011).
    bankPayeeName: text('bank_payee_name'),
    bankAccountNo: text('bank_account_no'),
    bankAccountType: text('bank_account_type'),
    bankName: text('bank_name'),
    bankBranch: text('bank_branch'),
    bankAddress: text('bank_address'),
    bankSwift: text('bank_swift'),
    paymentInstructionsTh: text('payment_instructions_th'),
    paymentInstructionsEn: text('payment_instructions_en'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'receipt_numbering_mode_check',
      sql`${table.receiptNumberingMode} IN ('combined', 'separate')`,
    ),
    // 088 US5 / T039 — seller Head-Office/Branch pairing: a head office carries a
    // NULL code; a branch carries an exactly-5-digit code. `char(5)` space-pads a
    // shorter value → the `^[0-9]{5}$` anchor also enforces the digit count.
    // NULL-safe: the branch leg carries an explicit `IS NOT NULL` so a
    // `(false, NULL)` row evaluates FALSE (rejected), not NULL (which a Postgres
    // CHECK treats as satisfied). See migration 0233 comment.
    check(
      'tenant_invoice_settings_seller_branch_ck',
      sql`(${table.sellerIsHeadOffice} = true AND ${table.sellerBranchCode} IS NULL)
        OR (${table.sellerIsHeadOffice} = false AND ${table.sellerBranchCode} IS NOT NULL AND ${table.sellerBranchCode} ~ '^[0-9]{5}$')`,
    ),
  ],
);

export type TenantInvoiceSettingsRow = typeof tenantInvoiceSettings.$inferSelect;
export type NewTenantInvoiceSettingsRow = typeof tenantInvoiceSettings.$inferInsert;
