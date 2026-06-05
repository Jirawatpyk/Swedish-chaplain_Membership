/**
 * F5 Phase 5 verify-fix C3 (2026-04-26) — Cross-tenant integration test
 * for the Phase-5 read-only surfaces.
 *
 * Constitution v1.4.0 Principle I clause 3 (REVIEW-GATE blocker):
 *   every feature that touches tenant-scoped data MUST include a
 *   cross-tenant integration test. Phase 5 added 3 read paths:
 *     1. PaymentsRepo.listInvoiceActivity      → loadInvoicePaymentActivity use-case
 *     2. PaymentsRepo.listSucceededMethodByInvoiceIds → listSucceededPaymentMethods use-case
 *     3. F4 InvoiceRepo.listPaged with `paidOnlineOnly: true` → F4 listInvoicesPaged
 *
 * The existing `tenant-isolation.test.ts` covered RAW table-level RLS
 * via direct INSERT/SELECT on payments + refunds + tenant_payment_settings
 * + processor_events. This file specifically exercises the use-case
 * surfaces shipped in Phase 5 — proving that a tenant-A query never
 * returns tenant-B payment activity, irrespective of which entry point
 * (use-case vs port vs F4 facade) the caller uses.
 *
 * Two-tenant fixture mirrors the seeding shape of tenant-isolation.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  payments,
  type NewPaymentRow,
} from '@/modules/payments/infrastructure/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import {
  loadInvoicePaymentActivity,
  listSucceededPaymentMethods,
  makeLoadInvoicePaymentActivityDeps,
  makeListSucceededPaymentMethodsDeps,
} from '@/modules/payments';
import {
  listInvoicesPaged,
  makeListInvoicesDeps,
} from '@/modules/invoicing';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const F5_PHASE5_MATRIX: BenefitMatrix = {
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

describe('F5 Phase 5 — Cross-tenant isolation on read use-cases (verify-fix C3)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;

  let aInvoiceId: string;
  let bInvoiceId: string;
  let aPaidInvoiceId: string;
  let bPaidInvoiceId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    aInvoiceId = randomUUID();
    bInvoiceId = randomUUID();
    aPaidInvoiceId = randomUUID();
    bPaidInvoiceId = randomUUID();
    const now = new Date();

    // Seed parent F4 chain per tenant (plan → member → settings → seq → invoices)
    for (const [t, prefix, memberId, pendingId, paidId] of [
      [tenantA, 'phase5a', randomUUID(), aInvoiceId, aPaidInvoiceId],
      [tenantB, 'phase5b', randomUUID(), bInvoiceId, bPaidInvoiceId],
    ] as const) {
      await runInTenant(t.ctx, async (tx) => {
        await tx.insert(membershipPlans).values({
          tenantId: t.ctx.slug,
          planId: `${prefix}-plan`,
          planYear: 2026,
          planName: { en: `${prefix} Plan` },
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
          benefitMatrix: F5_PHASE5_MATRIX,
          isActive: true,
          createdBy: user.userId,
          updatedBy: user.userId,
        });
        await tx.insert(members).values({
          tenantId: t.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `${prefix} Co`,
          country: 'TH',
          planId: `${prefix}-plan`,
          planYear: 2026,
        });
        await tx.insert(tenantInvoiceSettings).values({
          tenantId: t.ctx.slug,
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
          tenantId: t.ctx.slug,
          documentType: 'invoice',
          fiscalYear: 2026,
        });
        // Note: F4 invoices CHECK constraint `invoices_draft_has_no_number`
        // forbids non-draft status without a document number. Seeding full
        // issued/paid metadata for this read-only cross-tenant test would
        // double the boilerplate without changing the predicate-under-test
        // (paidOnlineOnly EXISTS subquery doesn't care about invoice
        // status — it only joins F5 payments table). Leave both invoices
        // as the default 'draft' status and pass `includeDrafts: true` to
        // listInvoicesPaged below; the EXISTS predicate semantics are
        // identical regardless of invoice state.
        await tx.insert(invoices).values({
          tenantId: t.ctx.slug,
          invoiceId: pendingId,
          memberId,
          planYear: 2026,
          planId: `${prefix}-plan`,
          draftByUserId: user.userId,
        });
        await tx.insert(invoices).values({
          tenantId: t.ctx.slug,
          invoiceId: paidId,
          memberId,
          planYear: 2026,
          planId: `${prefix}-plan`,
          draftByUserId: user.userId,
        });

        // Succeeded F5 payment for the paid invoice (drives paidOnlineOnly + method-badge probe)
        const paymentRow: NewPaymentRow = {
          id: makeUlid(),
          tenantId: t.ctx.slug,
          invoiceId: paidId,
          memberId,
          method: 'card',
          status: 'succeeded',
          amountSatang: 5_350_000n,
          currency: 'THB',
          processorPaymentIntentId: `pi_test_${prefix}_${randomUUID().slice(0, 8)}`,
          processorChargeId: `ch_test_${prefix}`,
          processorEnvironment: 'test',
          attemptSeq: 1,
          cardBrand: 'visa',
          cardLast4: '4242',
          cardExpMonth: 12,
          cardExpYear: 2030,
          initiatedAt: now,
          completedAt: now,
          actorUserId: user.userId,
          correlationId: `corr-${prefix}-paid-001`,
        };
        await tx.insert(payments).values(paymentRow);
      });
    }
  });

  afterAll(async () => {
    // Mirror tenant-isolation.test.ts cleanup posture — surface failures
    // instead of swallowing so orphaned F5 payment rows don't accumulate
    // on the live Neon test DB and poison subsequent runs (this is the
    // class of bug the previous run hit: test failed mid-seed, no
    // cleanup ran, payments rows blocked the next clear-test-data sweep).
    await tenantA?.cleanup().catch((e) => {
      console.error('[verify-fix C3] tenantA cleanup failed:', e);
    });
    await tenantB?.cleanup().catch((e) => {
      console.error('[verify-fix C3] tenantB cleanup failed:', e);
    });
  });

  it('loadInvoicePaymentActivity in tenant A never returns tenant B payment rows', async () => {
    // Probe: ask tenant A for tenant B's INVOICE id. RLS must return zero
    // payments + zero refunds — never the seeded tenant-B payment.
    const result = await loadInvoicePaymentActivity(
      makeLoadInvoicePaymentActivityDeps(tenantA.ctx.slug),
      { tenantId: tenantA.ctx.slug, invoiceId: bPaidInvoiceId },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.payments).toHaveLength(0);
      expect(result.value.refunds).toHaveLength(0);
    }

    // And the legitimate self-tenant query DOES return the seeded payment.
    const selfResult = await loadInvoicePaymentActivity(
      makeLoadInvoicePaymentActivityDeps(tenantA.ctx.slug),
      { tenantId: tenantA.ctx.slug, invoiceId: aPaidInvoiceId },
    );
    expect(selfResult.ok).toBe(true);
    if (selfResult.ok) {
      expect(selfResult.value.payments).toHaveLength(1);
      expect(selfResult.value.payments[0]?.tenantId).toBe(tenantA.ctx.slug);
    }
  });

  it('listSucceededPaymentMethods in tenant A excludes tenant B invoice ids passed in the input set', async () => {
    // Adversarial caller passes BOTH tenants' paid invoice ids. The repo
    // must return ONLY the tenant-A row in the resulting Map, never the
    // tenant-B row — regardless of what invoice ids the caller supplies.
    const result = await listSucceededPaymentMethods(
      makeListSucceededPaymentMethodsDeps(tenantA.ctx.slug),
      {
        tenantId: tenantA.ctx.slug,
        invoiceIds: [aPaidInvoiceId, bPaidInvoiceId],
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const map = result.value;
      expect(map.has(aPaidInvoiceId)).toBe(true);
      expect(map.get(aPaidInvoiceId)).toBe('card');
      // CRITICAL: the foreign tenant's invoice id MUST be absent from the
      // returned map, even though it was supplied as input.
      expect(map.has(bPaidInvoiceId)).toBe(false);
    }
  });

  it('F4 listInvoicesPaged with paidOnlineOnly does not leak tenant B paid-online invoices to tenant A', async () => {
    const result = await listInvoicesPaged(
      makeListInvoicesDeps(tenantA.ctx.slug),
      {
        tenantId: tenantA.ctx.slug,
        offset: 0,
        pageSize: 100,
        // Seed leaves invoices as draft (see beforeAll comment) — opt in
        // so the EXISTS predicate path actually surfaces the seeded row.
        includeDrafts: true,
        paidOnlineOnly: true,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // ONLY tenant A's paid invoice should surface; tenant B's must not.
      const ids = result.value.rows.map((r) => r.invoiceId);
      expect(ids).toContain(aPaidInvoiceId);
      expect(ids).not.toContain(bPaidInvoiceId);
      // All returned rows must carry tenant A's slug.
      for (const row of result.value.rows) {
        expect(row.tenantId).toBe(tenantA.ctx.slug);
      }
    }
  });
});
