/**
 * F5 Phase 5 polish — E2E reconciliation seed
 * (verify-run D2 follow-up, 2026-04-26).
 *
 * Seeds two F5 `payments` rows in `succeeded` state against the
 * existing E2E paid invoices (created by
 * `seed-e2e-portal-invoices.ts`):
 *
 *   • SC-2026-900001 → method='card', card metadata set, charge
 *     id `ch_test_e2e_recon_card`. This is the canonical paid-online
 *     fixture — the test reads `E2E_PAID_ONLINE_INVOICE_ID` and
 *     navigates to its detail page to assert the timeline +
 *     Stripe-dashboard click-through.
 *   • SC-2026-900002 → method='promptpay', no card metadata, no
 *     charge id (parity with the F5 PromptPay rail). Surfaces in
 *     the paid-online filter so the method-badge column gets at
 *     least one of each variant on screen.
 *
 * The 6 "manually-reconciled" invoices in spec.md US3 AS1 are NOT
 * seeded — the E2E asserts the filter HIDES them, which is already
 * true by construction (no F5 payment row → `paidOnlineOnly` filter
 * excludes them). The other paid F4 invoices already in the DB
 * (e.g. members seeded by `seed-f4-e2e-admin-fixtures.ts`) provide
 * that cohort organically.
 *
 * Idempotent — re-running the script:
 *   - upserts each F5 payment row by `(tenant_id, invoice_id, attempt_seq)`
 *     uniqueness; if a row already exists with the same id, it is
 *     left alone.
 *   - prints the canonical `E2E_PAID_ONLINE_INVOICE_ID` for
 *     `.env.local`.
 *
 * Depends on:
 *   - `seed-e2e-portal-invoices.ts` having created the SC-2026-900001
 *     and SC-2026-900002 paid invoices (idempotent itself).
 *   - `seed-f5-e2e-payment-settings.ts` having seeded
 *     tenant_payment_settings for swecham (so the admin page does
 *     not surface the "configure invoicing" empty-state guard).
 *
 * Usage:
 *   pnpm seed:f5-e2e:reconciliation
 *   # or:
 *   node --env-file=.env.local --import tsx scripts/seed-f5-e2e-reconciliation.ts
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { payments } from '@/modules/payments/infrastructure/schema';
import type { NewPaymentRow } from '@/modules/payments/infrastructure/schema';

// `payments.actor_user_id` is FK to users.id — use the e2e-admin
// fixture as a stand-in actor for the seeder. (For real online
// payments, `actor_user_id` is the member's user id; the seed bypasses
// that wiring since the reconciliation surface only renders system
// actor on `invoice_paid` events anyway.)
const SEED_ACTOR_EMAIL = 'e2e-admin@swecham.test';

const TENANT_SLUG = process.env.TENANT_SLUG ?? 'swecham';

// Pinned ids (matches `E2E_PAID_ONLINE_INVOICE_ID` in `.env.local`)
// so re-running the seed leaves the env-var stable across runs.
const PAID_ONLINE_CARD_INVOICE_DOC = 'SC-2026-900001';
const PAID_ONLINE_PROMPTPAY_INVOICE_DOC = 'SC-2026-900002';

// Deterministic ids — `pmt_` prefix matches the Domain ULID-like
// regex enforced by `asPaymentId`.
const CARD_PAYMENT_ID = 'pmt_e2e_reconcile_card_xxxxxxxxxxxx';
const PROMPTPAY_PAYMENT_ID = 'pmt_e2e_reconcile_pp_xxxxxxxxxxxx00';

function requireSwechamTenant(): TenantContext {
  if (TENANT_SLUG !== 'swecham') {
    throw new Error(
      `seed-f5-e2e-reconciliation: refusing to run against TENANT_SLUG="${TENANT_SLUG}". Only 'swecham' allowed.`,
    );
  }
  return asTenantContext('swecham');
}

interface SeedTarget {
  readonly invoiceDocNumber: string;
  readonly paymentId: string;
  readonly method: 'card' | 'promptpay';
  readonly chargeId: string | null;
  readonly cardBrand: string | null;
  readonly cardLast4: string | null;
  readonly cardExpMonth: number | null;
  readonly cardExpYear: number | null;
}

const TARGETS: readonly SeedTarget[] = [
  {
    invoiceDocNumber: PAID_ONLINE_CARD_INVOICE_DOC,
    paymentId: CARD_PAYMENT_ID,
    method: 'card',
    chargeId: 'ch_test_e2e_recon_card',
    cardBrand: 'visa',
    cardLast4: '4242',
    cardExpMonth: 12,
    cardExpYear: 2030,
  },
  {
    invoiceDocNumber: PAID_ONLINE_PROMPTPAY_INVOICE_DOC,
    paymentId: PROMPTPAY_PAYMENT_ID,
    method: 'promptpay',
    chargeId: null,
    cardBrand: null,
    cardLast4: null,
    cardExpMonth: null,
    cardExpYear: null,
  },
];

async function findInvoiceByDocNumber(
  ctx: TenantContext,
  docNumber: string,
): Promise<{ invoiceId: string; memberId: string; totalSatang: bigint; paidAt: Date | null } | null> {
  return runInTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        invoiceId: invoices.invoiceId,
        memberId: invoices.memberId,
        totalSatang: invoices.totalSatang,
        paidAt: invoices.paidAt,
        status: invoices.status,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, ctx.slug),
          eq(invoices.documentNumber, docNumber),
        ),
      )
      .limit(1);
    if (rows.length === 0) return null;
    const row = rows[0]!;
    if (row.status !== 'paid') {
      throw new Error(
        `seed-f5-e2e-reconciliation: ${docNumber} expected status=paid but got ${row.status}. Re-run seed-e2e-portal-invoices first.`,
      );
    }
    return {
      invoiceId: row.invoiceId,
      memberId: row.memberId,
      totalSatang: BigInt(row.totalSatang as unknown as string),
      paidAt: row.paidAt,
    };
  });
}

async function findSeedActorUserId(): Promise<string> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, SEED_ACTOR_EMAIL.toLowerCase()))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(
      `seed-f5-e2e-reconciliation: ${SEED_ACTOR_EMAIL} not found. Run seed-e2e-user first.`,
    );
  }
  return rows[0]!.id;
}

async function upsertSucceededPayment(
  ctx: TenantContext,
  target: SeedTarget,
  actorUserId: string,
): Promise<void> {
  const invoice = await findInvoiceByDocNumber(ctx, target.invoiceDocNumber);
  if (!invoice) {
    throw new Error(
      `seed-f5-e2e-reconciliation: invoice ${target.invoiceDocNumber} not found. Run seed-e2e-portal-invoices first.`,
    );
  }

  const existing = await runInTenant(ctx, async (tx) =>
    tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, ctx.slug),
          eq(payments.id, target.paymentId),
        ),
      )
      .limit(1),
  );
  if (existing.length > 0) {
    console.log(
      `  payment row ${target.paymentId} already exists for ${target.invoiceDocNumber} → leaving as-is`,
    );
    return;
  }

  const initiatedAt = invoice.paidAt ?? new Date();
  const completedAt = invoice.paidAt ?? new Date();
  // Member is the tenant-resolved actor for the F5 use-case path.
  // For the seed we attribute the payment to the member id directly
  // since `payments.actor_user_id` is `text` (UUID-or-system) at the
  // schema level and a member's user binding is not relevant for the
  // reconciliation surface (system-actor renders for the
  // `invoice_paid` event regardless).
  const row: NewPaymentRow = {
    id: target.paymentId,
    tenantId: ctx.slug,
    invoiceId: invoice.invoiceId,
    memberId: invoice.memberId,
    method: target.method,
    status: 'succeeded',
    amountSatang: invoice.totalSatang,
    currency: 'THB',
    processorPaymentIntentId: `pi_test_e2e_recon_${target.method}`,
    processorChargeId: target.chargeId,
    processorEnvironment: 'test',
    attemptSeq: 1,
    cardBrand: target.cardBrand,
    cardLast4: target.cardLast4,
    cardExpMonth: target.cardExpMonth,
    cardExpYear: target.cardExpYear,
    failureReasonCode: null,
    initiatedAt,
    completedAt,
    actorUserId,
    correlationId: `seed-recon-${target.method}-${invoice.invoiceId}`,
  };

  await runInTenant(ctx, (tx) => tx.insert(payments).values(row));
  console.log(
    `  inserted F5 payment ${target.paymentId} (${target.method}, succeeded) for ${target.invoiceDocNumber}`,
  );
}

async function main(): Promise<void> {
  const ctx = requireSwechamTenant();
  const actorUserId = await findSeedActorUserId();
  console.log('seeding F5 reconciliation E2E fixtures…');
  for (const target of TARGETS) {
    await upsertSucceededPayment(ctx, target, actorUserId);
  }

  // Resolve the canonical paid-online invoice id for env-var output.
  const cardInvoice = await findInvoiceByDocNumber(
    ctx,
    PAID_ONLINE_CARD_INVOICE_DOC,
  );
  if (!cardInvoice) {
    throw new Error('seed-f5-e2e-reconciliation: post-seed lookup failed');
  }

  console.log('\n----------------------------------------');
  console.log('F5 reconciliation E2E fixtures seeded:');
  console.log(`  export E2E_PAID_ONLINE_INVOICE_ID='${cardInvoice.invoiceId}'`);
  console.log('----------------------------------------');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
