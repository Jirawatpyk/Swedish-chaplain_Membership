/**
 * Hourly retry sweep for pending payments on no-longer-payable invoices —
 * live Neon (follow-up to the #447 review: a failed void-time cancel had no
 * retry).
 *
 * Proves against the REAL schema:
 *   - the owner-db finder measures its 15-minute..7-day window from the LATER
 *     of the attempt's `initiated_at` and the invoice's `updated_at` (when it
 *     stopped being payable). It picks pending attempts on VOIDED invoices
 *     inside that window, including an 8-day-old attempt on an invoice voided
 *     20 minutes ago (review M2). It skips attempts on an ISSUED invoice, a
 *     2-minute-old attempt, an old attempt whose invoice was voided 2 minutes
 *     ago (left to the void's own post-commit cancel), and a void older than
 *     the 7-day cap;
 *   - the sweep cancels exactly those rows through `cancelPendingPaymentsForInvoice`
 *     (per-tenant RLS deps), auditing `payment_canceled` with actor_type
 *     'system' and cause 'invoice_not_payable_sweep';
 *   - a re-run is a no-op.
 *
 * The CI database is shared, so the finder is narrowed to this file's tenant
 * (and its limit lifted) — another suite's leftovers must neither be touched
 * by this test nor push its rows out of the batch. The gateway is a counting
 * fake (no Stripe) and the settings repo a fixture, as in the sibling
 * `void-cancels-pending-payment.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ok } from '@/lib/result';
import { db, runInTenant, type TenantTx } from '@/lib/db';
import {
  makeCancelPendingPaymentsForInvoiceDeps,
  sweepPendingPaymentsOnUnpayableInvoices,
  type CancelPendingPaymentsForInvoiceDeps,
} from '@/modules/payments';
import { drizzleUnpayablePendingFinder } from '@/modules/payments/infrastructure/repos/drizzle-unpayable-pending-finder';
import type { TenantPaymentSettingsRepo } from '@/modules/payments/application/ports';
import type { TenantPaymentSettings } from '@/modules/payments/domain/tenant-payment-settings';
import {
  payments,
  tenantPaymentSettings,
  type NewTenantPaymentSettingsRow,
} from '@/modules/payments/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
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

function pmtId(): string {
  return `pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
}

interface Row {
  readonly invoiceId: string;
  readonly paymentId: string;
  readonly pi: string;
  /** How long ago the pending attempt was initiated. */
  readonly ageMs: number;
  /** `null` = invoice stays `issued`; else how long ago it was voided (its `updated_at`). */
  readonly voidedAgoMs: number | null;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
function row(tag: string, ageMs: number, voidedAgoMs: number | null): Row {
  return {
    invoiceId: randomUUID(),
    paymentId: pmtId(),
    pi: `pi_test_sw_${tag}_${randomUUID().slice(0, 8)}`,
    ageMs,
    voidedAgoMs,
  };
}

