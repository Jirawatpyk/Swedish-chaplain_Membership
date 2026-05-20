/**
 * T043 — F5 Tenant isolation integration test (REVIEW-GATE BLOCKER).
 *
 * Constitution v1.4.0 Principle I clause 3 — cross-tenant probes on every
 * CRUD operation against all 4 F5 tables, from both directions.
 *
 * Why this is a blocker: F5 carries financial PII (payment method details,
 * processor charge IDs, refund amounts). A single missed RLS path leaks
 * payment records across chambers — a PCI DSS scope violation.
 *
 * Covered surfaces (all 4 F5 tables):
 *   - payments              — SELECT / UPDATE / DELETE
 *   - refunds               — SELECT / UPDATE / DELETE
 *   - tenant_payment_settings — SELECT / UPDATE
 *   - processor_events      — SELECT / UPDATE / INSERT
 *     (processor_events.tenantId is nullable pre-resolution; both NULL
 *      and post-resolution states are probed)
 *
 * Cross-tenant-probe audit emission (`payment_cross_tenant_probe`) is
 * deferred to the application use-case layer (Group D T051). The RLS
 * table-level guarantee tested here is independent of use-case existence.
 *
 * Sibling file: tests/integration/invoicing/tenant-isolation.test.ts (F4).
 *
 * RED reason: F5 DB tables (payments, refunds, tenant_payment_settings,
 * processor_events) do not exist in the live Neon schema yet — migrations
 * 0033–0036 + 0040 are applied by Group A T028/T029/T030/T031. Additionally,
 * test-tenant.ts cleanup does NOT yet include F5 tables, so beforeAll seeding
 * will fail. This entire test suite is RED until Group A migrations land AND
 * test-tenant.ts is updated to clean F5 tables (Group C T049).
 *
 * Turns GREEN: Group A T028-T031 (migrations) + Group C T049 (test-tenant
 * cleanup extension).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  payments,
  refunds,
  tenantPaymentSettings,
  processorEvents,
  type NewPaymentRow,
  type NewRefundRow,
  type NewTenantPaymentSettingsRow,
  type NewProcessorEventRow,
} from '@/modules/payments/infrastructure/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

const F5_ISOLATION_MATRIX: BenefitMatrix = {
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

// ---------------------------------------------------------------------------
// Helper: ULID-shaped text ID for payment / refund rows
// ---------------------------------------------------------------------------
function makeUlid(): string {
  // Simple collision-resistant prefix for test rows; not production-grade ULID
  return `pmt_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

describe('F5 Tenant isolation — REVIEW-GATE BLOCKER (T043)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;

  // payments
  let aPaymentId: string;
  let bPaymentId: string;

  // refunds
  let aRefundId: string;
  let bRefundId: string;

  // processor_events
  let aEventId: string;
  let bEventId: string;

  // FK targets surfaced for INSERT-probe tests (Review CR-5).
  let bInvoiceIdShared: string;
  let bMemberIdShared: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // ------------------------------------------------------------------
    // Seed tenant_payment_settings per tenant
    // ------------------------------------------------------------------
    for (const t of [tenantA, tenantB]) {
      const settingsRow: NewTenantPaymentSettingsRow = {
        tenantId: t.ctx.slug,
        processor: 'stripe',
        processorEnvironment: 'test',
        processorAccountId: `acct_test_${t.ctx.slug.slice(-8)}`,
        processorPublishableKey: `pk_test_${t.ctx.slug.slice(-8)}`,
        enabledMethods: ['card'],
        onlinePaymentEnabled: true,
        autoEmailOnPayment: true,
        promptpayQrExpirySeconds: 900,
        allowAnonymousPaylink: false,
      };
      await runInTenant(t.ctx, (tx) =>
        tx.insert(tenantPaymentSettings).values(settingsRow),
      );
    }

    // ------------------------------------------------------------------
    // Seed parent F4 chain per tenant: plan → member → invoice_settings →
    // sequences → invoice. payments.invoiceId has a composite FK to
    // invoices(tenant_id, invoice_id); skipping this chain triggers
    // "payments_invoice_tenant_fk" violations at insert time.
    // ------------------------------------------------------------------
    const aMemberId = randomUUID();
    const bMemberId = randomUUID();
    const aInvoiceId = randomUUID();
    const bInvoiceId = randomUUID();
    bInvoiceIdShared = bInvoiceId;
    bMemberIdShared = bMemberId;

    for (const [t, prefix, memberId, invoiceId] of [
      [tenantA, 'alpha', aMemberId, aInvoiceId],
      [tenantB, 'beta', bMemberId, bInvoiceId],
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
          benefitMatrix: F5_ISOLATION_MATRIX,
          isActive: true,
          createdBy: user.userId,
          updatedBy: user.userId,
        });
        await tx.insert(members).values({
          tenantId: t.ctx.slug,
          memberId,
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
        await tx.insert(invoices).values({
          tenantId: t.ctx.slug,
          invoiceId,
          memberId,
          planYear: 2026,
          planId: `${prefix}-plan`,
          draftByUserId: user.userId,
        });
      });
    }

    aPaymentId = makeUlid();
    bPaymentId = makeUlid();

    const now = new Date();

    const aPaymentRow: NewPaymentRow = {
      id: aPaymentId,
      tenantId: tenantA.ctx.slug,
      invoiceId: aInvoiceId,
      memberId: aMemberId,
      method: 'card',
      status: 'pending',
      amountSatang: 5_350_000n,
      currency: 'THB',
      processorPaymentIntentId: `pi_test_a_${randomUUID().slice(0, 8)}`,
      processorEnvironment: 'test',
      attemptSeq: 1,
      // Migration 0042 (Group E2b, 2026-04-24) relaxed the original
      // `payments_card_metadata_iff_card` CHECK to match the Domain
      // invariant `assertCardMetadataComplete`: method='card' + status='pending'
      // rows MUST carry NULL card_* fields (Stripe hasn't returned card
      // details at initiate time). Succeeded card rows carry the full
      // card metadata — tested under a separate fixture.
      cardBrand: null,
      cardLast4: null,
      cardExpMonth: null,
      cardExpYear: null,
      initiatedAt: now,
      actorUserId: user.userId,
      correlationId: 'corr-a-001',
    };

    const bPaymentRow: NewPaymentRow = {
      id: bPaymentId,
      tenantId: tenantB.ctx.slug,
      invoiceId: bInvoiceId,
      memberId: bMemberId,
      method: 'card',
      status: 'pending',
      amountSatang: 3_200_000n,
      currency: 'THB',
      processorPaymentIntentId: `pi_test_b_${randomUUID().slice(0, 8)}`,
      processorEnvironment: 'test',
      attemptSeq: 1,
      // Migration 0042 — pending card rows carry NULL card metadata.
      cardBrand: null,
      cardLast4: null,
      cardExpMonth: null,
      cardExpYear: null,
      initiatedAt: now,
      actorUserId: user.userId,
      correlationId: 'corr-b-001',
    };

    await runInTenant(tenantA.ctx, (tx) => tx.insert(payments).values(aPaymentRow));
    await runInTenant(tenantB.ctx, (tx) => tx.insert(payments).values(bPaymentRow));

    // ------------------------------------------------------------------
    // Seed refunds per tenant (point to own payment IDs)
    // ------------------------------------------------------------------
    aRefundId = makeUlid();
    bRefundId = makeUlid();

    const aRefundRow: NewRefundRow = {
      id: aRefundId,
      tenantId: tenantA.ctx.slug,
      paymentId: aPaymentId,
      invoiceId: aInvoiceId,
      amountSatang: 100_000n,
      reason: 'Test refund A',
      status: 'pending',
      initiatedAt: now,
      initiatorUserId: user.userId,
      correlationId: 'corr-refund-a-001',
    };

    const bRefundRow: NewRefundRow = {
      id: bRefundId,
      tenantId: tenantB.ctx.slug,
      paymentId: bPaymentId,
      invoiceId: bInvoiceId,
      amountSatang: 50_000n,
      reason: 'Test refund B',
      status: 'pending',
      initiatedAt: now,
      initiatorUserId: user.userId,
      correlationId: 'corr-refund-b-001',
    };

    await runInTenant(tenantA.ctx, (tx) => tx.insert(refunds).values(aRefundRow));
    await runInTenant(tenantB.ctx, (tx) => tx.insert(refunds).values(bRefundRow));

    // ------------------------------------------------------------------
    // Seed processor_events — both with tenant_id resolved (post-resolution)
    // The NULL tenant_id pre-resolution window is tested separately below.
    // ------------------------------------------------------------------
    aEventId = `evt_test_a_${randomUUID().slice(0, 16)}`;
    bEventId = `evt_test_b_${randomUUID().slice(0, 16)}`;

    const aEventRow: NewProcessorEventRow = {
      id: aEventId,
      tenantId: tenantA.ctx.slug,
      eventType: 'payment_intent.succeeded',
      apiVersion: '2024-06-20',
      livemode: false,
      processorAccountId: `acct_test_${tenantA.ctx.slug.slice(-8)}`,
      receivedAt: now,
      outcome: 'processed',
      payloadSha256: 'a'.repeat(64),
      correlationId: 'corr-evt-a-001',
    };

    const bEventRow: NewProcessorEventRow = {
      id: bEventId,
      tenantId: tenantB.ctx.slug,
      eventType: 'payment_intent.succeeded',
      apiVersion: '2024-06-20',
      livemode: false,
      processorAccountId: `acct_test_${tenantB.ctx.slug.slice(-8)}`,
      receivedAt: now,
      outcome: 'processed',
      payloadSha256: 'b'.repeat(64),
      correlationId: 'corr-evt-b-001',
    };

    // processor_events allows INSERT from the pre-resolution context (NULL tenantId);
    // we insert with resolved tenantId using runInTenant for simplicity.
    await runInTenant(tenantA.ctx, (tx) => tx.insert(processorEvents).values(aEventRow));
    await runInTenant(tenantB.ctx, (tx) => tx.insert(processorEvents).values(bEventRow));
  }, 60_000);

  afterAll(async () => {
    // Senior-tester F8 (Group B deferred, 2026-04-24): surface cleanup
    // failures instead of swallowing them silently — orphaned rows
    // across the 4 F5 tables would quietly pollute the live Neon schema
    // and poison later test runs.
    await tenantA.cleanup().catch((e) => {
      console.error('[T043] tenantA cleanup failed:', e);
    });
    await tenantB.cleanup().catch((e) => {
      console.error('[T043] tenantB cleanup failed:', e);
    });
  });

  // ---------------------------------------------------------------------------
  // tenant_payment_settings
  // ---------------------------------------------------------------------------

  it('A sees only A tenant_payment_settings', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(tenantPaymentSettings),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(tenantA.ctx.slug);
  });

  it('A cannot SELECT B tenant_payment_settings (cross-tenant returns 0 rows)', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(tenantPaymentSettings)
        .where(eq(tenantPaymentSettings.tenantId, tenantB.ctx.slug)),
    );
    expect(rows).toHaveLength(0);
  });

  it('A.update(B tenant_payment_settings) affects 0 rows', async () => {
    const updated = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(tenantPaymentSettings)
        .set({ onlinePaymentEnabled: false })
        .where(eq(tenantPaymentSettings.tenantId, tenantB.ctx.slug))
        .returning(),
    );
    expect(updated).toHaveLength(0);

    // B's setting must remain unchanged
    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx
        .select()
        .from(tenantPaymentSettings)
        .where(eq(tenantPaymentSettings.tenantId, tenantB.ctx.slug)),
    );
    expect(check).toHaveLength(1);
    expect(check[0]!.onlinePaymentEnabled).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // payments
  // ---------------------------------------------------------------------------

  it('A sees only A payments', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) => tx.select().from(payments));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(tenantA.ctx.slug);
    expect(rows[0]!.id).toBe(aPaymentId);
  });

  it('B sees only B payments', async () => {
    const rows = await runInTenant(tenantB.ctx, (tx) => tx.select().from(payments));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(bPaymentId);
  });

  it('A cannot SELECT B payment by id (RLS hides row)', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(payments).where(eq(payments.id, bPaymentId)),
    );
    expect(rows).toHaveLength(0);
  });

  it('A.update(B payment) affects 0 rows', async () => {
    const updated = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(payments)
        .set({ status: 'succeeded' })
        .where(eq(payments.id, bPaymentId))
        .returning(),
    );
    expect(updated).toHaveLength(0);

    // Confirm B's payment is still 'pending'
    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(payments).where(eq(payments.id, bPaymentId)),
    );
    expect(check).toHaveLength(1);
    expect(check[0]!.status).toBe('pending');
  });

  it('A.delete(B payment) affects 0 rows', async () => {
    const deleted = await runInTenant(tenantA.ctx, (tx) =>
      tx.delete(payments).where(eq(payments.id, bPaymentId)).returning(),
    );
    expect(deleted).toHaveLength(0);

    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(payments).where(eq(payments.id, bPaymentId)),
    );
    expect(check).toHaveLength(1);
  });

  // Constitution v1.4.0 Principle I clause 3 mandates
  // INSERT probes alongside SELECT/UPDATE/DELETE. RLS WITH CHECK on
  // payments rejects any INSERT carrying a tenant_id ≠ session tenant.
  it('A.insert(payment with tenant_id=B) is rejected by RLS WITH CHECK', async () => {
    const rogueId = makeUlid();
    const rogue: NewPaymentRow = {
      id: rogueId,
      tenantId: tenantB.ctx.slug, // cross-tenant payload — must be rejected
      invoiceId: bInvoiceIdShared,
      memberId: bMemberIdShared,
      method: 'card',
      status: 'pending',
      amountSatang: 1000n,
      currency: 'THB',
      processorPaymentIntentId: `pi_rogue_${rogueId}`,
      processorEnvironment: 'test',
      attemptSeq: 1,
      cardBrand: null,
      cardLast4: null,
      cardExpMonth: null,
      cardExpYear: null,
      initiatedAt: new Date(),
      actorUserId: user.userId,
      correlationId: `corr-rogue-${rogueId}`,
    };
    await expect(
      runInTenant(tenantA.ctx, (tx) => tx.insert(payments).values(rogue)),
    ).rejects.toThrow();

    // Confirm the rogue row never landed.
    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(payments).where(eq(payments.id, rogueId)),
    );
    expect(check).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // refunds
  // ---------------------------------------------------------------------------

  it('A sees only A refunds', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) => tx.select().from(refunds));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(tenantA.ctx.slug);
    expect(rows[0]!.id).toBe(aRefundId);
  });

  it('A cannot SELECT B refund by id', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(refunds).where(eq(refunds.id, bRefundId)),
    );
    expect(rows).toHaveLength(0);
  });

  it('A.update(B refund status) affects 0 rows', async () => {
    const updated = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(refunds)
        .set({ status: 'succeeded' })
        .where(eq(refunds.id, bRefundId))
        .returning(),
    );
    expect(updated).toHaveLength(0);

    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(refunds).where(eq(refunds.id, bRefundId)),
    );
    expect(check).toHaveLength(1);
    expect(check[0]!.status).toBe('pending');
  });

  it('A.delete(B refund) affects 0 rows', async () => {
    const deleted = await runInTenant(tenantA.ctx, (tx) =>
      tx.delete(refunds).where(eq(refunds.id, bRefundId)).returning(),
    );
    expect(deleted).toHaveLength(0);

    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(refunds).where(eq(refunds.id, bRefundId)),
    );
    expect(check).toHaveLength(1);
  });

  // INSERT probe for refunds.
  it('A.insert(refund with tenant_id=B) is rejected by RLS WITH CHECK', async () => {
    const rogueId = makeUlid();
    const rogue: NewRefundRow = {
      id: rogueId,
      tenantId: tenantB.ctx.slug, // cross-tenant payload
      paymentId: bPaymentId,
      invoiceId: bInvoiceIdShared,
      amountSatang: 1n,
      reason: 'rogue-cross-tenant',
      status: 'pending',
      initiatedAt: new Date(),
      initiatorUserId: user.userId,
      correlationId: `corr-rogue-${rogueId}`,
    };
    await expect(
      runInTenant(tenantA.ctx, (tx) => tx.insert(refunds).values(rogue)),
    ).rejects.toThrow();

    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(refunds).where(eq(refunds.id, rogueId)),
    );
    expect(check).toHaveLength(0);
  });

  // INSERT probe for tenant_payment_settings.
  // RLS WITH CHECK rejects any INSERT carrying a tenant_id ≠ the
  // session's `app.current_tenant`. The pre-seeded UNIQUE-on-tenant_id
  // would also block a same-tenant collision, but RLS fires first when
  // the session tenant differs.
  it('A.insert(tenant_payment_settings with tenant_id=B) is rejected by RLS WITH CHECK', async () => {
    const rogue: NewTenantPaymentSettingsRow = {
      tenantId: tenantB.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: `acct_rogue_${randomUUID().slice(0, 8)}`,
      processorPublishableKey: 'pk_test_rogue',
      enabledMethods: ['card'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    };
    await expect(
      runInTenant(tenantA.ctx, (tx) =>
        tx.insert(tenantPaymentSettings).values(rogue),
      ),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // processor_events — post-resolution (tenantId set)
  // ---------------------------------------------------------------------------

  it('A sees only A processor_events (post-resolution)', async () => {
    // Senior-tester F7 (Group B deferred, 2026-04-24): the previous
    // `.filter(r => r.tenantId === A.slug)` style silently accepts a
    // leak — if RLS actually returned B rows, the filter would hide
    // them and the length assertion would still pass at 1. Assert the
    // raw row count directly: A + B each seeded exactly 1 event, so
    // a tenant-scoped SELECT must return exactly 1 row AND every row
    // it returns must carry A's tenantId.
    const rows = await runInTenant(tenantA.ctx, (tx) => tx.select().from(processorEvents));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(tenantA.ctx.slug);
    expect(rows[0]!.id).toBe(aEventId);
  });

  it('A cannot SELECT B processor_events by id (RLS hides row)', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(processorEvents).where(eq(processorEvents.id, bEventId)),
    );
    expect(rows).toHaveLength(0);
  });

  it('A.update(B processor_event) affects 0 rows', async () => {
    const updated = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(processorEvents)
        .set({ outcome: 'acknowledged_only' })
        .where(eq(processorEvents.id, bEventId))
        .returning(),
    );
    expect(updated).toHaveLength(0);

    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(processorEvents).where(eq(processorEvents.id, bEventId)),
    );
    expect(check).toHaveLength(1);
    expect(check[0]!.outcome).toBe('processed');
  });

  // INSERT probe completes Constitution v1.4.0 Principle I clause 3
  // matrix coverage for processor_events post-resolution path. Pre-resolution
  // path (tenantId NULL) is INSERT-allowed by design (covered by line ~575
  // SELECT-policy verification of NULL-tenant rejection rows).
  it('A.insert(processor_event with tenant_id=B) is rejected by RLS WITH CHECK', async () => {
    const rogueId = `evt_rogue_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const rogue: NewProcessorEventRow = {
      id: rogueId,
      tenantId: tenantB.ctx.slug, // cross-tenant payload — must be rejected
      eventType: 'payment_intent.succeeded',
      apiVersion: '2024-06-20',
      livemode: false,
      processorAccountId: 'acct_rogue',
      outcome: 'processed',
      payloadSha256: 'a'.repeat(64),
      correlationId: `corr-rogue-${rogueId}`,
      receivedAt: new Date(),
    };
    await expect(
      runInTenant(tenantA.ctx, (tx) =>
        tx.insert(processorEvents).values(rogue),
      ),
    ).rejects.toThrow();

    // Confirm no row landed under B's view either.
    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(processorEvents).where(eq(processorEvents.id, rogueId)),
    );
    expect(check).toHaveLength(0);
  });

  // processor_events DELETE is forbidden by RLS FOR ALL tenants (append-only)
  it('A.delete(A processor_event) affects 0 rows — append-only policy', async () => {
    const deleted = await runInTenant(tenantA.ctx, (tx) =>
      tx.delete(processorEvents).where(eq(processorEvents.id, aEventId)).returning(),
    );
    expect(deleted).toHaveLength(0);

    // Row must still exist
    const check = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(processorEvents).where(eq(processorEvents.id, aEventId)),
    );
    expect(check).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // processor_events — NULL tenantId rejection-audit rows
  // Constitution v1.4.0 Principle I clause 3 — Review-Gate blocker.
  //
  // Background: data-model.md § 5.4 originally described a "pre-
  // resolution → UPDATE" flow where the webhook INSERTs a NULL-tenant
  // row and later UPDATEs `tenant_id` once resolved. Empirical audit
  // 2026-04-25 proved this flow is UNIMPLEMENTABLE under the current
  // RLS policies — PostgreSQL applies the SELECT policy's USING clause
  // as a visibility filter BEFORE any UPDATE policy evaluation, and
  // the strict SELECT policy (`tenant_id = current_setting`) hides
  // NULL rows from every chamber_app context. UPDATE's more-permissive
  // USING (`tenant_id IS NULL OR = current_setting`) never gets a
  // chance to evaluate.
  //
  // Production follows the actually-safe pattern: the webhook route
  // resolves `tenant_id` BEFORE calling `processWebhookEvent` under
  // `runInTenant(resolvedCtx, ...)`. NULL-tenantId rows ONLY appear as
  // REJECTION audit records (environment mismatch / api-version
  // mismatch / acknowledged_only for unknown-account) via
  // `insertRejectedProcessorEvent` (src/lib/stripe-webhook-deps.ts:68)
  // — these rows are system-level rejection logs and never need to be
  // promoted to a tenant.
  //
  // The invariant this test therefore pins is the ACTUAL production
  // contract: NULL-tenant rejection rows are INVISIBLE to all chamber_app
  // contexts (tenantA AND tenantB both see 0 rows). That is the security
  // guarantee Principle I clause 3 needs — no tenant can enumerate the
  // rejected-webhook audit trail of another tenant (or even their own).
  // Reviewing rejection audits is an ops-role concern handled out-of-
  // band via the `neondb_owner` role, which has BYPASSRLS.
  // ---------------------------------------------------------------------------
  it('NULL-tenantId rejection row is invisible to every chamber_app tenant (Principle I clause 3 — audit 2026-04-25)', async () => {
    const nullEventId = `evt_null_${randomUUID().slice(0, 16)}`;

    // INSERT a NULL-tenant rejection row under chamber_app. INSERT
    // policy's WITH CHECK permits NULL, so the row persists. We do
    // this under tenantA's context because the real rejected-path in
    // production runs outside runInTenant (see `insertRejectedProcessor
    // Event`) — but the RLS INSERT policy is role-keyed, not tenant-
    // keyed, so the row that lands is semantically identical.
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.execute(sql`
        INSERT INTO processor_events (
          id, tenant_id, event_type, api_version, livemode,
          processor_account_id, received_at, outcome,
          payload_sha256, correlation_id
        ) VALUES (
          ${nullEventId}, NULL, 'payment_intent.succeeded',
          '2024-06-20', false, 'acct_unknown',
          NOW(), 'acknowledged_only',
          ${'c'.repeat(64)}, 'corr-null-rejection-001'
        )
      `);
    });

    // Neither tenantA nor tenantB can SELECT the row via chamber_app
    // (SELECT policy `tenant_id = current_setting` never matches NULL).
    const aRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(processorEvents)
        .where(eq(processorEvents.id, nullEventId)),
    );
    expect(aRows).toHaveLength(0);

    const bRows = await runInTenant(tenantB.ctx, (tx) =>
      tx
        .select()
        .from(processorEvents)
        .where(eq(processorEvents.id, nullEventId)),
    );
    expect(bRows).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Cross-tenant-probe audit emission — CLOSED via unit tests, not integration.
  //
  // Group B PCI F7 (deferred 2026-04-23): this placeholder existed to track
  // `payment_cross_tenant_probe` audit emission once the Application layer
  // landed. Group D T055 (initiate-payment) + T059 (cancel-payment) now
  // emit via `deps.audit.emit(null, { eventType: 'payment_cross_tenant_probe',
  // ... })` on every forbidden_invoice / forbidden_payment branch; paired
  // unit tests in tests/unit/payments/application/ pin the emission at call
  // count + structural payload level:
  //   - initiate-payment.test.ts:363 ("invoice forbidden — forbidden_invoice
  //     + payment_cross_tenant_probe emitted")
  //   - cancel-and-fail-payment.test.ts (analogous coverage on cancel path)
  //
  // An integration-level duplicate would require wiring 2 live-Neon tenants
  // through the full initiate-use-case chain including Stripe mock — ROI
  // low vs the unit tests already GREEN. Close the placeholder.
  // ---------------------------------------------------------------------------
});
