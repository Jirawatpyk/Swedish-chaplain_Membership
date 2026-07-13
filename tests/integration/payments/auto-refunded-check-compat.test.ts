/**
 * Migration 0240 — CHECK-compat probe for the `auto_refunded` terminal
 * payment status (live Neon).
 *
 * Bug #3: the stale-invoice auto-refund path currently leaves the payment
 * stuck `pending` because there was no terminal status expressing "we
 * auto-refunded this charge". Migration 0240 widens `payments_status_enum`
 * and `payments_card_metadata_iff_card` to admit `auto_refunded`, and adds
 * the durable `auto_refund_processor_refund_id` column + its partial unique
 * index.
 *
 * This test is the "red-first" proof for the migration task. It exercises
 * the DB CHECK constraints directly (typed Drizzle writes threaded through
 * `runInTenant`, never the pool-global db — Constitution Principle I) and
 * asserts three constraint interactions the later PR-A code depends on:
 *
 *   (a) UPDATE pending → auto_refunded WITH completed_at set  → PASSES
 *       (payments_status_enum admits auto_refunded; the card-metadata CHECK
 *        admits a card row with NULL metadata in the auto_refunded state).
 *   (b) UPDATE pending → auto_refunded WITHOUT completed_at    → REJECTED
 *       by `payments_completed_at_iff_not_pending` (any non-pending row MUST
 *        carry completed_at). This is the load-bearing correctness detail:
 *        the A4 use-case MUST set completed_at when it marks auto_refunded.
 *   (c) After the first payment is auto_refunded, a SECOND payment can be
 *       INSERTed for the same invoice — auto_refunded is OUTSIDE the
 *       `payments_one_active_per_invoice` partial index, so the invoice is
 *        no longer blocked and can be re-paid.
 *
 * Mocking policy: hits live Postgres. No SUT mocks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { payments } from '@/modules/payments/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

function makeUlid(): string {
  return `pmt_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * Assert `fn` throws a Postgres CHECK violation (SQLSTATE 23514) for the
 * named constraint. Drizzle wraps the driver error, so the constraint name
 * lives on the original PostgresError at `.cause` (`.constraint_name` or in
 * `.message`). Mirrors tests/integration/events/db-constraints.test.ts.
 */
