/**
 * #731 (task 55) — a REFUNDABLE F5 fixture plus an orphan pending refund, so
 * a relay run can exercise the stale-pending-refund sweep's orphan close
 * (#716 / #50) on the `swecham` tenant. The integration-test orphans on the
 * dev branch all belong to throw-away `test-*` tenants, and the cron sweeps
 * swecham only, so without this seed the live close never runs.
 *
 * What it seeds (idempotent — a re-run reuses every row and the Stripe PI):
 *   1. A real Stripe TEST-MODE PaymentIntent on swecham's connected account,
 *      confirmed with `pm_card_visa` for the invoice total (so it is
 *      `succeeded` and genuinely refundable at Stripe). A re-run retrieves the
 *      PI already on the payment row instead of creating another one.
 *   2. A `payments` row (`succeeded`, that PI + its charge id) on a PAID
 *      swecham membership invoice that has no active payment yet (the
 *      `payments_one_active_per_invoice` index allows one). Pass
 *      `F5_REFUNDABLE_INVOICE_DOC=<SC-…>` to pick one; otherwise the newest
 *      eligible paid invoice is used. The invoice was paid offline by its own
 *      seed, so dev then shows it paid both ways (offline + this card row);
 *      KPIs read amounts from `invoices`, so nothing double counts.
 *   3. An ORPHAN `refunds` row on it: `pending`, `processor_refund_id` NULL,
 *      `initiated_at` = now − 25 h (past the sweep's 24 h floor), for 100 THB.
 *      Nothing was ever sent to Stripe for it, so a sweep run lists the PI's
 *      refunds, finds none, and closes the row `failed`
 *      (`failure_reason_code = 'no_processor_refund'`, on the row and in the `refund_failed` audit).
 *
 * DEV ONLY. It refuses unless ALL of:
 *   - `DATABASE_URL` passes `assertDbHostNotBlocklisted` (TEST_DB_HOST_BLOCKLIST);
 *   - `STRIPE_SECRET_KEY` is a test key (`sk_test_…`);
 *   - swecham's `processor_account_id` is a real test account, not the
 *     `acct_test_e2e_fixture` placeholder `seed-f5-e2e-payment-settings` writes
 *     when `STRIPE_ACCOUNT_ID_SWECHAM` is unset;
 *   - `TENANT_SLUG` is `swecham`.
 *
 * Depends on: `seed-e2e-user` (the e2e-admin actor), `seed-e2e-portal-invoices`
 * (paid invoices), `seed-f5-e2e-payment-settings` with a real test account.
 *
 * Usage:
 *   pnpm seed:f5-e2e:refundable
 *   # then run the sweep once (cron bearer) and check the refund row.
 */
import Stripe from 'stripe';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { users } from '@/modules/auth/infrastructure/db/schema';
import {
  payments,
  refunds,
  tenantPaymentSettings,
} from '@/modules/payments/infrastructure/schema';
import { assertDbHostNotBlocklisted } from '../tests/helpers/db-host-guard';

const TENANT_SLUG = process.env.TENANT_SLUG ?? 'swecham';
const SEED_ACTOR_EMAIL = 'e2e-admin@swecham.test';
const FIXTURE_ACCOUNT_PLACEHOLDER = 'acct_test_e2e_fixture';

// Deterministic ids (`RE_ULID_LIKE`-safe: no i / l / o / u).
const PAYMENT_ID = 'pmt_e2e_f5_rfndabe_card_xxxxxxxxxx';
const ORPHAN_REFUND_ID = 'rfnd_e2e_f5_stab_pndng_xxxxxxxxxxx';
const ORPHAN_AMOUNT_SATANG = 10_000n; // 100 THB
const ORPHAN_AGE_MS = 25 * 60 * 60 * 1000;

function refuseUnlessDev(): TenantContext {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('seed-f5-e2e-refundable: DATABASE_URL is not set.');
  assertDbHostNotBlocklisted(url, process.env.TEST_DB_HOST_BLOCKLIST, 'seed-f5-e2e-refundable');
  if (!env.stripe.secretKey.startsWith('sk_test_')) {
    throw new Error('seed-f5-e2e-refundable: STRIPE_SECRET_KEY is not a test key (sk_test_…). Refusing.');
  }
  if (TENANT_SLUG !== 'swecham') {
    throw new Error(`seed-f5-e2e-refundable: refusing TENANT_SLUG="${TENANT_SLUG}". Only 'swecham'.`);
  }
  return asTenantContext('swecham');
}

