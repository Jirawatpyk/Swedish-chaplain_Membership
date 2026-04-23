/**
 * T027 — Drizzle schema for F5 Online Payment tables.
 *
 * Migrations: drizzle/migrations/{0033_create_payments, 0034_create_refunds,
 * 0035_create_tenant_payment_settings, 0036_create_processor_events}.sql.
 *
 * 4 pgTable definitions mirroring the migrations exactly. Inferred
 * insert/select types live HERE (Infrastructure layer) and MUST NOT
 * leak into Application or Domain (Constitution Principle III).
 * Repository adapters translate between these DTOs and the Domain's
 * `Payment`, `Refund`, `TenantPaymentSettings`, `ProcessorEvent`
 * aggregates.
 *
 * Tenant isolation: every tenant-scoped table uses `tenant_id text`
 * scoped by RLS+FORCE (see migrations). `processor_events.tenant_id`
 * is NULL-allowed during the pre-resolution window; see data-model.md
 * § 5.4 for the special 4-policy RLS setup.
 *
 * Relations: `payments → refunds` (one-to-many), `refunds → credit_notes`
 * (many-to-one via `refunds.credit_note_id` nullable FK). Relations are
 * declared for Drizzle query-builder joins; no schema change implied.
 *
 * NOTE: this module is Infrastructure. It MUST NOT be exported from
 * `src/modules/payments/index.ts` barrel — ESLint barrel-guard rule
 * enforces Domain-type-only exports.
 */