async function expectCheckViolation(
  fn: () => Promise<unknown>,
  constraint: string,
): Promise<void> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected a CHECK violation for ${constraint}`).not.toBeNull();
  const err = caught as { cause?: unknown; message?: string };
  const cause = err.cause as
    | { code?: string; message?: string; constraint_name?: string }
    | undefined;
  const fullMessage = `${err.message ?? ''} ${cause?.message ?? ''}`;
  // SQLSTATE 23514 = check_violation; required.
  expect(cause?.code).toBe('23514');
  // Constraint name MUST be the target (or appear in the message as fallback).
  const matched =
    cause?.constraint_name === constraint || fullMessage.includes(constraint);
  expect(matched, `error did not name ${constraint}`).toBe(true);
}

describe('migration 0240 — auto_refunded CHECK-compat (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  // invoice1 exercises sub-cases (a) + (c); invoice2 exercises (b).
  let invoice1: string;
  let invoice2: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    memberId = randomUUID();
    invoice1 = randomUUID();
    invoice2 = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'auto-refund-plan',
        planYear: 2026,
        planName: { en: 'Auto Refund Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Auto Refund Co',
        country: 'TH',
        planId: 'auto-refund-plan',
        planYear: 2026,
      });
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 500000n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'T',
        creditNoteNumberPrefix: 'TC',
      });
      await tx.insert(tenantDocumentSequences).values({
        tenantId: tenant.ctx.slug,
        documentType: 'invoice',
        fiscalYear: 2026,
      });
      for (const iid of [invoice1, invoice2]) {
        await tx.insert(invoices).values({
          tenantId: tenant.ctx.slug,
          invoiceId: iid,
          memberId,
          planYear: 2026,
          planId: 'auto-refund-plan',
          draftByUserId: user.userId,
        });
      }
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  it('(a) pending → auto_refunded WITH completed_at passes; (c) a fresh payment can follow on the same invoice', async () => {
    const p1 = makeUlid();
    const p2 = makeUlid();
    const now = new Date();
    const refundId = `re_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

    // Insert a card-rail payment in `pending` with NULL card metadata
    // (the legitimate pre-webhook state relaxed by migration 0042/0044).
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(payments).values({
        id: p1,
        tenantId: tenant.ctx.slug,
        invoiceId: invoice1,
        memberId,
        method: 'card',
        status: 'pending',
        amountSatang: 3_200_000n,
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        initiatedAt: now,
        actorUserId: user.userId,
        correlationId: 'corr-0240-a',
      });
    });

    // (a) Auto-refund it: status → auto_refunded WITH completed_at set +
    // durable processor-refund-id. Must satisfy payments_status_enum,
    // payments_card_metadata_iff_card (card + auto_refunded + NULL metadata),
    // and payments_completed_at_iff_not_pending (non-pending ⇒ completed_at).
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(payments)
        .set({
          status: 'auto_refunded',
          completedAt: now,
          autoRefundProcessorRefundId: refundId,
          updatedAt: now,
        })
        .where(and(eq(payments.id, p1), eq(payments.tenantId, tenant.ctx.slug)));
    });

    // (c) The invoice is no longer blocked — auto_refunded is outside the
    // `payments_one_active_per_invoice` partial index, so a new `pending`
    // attempt for the same invoice inserts cleanly.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(payments).values({
        id: p2,
        tenantId: tenant.ctx.slug,
        invoiceId: invoice1,
        memberId,
        method: 'card',
        status: 'pending',
        amountSatang: 3_200_000n,
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 2,
        initiatedAt: new Date(now.getTime() + 1_000),
        actorUserId: user.userId,
        correlationId: 'corr-0240-c',
      });
    });

    // Verify both rows persisted with the expected states.
    const rows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(payments)
        .where(eq(payments.invoiceId, invoice1))
        .orderBy(payments.attemptSeq),
    );
    expect(rows).toHaveLength(2);

    const refunded = rows.find((r) => r.id === p1);
    expect(refunded?.status).toBe('auto_refunded');
    expect(refunded?.completedAt).not.toBeNull();
    expect(refunded?.autoRefundProcessorRefundId).toBe(refundId);
    expect(refunded?.cardBrand).toBeNull();

    const fresh = rows.find((r) => r.id === p2);
    expect(fresh?.status).toBe('pending');
    expect(fresh?.autoRefundProcessorRefundId).toBeNull();
  });

  it('(b) pending → auto_refunded WITHOUT completed_at is REJECTED by payments_completed_at_iff_not_pending', async () => {
    const p3 = makeUlid();
    const now = new Date();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(payments).values({
        id: p3,
        tenantId: tenant.ctx.slug,
        invoiceId: invoice2,
        memberId,
        method: 'card',
        status: 'pending',
        amountSatang: 1_000_000n,
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        initiatedAt: now,
        actorUserId: user.userId,
        correlationId: 'corr-0240-b',
      });
    });

    // Flip to auto_refunded but LEAVE completed_at NULL — must violate the
    // completed_at-iff-not-pending CHECK (the row is now terminal but has no
    // completion timestamp). The whole runInTenant tx aborts on the CHECK.
    await expectCheckViolation(
      () =>
        runInTenant(tenant.ctx, async (tx) => {
          await tx
            .update(payments)
            .set({ status: 'auto_refunded', updatedAt: now })
            .where(
              and(eq(payments.id, p3), eq(payments.tenantId, tenant.ctx.slug)),
            );
        }),
      'payments_completed_at_iff_not_pending',
    );

    // The rejected UPDATE rolled back — the row is still pending.
    const row = await runInTenant(tenant.ctx, async (tx) => {
      const found = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.id, p3), eq(payments.tenantId, tenant.ctx.slug)));
      return found[0];
    });
    expect(row?.status).toBe('pending');
    expect(row?.completedAt).toBeNull();
  });
});