async function connectedAccount(ctx: TenantContext): Promise<string> {
  const rows = await runInTenant(ctx, (tx) =>
    tx
      .select({ account: tenantPaymentSettings.processorAccountId })
      .from(tenantPaymentSettings)
      .where(eq(tenantPaymentSettings.tenantId, ctx.slug))
      .limit(1),
  );
  const account = rows[0]?.account;
  if (!account) {
    throw new Error('seed-f5-e2e-refundable: no tenant_payment_settings for swecham. Run seed-f5-e2e-payment-settings first.');
  }
  if (account === FIXTURE_ACCOUNT_PLACEHOLDER) {
    throw new Error(
      'seed-f5-e2e-refundable: swecham uses the fixture account placeholder. Set STRIPE_ACCOUNT_ID_SWECHAM to a real test account and re-run seed-f5-e2e-payment-settings.',
    );
  }
  return account;
}

async function seedActorUserId(): Promise<string> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, SEED_ACTOR_EMAIL))
    .limit(1);
  if (!rows[0]) throw new Error(`seed-f5-e2e-refundable: ${SEED_ACTOR_EMAIL} not found. Run seed-e2e-user first.`);
  return rows[0].id;
}

interface Target {
  /** The PI already on the seeded payment row, when a previous run made it. */
  readonly existingIntentId: string | null;
  readonly existingStatus: string | null;
  readonly invoiceId: string;
  readonly memberId: string;
  readonly docNumber: string;
  readonly totalSatang: bigint;
}

/** A paid membership invoice the payment row can sit on (or already sits on). */
async function findTarget(ctx: TenantContext): Promise<Target> {
  return runInTenant(ctx, async (tx) => {
    const existing = await tx
      .select({
        invoiceId: payments.invoiceId,
        intentId: payments.processorPaymentIntentId,
        status: payments.status,
      })
      .from(payments)
      .where(and(eq(payments.tenantId, ctx.slug), eq(payments.id, PAYMENT_ID)))
      .limit(1);
    const wantedDoc = process.env.F5_REFUNDABLE_INVOICE_DOC;
    const candidates = await tx
      .select({
        invoiceId: invoices.invoiceId,
        memberId: invoices.memberId,
        documentNumber: invoices.documentNumber,
        billDocumentNumberRaw: invoices.billDocumentNumberRaw,
        totalSatang: invoices.totalSatang,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, ctx.slug),
          eq(invoices.status, 'paid'),
          // A membership invoice (event-fee bills carry no member).
          sql`${invoices.memberId} IS NOT NULL`,
          existing[0]
            ? eq(invoices.invoiceId, existing[0].invoiceId)
            : and(
                wantedDoc
                  ? sql`(${invoices.documentNumber} = ${wantedDoc} OR ${invoices.billDocumentNumberRaw} = ${wantedDoc})`
                  : undefined,
                // One settlement row per invoice: never seed on an invoice
                // that already has an active payment.
                sql`NOT EXISTS (
                  SELECT 1 FROM payments p
                  WHERE p.tenant_id = ${ctx.slug}
                    AND p.invoice_id = ${invoices.invoiceId}
                    AND p.status IN ('pending','succeeded','partially_refunded')
                )`,
              ),
        ),
      )
      .orderBy(desc(invoices.paidAt))
      .limit(1);
    const row = candidates[0];
    if (!row || row.memberId === null) {
      throw new Error(
        'seed-f5-e2e-refundable: no paid membership invoice without an active payment. Run seed-e2e-portal-invoices, or pass F5_REFUNDABLE_INVOICE_DOC.',
      );
    }
    return {
      existingIntentId: existing[0]?.intentId ?? null,
      existingStatus: existing[0]?.status ?? null,
      invoiceId: row.invoiceId,
      memberId: row.memberId,
      docNumber: row.documentNumber ?? row.billDocumentNumberRaw ?? row.invoiceId,
      totalSatang: BigInt(row.totalSatang as unknown as string),
    };
  });
}