import {
  bigint,
  boolean,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';

// ---------------------------------------------------------------------------
// 1. payments
// ---------------------------------------------------------------------------

/**
 * One row per Stripe PaymentIntent attempt. See migration 0033 + data-
 * model.md § 2. `id` is a TEXT ULID (application-generated); FK to
 * invoices uses composite `(tenant_id, invoice_id)`.
 */
export const payments = pgTable('payments', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  invoiceId: text('invoice_id').notNull(), // uuid at DB; Drizzle reads as string
  memberId: text('member_id').notNull(),
  method: text('method').notNull(), // 'card' | 'promptpay' (CHECK at DB)
  status: text('status').notNull(), // 6-state enum (CHECK at DB)
  amountSatang: bigint('amount_satang', { mode: 'bigint' }).notNull(),
  currency: text('currency').notNull().default('THB'),
  processorPaymentIntentId: text('processor_payment_intent_id').notNull(),
  processorChargeId: text('processor_charge_id'),
  processorEnvironment: text('processor_environment').notNull(), // 'test' | 'live'
  attemptSeq: integer('attempt_seq').notNull().default(1),
  cardBrand: text('card_brand'),
  cardLast4: text('card_last4'),
  cardExpMonth: smallint('card_exp_month'),
  cardExpYear: smallint('card_exp_year'),
  failureReasonCode: text('failure_reason_code'),
  initiatedAt: timestamp('initiated_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  actorUserId: text('actor_user_id').notNull(), // uuid at DB
  correlationId: text('correlation_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PaymentRow = typeof payments.$inferSelect;
export type NewPaymentRow = typeof payments.$inferInsert;

// ---------------------------------------------------------------------------
// 2. refunds
// ---------------------------------------------------------------------------

/**
 * One row per refund attempt against a succeeded Payment. See migration
 * 0034 + data-model.md § 3. Single-column FK to payments.id; composite
 * FK to credit_notes via (tenant_id, credit_note_id) — credit_note_id
 * is nullable until the refund succeeds.
 */
export const refunds = pgTable('refunds', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  paymentId: text('payment_id').notNull(),
  invoiceId: text('invoice_id').notNull(), // uuid at DB
  amountSatang: bigint('amount_satang', { mode: 'bigint' }).notNull(),
  reason: text('reason').notNull(),
  status: text('status').notNull(), // 'pending' | 'succeeded' | 'failed'
  processorRefundId: text('processor_refund_id'),
  failureReasonCode: text('failure_reason_code'),
  creditNoteId: text('credit_note_id'), // uuid at DB; nullable
  initiatedAt: timestamp('initiated_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  initiatorUserId: text('initiator_user_id').notNull(), // uuid at DB
  correlationId: text('correlation_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type RefundRow = typeof refunds.$inferSelect;
export type NewRefundRow = typeof refunds.$inferInsert;

// ---------------------------------------------------------------------------
// 3. tenant_payment_settings
// ---------------------------------------------------------------------------

/**
 * Per-tenant F5 configuration. PK = tenant_id (one row per tenant).
 * See migration 0035 + data-model.md § 4. Secret keys NOT stored here —
 * env vars only (Constitution Principle IV).
 */
export const tenantPaymentSettings = pgTable('tenant_payment_settings', {
  tenantId: text('tenant_id').primaryKey(),
  processor: text('processor').notNull(), // 'stripe' (CHECK)
  processorEnvironment: text('processor_environment').notNull(), // 'test' | 'live'
  processorAccountId: text('processor_account_id').notNull(),
  processorPublishableKey: text('processor_publishable_key').notNull(),
  enabledMethods: text('enabled_methods').array().notNull(), // TEXT[]: ['card','promptpay']
  onlinePaymentEnabled: boolean('online_payment_enabled')
    .notNull()
    .default(true),
  autoEmailOnPayment: boolean('auto_email_on_payment').notNull().default(true),
  promptpayQrExpirySeconds: integer('promptpay_qr_expiry_seconds')
    .notNull()
    .default(900),
  allowAnonymousPaylink: boolean('allow_anonymous_paylink')
    .notNull()
    .default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TenantPaymentSettingsRow =
  typeof tenantPaymentSettings.$inferSelect;
export type NewTenantPaymentSettingsRow =
  typeof tenantPaymentSettings.$inferInsert;

// ---------------------------------------------------------------------------
// 4. processor_events
// ---------------------------------------------------------------------------

/**
 * Append-only idempotency log — PK = Stripe event id. See migration
 * 0036 + data-model.md § 5. `tenantId` is NULL during the pre-resolution
 * webhook window (INSERT policy permits NULL; UPDATE policy fills it
 * post-resolution); `outcome` classifies the webhook handler's decision.
 * DELETE is forbidden by RLS (policy `FOR DELETE USING (false)`).
 */
export const processorEvents = pgTable('processor_events', {
  id: text('id').primaryKey(), // Stripe event id (evt_…)
  tenantId: text('tenant_id'), // NULLable — see data-model.md § 5.4
  eventType: text('event_type').notNull(),
  apiVersion: text('api_version').notNull(),
  livemode: boolean('livemode').notNull(),
  processorAccountId: text('processor_account_id').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  outcome: text('outcome').notNull(), // 5-state enum (CHECK at DB)
  payloadSha256: text('payload_sha256').notNull(),
  correlationId: text('correlation_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ProcessorEventRow = typeof processorEvents.$inferSelect;
export type NewProcessorEventRow = typeof processorEvents.$inferInsert;

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

/**
 * payments → refunds (one-to-many).
 * payments join keyed by payments.id (refunds.payment_id).
 */
export const paymentsRelations = relations(payments, ({ many }) => ({
  refunds: many(refunds),
}));

/**
 * refunds → payments (many-to-one), refunds → credit_notes (many-to-one
 * via nullable credit_note_id FK). The credit-note side composes with
 * F4's own schema via a composite-key-join which drizzle-orm relations()
 * does not natively express with composite keys; repositories perform
 * the join manually when needed. The single-column relation is declared
 * here for type inference on future query-builder use.
 */
export const refundsRelations = relations(refunds, ({ one }) => ({
  payment: one(payments, {
    fields: [refunds.paymentId],
    references: [payments.id],
  }),
  // Composite-key relation: refunds(tenant_id, credit_note_id) →
  // credit_notes(tenant_id, credit_note_id). Drizzle relations() does
  // not currently support composite FKs; repositories (Application
  // consumers) perform this join explicitly when required.
  creditNote: one(creditNotes, {
    fields: [refunds.creditNoteId],
    references: [creditNotes.creditNoteId],
  }),
}));

/**
 * No outbound relation from `tenantPaymentSettings` — it's a singleton
 * lookup keyed by tenant_id. Joins from payments/refunds to settings
 * happen in repositories on demand.
 */

/**
 * No outbound relation from `processorEvents` — webhook-side pre-
 * resolution state is resolved to payments/refunds via business-logic
 * correlation (event_type + payload) at the use-case layer, not via
 * a physical FK.
 */