describe('sweep cancels pending payments on no-longer-payable invoices — live Neon', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  // The window is measured from the LATER of the attempt and the invoice's
  // last change (review M2), so each row pins one side of it.
  // Target: attempt 30 min old, voided 30 min ago.
  const voidedOld = row('void_old', 30 * MIN, 30 * MIN);
  // Target (M2): attempt 8 days old, voided only 20 min ago — must still be
  // retried; measuring from initiated_at alone would skip it forever.
  const oldAttemptRecentVoid = row('old_attempt_recent_void', 8 * DAY, 20 * MIN);
  // Untouched: issued invoice (member may still be paying it).
  const issuedOld = row('issued_old', 30 * MIN, null);
  // Untouched: attempt younger than the 15-minute floor.
  const voidedYoung = row('void_young', 2 * MIN, 2 * MIN);
  // Untouched: old attempt, but voided 2 min ago — the void's own
  // post-commit cancel is still handling it.
  const oldAttemptFreshVoid = row('old_attempt_fresh_void', 30 * MIN, 2 * MIN);
  // Untouched: voided more than the 7-day cap ago.
  const voidedAncient = row('void_ancient', 8 * DAY, 8 * DAY);
  const ROWS = [
    voidedOld,
    oldAttemptRecentVoid,
    issuedOld,
    voidedYoung,
    oldAttemptFreshVoid,
    voidedAncient,
  ];
  const TARGETS = [voidedOld, oldAttemptRecentVoid];
  const UNTOUCHED = [issuedOld, voidedYoung, oldAttemptFreshVoid, voidedAncient];

  async function insertInvoice(tx: TenantTx, id: string, seq: number): Promise<void> {
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId: id,
      memberId,
      planYear: 2026,
      planId: 'sw-plan',
      status: 'issued',
      pdfDocKind: 'invoice',
      draftByUserId: user.userId,
      fiscalYear: 2026,
      sequenceNumber: seq,
      documentNumber: `T6-2026-${String(seq).padStart(6, '0')}`,
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      subtotalSatang: 1_000_000n,
      vatRateSnapshot: '0.0700',
      vatSatang: 70_000n,
      totalSatang: 1_070_000n,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: {
        legal_name_th: 'ทดสอบ',
        legal_name_en: 'Test',
        tax_id: '0000000000000',
        address_th: 'Bangkok',
        address_en: 'Bangkok',
        logo_blob_key: null,
      },
      memberIdentitySnapshot: {
        legal_name: 'SW Co',
        tax_id: '1234567890123',
        address: 'Bangkok',
        primary_contact_name: 'SW Contact',
        primary_contact_email: 'sw@example.com',
      },
      pdfBlobKey: `invoices/sw-${id}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
    });
  }

  async function insertPendingPayment(
    tx: TenantTx,
    row: Row,
  ): Promise<void> {
    await tx.insert(payments).values({
      id: row.paymentId,
      tenantId: tenant.ctx.slug,
      invoiceId: row.invoiceId,
      memberId,
      method: 'card',
      status: 'pending',
      amountSatang: 1_070_000n,
      currency: 'THB',
      processorPaymentIntentId: row.pi,
      processorChargeId: null,
      processorEnvironment: 'test',
      attemptSeq: 1,
      initiatedAt: new Date(Date.now() - row.ageMs),
      completedAt: null,
      actorUserId: user.userId,
      correlationId: `corr-${row.paymentId}`,
    });
  }

  beforeAll(async () => {
    user = await createActiveTestUser('member');
    const pair = await createTwoTestTenants();
    tenant = pair.a;
    memberId = randomUUID();

    const settings: NewTenantPaymentSettingsRow = {
      tenantId: tenant.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: `acct_test_${tenant.ctx.slug.slice(-8)}`,
      processorPublishableKey: `pk_test_${tenant.ctx.slug.slice(-8)}`,
      enabledMethods: ['card', 'promptpay'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    };

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantPaymentSettings).values(settings);
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'sw-plan',
        planYear: 2026,
        planName: { en: 'SW Plan' },
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
        companyName: 'SW Co',
        country: 'TH',
        planId: 'sw-plan',
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
        invoiceNumberPrefix: 'T6',
        creditNoteNumberPrefix: 'T6C',
      });
      await tx.insert(tenantDocumentSequences).values({
        tenantId: tenant.ctx.slug,
        documentType: 'invoice',
        fiscalYear: 2026,
      });
    });

    await runInTenant(tenant.ctx, async (tx) => {
      for (const [i, r] of ROWS.entries()) {
        await insertInvoice(tx, r.invoiceId, i + 1);
        await insertPendingPayment(tx, r);
      }
    });

    // The state a committed void leaves — same columns as the real applyVoid,
    // back-dated per row (`updated_at` is what the finder's window reads).
    await runInTenant(tenant.ctx, async (tx) => {
      for (const r of ROWS) {
        if (r.voidedAgoMs === null) continue;
        const at = new Date(Date.now() - r.voidedAgoMs);
        await tx
          .update(invoices)
          .set({
            status: 'void',
            voidReason: 'sweep integration test',
            voidedByUserId: user.userId,
            voidedAt: at,
            updatedAt: at,
          })
          .where(eq(invoices.invoiceId, r.invoiceId));
      }
    });
  }, 120_000);

  afterAll(async () => {
    if (tenant) {
      await tenant.cleanup().catch((e) => console.error('sweep tenant cleanup:', e));
    }
  });

  function makeCancelDeps(cancelCalls: string[]): CancelPendingPaymentsForInvoiceDeps {
    const settingsFixture: TenantPaymentSettings = {
      tenantId: tenant.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: `acct_test_${tenant.ctx.slug.slice(-8)}`,
      processorPublishableKey: `pk_test_${tenant.ctx.slug.slice(-8)}`,
      enabledMethods: ['card', 'promptpay'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    };
    const settingsRepo: TenantPaymentSettingsRepo = {
      async getByTenantId() {
        return settingsFixture;
      },
      async findByProcessorAccountId() {
        return settingsFixture;
      },
    };
    const real = makeCancelPendingPaymentsForInvoiceDeps(tenant.ctx.slug);
    return {
      ...real,
      tenantSettingsRepo: settingsRepo,
      processorGateway: {
        ...real.processorGateway,
        async cancelPaymentIntent(pi: string) {
          cancelCalls.push(pi);
          return ok(undefined);
        },
      },
    };
  }

  function makeSweepDeps(cancelCalls: string[]) {
    return {
      finder: {
        async listInvoicesWithPendingOnUnpayable(args: {
          minAgeMinutes: number;
          maxAgeDays: number;
          limit: number;
        }) {
          const all = await drizzleUnpayablePendingFinder.listInvoicesWithPendingOnUnpayable({
            ...args,
            limit: 10_000,
          });
          return all.filter((p) => p.tenantId === tenant.ctx.slug);
        },
      },
      cancelDepsFor: (tenantId: string) => {
        // Never build deps (or reach Stripe) for another suite's tenant.
        expect(tenantId).toBe(tenant.ctx.slug);
        return makeCancelDeps(cancelCalls);
      },
      clock: { nowIso: () => new Date().toISOString(), nowMs: () => Date.now() },
    };
  }

  async function statusOf(paymentId: string): Promise<string> {
    const [r] = await db
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.id, paymentId));
    return r!.status;
  }

  it('finds only the voided attempts inside the window, oldest first', async () => {
    const found = await makeSweepDeps([]).finder.listInvoicesWithPendingOnUnpayable({
      minAgeMinutes: 15,
      maxAgeDays: 7,
      limit: 50,
    });
    // Ordered by GREATEST(initiated_at, updated_at): 30 min ago, then 20 min ago.
    expect(found).toEqual([
      { tenantId: tenant.ctx.slug, invoiceId: voidedOld.invoiceId },
      { tenantId: tenant.ctx.slug, invoiceId: oldAttemptRecentVoid.invoiceId },
    ]);
  }, 60_000);

  it('cancels those attempts with a system audit; the others stay pending; a re-run is a no-op', async () => {
    const cancelCalls: string[] = [];
    const deps = makeSweepDeps(cancelCalls);

    const first = await sweepPendingPaymentsOnUnpayableInvoices(deps, {
      requestId: 'req-sweep-1',
      budgetMs: 30_000,
    });
    expect(first).toEqual({
      invoicesFound: 2,
      invoicesProcessed: 2,
      invoicesErrored: 0,
      deferred: 0,
      canceled: 2,
      skipped: 0,
      failed: 0,
    });
    expect(cancelCalls).toEqual(TARGETS.map((r) => r.pi));
    for (const r of TARGETS) expect(await statusOf(r.paymentId)).toBe('canceled');
    for (const r of UNTOUCHED) expect(await statusOf(r.paymentId)).toBe('pending');

    for (const r of TARGETS) {
      const auditRows = await db
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            sql`${auditLog.eventType} = 'payment_canceled'`,
            sql`${auditLog.payload}->>'payment_id' = ${r.paymentId}`,
          ),
        );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.payload).toMatchObject({
        invoice_id: r.invoiceId,
        actor_type: 'system',
        cause: 'invoice_not_payable_sweep',
      });
    }

    const second = await sweepPendingPaymentsOnUnpayableInvoices(deps, {
      requestId: 'req-sweep-2',
      budgetMs: 30_000,
    });
    expect(second).toMatchObject({ invoicesFound: 0, canceled: 0 });
    expect(cancelCalls).toHaveLength(2);
  }, 60_000);
});
