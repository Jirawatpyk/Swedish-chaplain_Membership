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
    registrationFeeSatang: bigint('registration_fee_satang', { mode: 'bigint' })
      .notNull()
      .default(0n),

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
