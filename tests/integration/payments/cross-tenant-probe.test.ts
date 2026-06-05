/**
 * CR-5 (review 2026-04-27) — Cross-tenant probe audit-emit integration test.
 *
 * Constitution v1.4.0 Principle I clause 3 — Review-Gate blocker.
 * Closes the gap flagged by /speckit.review tests-agent: prior coverage
 * for `payment_cross_tenant_probe` was unit-test-only (mocked repo)
 * which does not exercise live Neon RLS. This test runs the real
 * `initiatePayment` use-case through `makeInitiatePaymentDeps(tenantB)`
 * against an invoice owned by tenantA and asserts:
 *
 *   1. Application-layer probe rejection — `forbidden_invoice` (does
 *      not leak the existence of the cross-tenant row).
 *   2. Audit row written under TENANT B's context (the probing actor's
 *      tenant), with payload pinning the probed entity + actor.
 *   3. RLS keeps the audit row INVISIBLE to tenant A (so even if
 *      tenant A's admin later reads their audit log, the cross-tenant
 *      probe attempt against their invoice does not appear there —
 *      the audit row belongs to the probing tenant's forensic trail).
 *
 * Mocking policy mirrors `concurrent-initiate.test.ts`: live Neon for
 * everything except processor gateway + tenant settings (Vitest
 * unstable_cache limitation documented elsewhere).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ok } from '@/lib/result';
import { db, runInTenant } from '@/lib/db';
import { makeInitiatePaymentDeps } from '@/modules/payments/infrastructure/di';
import { initiatePayment } from '@/modules/payments/application/use-cases/initiate-payment';
import type {
  ProcessorGatewayPort,
  TenantPaymentSettingsRepo,
} from '@/modules/payments/application/ports';
import type { InitiatePaymentDeps } from '@/modules/payments/application/use-cases/initiate-payment';
import type { TenantPaymentSettings } from '@/modules/payments/domain/tenant-payment-settings';
import { tenantPaymentSettings, type NewTenantPaymentSettingsRow } from '@/modules/payments/infrastructure/schema';
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

function makeNoOpGateway(): ProcessorGatewayPort {
  return {
    async createPaymentIntent() {
      return ok({
        id: 'pi_should_not_be_called',
        clientSecret: 'cs_unused',
        status: 'requires_payment_method',
        livemode: false,
        promptpayQrSvgUrl: null,
      });
    },
    async retrievePaymentIntent() {
      throw new Error('cross-tenant-probe.test: retrievePaymentIntent must not be called');
    },
    async cancelPaymentIntent() {
      throw new Error('cross-tenant-probe.test: cancelPaymentIntent must not be called');
    },
    async createRefund() {
      throw new Error('cross-tenant-probe.test: createRefund must not be called');
    },
  };
}

describe('CR-5 cross-tenant probe — payment_cross_tenant_probe audit emission (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let userA: TestUser;
  let userB: TestUser;
  let memberAId: string;
  let memberBId: string;
  let invoiceAId: string;

  beforeAll(async () => {
    userA = await createActiveTestUser('member');
    userB = await createActiveTestUser('member');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
    memberAId = randomUUID();
    memberBId = randomUUID();
    invoiceAId = randomUUID();

    // ---- Seed tenant A: plan + member + invoice + payment settings ----
    const settingsA: NewTenantPaymentSettingsRow = {
      tenantId: tenantA.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: `acct_test_a_${tenantA.ctx.slug.slice(-8)}`,
      processorPublishableKey: `pk_test_a_${tenantA.ctx.slug.slice(-8)}`,
      enabledMethods: ['card', 'promptpay'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    };

    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(tenantPaymentSettings).values(settingsA);
      await tx.insert(membershipPlans).values({
        tenantId: tenantA.ctx.slug,
        planId: 'cr5-plan-a',
        planYear: 2026,
        planName: { en: 'CR5 Plan A' },
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
        createdBy: userA.userId,
        updatedBy: userA.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: memberAId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'CR5 A Co',
        country: 'TH',
        planId: 'cr5-plan-a',
        planYear: 2026,
      });
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenantA.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 500000n,
        legalNameTh: 'ทดสอบเอ',
        legalNameEn: 'Test A',
        taxId: '0000000000001',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'CR5A',
        creditNoteNumberPrefix: 'CR5AC',
      });
      await tx.insert(tenantDocumentSequences).values({
        tenantId: tenantA.ctx.slug,
        documentType: 'invoice',
        fiscalYear: 2026,
      });
      await tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
        invoiceId: invoiceAId,
        memberId: memberAId,
        planYear: 2026,
        planId: 'cr5-plan-a',
        status: 'issued',
        draftByUserId: userA.userId,
        fiscalYear: 2026,
        sequenceNumber: 1,
        documentNumber: 'CR5A-2026-000001',
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
          legal_name_th: 'ทดสอบเอ',
          legal_name_en: 'Test A',
          tax_id: '0000000000001',
          address_th: 'Bangkok',
          address_en: 'Bangkok',
          logo_blob_key: null,
        },
        memberIdentitySnapshot: {
          legal_name: 'CR5 A Co',
          tax_id: '1234567890124',
          address: 'Bangkok',
          primary_contact_name: 'CR5 A Contact',
          primary_contact_email: 'cr5a@example.com',
        },
        pdfBlobKey: 'invoices/cr5a.pdf',
        pdfSha256: 'b'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });

    // ---- Seed tenant B: minimal — payment settings + member only ----
    // (tenant B does NOT need an invoice — the probe uses tenant A's id)
    await runInTenant(tenantB.ctx, async (tx) => {
      await tx.insert(tenantPaymentSettings).values({
        tenantId: tenantB.ctx.slug,
        processor: 'stripe',
        processorEnvironment: 'test',
        processorAccountId: `acct_test_b_${tenantB.ctx.slug.slice(-8)}`,
        processorPublishableKey: `pk_test_b_${tenantB.ctx.slug.slice(-8)}`,
        enabledMethods: ['card', 'promptpay'],
        onlinePaymentEnabled: true,
        autoEmailOnPayment: true,
        promptpayQrExpirySeconds: 900,
        allowAnonymousPaylink: false,
      } satisfies NewTenantPaymentSettingsRow);
      await tx.insert(membershipPlans).values({
        tenantId: tenantB.ctx.slug,
        planId: 'cr5-plan-b',
        planYear: 2026,
        planName: { en: 'CR5 Plan B' },
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
        createdBy: userB.userId,
        updatedBy: userB.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantB.ctx.slug,
        memberId: memberBId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'CR5 B Co',
        country: 'TH',
        planId: 'cr5-plan-b',
        planYear: 2026,
      });
    });
  }, 120_000);

  afterAll(async () => {
    await tenantA?.cleanup().catch((e) => console.error('CR-5 tenant A cleanup:', e));
    await tenantB?.cleanup().catch((e) => console.error('CR-5 tenant B cleanup:', e));
  });

  it('initiatePayment from tenant B with tenant A invoice id → forbidden_invoice + audit emitted under tenant B', async () => {
    const settingsB: TenantPaymentSettings = {
      tenantId: tenantB.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: `acct_test_b_${tenantB.ctx.slug.slice(-8)}`,
      processorPublishableKey: `pk_test_b_${tenantB.ctx.slug.slice(-8)}`,
      enabledMethods: ['card', 'promptpay'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    };
    const settingsRepoFixture: TenantPaymentSettingsRepo = {
      async getByTenantId() {
        return settingsB;
      },
      async findByProcessorAccountId() {
        return settingsB;
      },
    };
    const deps: InitiatePaymentDeps = {
      ...makeInitiatePaymentDeps(tenantB.ctx.slug),
      processorGateway: makeNoOpGateway(),
      tenantSettingsRepo: settingsRepoFixture,
    };

    // Probe: caller is tenant B's actor; invoiceId belongs to tenant A.
    const result = await initiatePayment(deps, {
      tenantId: tenantB.ctx.slug,
      actorUserId: userB.userId,
      actorMemberId: memberBId,
      actorEmail: userB.email,
      invoiceId: invoiceAId,
      method: 'card',
      requestId: 'req-cr5-probe',
      correlationId: 'corr-cr5-probe',
    });

    // (1) Application-layer rejection — does NOT leak existence.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Either `invoice_not_found` or `forbidden_invoice` — both are
      // valid Principle I outcomes (ambiguous-by-design so the probing
      // actor cannot enumerate cross-tenant invoice ids).
      expect(['invoice_not_found', 'forbidden_invoice']).toContain(
        result.error.code,
      );
    }

    // (2) Audit row exists under tenant B's context.
    const probeRowsB = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.eventType, 'payment_cross_tenant_probe'),
          eq(auditLog.tenantId, tenantB.ctx.slug),
          sql`${auditLog.payload}->>'target_id' = ${invoiceAId}`,
        ),
      );
    expect(
      probeRowsB.length,
      `expected at least 1 payment_cross_tenant_probe audit row under tenant B for target_id=${invoiceAId}`,
    ).toBeGreaterThanOrEqual(1);
    const probeRow = probeRowsB[0]!;
    expect(probeRow.actorUserId).toBe(userB.userId);
    expect(probeRow.tenantId).toBe(tenantB.ctx.slug);
    // Payload pins probing tenant + target entity (NOT the victim
    // tenant — naming clarified per audit 2026-04-25 finding #12).
    const payload = probeRow.payload as Record<string, unknown>;
    expect(payload.acting_tenant_id).toBe(tenantB.ctx.slug);
    expect(payload.probing_actor_id).toBe(userB.userId);
    expect(payload.target_id).toBe(invoiceAId);
    // T-C (review 2026-04-27): negative assertion locking PII payload
    // shape — victim tenant id MUST NOT leak into the probe audit row
    // (would let an actor enumerate cross-tenant tenant slugs via audit
    // exports). Naming was clarified to `target_id` for this reason.
    expect(payload.victim_tenant_id).toBeUndefined();
    // Staff-review R2 R021 (2026-04-28): cross-tenant probe is a forensic
    // record — pin retention_years explicitly per
    // `F5_AUDIT_RETENTION_YEARS['payment_cross_tenant_probe'] = 5`. A
    // future change to the retention map must visibly break this test.
    // Probe row read via raw SQL since the Drizzle audit_log model does
    // not currently surface the `retention_years` column on the SELECT.
    const retentionRow = await db.execute<{ retention_years: number }>(sql`
      SELECT retention_years FROM audit_log WHERE id = ${probeRow.id}
    `);
    const [first] = Array.from(retentionRow);
    expect(first?.retention_years).toBe(5);

    // (3) RLS: the probe audit row is INVISIBLE to tenant A.
    const probeRowsA = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, 'payment_cross_tenant_probe'),
            sql`${auditLog.payload}->>'target_id' = ${invoiceAId}`,
          ),
        ),
    );
    expect(
      probeRowsA.length,
      `tenant A must NOT see tenant B's probe audit row under RLS — got ${probeRowsA.length} rows`,
    ).toBe(0);
  }, 60_000);
});
