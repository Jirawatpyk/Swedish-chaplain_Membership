/**
 * T061 integration — DrizzlePaymentsRepo against live Neon.
 *
 * Exercises the minimum-viable contract surface:
 *   - insert + lockForUpdate round-trip (card row + promptpay row)
 *   - updateStatus promotes pending → succeeded and paints card metadata
 *   - findPendingByInvoiceAndActor returns null when already terminal
 *   - findPendingByInvoiceAndActor works BOTH with caller-supplied tx
 *     AND with the repo's own runInTenant read tx (D-01 resume path)
 *   - listSiblingStatusesForInvariant excludes self
 *   - RLS cross-tenant isolation: tenant B's repo sees ZERO of tenant A's
 *     pending rows even when given tenant A's invoiceId / actorUserId
 *
 * Mocking policy: this file hits live Postgres. No SUT mocks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import {
  payments,
  tenantPaymentSettings,
  type NewTenantPaymentSettingsRow,
} from '@/modules/payments/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { PaymentId } from '@/modules/payments/domain/payment';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

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

describe('DrizzlePaymentsRepo — live Neon', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let aInvoiceIds: string[] = [];
  let aMemberId: string;
  let bInvoiceId: string;
  let bMemberId: string;

  // Unique-constraint `payments_one_active_per_invoice` — one pending
  // per invoice. Use a fresh invoice per test by allocating 3 up
  // front and consuming sequentially.
  let invoiceIndex = 0;
  const nextInvoice = (): string => {
    const id = aInvoiceIds[invoiceIndex];
    invoiceIndex += 1;
    if (!id) throw new Error('drizzle-payments-repo.test: ran out of seeded invoices');
    return id;
  };

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    aMemberId = randomUUID();
    bMemberId = randomUUID();
    // F5R3 H-9 (2026-05-16) — bumped 5 → 6 to seed the
    // expectedCurrentStatus-mismatch SQL-guard test below.
    aInvoiceIds = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    bInvoiceId = randomUUID();

    // Seed payment-settings + F4 parent chain for both tenants.
    // tenant A gets multiple invoices (one per test); tenant B gets one.
    for (const [t, prefix, memberId, invoiceIds] of [
      [tenantA, 'alpha', aMemberId, aInvoiceIds],
      [tenantB, 'beta', bMemberId, [bInvoiceId]],
    ] as const) {
      const settings: NewTenantPaymentSettingsRow = {
        tenantId: t.ctx.slug,
        processor: 'stripe',
        processorEnvironment: 'test',
        processorAccountId: `acct_test_${t.ctx.slug.slice(-8)}`,
        processorPublishableKey: `pk_test_${t.ctx.slug.slice(-8)}`,
        enabledMethods: ['card', 'promptpay'],
        onlinePaymentEnabled: true,
        autoEmailOnPayment: true,
        promptpayQrExpirySeconds: 900,
        allowAnonymousPaylink: false,
      };
      await runInTenant(t.ctx, async (tx) => {
        await tx.insert(tenantPaymentSettings).values(settings);
        await tx.insert(membershipPlans).values({
          tenantId: t.ctx.slug,
          planId: `${prefix}-plan`,
          planYear: 2026,
          planName: { en: `${prefix} Plan` },
          description: { en: '' },
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
        for (const iid of invoiceIds) {
          await tx.insert(invoices).values({
            tenantId: t.ctx.slug,
            invoiceId: iid,
            memberId,
            planYear: 2026,
            planId: `${prefix}-plan`,
            draftByUserId: user.userId,
          });
        }
      });
    }
  }, 90_000);

  afterAll(async () => {
    await tenantA.cleanup().catch((e) => console.error('tenantA cleanup:', e));
    await tenantB.cleanup().catch((e) => console.error('tenantB cleanup:', e));
  });

  // NOTE: The original DB CHECK `payments_card_metadata_iff_card`
  // (migration 0033) required card_* non-null on every card row,
  // including pending rows where card metadata is not yet known.
  // Migration 0042 (Group E2b) relaxed the constraint so
  // method='card' + status='pending' + NULL card metadata inserts
  // pass — aligning the DB with the Domain invariant
  // `assertCardMetadataComplete` (Group C T047). The insert contract
  // path is exercised below; the updateStatus card-painting branch
  // remains covered in unit tests against the port.

  it('insert + lockForUpdateByPaymentIntentId round-trips a promptpay payment', async () => {
    const invoiceId = nextInvoice();
    const repo = makeDrizzlePaymentsRepo(tenantA.ctx.slug);
    const paymentId = makeUlid();
    const pi = `pi_test_${randomUUID().slice(0, 8)}`;
    const now = new Date();

    const inserted = await repo.withTx(async (tx) =>
      repo.insert(tx, {
        id: paymentId as PaymentId,
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId: aMemberId,
        method: 'promptpay',
        amountSatang: 5_350_000n,
        processorPaymentIntentId: pi,
        processorEnvironment: 'test',
        attemptSeq: 1,
        initiatedAt: now,
        actorUserId: user.userId,
        correlationId: 'corr-r-001',
      }),
    );
    expect(inserted.status).toBe('pending');
    expect(inserted.card).toBeNull();

    const locked = await repo.withTx(async (tx) =>
      repo.lockForUpdateByPaymentIntentId(tx, pi, tenantA.ctx.slug),
    );
    expect(locked?.id).toBe(paymentId);
    expect(locked?.method).toBe('promptpay');
  });

  it('updateStatus promotes promptpay pending → succeeded; sibling list excludes self', async () => {
    // DB UNIQUE INDEX `payments_one_active_per_invoice` is partial on
    // `(tenant_id, invoice_id, status)` WHERE status IN (pending,
    // succeeded, partially_refunded). So to have a sibling co-exist
    // with a succeeded row we need its FINAL status to be in the
    // terminal-and-excluded set (failed / canceled / refunded) OR
    // to share the invoice but differ in status bucket. Here we park
    // the sibling at `failed` (excluded from the index) so the
    // subject can transition to `succeeded` without collision.
    const invoiceId = nextInvoice();
    const repo = makeDrizzlePaymentsRepo(tenantA.ctx.slug);
    const paymentId = makeUlid();
    const siblingPaymentId = makeUlid();
    const now = new Date();

    await repo.withTx(async (tx) => {
      await repo.insert(tx, {
        id: siblingPaymentId as PaymentId,
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId: aMemberId,
        method: 'promptpay',
        amountSatang: 999_000n,
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        initiatedAt: now,
        actorUserId: user.userId,
        correlationId: 'corr-r-002-sib',
      });
      await repo.updateStatus(tx, {
        paymentId: siblingPaymentId as PaymentId,
        tenantId: tenantA.ctx.slug,
        nextStatus: 'failed',
        card: null,
        failureReasonCode: 'test_failure',
        completedAt: now,
      });

      await repo.insert(tx, {
        id: paymentId as PaymentId,
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId: aMemberId,
        method: 'promptpay',
        amountSatang: 1_000_000n,
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 2,
        initiatedAt: now,
        actorUserId: user.userId,
        correlationId: 'corr-r-002',
      });
      const updated = await repo.updateStatus(tx, {
        paymentId: paymentId as PaymentId,
        tenantId: tenantA.ctx.slug,
        nextStatus: 'succeeded',
        processorChargeId: 'ch_test_1',
        card: null,
        completedAt: now,
      });
      // F5R2-CRIT-1 — `updateStatus` returns `Payment | null` now;
      // null only when `expectedCurrentStatus` was passed and missed.
      // This call omits `expectedCurrentStatus` so the throw-on-zero
      // path applies and a non-null Payment is guaranteed.
      expect(updated).not.toBeNull();
      if (!updated) throw new Error('expected non-null updated');
      expect(updated.status).toBe('succeeded');
      expect(updated.card).toBeNull();
      expect(updated.processorChargeId).toBe('ch_test_1');
    });

    await repo.withTx(async (tx) => {
      const siblings = await repo.listSiblingStatusesForInvariant(
        tx,
        tenantA.ctx.slug,
        invoiceId,
        paymentId as PaymentId,
      );
      expect(siblings).toHaveLength(1);
      expect(siblings[0]).toBe('failed');
    });
  });

  it('findPendingByInvoiceAndActor: works WITH caller tx AND WITHOUT (D-01 resume)', async () => {
    const invoiceId = nextInvoice();
    const repo = makeDrizzlePaymentsRepo(tenantA.ctx.slug);
    const paymentId = makeUlid();

    // Seed a pending row in a committed tx, then query from outside (no tx).
    await repo.withTx(async (tx) => {
      await repo.insert(tx, {
        id: paymentId as PaymentId,
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId: aMemberId,
        method: 'promptpay',
        amountSatang: 250_000n,
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        initiatedAt: new Date(),
        actorUserId: user.userId,
        correlationId: 'corr-r-003',
      });
    });

    // No-tx path (repo opens its own runInTenant)
    const noTx = await repo.findPendingByInvoiceAndActor(
      tenantA.ctx.slug,
      invoiceId,
      user.userId,
    );
    expect(noTx?.id).toBe(paymentId);
    expect(noTx?.method).toBe('promptpay');
    expect(noTx?.card).toBeNull();

    // With-tx path
    const withTx = await repo.withTx(async (tx) =>
      repo.findPendingByInvoiceAndActor(
        tenantA.ctx.slug,
        invoiceId,
        user.userId,
        tx,
      ),
    );
    expect(withTx?.id).toBe(paymentId);
  });

  it('migration 0042: card + status=pending insert with NULL card metadata SUCCEEDS', async () => {
    // Before migration 0042, the DB CHECK `payments_card_metadata_iff_card`
    // rejected this insert (required card_* non-null on every card row).
    // After 0042, a card rail in `pending` may carry NULL card metadata;
    // metadata is painted by the webhook on promotion to `succeeded`.
    const invoiceId = nextInvoice();
    const repo = makeDrizzlePaymentsRepo(tenantA.ctx.slug);
    const paymentId = makeUlid();
    const pi = `pi_test_${randomUUID().slice(0, 8)}`;
    const now = new Date();

    const inserted = await repo.withTx(async (tx) =>
      repo.insert(tx, {
        id: paymentId as PaymentId,
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId: aMemberId,
        method: 'card',
        amountSatang: 3_200_000n,
        processorPaymentIntentId: pi,
        processorEnvironment: 'test',
        attemptSeq: 1,
        initiatedAt: now,
        actorUserId: user.userId,
        correlationId: 'corr-r-e2b-card-pending',
      }),
    );
    expect(inserted.status).toBe('pending');
    expect(inserted.method).toBe('card');
    expect(inserted.card).toBeNull();
  });

  it('migration 0042: card transitions pending → canceled with NULL card metadata (Drizzle-reviewer #1)', async () => {
    // Drizzle-reviewer follow-up #1 (2026-04-24): verify the relaxed
    // CHECK allows a card-rail payment that NEVER reached succeeded
    // (user cancelled before webhook confirmed) to terminate with
    // NULL card metadata. Without this, migration 0042's
    // `status <> 'pending' AND card_* NOT NULL` branch would reject
    // the UPDATE because card metadata was never populated.
    const invoiceId = nextInvoice();
    const repo = makeDrizzlePaymentsRepo(tenantA.ctx.slug);
    const paymentId = makeUlid();
    const pi = `pi_test_${randomUUID().slice(0, 8)}`;
    const now = new Date();

    // Insert card + pending with NULL metadata (0042 path).
    await repo.withTx(async (tx) =>
      repo.insert(tx, {
        id: paymentId as PaymentId,
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId: aMemberId,
        method: 'card',
        amountSatang: 3_200_000n,
        processorPaymentIntentId: pi,
        processorEnvironment: 'test',
        attemptSeq: 1,
        initiatedAt: now,
        actorUserId: user.userId,
        correlationId: 'corr-r-drizzle-1-pending',
      }),
    );

    // Transition directly to canceled WITHOUT painting card metadata.
    // Must succeed under the relaxed CHECK — the 'card_metadata NOT
    // NULL on non-pending' branch only applies when card metadata was
    // populated during the succeeded lineage; a pre-succeeded cancel
    // leaves all card_* as NULL and the CHECK must accept that state.
    await repo.withTx(async (tx) =>
      repo.updateStatus(tx, {
        tenantId: tenantA.ctx.slug,
        paymentId: paymentId as PaymentId,
        nextStatus: 'canceled',
        completedAt: new Date(now.getTime() + 1_000),
      }),
    );

    // Confirm persistence + NULL card metadata survives.
    const reloaded = await repo.withTx((tx) =>
      repo.lockForUpdateByPaymentIntentId(tx, pi, tenantA.ctx.slug),
    );
    expect(reloaded?.status).toBe('canceled');
    expect(reloaded?.card).toBeNull();
  });

  it('RLS cross-tenant isolation: tenantB repo sees none of tenantA rows', async () => {
    const repoB = makeDrizzlePaymentsRepo(tenantB.ctx.slug);
    // Query tenant B's repo with tenant A's invoice (any prior-allocated id) + actor.
    const probeInvoice = aInvoiceIds[0]!;
    const leaked = await repoB.findPendingByInvoiceAndActor(
      tenantA.ctx.slug,
      probeInvoice,
      user.userId,
    );
    expect(leaked).toBeNull();

    // Verify direct DB read under tenant B's context yields zero A rows.
    const rowsUnderB = await runInTenant(tenantB.ctx, async (tx) =>
      tx.select().from(payments).where(eq(payments.tenantId, tenantA.ctx.slug)),
    );
    expect(rowsUnderB).toHaveLength(0);
  });

  it('H-8: findStaleInvoiceAutoRefund returns the refund ref iff matching audit row exists', async () => {
    // Use a fresh invoice id for this test so prior cases do not pollute.
    const repoA = makeDrizzlePaymentsRepo(tenantA.ctx.slug);
    const probeInvoiceId = randomUUID();

    // (1) No audit row yet → null.
    const before = await repoA.findStaleInvoiceAutoRefund(probeInvoiceId);
    expect(before).toBeNull();

    // (2) Append the canonical auto-refund audit row under tenant A's
    //     context (raw SQL — Drizzle auditLog schema does not expose
    //     `retention_years`; mirrors F4 audit-adapter pattern).
    const { sql: rawSql } = await import('drizzle-orm');
    const probeRefundId = `re_probe_${randomUUID().slice(0, 8)}`;
    const probePayload = JSON.stringify({
      payment_id: makeUlid(),
      invoice_id: probeInvoiceId,
      refunded_amount_satang: '1000000',
      cause: 'invoice_voided',
      processor_refund_id: probeRefundId,
    });
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.execute(rawSql`
        INSERT INTO audit_log
          (event_type, actor_user_id, summary, request_id, payload,
           tenant_id, retention_years)
        VALUES
          ('payment_auto_refunded_stale_invoice'::audit_event_type,
           '00000000-0000-0000-0000-000000000000',
           'H-8 integration probe',
           ${`h8-probe-${probeInvoiceId}`},
           ${probePayload}::jsonb,
           ${tenantA.ctx.slug},
           10)
      `);
    });

    const after = await repoA.findStaleInvoiceAutoRefund(probeInvoiceId);
    expect(after).not.toBeNull();
    expect(after!.processorRefundId).toBe(probeRefundId);

    // (3) Tenant B repo asking about tenant A's invoice → null. The
    //     factory-bound tenantId predicate means this would be null
    //     even without RLS, so this assertion alone proves only the
    //     WHERE-clause filter, not isolation. (4) below is the actual
    //     Constitution Principle I clause-3 cross-tenant test.
    const repoB = makeDrizzlePaymentsRepo(tenantB.ctx.slug);
    const crossTenant = await repoB.findStaleInvoiceAutoRefund(probeInvoiceId);
    expect(crossTenant).toBeNull();

    // (4) Principle I clause 3 — direct RLS probe. Run a raw SELECT
    //     for tenant A's audit row UNDER TENANT B's RLS context. This
    //     bypasses the factory-bound `WHERE tenant_id =` filter and
    //     proves the audit_log RLS policy actively blocks visibility.
    //     If RLS is misconfigured or accidentally permissive, this
    //     assertion fails — even if the repo's WHERE clause is right.
    const rlsProbe = await runInTenant(tenantB.ctx, async (tx) => {
      const result = await tx.execute(rawSql`
        SELECT 1 AS hit
          FROM audit_log
         WHERE event_type = 'payment_auto_refunded_stale_invoice'
           AND payload->>'invoice_id' = ${probeInvoiceId}
         LIMIT 1
      `);
      return Array.from(result as unknown as Iterable<unknown>);
    });
    expect(
      rlsProbe.length,
      'tenant B MUST NOT see tenant A audit_log rows under RLS — Constitution Principle I clause 3',
    ).toBe(0);
  });

  // ===========================================================================
  // F5R3 H-9 (2026-05-16) — live-Neon coverage of the
  // `expectedCurrentStatus` defence-in-depth WHERE clause (R2-CRIT-1).
  // ===========================================================================
  //
  // The unit tests for cancel-payment use a mocked PaymentsRepo that
  // returns `null` on `updateStatus(expectedCurrentStatus: ...)`
  // mismatch. That covers the Application-layer wiring but NOT the
  // SQL semantics — a typo like `eq(payments.statu, ...)` (column
  // name) or a missing `and(...)` join would silently drop the
  // WHERE clause without unit tests noticing. The repo-level
  // integration test below adversarially probes the actual SQL by
  // seeding a row + mutating its status out-of-band + invoking
  // updateStatus with the wrong expectedCurrentStatus, asserting:
  //   1. Returns `null` (not throws)
  //   2. The DB row is UNCHANGED (the most important invariant —
  //      if the WHERE clause was dropped, the row would silently
  //      flip to whatever nextStatus we asked for, which is the
  //      exact silent-overwrite bug R2-CRIT-1 closed).
  // ---------------------------------------------------------------------------

  it('R3-H9: updateStatus with mismatched expectedCurrentStatus returns null + leaves DB row UNCHANGED (defence-in-depth SQL guard)', async () => {
    const invoiceId = nextInvoice();
    const repo = makeDrizzlePaymentsRepo(tenantA.ctx.slug);
    const paymentId = makeUlid();
    const now = new Date();

    // Seed: insert a pending payment, then transition out-of-band
    // to succeeded (simulates a concurrent webhook landing between
    // the caller's lockForUpdate and the about-to-fire updateStatus).
    await repo.withTx(async (tx) => {
      await repo.insert(tx, {
        id: paymentId as PaymentId,
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId: aMemberId,
        method: 'card',
        amountSatang: 250_000n,
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        initiatedAt: now,
        actorUserId: user.userId,
        correlationId: 'corr-r-h9-seed',
      });
      // Out-of-band flip pending → succeeded (no expectedCurrentStatus
      // — represents the "concurrent webhook" that finalised the row).
      await repo.updateStatus(tx, {
        paymentId: paymentId as PaymentId,
        tenantId: tenantA.ctx.slug,
        nextStatus: 'succeeded',
        processorChargeId: 'ch_test_h9_oob',
        card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2027 },
        completedAt: now,
      });
    });

    // Now adversarially attempt to flip succeeded → canceled with
    // `expectedCurrentStatus: 'pending'` (the value the caller saw
    // BEFORE the out-of-band flip). The SQL WHERE clause should
    // match zero rows and the adapter should return null. The DB
    // row's status MUST stay 'succeeded' — if the WHERE clause was
    // silently dropped, the row would flip to 'canceled' and SC-013
    // would break (charged customer, DB says canceled).
    await repo.withTx(async (tx) => {
      const updated = await repo.updateStatus(tx, {
        paymentId: paymentId as PaymentId,
        tenantId: tenantA.ctx.slug,
        nextStatus: 'canceled',
        expectedCurrentStatus: 'pending',
        completedAt: now,
      });
      expect(updated, 'mismatched expectedCurrentStatus must return null').toBeNull();
    });

    // Verify the actual DB row: status still 'succeeded' (the
    // out-of-band write survived; the racing canceled attempt did
    // NOT silently overwrite).
    const verified = await repo.withTx(async (tx) =>
      repo.lockForUpdate(tx, paymentId as PaymentId, tenantA.ctx.slug),
    );
    expect(verified, 'seeded payment row must still exist').not.toBeNull();
    expect(verified!.status).toBe('succeeded');
    expect(verified!.processorChargeId).toBe('ch_test_h9_oob');
  });
});