async function confirmedTestIntent(
  account: string,
  target: Target,
): Promise<{ id: string; chargeId: string }> {
  const stripe = new Stripe(env.stripe.secretKey, {
    apiVersion: env.stripe.apiVersion as unknown as '2026-03-25.dahlia',
  });
  const onBehalf = account !== env.stripe.accountIdSwecham ? { stripeAccount: account } : {};
  const pi = target.existingIntentId
    ? await stripe.paymentIntents.retrieve(target.existingIntentId, undefined, onBehalf)
    : await stripe.paymentIntents.create(
    {
      amount: Number(target.totalSatang),
      currency: 'thb',
      payment_method: 'pm_card_visa',
      payment_method_types: ['card'],
      confirm: true,
      metadata: { tenantId: 'swecham', invoiceId: target.invoiceId, paymentId: PAYMENT_ID, seed: 'f5-e2e-refundable' },
    },
    { idempotencyKey: `seed-f5-refundable-${target.invoiceId}`, ...onBehalf },
  );
  if (pi.status !== 'succeeded' || typeof pi.latest_charge !== 'string') {
    throw new Error(`seed-f5-e2e-refundable: test PaymentIntent ${pi.id} is ${pi.status}, expected succeeded.`);
  }
  return { id: pi.id, chargeId: pi.latest_charge };
}

async function main(): Promise<void> {
  const ctx = refuseUnlessDev();
  const account = await connectedAccount(ctx);
  const actorUserId = await seedActorUserId();
  const target = await findTarget(ctx);
  if (target.existingStatus !== null && target.existingStatus !== 'succeeded') {
    throw new Error(
      `seed-f5-e2e-refundable: the seeded payment is now ${target.existingStatus} (a real refund ran on it), so a reset orphan could exceed what is left to refund. Delete ${PAYMENT_ID} on dev to start over.`,
    );
  }
  const pi = await confirmedTestIntent(account, target);
  const now = Date.now();

  await runInTenant(ctx, async (tx) => {
    await tx
      .insert(payments)
      .values({
        id: PAYMENT_ID,
        tenantId: ctx.slug,
        invoiceId: target.invoiceId,
        memberId: target.memberId,
        method: 'card',
        status: 'succeeded',
        amountSatang: target.totalSatang,
        currency: 'THB',
        processorPaymentIntentId: pi.id,
        processorChargeId: pi.chargeId,
        processorEnvironment: 'test',
        attemptSeq: 90,
        cardBrand: 'visa',
        cardLast4: '4242',
        cardExpMonth: 12,
        cardExpYear: 2034,
        failureReasonCode: null,
        initiatedAt: new Date(now - 2 * ORPHAN_AGE_MS),
        completedAt: new Date(now - 2 * ORPHAN_AGE_MS),
        actorUserId,
        correlationId: `seed-f5-refundable-${target.invoiceId}`,
      })
      .onConflictDoNothing({ target: payments.id });

    // Reset the orphan to its seeded state on every run, so the relay can
    // re-exercise the close after a sweep flipped it `failed`.
    await tx
      .delete(refunds)
      .where(and(eq(refunds.tenantId, ctx.slug), inArray(refunds.id, [ORPHAN_REFUND_ID])));
    await tx.insert(refunds).values({
      id: ORPHAN_REFUND_ID,
      tenantId: ctx.slug,
      paymentId: PAYMENT_ID,
      invoiceId: target.invoiceId,
      amountSatang: ORPHAN_AMOUNT_SATANG,
      reason: 'Seeded orphan for the stale-pending sweep (#731)',
      status: 'pending',
      processorRefundId: null,
      initiatedAt: new Date(now - ORPHAN_AGE_MS),
      initiatorUserId: actorUserId,
      correlationId: 'seed-f5-refundable-orphan',
    });
  });

  console.log('\n----------------------------------------');
  console.log('F5 refundable fixture seeded (swecham, Stripe test mode):');
  console.log(`  invoice        ${target.docNumber} (${target.invoiceId})`);
  console.log(`  payment        ${PAYMENT_ID} → ${pi.id}`);
  console.log(`  orphan refund  ${ORPHAN_REFUND_ID} (pending, no processor id, initiated 25 h ago)`);
  console.log('----------------------------------------');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    // Ids and codes only: a StripeError carries raw headers, can echo
    // submitted values in its message and, on a card error, payment-method
    // details (PCI review, #731). The seed's own guard errors are plain
    // Errors with no Stripe `type`, so their message is safe to print.
    const e = error as { type?: string; code?: string; requestId?: string; message?: string };
    console.error(
      'seed-f5-e2e-refundable failed:',
      e.type ?? (error instanceof Error ? error.constructor.name : 'unknown'),
      e.code ?? '',
      e.requestId ?? '',
      e.type === undefined ? (e.message ?? String(error)) : '',
    );
    process.exit(1);
  });
