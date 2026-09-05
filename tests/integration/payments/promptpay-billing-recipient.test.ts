/**
 * 108 T029 remediation (US1, FR-004) — the address handed to Stripe for a
 * PromptPay PaymentIntent is the MEMBER's live primary contact, proven against
 * live Neon through the real adapter.
 *
 * The unit tests mock `billingRecipient` entirely, which means the whole chain
 * they cannot see — adapter → members barrel → `runInTenant` →
 * `findPrimaryContactEmailInTx` → RLS — had never executed against a database.
 * The review that asked for this file made the point sharply: the one finding a
 * mock cannot expose (a repo failure being indistinguishable from "no contact")
 * lived exactly there.
 *
 * The gateway is a spy: no Stripe call is made, but every argument it would
 * have received is captured, so `billing_details.email` is asserted on the real
 * value the real adapter produced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ok } from '@/lib/result';
import { db, runInTenant } from '@/lib/db';
import { makeInitiatePaymentDeps } from '@/modules/payments/infrastructure/di';
import { initiatePayment } from '@/modules/payments/application/use-cases/initiate-payment';
import type { InitiatePaymentDeps } from '@/modules/payments/application/use-cases/initiate-payment';
import type { ProcessorGatewayPort } from '@/modules/payments/application/ports/processor-gateway-port';
import type { TenantPaymentSettingsRepo } from '@/modules/payments/application/ports/tenant-payment-settings-repo';
import type { TenantPaymentSettings } from '@/modules/payments/domain/tenant-payment-settings';
import {
  payments,
  tenantPaymentSettings,
  type NewTenantPaymentSettingsRow,
} from '@/modules/payments/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
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

const PLAN_ID = 'promptpay-billing-plan';

/** Captures what would have gone to Stripe without calling it. */
function makeCapturingGateway(): {
  gateway: ProcessorGatewayPort;
  calls: Array<{ billingEmail?: string; paymentMethodTypes: readonly string[] }>;
} {
  const calls: Array<{ billingEmail?: string; paymentMethodTypes: readonly string[] }> = [];
  const gateway = {
    async createPaymentIntent(input: {
      billingEmail?: string;
      paymentMethodTypes: readonly string[];
    }) {
      calls.push({ ...(input.billingEmail === undefined ? {} : { billingEmail: input.billingEmail }), paymentMethodTypes: input.paymentMethodTypes });
      return ok({
        id: `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        clientSecret: 'cs_test_secret',
        status: 'requires_action' as const,
        livemode: false,
        promptpayQrSvgUrl: 'https://qr.stripe.test/x.svg',
      });
    },
    async retrievePaymentIntent() {
      throw new Error('promptpay-billing-recipient.test: retrievePaymentIntent must not be called');
    },
    async cancelPaymentIntent() {
      throw new Error('promptpay-billing-recipient.test: cancelPaymentIntent must not be called');
    },
    async createRefund() {
      throw new Error('promptpay-billing-recipient.test: createRefund must not be called');
    },
    async retrieveRefund() {
      throw new Error('promptpay-billing-recipient.test: retrieveRefund must not be called');
    },
  } as unknown as ProcessorGatewayPort;
  return { gateway, calls };
}

describe('108 initiatePayment — PromptPay billing recipient (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('member');
    tenant = await createTestTenant();

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
        planId: PLAN_ID,
        planYear: 2026,
        planName: { en: 'PromptPay Billing Plan' },
        description: { en: '108 billing-recipient fixture' },
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
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 500000n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000001',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'PPB',
        creditNoteNumberPrefix: 'PPBC',
      });
      await tx.insert(tenantDocumentSequences).values({
        tenantId: tenant.ctx.slug,
        documentType: 'invoice',
        fiscalYear: 2026,
      });
    });
  }, 120_000);

  afterAll(async () => {
    for (const table of [payments, invoices, contacts, members] as const) {
      await db.delete(table).where(eq(table.tenantId, tenant.ctx.slug)).catch(() => {});
    }
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  /** Member + issued invoice; `primaryEmail: null` seeds NO contact at all. */
  async function seedPayableInvoice(
    primaryEmail: string | null,
    sequence: number,
  ): Promise<{ memberId: string; invoiceId: string }> {
    const memberId = randomUUID();
    const invoiceId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'PromptPay Billing Co',
        country: 'TH',
        planId: PLAN_ID,
        planYear: 2026,
      });
      // Every member WITH a primary also gets a LIVE secondary. Without it
      // the repo's `is_primary` predicate could be deleted and these tests
      // stay green — and 'the primary, not a secondary' is the entire feature.
      // The no-primary member (primaryEmail === null) gets NO contact rows:
      // since 108 PR-B (migration 0293) an active member with contact rows
      // must carry exactly one live primary at COMMIT, so "secondary only" is
      // no longer a reachable state — the contact-less member is.
      if (primaryEmail !== null) {
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId,
          firstName: 'Live',
          lastName: 'Secondary',
          email: `live-secondary-${randomUUID().slice(0, 8)}@example.com`,
          isPrimary: false,
        });
      }
      if (primaryEmail !== null) {
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId,
          firstName: 'Primary',
          lastName: 'Contact',
          email: primaryEmail,
          isPrimary: true,
        });
      }
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: PLAN_ID,
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: user.userId,
        fiscalYear: 2026,
        sequenceNumber: sequence,
        documentNumber: `PPB-2026-${String(sequence).padStart(6, '0')}`,
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
          tax_id: '0000000000001',
          address_th: 'Bangkok',
          address_en: 'Bangkok',
          logo_blob_key: null,
        },
        memberIdentitySnapshot: {
          legal_name: 'PromptPay Billing Co',
          tax_id: '1234567890124',
          address: 'Bangkok',
          // The FROZEN address — deliberately different from every live contact
          // below, so any assertion that passes by accident would show it.
          primary_contact_name: 'Frozen At Issue',
          primary_contact_email: 'frozen-at-issue@example.com',
        },
        pdfBlobKey: `invoices/ppb-${sequence}.pdf`,
        pdfSha256: 'c'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });
    return { memberId, invoiceId };
  }

  function makeDeps(gateway: ProcessorGatewayPort): InitiatePaymentDeps {
    // The real settings repo wraps its read in Next's `unstable_cache`, which
    // has no incremental-cache context outside a request — the sibling
    // cross-tenant test substitutes it for the same reason. Everything else,
    // including the billing-recipient adapter under test, stays real.
    const settings: TenantPaymentSettings = {
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
        return settings;
      },
      async findByProcessorAccountId() {
        return settings;
      },
    };
    return {
      ...makeInitiatePaymentDeps(tenant.ctx.slug),
      processorGateway: gateway,
      tenantSettingsRepo: settingsRepo,
    };
  }

  it('PromptPay hands Stripe the live primary contact, not the frozen snapshot', async () => {
    const live = `live-primary-${randomUUID().slice(0, 8)}@example.com`;
    const { memberId, invoiceId } = await seedPayableInvoice(live, 1);
    const { gateway, calls } = makeCapturingGateway();

    const r = await initiatePayment(makeDeps(gateway), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      actorMemberId: memberId,
      invoiceId,
      method: 'promptpay',
      requestId: 'req-ppb-1',
      correlationId: 'corr-ppb-1',
    });

    expect(r.ok, r.ok ? 'ok' : JSON.stringify(r)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.billingEmail).toBe(live);
    expect(calls[0]!.billingEmail).not.toBe('frozen-at-issue@example.com');
  }, 120_000);

  it('after a promotion, the NEW primary is what reaches Stripe', async () => {
    const first = `first-${randomUUID().slice(0, 8)}@example.com`;
    const { memberId, invoiceId } = await seedPayableInvoice(first, 2);
    const promoted = `promoted-${randomUUID().slice(0, 8)}@example.com`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(contacts)
        .set({ isPrimary: false, removedAt: new Date() })
        .where(eq(contacts.memberId, memberId));
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Promoted',
        lastName: 'Primary',
        email: promoted,
        isPrimary: true,
      });
    });
    const { gateway, calls } = makeCapturingGateway();

    const r = await initiatePayment(makeDeps(gateway), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      actorMemberId: memberId,
      invoiceId,
      method: 'promptpay',
      requestId: 'req-ppb-2',
      correlationId: 'corr-ppb-2',
    });

    expect(r.ok, r.ok ? 'ok' : JSON.stringify(r)).toBe(true);
    expect(calls[0]!.billingEmail).toBe(promoted);
    expect(calls[0]!.billingEmail).not.toBe(first);
  }, 120_000);

  it('no live primary → primary_contact_missing, no PaymentIntent, no payment row', async () => {
    const { memberId, invoiceId } = await seedPayableInvoice(null, 3);
    const { gateway, calls } = makeCapturingGateway();

    const r = await initiatePayment(makeDeps(gateway), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      actorMemberId: memberId,
      invoiceId,
      method: 'promptpay',
      requestId: 'req-ppb-3',
      correlationId: 'corr-ppb-3',
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('primary_contact_missing');
    expect(calls).toHaveLength(0);
    // The refusal happens before the transaction opens, so nothing was written.
    const rows = await db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.invoiceId, invoiceId));
    expect(rows).toHaveLength(0);
  }, 120_000);

  it('card needs no primary contact and shares no address', async () => {
    const { memberId, invoiceId } = await seedPayableInvoice(null, 4);
    const { gateway, calls } = makeCapturingGateway();

    const r = await initiatePayment(makeDeps(gateway), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      actorMemberId: memberId,
      invoiceId,
      method: 'card',
      requestId: 'req-ppb-4',
      correlationId: 'corr-ppb-4',
    });

    expect(r.ok, r.ok ? 'ok' : JSON.stringify(r)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.billingEmail).toBeUndefined();
  }, 120_000);

  it('an EMPTY primary address is treated as no address (re-review LOW-4)', async () => {
    // `contacts.email` is NOT NULL but only length-checked, so a bulk import
    // that bypassed `asEmail` can store ''. F4's resolver has always treated
    // that as no-recipient; F5 did not, and would have handed Stripe '' — an
    // opaque `processor_unavailable` the member cannot act on.
    const { memberId, invoiceId } = await seedPayableInvoice('', 5);
    const { gateway, calls } = makeCapturingGateway();

    const r = await initiatePayment(makeDeps(gateway), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      actorMemberId: memberId,
      invoiceId,
      method: 'promptpay',
      requestId: 'req-ppb-5',
      correlationId: 'corr-ppb-5',
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('primary_contact_missing');
    expect(calls).toHaveLength(0);
  }, 120_000);

  it('a REAL repo failure is transient, never the permanent no-contact refusal (re-review LOW-6)', async () => {
    // The distinction this port exists for, exercised against a real database
    // instead of a mock. The failure is induced honestly: `contacts.member_id`
    // is `uuid`, so a non-UUID id makes Postgres raise, the repo catches it as
    // `repo.unexpected`, and the adapter must report `read_failed` — NOT the
    // `primary_contact_missing` that asserts a fact about the member's data.
    //
    // Mutate the adapter's catch back to `return null` and this goes red with
    // a 409, which is exactly the bug the review found.
    const { gateway, calls } = makeCapturingGateway();
    const deps = makeDeps(gateway);
    const result = await deps.billingRecipient.getPrimaryContactEmail(
      tenant.ctx.slug,
      'definitely-not-a-uuid',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('read_failed');
    expect(calls).toHaveLength(0);
  }, 120_000);

  it('and the same adapter succeeds on a real member (the control)', async () => {
    // Without this, the assertion above would pass against an adapter that
    // failed for every input.
    const { memberId } = await seedPayableInvoice('control@example.com', 6);
    const { gateway } = makeCapturingGateway();
    const result = await makeDeps(gateway).billingRecipient.getPrimaryContactEmail(
      tenant.ctx.slug,
      memberId,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('control@example.com');
  }, 120_000);
});
