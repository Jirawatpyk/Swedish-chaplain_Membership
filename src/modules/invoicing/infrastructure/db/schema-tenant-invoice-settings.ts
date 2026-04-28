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
    taxId: text('tax_id').notNull(),
    registeredAddressTh: text('registered_address_th').notNull(),
    registeredAddressEn: text('registered_address_en').notNull(),

    invoiceNumberPrefix: text('invoice_number_prefix').notNull(),
    invoiceNumberResetCadence: numberingResetCadenceEnum('invoice_number_reset_cadence')
      .notNull()
      .default('yearly'),
    receiptNumberingMode: text('receipt_numbering_mode').notNull().default('combined'),
    creditNoteNumberPrefix: text('credit_note_number_prefix').notNull(),

    fiscalYearStartMonth: smallint('fiscal_year_start_month').notNull().default(1),

    defaultNetDays: smallint('default_net_days').notNull().default(30),
    proRatePolicy: proRatePolicyEnum('pro_rate_policy').notNull().default('monthly'),

    logoBlobKey: text('logo_blob_key'),
    autoEmailEnabled: boolean('auto_email_enabled').notNull().default(true),
    billingReplyToEmail: text('billing_reply_to_email'),
    billingFromName: text('billing_from_name'),
    tenantLogoCount: integer('tenant_logo_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'receipt_numbering_mode_check',
      sql`${table.receiptNumberingMode} IN ('combined', 'separate')`,
    ),
  ],
);

export type TenantInvoiceSettingsRow = typeof tenantInvoiceSettings.$inferSelect;
export type NewTenantInvoiceSettingsRow = typeof tenantInvoiceSettings.$inferInsert;
