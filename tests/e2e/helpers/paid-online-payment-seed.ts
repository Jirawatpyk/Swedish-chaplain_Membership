/**
 * E2E seed for T095 (`admin-payment-reconciliation-view.spec.ts`) —
 * the two `succeeded` F5 payments the reconciliation surface reads.
 *
 * Same two fixtures as `scripts/seed-f5-e2e-reconciliation.ts`, with the
 * same pinned payment ids, so the script and this helper converge instead
 * of double-seeding:
 *
 *   • SC-2026-900001 → method='card', charge id `ch_test_e2e_recon_card`,
 *     card metadata set. This is the invoice the timeline assertions open.
 *   • SC-2026-900002 → method='promptpay', no card metadata, no charge id.
 *     It gives the method-badge column its second variant.
 *
 * Why a helper and not just the script: the spec used to navigate to
 * `E2E_PAID_ONLINE_INVOICE_ID` and assume someone had run the script on
 * this database. When the dev branch lost its payment rows, the env var
 * still pointed at a deleted invoice, so the suite did not skip — it
 * failed on a missing timeline, which reads like a product regression.
 * Seeding in `beforeAll` makes the fixture the spec's own responsibility.
 *
 * Both invoices are created by `scripts/seed-e2e-portal-invoices.ts` as
 * **088 bills**, so their SC number rides `bill_document_number_raw` and
 * `document_number` is NULL — look them up by either.
 *
 * Idempotent: the payment rows are pinned by id and inserted
 * `ON CONFLICT DO NOTHING`. Returns `null` (with a labelled warn) when the
 * prerequisites are missing, so the spec can skip rather than fail.
 */
import { openSeedClient } from './open-seed-client';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? process.env.TENANT_SLUG ?? 'swecham';

const SEED_LABEL = 'e2e seed T095 paid-online';

/** FK target for `payments.actor_user_id` — seeded by `seed-e2e-user.ts`. */
const SEED_ACTOR_EMAIL = 'e2e-admin@swecham.test';

interface Target {
  readonly docNumber: string;
  readonly paymentId: string;
  readonly method: 'card' | 'promptpay';
  readonly chargeId: string | null;
  readonly cardBrand: string | null;
  readonly cardLast4: string | null;
  readonly cardExpMonth: number | null;
  readonly cardExpYear: number | null;
}

const TARGETS: readonly Target[] = [
  {
    docNumber: 'SC-2026-900001',
    paymentId: 'pmt_e2e_reconcile_card_xxxxxxxxxxxx',
    method: 'card',
    chargeId: 'ch_test_e2e_recon_card',
    cardBrand: 'visa',
    cardLast4: '4242',
    cardExpMonth: 12,
    cardExpYear: 2030,
  },
  {
    docNumber: 'SC-2026-900002',
    paymentId: 'pmt_e2e_reconcile_pp_xxxxxxxxxxxx00',
    method: 'promptpay',
    chargeId: null,
    cardBrand: null,
    cardLast4: null,
    cardExpMonth: null,
    cardExpYear: null,
  },
];

export interface PaidOnlineSeedResult {
  /** The card-paid invoice — the one the timeline assertions open. */
  readonly cardInvoiceId: string;
  /** The PromptPay-paid invoice — the method column's second variant. */
  readonly promptpayInvoiceId: string;
}

export async function seedPaidOnlinePayments(
  tenantSlug: string = TENANT_ID,
): Promise<PaidOnlineSeedResult | null> {
  const client = openSeedClient(SEED_LABEL);
  if (!client) return null;
  try {
    const actorRows = await client.sql<Array<{ id: string }>>`
      SELECT id::text AS id FROM users
      WHERE lower(email) = ${SEED_ACTOR_EMAIL.toLowerCase()}
      LIMIT 1
    `;
    const actorUserId = actorRows[0]?.id;
    if (!actorUserId) {
      console.warn(
        `[${SEED_LABEL}] skipped — ${SEED_ACTOR_EMAIL} missing; run seed-e2e-user.ts`,
      );
      return null;
    }

    const invoiceIds: string[] = [];
    for (const target of TARGETS) {
      const rows = await client.sql<
        Array<{
          invoice_id: string;
          member_id: string | null;
          total_satang: string;
          paid_at: Date | null;
          status: string;
        }>
      >`
        SELECT invoice_id::text AS invoice_id,
               member_id::text AS member_id,
               total_satang::text AS total_satang,
               paid_at,
               status::text AS status
        FROM invoices
        WHERE tenant_id = ${tenantSlug}
          AND (document_number = ${target.docNumber}
               OR bill_document_number_raw = ${target.docNumber})
        LIMIT 1
      `;
      const invoice = rows[0];
      if (!invoice) {
        console.warn(
          `[${SEED_LABEL}] skipped — ${target.docNumber} missing; run seed-e2e-portal-invoices.ts`,
        );
        return null;
      }
      if (invoice.status !== 'paid' || invoice.member_id === null) {
        console.warn(
          `[${SEED_LABEL}] skipped — ${target.docNumber} is status=${invoice.status}, member_id=${invoice.member_id ?? 'null'}; re-run seed-e2e-portal-invoices.ts`,
        );
        return null;
      }

      // `initiated_at`/`completed_at` follow the invoice's own paid_at so the
      // timeline's ordering matches the invoice it belongs to.
      await client.sql`
        INSERT INTO payments (
          id, tenant_id, invoice_id, member_id, method, status,
          amount_satang, currency,
          processor_payment_intent_id, processor_charge_id, processor_environment,
          attempt_seq, card_brand, card_last4, card_exp_month, card_exp_year,
          failure_reason_code, initiated_at, completed_at, actor_user_id,
          correlation_id
        ) VALUES (
          ${target.paymentId}, ${tenantSlug}, ${invoice.invoice_id}::uuid,
          ${invoice.member_id}::uuid, ${target.method}, 'succeeded',
          ${invoice.total_satang}::bigint, 'THB',
          ${`pi_test_e2e_recon_${target.method}`}, ${target.chargeId}, 'test',
          1, ${target.cardBrand}, ${target.cardLast4},
          ${target.cardExpMonth}, ${target.cardExpYear},
          NULL,
          COALESCE(${invoice.paid_at}::timestamptz, NOW()),
          COALESCE(${invoice.paid_at}::timestamptz, NOW()),
          ${actorUserId}::uuid,
          ${`seed-recon-${target.method}-${invoice.invoice_id}`}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      invoiceIds.push(invoice.invoice_id);
    }

    return {
      cardInvoiceId: invoiceIds[0]!,
      promptpayInvoiceId: invoiceIds[1]!,
    };
  } finally {
    await client.end();
  }
}
