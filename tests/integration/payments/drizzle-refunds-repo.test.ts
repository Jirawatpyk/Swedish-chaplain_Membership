/**
 * T109 integration — DrizzleRefundsRepo against live Neon.
 *
 * Smoke-tests the repo's contract:
 *   - insert + round-trip via getRefundContextForUpdate
 *   - updateStatus pending → failed (with failureReasonCode)
 *   - findByProcessorRefundId after Stripe id is set
 *   - getRefundContextForUpdate aggregates correctly across multiple
 *     inserts in the same (tenant, payment) partition (pending count
 *     + nextSeq increment); succeeded-sum path is covered indirectly
 *     via the empty-partition COALESCE check
 *   - RLS cross-tenant isolation: tenant B's repo sees ZERO of
 *     tenant A's refund rows even when given tenant A's paymentId
 *
 * The succeeded-path round-trip (with credit_note_id NOT NULL) is
 * NOT covered here — it requires seeding an F4 credit_note row
 * (full PDF + Blob + sequence allocation chain). That round-trip is
 * exercised end-to-end via the issueRefund use-case integration test.
 *
 * Mocking policy: this file hits live Postgres. No SUT mocks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { asSatang } from '@/lib/money';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { makeDrizzleRefundsRepo } from '@/modules/payments/infrastructure/repos/drizzle-refunds-repo';
// Money-remediation Task 6: writing `failed` requires evidence. These cases
// simulate a processor-confirmed failed settlement, so they mint the proof
// from the real Domain function. The REJECTION_PROOF brand stays private —
// exporting it to make a stub compile would turn the guard into decoration.
import { proveProcessorSettledFailed } from '@/modules/payments/domain/settlement/money-moved';
import {
  payments,
  refunds,
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

function makePaymentUlid(): string {
  return `pmt_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
function makeRefundUlid(): string {
  return `rfnd_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

describe('DrizzleRefundsRepo — live Neon', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let invoiceId: string;
  let memberId: string;
  let paymentIdA: PaymentId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    invoiceId = randomUUID();
    memberId = randomUUID();

    // Seed tenant A: payment-settings + F4 parent chain + ONE succeeded
    // promptpay payment (which the refund rows attach to).
    const settings: NewTenantPaymentSettingsRow = {
      tenantId: tenantA.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: `acct_test_${tenantA.ctx.slug.slice(-8)}`,
      processorPublishableKey: `pk_test_${tenantA.ctx.slug.slice(-8)}`,
      enabledMethods: ['card', 'promptpay'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    };

    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(tenantPaymentSettings).values(settings);
      await tx.insert(membershipPlans).values({
        tenantId: tenantA.ctx.slug,
        planId: 'rfnd-plan',
        planYear: 2026,
        planName: { en: 'Refund Plan' },
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
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Refund Co',
        country: 'TH',
        planId: 'rfnd-plan',
        planYear: 2026,
      });
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenantA.ctx.slug,
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
        tenantId: tenantA.ctx.slug,
        documentType: 'invoice',
        fiscalYear: 2026,
      });
      await tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: 'rfnd-plan',
        draftByUserId: user.userId,
      });
    });

    // Insert two pending payments (one per test tenant) — each is the
    // FK target the refund rows below attach to. Status stays
    // 'pending' for the test; refunds.payment_id FK only needs the
    // row to exist, not to be in a particular status (the FR-011b
    // invariant lives in use-case logic, not DB CHECK).
    paymentIdA = makePaymentUlid() as PaymentId;
    const paymentsRepoA = makeDrizzlePaymentsRepo(tenantA.ctx.slug);
    await paymentsRepoA.withTx(async (tx) =>
      paymentsRepoA.insert(tx, {
        id: paymentIdA,
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId,
        method: 'promptpay',
        amountSatang: asSatang(5_350_000n),
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        initiatedAt: new Date(),
        actorUserId: user.userId,
        correlationId: 'corr-rfnd-A',
      }),
    );
  }, 90_000);

  afterAll(async () => {
    await tenantA.cleanup().catch((e) => console.error('tenantA cleanup:', e));
    await tenantB.cleanup().catch((e) => console.error('tenantB cleanup:', e));
  });

  it('insert pending refund + getRefundContextForUpdate sees the row', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    const refundId = makeRefundUlid();
    const initiatedAt = new Date();

    // Repo doesn't expose withTx (RefundsRepo port keeps the tx
    // boundary at the use-case level — `paymentsRepo.withTx` is the
    // canonical wrapper). Drive via `runInTenant` directly here,
    // mirroring how `issueRefund` will share its outer tx with the
    // refunds repo through the same tenant-bound connection.
    const ctxAfterInsert = await runInTenant(tenantA.ctx, async (tx) => {
      await repo.insert(tx, {
        id: refundId,
        tenantId: tenantA.ctx.slug,
        paymentId: paymentIdA,
        invoiceId,
        amountSatang: asSatang(100_000n),
        reason: 'first partial',
        status: 'pending',
        processorRefundId: null,
        creditNoteWaiverReason: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-rfnd-1',
        initiatedAt,
      });
      return repo.getRefundContextForUpdate(tx, tenantA.ctx.slug, paymentIdA);
    });

    expect(ctxAfterInsert.pendingCount).toBe(1);
    expect(ctxAfterInsert.succeededSumSatang).toBe(0n);
    expect(ctxAfterInsert.nextSeq).toBe(2); // 1 row exists → next is 2
  });

  it('updateStatus pending → failed sets failureReasonCode + completedAt', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    const refundId = makeRefundUlid();
    const initiatedAt = new Date();
    const failedAt = new Date(initiatedAt.getTime() + 5_000);

    await runInTenant(tenantA.ctx, async (tx) => {
      await repo.insert(tx, {
        id: refundId,
        tenantId: tenantA.ctx.slug,
        paymentId: paymentIdA,
        invoiceId,
        amountSatang: asSatang(50_000n),
        reason: 'will fail',
        status: 'pending',
        processorRefundId: null,
        creditNoteWaiverReason: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-rfnd-fail',
        initiatedAt,
      });
      // No `expectedCurrentStatus` here → repo returns the updated row
      // (never null; throws on zero-match). Non-null-assert for the
      // widened `RefundRow | null` return type (RR-1).
      const updated = await repo.updateStatus(tx, {
        refundId,
        tenantId: tenantA.ctx.slug,
        nextStatus: 'failed',
        rejectionProof: proveProcessorSettledFailed('failed'),
        failureReasonCode: 'retryable',
        completedAt: failedAt,
      });
      expect(updated).not.toBeNull();
      expect(updated?.status).toBe('failed');
      // Failed rows do not carry a processor_refund_id (CHECK
      // constraint allows NULL only for non-succeeded statuses).
      expect(updated?.processorRefundId).toBeNull();
    });
  });

  it('getRefundContextForUpdate aggregates pending rows + tracks nextSeq', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);

    // Insert 2 more pending rows — total partition state should be
    // (1 from test #1) + (1 failed from test #2 — counts toward nextSeq)
    // + 2 new pending = 4 rows total → pendingCount=3, nextSeq=5.
    await runInTenant(tenantA.ctx, async (tx) => {
      for (let i = 0; i < 2; i += 1) {
        await repo.insert(tx, {
          id: makeRefundUlid(),
          tenantId: tenantA.ctx.slug,
          paymentId: paymentIdA,
          invoiceId,
          amountSatang: asSatang(25_000n),
          reason: `bulk-${i}`,
          status: 'pending',
          processorRefundId: null,
          initiatorUserId: user.userId,
          correlationId: `corr-bulk-${i}`,
          creditNoteWaiverReason: null,
          initiatedAt: new Date(),
        });
      }
      const ctx = await repo.getRefundContextForUpdate(
        tx,
        tenantA.ctx.slug,
        paymentIdA,
      );
      // Test order: this test runs after #1 (1 pending) + #2 (1 failed)
      // → 2 starting rows + 2 new = 4 total; pendingCount = 1 (test #1) + 2 new = 3.
      expect(ctx.pendingCount).toBe(3);
      expect(ctx.succeededSumSatang).toBe(0n);
      expect(ctx.nextSeq).toBe(5);
    });
  });

  it('findByProcessorRefundId returns null for unknown id', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    await runInTenant(tenantA.ctx, async (tx) => {
      const found = await repo.findByProcessorRefundId(
        tx,
        tenantA.ctx.slug,
        're_does_not_exist',
      );
      expect(found).toBeNull();
    });
  });

  it('RLS cross-tenant: tenant B sees ZERO of tenant A refunds even with A paymentId', async () => {
    // Tenant B's repo bound to tenant B's RLS context. Even when
    // we hand it tenant A's paymentId, the RLS policy filters out
    // every row where tenant_id != app.current_tenant.
    const repoB = makeDrizzleRefundsRepo(tenantB.ctx.slug);
    const ctxFromB = await runInTenant(tenantB.ctx, async (tx) =>
      repoB.getRefundContextForUpdate(tx, tenantA.ctx.slug, paymentIdA),
    );
    expect(ctxFromB.pendingCount).toBe(0);
    expect(ctxFromB.succeededSumSatang).toBe(0n);
    expect(ctxFromB.nextSeq).toBe(1);
  });

  // --- RR-1 / H-b: optimistic-concurrency guard returns null on miss ------
  // Placed LAST so the succeeded row seeded here does not perturb the
  // cumulative-partition assertions in the aggregates test above.

  it('updateStatus with expectedCurrentStatus:pending on an already-succeeded row returns null (RR-1 / H-b)', async () => {
    // RR-1: the optimistic-concurrency guard must return `null` (not
    // throw) when a concurrent writer already finalised the row, so
    // callers can distinguish "lost the race" from a genuine error.
    // Mirrors `drizzle-payments-repo.updateStatus` (payments-repo.ts).
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    const refundId = makeRefundUlid();
    const initiatedAt = new Date();
    const completedAt = new Date(initiatedAt.getTime() + 5_000);

    // Seed a placeholder F4 credit note so the refund can reach
    // 'succeeded' — CHECK `refunds_succeeded_ids` requires BOTH
    // processor_refund_id AND credit_note_id NOT NULL (migration 0034).
    const creditNoteId = randomUUID();
    const seq = Math.floor(Math.random() * 1_000_000);
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.execute(sql`
        INSERT INTO credit_notes (
          tenant_id, credit_note_id, original_invoice_id,
          fiscal_year, sequence_number, document_number,
          issue_date, issued_by_user_id, reason,
          credit_amount_satang, vat_satang, total_satang,
          tenant_identity_snapshot, member_identity_snapshot,
          pdf_blob_key, pdf_sha256, pdf_template_version,
          created_at, updated_at
        ) VALUES (
          ${tenantA.ctx.slug}, ${creditNoteId}, ${invoiceId},
          2026, ${seq}, ${`TC-2026-RR1-${randomUUID().slice(0, 6)}`},
          '2026-04-15', ${user.userId}, 'RR-1 test',
          1, 0, 1,
          '{}'::jsonb, '{}'::jsonb,
          'placeholder', ${'a'.repeat(64)}, 1,
          NOW(), NOW()
        )
      `);
    });

    await runInTenant(tenantA.ctx, async (tx) => {
      await repo.insert(tx, {
        id: refundId,
        tenantId: tenantA.ctx.slug,
        paymentId: paymentIdA,
        invoiceId,
        amountSatang: asSatang(75_000n),
        reason: 'RR-1 race target',
        status: 'pending',
        processorRefundId: null,
        creditNoteWaiverReason: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-rr1',
        initiatedAt,
      });

      // A concurrent writer (webhook charge.refunded / issueRefund
      // Phase B) finalises the row to 'succeeded'.
      const finalised = await repo.updateStatus(tx, {
        refundId,
        tenantId: tenantA.ctx.slug,
        nextStatus: 'succeeded',
        processorRefundId: `re_rr1_${randomUUID().slice(0, 8)}`,
        creditNoteId,
        completedAt,
      });
      expect(finalised).not.toBeNull();
      expect(finalised?.status).toBe('succeeded');

      // A late sweep flip arrives with the optimistic guard. The row is
      // no longer 'pending' → zero rows match → repo returns `null`
      // rather than throwing (which would falsely commit a
      // stale_pending_refund_detected audit — see RR-1 sweep fix).
      const raced = await repo.updateStatus(tx, {
        refundId,
        tenantId: tenantA.ctx.slug,
        nextStatus: 'failed',
        rejectionProof: proveProcessorSettledFailed('failed'),
        failureReasonCode: 'stale_pending_sweep',
        completedAt: new Date(completedAt.getTime() + 5_000),
        expectedCurrentStatus: 'pending',
      });
      expect(raced).toBeNull();
    });
  });

  it('updateStatus WITHOUT expectedCurrentStatus still THROWS on zero-match (unknown refund)', async () => {
    // Backward-compat guard: the throw-on-zero path is preserved for
    // callers that re-check under their own lock and do not pass the
    // optimistic guard.
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    await runInTenant(tenantA.ctx, async (tx) => {
      await expect(
        repo.updateStatus(tx, {
          refundId: makeRefundUlid(), // never inserted
          tenantId: tenantA.ctx.slug,
          nextStatus: 'failed',
          rejectionProof: proveProcessorSettledFailed('failed'),
          failureReasonCode: 'retryable',
          completedAt: new Date(),
        }),
      ).rejects.toThrow(/matched zero rows/);
    });
  });

  // ===========================================================================
  // Task A.6 — attachProcessorRefundId / lockForUpdateByProcessorRefundId.
  // Placed last (own describe-independent `it`s, but still inside the
  // outer describe) so new inserts here do not perturb the earlier
  // cumulative-partition assertions (`getRefundContextForUpdate`
  // aggregates test above already ran and captured its expected
  // counts by file-declaration order).
  // ===========================================================================

  it('A.6: attachProcessorRefundId sets ONLY processor_refund_id, keeps pending/completed_at=NULL (CHECK-safe biconditional)', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    const refundId = makeRefundUlid();
    const processorRefundId = `re_attach_${randomUUID().slice(0, 8)}`;

    await runInTenant(tenantA.ctx, async (tx) => {
      await repo.insert(tx, {
        id: refundId,
        tenantId: tenantA.ctx.slug,
        paymentId: paymentIdA,
        invoiceId,
        amountSatang: asSatang(10_000n),
        reason: 'attach-id test',
        status: 'pending',
        processorRefundId: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-attach-1',
        creditNoteWaiverReason: null,
        initiatedAt: new Date(),
      });

      await repo.attachProcessorRefundId(tx, {
        refundId,
        tenantId: tenantA.ctx.slug,
        processorRefundId,
      });

      // Port-level round-trip.
      const reloaded = await repo.findByProcessorRefundId(
        tx,
        tenantA.ctx.slug,
        processorRefundId,
      );
      expect(reloaded).not.toBeNull();
      expect(reloaded?.id).toBe(refundId);
      expect(reloaded?.status).toBe('pending');
      expect(reloaded?.processorRefundId).toBe(processorRefundId);

      // Raw-row check that `completed_at` truly stayed NULL — the
      // `refunds_succeeded_iff_complete` + `refunds_completed_at_iff_not_pending`
      // CHECK constraints would have rejected the UPDATE outright if
      // the narrow write path leaked a status/completed_at change.
      const [raw] = await tx.select().from(refunds).where(eq(refunds.id, refundId));
      expect(raw?.status).toBe('pending');
      expect(raw?.completedAt).toBeNull();
      expect(raw?.creditNoteId).toBeNull();
      expect(raw?.processorRefundId).toBe(processorRefundId);
    });
  });

  it('A.6: attachProcessorRefundId throws on zero-match for an unknown refundId', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    await runInTenant(tenantA.ctx, async (tx) => {
      await expect(
        repo.attachProcessorRefundId(tx, {
          refundId: makeRefundUlid(), // never inserted
          tenantId: tenantA.ctx.slug,
          processorRefundId: `re_unknown_${randomUUID().slice(0, 8)}`,
        }),
      ).rejects.toThrow(/matched zero rows/);
    });
  });

  it('A.6: lockForUpdateByProcessorRefundId returns the full Domain Refund under FOR UPDATE', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    const refundId = makeRefundUlid();
    const initiatedAt = new Date();
    const processorRefundId = `re_lock_${randomUUID().slice(0, 8)}`;

    await runInTenant(tenantA.ctx, async (tx) => {
      await repo.insert(tx, {
        id: refundId,
        tenantId: tenantA.ctx.slug,
        paymentId: paymentIdA,
        invoiceId,
        amountSatang: asSatang(20_000n),
        reason: 'lock test',
        status: 'pending',
        processorRefundId: null,
        creditNoteWaiverReason: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-lock-1',
        initiatedAt,
      });
      await repo.attachProcessorRefundId(tx, {
        refundId,
        tenantId: tenantA.ctx.slug,
        processorRefundId,
      });

      const locked = await repo.lockForUpdateByProcessorRefundId(
        tx,
        tenantA.ctx.slug,
        processorRefundId,
      );
      expect(locked).not.toBeNull();
      expect(locked?.id).toBe(refundId);
      expect(locked?.tenantId).toBe(tenantA.ctx.slug);
      expect(locked?.paymentId).toBe(paymentIdA);
      expect(locked?.invoiceId).toBe(invoiceId);
      expect(locked?.amountSatang).toBe(20_000n);
      expect(locked?.reason).toBe('lock test');
      expect(locked?.status).toBe('pending');
      expect(locked?.processorRefundId).toBe(processorRefundId);
      expect(locked?.failureReasonCode).toBeNull();
      expect(locked?.creditNoteId).toBeNull();
      expect(locked?.initiatedAt).toBeInstanceOf(Date);
      expect(locked?.completedAt).toBeNull();
      expect(locked?.initiatorUserId).toBe(user.userId);
      expect(locked?.correlationId).toBe('corr-lock-1');
    });
  });

  it('A.6: lockForUpdateByProcessorRefundId returns null for an unknown processorRefundId', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    await runInTenant(tenantA.ctx, async (tx) => {
      const result = await repo.lockForUpdateByProcessorRefundId(
        tx,
        tenantA.ctx.slug,
        're_does_not_exist_lock',
      );
      expect(result).toBeNull();
    });
  });

  it('A.6 cross-tenant: attachProcessorRefundId + lockForUpdateByProcessorRefundId see ZERO of tenant A refunds', async () => {
    // Seed a fresh tenant A refund with a known processorRefundId to probe.
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    const refundId = makeRefundUlid();
    const processorRefundId = `re_xtenant_${randomUUID().slice(0, 8)}`;
    await runInTenant(tenantA.ctx, async (tx) => {
      await repo.insert(tx, {
        id: refundId,
        tenantId: tenantA.ctx.slug,
        paymentId: paymentIdA,
        invoiceId,
        amountSatang: asSatang(15_000n),
        reason: 'cross-tenant probe target',
        status: 'pending',
        processorRefundId,
        initiatorUserId: user.userId,
        correlationId: 'corr-xtenant-1',
        creditNoteWaiverReason: null,
        initiatedAt: new Date(),
      });
    });

    const repoB = makeDrizzleRefundsRepo(tenantB.ctx.slug);

    // lockForUpdateByProcessorRefundId — tenant B's session queries
    // tenant A's processorRefundId (explicitly passing A's tenantId
    // as the app-layer filter, probing whether the DB-layer RLS
    // backstop independently blocks it) → null.
    const lockedFromB = await runInTenant(tenantB.ctx, (tx) =>
      repoB.lockForUpdateByProcessorRefundId(tx, tenantA.ctx.slug, processorRefundId),
    );
    expect(lockedFromB).toBeNull();

    // attachProcessorRefundId — same cross-tenant probe direction —
    // must throw (zero-match under RLS), and must NOT mutate tenant
    // A's row.
    await expect(
      runInTenant(tenantB.ctx, (tx) =>
        repoB.attachProcessorRefundId(tx, {
          refundId,
          tenantId: tenantA.ctx.slug,
          processorRefundId: `re_rogue_overwrite_${randomUUID().slice(0, 8)}`,
        }),
      ),
    ).rejects.toThrow();

    // Verify tenant A's row is unchanged (still carries the ORIGINAL
    // processorRefundId, not the rogue overwrite attempt).
    const stillA = await runInTenant(tenantA.ctx, (tx) =>
      repo.findByProcessorRefundId(tx, tenantA.ctx.slug, processorRefundId),
    );
    expect(stillA).not.toBeNull();
    expect(stillA?.id).toBe(refundId);
  });

  // ===========================================================================
  // A.14 fairness — `listPendingOlderThan` returns oldest-first so the sweep's
  // row-cap (MAX_STALE_REFUNDS_PER_SWEEP) + this repo's LIMIT can never
  // permanently starve a stuck refund past the batch boundary. Placed last so
  // these fresh inserts do not perturb the cumulative-partition assertions in
  // the earlier aggregates test (which ran first by declaration order).
  // ===========================================================================

  it('A.14: listPendingOlderThan returns rows oldest-first (initiatedAt ASC), independent of insertion order', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    const base = Date.now();
    // Three distinct initiatedAt values in the past, INSERTED out of
    // chronological order to prove the ORDER BY (not insertion order) drives
    // the result.
    const oldest = new Date(base - 3 * 60 * 60 * 1000);
    const middle = new Date(base - 2 * 60 * 60 * 1000);
    const newest = new Date(base - 1 * 60 * 60 * 1000);
    const idOldest = makeRefundUlid();
    const idMiddle = makeRefundUlid();
    const idNewest = makeRefundUlid();

    await runInTenant(tenantA.ctx, async (tx) => {
      // Scrambled insertion order: middle → newest → oldest.
      for (const [id, initiatedAt] of [
        [idMiddle, middle],
        [idNewest, newest],
        [idOldest, oldest],
      ] as const) {
        await repo.insert(tx, {
          id,
          tenantId: tenantA.ctx.slug,
          paymentId: paymentIdA,
          invoiceId,
          amountSatang: asSatang(5_000n),
          reason: 'a14-order',
          status: 'pending',
          processorRefundId: null,
          creditNoteWaiverReason: null,
          initiatorUserId: user.userId,
          correlationId: 'corr-a14-order',
          initiatedAt,
        });
      }

      // All three past rows are `< cutoff`. Filter the (globally-ordered)
      // result to just this test's three ids — their relative order must be
      // oldest-first regardless of the other pending rows in the partition.
      const rows = await repo.listPendingOlderThan(tx, tenantA.ctx.slug, new Date(base));
      const mine = rows
        .filter((r) => [idOldest, idMiddle, idNewest].includes(r.id))
        .map((r) => r.id);
      expect(mine).toEqual([idOldest, idMiddle, idNewest]);
    });
  });
  // ── money-remediation Task 6, change 5 ────────────────────────────────────
  //
  // `settledUnbookedCount` gates a 409 that PERMANENTLY blocks further refunds
  // on the payment, so which rows it counts is the whole safety property.
  //
  // The remediation plan originally specified the predicate as
  // `status='failed' AND processor_refund_id IS NOT NULL` — which also
  // matches every refund Stripe legitimately settled `failed`/`canceled`
  // (three writers produce exactly that shape, keeping the `re_…` id for
  // forensics). Measured on the dev branch when this was written: 18 such
  // rows, and zero real F-3 casualties. Shipping that predicate would have
  // 409-blocked all of them forever, unrecoverable by runbook because the
  // data is not corrupt.
  //
  // The two halves below are therefore inseparable. A test that only asserted
  // the F-3 row IS counted would pass under the over-broad predicate.
  it('settledUnbookedCount counts ONLY the F-3 casualty shape, never a benign Stripe-settled failure', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    // Own invoice + payment: `payments_one_active_per_invoice` forbids a
    // second active payment on the shared fixture invoice, and an isolated
    // partition also keeps the absolute counts below immune to whatever the
    // sibling tests in this file leave behind.
    const backstopInvoiceId = randomUUID();
    const paymentId = makePaymentUlid() as PaymentId;
    const paymentsRepo = makeDrizzlePaymentsRepo(tenantA.ctx.slug);
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
        invoiceId: backstopInvoiceId,
        memberId,
        planYear: 2026,
        planId: 'rfnd-plan',
        draftByUserId: user.userId,
      });
    });
    await paymentsRepo.withTx(async (tx) =>
      paymentsRepo.insert(tx, {
        id: paymentId,
        tenantId: tenantA.ctx.slug,
        invoiceId: backstopInvoiceId,
        memberId,
        method: 'card',
        amountSatang: asSatang(5_350_000n),
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        initiatedAt: new Date(),
        actorUserId: user.userId,
        correlationId: 'corr-backstop',
      }),
    );

    const seedFailed = async (reasonCode: string): Promise<void> => {
      const refundId = makeRefundUlid();
      await runInTenant(tenantA.ctx, async (tx) => {
        await repo.insert(tx, {
          id: refundId,
          tenantId: tenantA.ctx.slug,
          paymentId,
          invoiceId: backstopInvoiceId,
          amountSatang: asSatang(100_000n),
          reason: `seed ${reasonCode}`,
          status: 'pending',
          processorRefundId: null,
          initiatorUserId: user.userId,
          correlationId: 'corr-backstop',
          creditNoteWaiverReason: null,
          initiatedAt: new Date(),
        });
        await repo.updateStatus(tx, {
          refundId,
          tenantId: tenantA.ctx.slug,
          nextStatus: 'failed',
          rejectionProof: proveProcessorSettledFailed('failed'),
          failureReasonCode: reasonCode,
          // Non-null processor id on BOTH rows — that is precisely why the
          // reason-code predicate has to carry the discrimination.
          processorRefundId: `re_test_${randomUUID().slice(0, 8)}`,
          completedAt: new Date(),
        });
      });
    };

    // (a) BENIGN — Stripe created the refund and then settled it failed. No
    //     money moved; the id is kept so a late webhook can match. This must
    //     NOT block future refunds.
    await seedFailed('stripe_refund_failed');
    const afterBenign = await runInTenant(tenantA.ctx, (tx) =>
      repo.getRefundContextForUpdate(tx, tenantA.ctx.slug, paymentId),
    );
    expect(afterBenign.settledUnbookedCount).toBe(0);

    // (b) BENIGN — the canceled variant, same reasoning.
    await seedFailed('stripe_refund_canceled');
    const afterCanceled = await runInTenant(tenantA.ctx, (tx) =>
      repo.getRefundContextForUpdate(tx, tenantA.ctx.slug, paymentId),
    );
    expect(afterCanceled.settledUnbookedCount).toBe(0);

    // (c) THE REAL THING — written by the pre-remediation `issue-refund.ts`
    //     AFTER Stripe confirmed the refund succeeded. Money left; the row
    //     lies. Both interpolated variants of the reason code are covered by
    //     the `f4_bridge_%` prefix.
    await seedFailed('f4_bridge_phase_b_db_error');
    const afterCasualty = await runInTenant(tenantA.ctx, (tx) =>
      repo.getRefundContextForUpdate(tx, tenantA.ctx.slug, paymentId),
    );
    expect(afterCasualty.settledUnbookedCount).toBe(1);

    await seedFailed('f4_bridge_remainder_credit_exceeded');
    const afterSecond = await runInTenant(tenantA.ctx, (tx) =>
      repo.getRefundContextForUpdate(tx, tenantA.ctx.slug, paymentId),
    );
    expect(afterSecond.settledUnbookedCount).toBe(2);

    // The benign rows must not have leaked into the money aggregate either —
    // `succeededSumSatang` drives the remaining-refundable invariant, and the
    // plan explicitly warns against folding this count into it (webhook-mode
    // `finalizeSucceededRefund` reads the same aggregate and would flip a
    // payment to `refunded` on money that never settled).
    expect(afterSecond.succeededSumSatang).toBe(asSatang(0n));
  });


  // -------------------------------------------------------------------------
  // Money-remediation Task 9 (F-9) — findAwaitingAttachByAppRefundId.
  //
  // Resolves a refund by the marker `issueRefund` stamps on Stripe BEFORE the
  // external call, closing the window where `charge.refunded` overtakes
  // `attachProcessorRefundId` and fires a false 10-year OOB forensic.
  //
  // These run against live Neon on purpose: the `IS NULL` predicate, the
  // two-table tenant filter and the INNER join are SQL-level guarantees that a
  // mock cannot demonstrate, and RLS only exists here.
  // -------------------------------------------------------------------------
  it('F-9: resolves an unattached pending refund + returns the parent PI', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    const refundId = makeRefundUlid();

    await runInTenant(tenantA.ctx, async (tx) => {
      await repo.insert(tx, {
        id: refundId,
        tenantId: tenantA.ctx.slug,
        paymentId: paymentIdA,
        invoiceId,
        amountSatang: asSatang(70_000n),
        reason: 'f9 awaiting attach',
        status: 'pending',
        processorRefundId: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-f9-1',
        creditNoteWaiverReason: null,
        initiatedAt: new Date(),
      });
    });

    // Read the parent payment's real PI so the assertion pins the JOIN rather
    // than merely "some non-empty string".
    const [parent] = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ pi: payments.processorPaymentIntentId })
        .from(payments)
        .where(eq(payments.id, paymentIdA))
        .limit(1),
    );

    const found = await runInTenant(tenantA.ctx, (tx) =>
      repo.findAwaitingAttachByAppRefundId(tx, tenantA.ctx.slug, refundId),
    );

    expect(found).not.toBeNull();
    expect(found?.id).toBe(refundId);
    expect(found?.status).toBe('pending');
    expect(found?.amountSatang).toBe(70_000n);
    expect(found?.invoiceId).toBe(invoiceId);
    expect(found?.parentProcessorPaymentIntentId).toBe(parent?.pi);
  });

  /**
   * THE LOAD-BEARING PREDICATE. A row that already carries a
   * `processor_refund_id` must be unreachable through this method — that is
   * what stops an attacker-supplied `metadata.refundId` from addressing an
   * already-matched refund and laundering it. Structural, not advisory.
   */
  it('F-9: returns null once processor_refund_id is attached (IS NULL predicate)', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    const refundId = makeRefundUlid();
    const processorRefundId = `re_f9_attached_${randomUUID().slice(0, 8)}`;

    await runInTenant(tenantA.ctx, async (tx) => {
      await repo.insert(tx, {
        id: refundId,
        tenantId: tenantA.ctx.slug,
        paymentId: paymentIdA,
        invoiceId,
        amountSatang: asSatang(11_000n),
        reason: 'f9 already attached',
        status: 'pending',
        processorRefundId: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-f9-2',
        creditNoteWaiverReason: null,
        initiatedAt: new Date(),
      });
    });

    // Before the attach it IS reachable — proving the null below is caused by
    // the attach and not by an unrelated seeding failure.
    const before = await runInTenant(tenantA.ctx, (tx) =>
      repo.findAwaitingAttachByAppRefundId(tx, tenantA.ctx.slug, refundId),
    );
    expect(before).not.toBeNull();

    await runInTenant(tenantA.ctx, (tx) =>
      repo.attachProcessorRefundId(tx, {
        refundId,
        tenantId: tenantA.ctx.slug,
        processorRefundId,
      }),
    );

    const after = await runInTenant(tenantA.ctx, (tx) =>
      repo.findAwaitingAttachByAppRefundId(tx, tenantA.ctx.slug, refundId),
    );
    expect(after).toBeNull();
  });

  /**
   * Principle I, Review-Gate blocker. A forged `metadata.refundId` naming
   * another tenant's row must not resolve — probed the hard way, with tenant
   * A's id passed explicitly as the app-layer filter so the DB-layer RLS
   * backstop is tested independently of the WHERE clause.
   */
  it('F-9 cross-tenant: tenant B cannot resolve tenant A unattached refund', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    const refundId = makeRefundUlid();

    await runInTenant(tenantA.ctx, async (tx) => {
      await repo.insert(tx, {
        id: refundId,
        tenantId: tenantA.ctx.slug,
        paymentId: paymentIdA,
        invoiceId,
        amountSatang: asSatang(9_000n),
        reason: 'f9 cross-tenant probe target',
        status: 'pending',
        processorRefundId: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-f9-xtenant',
        creditNoteWaiverReason: null,
        initiatedAt: new Date(),
      });
    });

    // Sanity: it IS resolvable from its own tenant, so a null from B is
    // isolation and not a broken fixture.
    const fromA = await runInTenant(tenantA.ctx, (tx) =>
      repo.findAwaitingAttachByAppRefundId(tx, tenantA.ctx.slug, refundId),
    );
    expect(fromA).not.toBeNull();

    const repoB = makeDrizzleRefundsRepo(tenantB.ctx.slug);
    // (a) B's session, A's tenantId as the filter -> RLS must block.
    const probeWithATenantId = await runInTenant(tenantB.ctx, (tx) =>
      repoB.findAwaitingAttachByAppRefundId(tx, tenantA.ctx.slug, refundId),
    );
    expect(probeWithATenantId).toBeNull();

    // (b) B's session, B's own tenantId -> the WHERE clause must block.
    const probeWithBTenantId = await runInTenant(tenantB.ctx, (tx) =>
      repoB.findAwaitingAttachByAppRefundId(tx, tenantB.ctx.slug, refundId),
    );
    expect(probeWithBTenantId).toBeNull();
  });

  /**
   * PINS THE APP-LAYER TENANT FILTER, INDEPENDENTLY OF RLS.
   *
   * The cross-tenant test above runs from tenant B's session, so RLS alone
   * blocks it — deleting the WHERE-clause tenant filter leaves that test GREEN
   * (verified by mutation). Principle I requires BOTH layers, so one of them
   * being untested is a real gap, not a stylistic one.
   *
   * This probes from tenant A's OWN session (RLS permits the row) while passing
   * a DIFFERENT tenantId as the argument. Only the app-layer predicate can
   * produce null here, so the mutation that removes it dies on this test.
   */
  it('F-9: app-layer tenant filter blocks a mismatched tenantId within a permitted session', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    const refundId = makeRefundUlid();

    await runInTenant(tenantA.ctx, async (tx) => {
      await repo.insert(tx, {
        id: refundId,
        tenantId: tenantA.ctx.slug,
        paymentId: paymentIdA,
        invoiceId,
        amountSatang: asSatang(8_000n),
        reason: 'f9 app-layer filter probe',
        status: 'pending',
        processorRefundId: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-f9-applayer',
        creditNoteWaiverReason: null,
        initiatedAt: new Date(),
      });
    });

    // Same session, correct tenantId -> resolves. Anchors the null below.
    const withOwnTenantId = await runInTenant(tenantA.ctx, (tx) =>
      repo.findAwaitingAttachByAppRefundId(tx, tenantA.ctx.slug, refundId),
    );
    expect(withOwnTenantId).not.toBeNull();

    // Same session (RLS satisfied), WRONG tenantId -> only the WHERE clause
    // can reject this.
    const withForeignTenantId = await runInTenant(tenantA.ctx, (tx) =>
      repo.findAwaitingAttachByAppRefundId(tx, tenantB.ctx.slug, refundId),
    );
    expect(withForeignTenantId).toBeNull();
  });

  it('F-9: returns null for an unknown marker', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    const result = await runInTenant(tenantA.ctx, (tx) =>
      repo.findAwaitingAttachByAppRefundId(tx, tenantA.ctx.slug, makeRefundUlid()),
    );
    expect(result).toBeNull();
  });


  // -------------------------------------------------------------------------
  // Track B — migration 0268 completeness CHECKs, against live Postgres
  // -------------------------------------------------------------------------
  //
  // These pin a DESIGN DECISION, not just DDL. The completeness CHECK keys on
  // `credit_note_waived_at` (a settlement fact) and NOT on
  // `credit_note_waiver_reason` (a Phase-A intent). The reason-keyed variant
  // looks equivalent and is not: it REJECTS the two states below, and both are
  // reached only AFTER Stripe has already moved the money — leaving the row
  // stuck `pending` forever, which then blocks every future refund on that
  // payment.
  //
  // A unit test cannot make this argument. Only the database can say which
  // shapes it will actually accept.
  describe('0268 — waiver completeness CHECKs', () => {
    /** Raw insert so a constraint can be violated deliberately. */
    async function insertRefund(cols: Record<string, unknown>): Promise<void> {
      await runInTenant(tenantA.ctx, async (tx) => {
        await tx.insert(refunds).values({
          id: makeRefundUlid(),
          tenantId: tenantA.ctx.slug,
          paymentId: paymentIdA,
          invoiceId,
          amountSatang: asSatang(1_000n),
          reason: '0268 constraint probe',
          status: 'pending',
          processorRefundId: null,
          creditNoteId: null,
          creditNoteWaivedAt: null,
          creditNoteWaiverReason: null,
          initiatorUserId: user.userId,
          correlationId: 'corr-0268',
          initiatedAt: new Date(),
          ...cols,
        } as never);
      });
    }

    /**
     * Drizzle wraps a driver error as `Failed query: <sql>`, so the CHECK's name
     * is not in `.message` — it is on the postgres.js cause. Asserting the NAME
     * (not merely "it threw") is what makes these tests prove WHICH constraint
     * fired; any bad insert throws, and a test that only asserts rejection would
     * pass even if the constraint under test had been dropped.
     */
    async function expectConstraintViolation(
      run: Promise<void>,
      constraint: string,
    ): Promise<void> {
      let caught: unknown;
      try {
        await run;
      } catch (e) {
        caught = e;
      }
      expect(caught, `expected ${constraint} to reject the insert`).toBeDefined();
      const cause = (caught as { cause?: { constraint_name?: string } }).cause;
      const name =
        cause?.constraint_name ??
        (caught as { constraint_name?: string }).constraint_name;
      expect(name).toBe(constraint);
    }

    it('ACCEPTS a pending row that already carries the waiver reason AND a processor id', async () => {
      // THE case that decided the design. This is the real Phase-A → Stripe
      // sequence: the reason is stamped at insert while the row is pending,
      // then the processor id is attached once Stripe responds. A CHECK keyed
      // on the reason would reject this — after the money had already moved.
      await expect(
        insertRefund({
          status: 'pending',
          processorRefundId: `re_0268_${Date.now()}`,
          creditNoteWaiverReason: 'section_105_receipt',
          creditNoteWaivedAt: null,
        }),
      ).resolves.toBeUndefined();
    });

    it('a FAILED settlement KEEPS the waiver reason (intent survives outcome)', async () => {
      // The second state reason-keying would break. Driven through the repo's
      // real failure path rather than a raw insert, because writing `failed`
      // requires rejection proof — a raw insert would be rejected for an
      // unrelated reason and prove nothing about the waiver constraints.
      const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
      const refundId = makeRefundUlid();
      await runInTenant(tenantA.ctx, async (tx) => {
        await repo.insert(tx, {
          id: refundId,
          tenantId: tenantA.ctx.slug,
          paymentId: paymentIdA,
          invoiceId,
          amountSatang: asSatang(1_000n),
          reason: '0268 failed-keeps-reason probe',
          status: 'pending',
          processorRefundId: null,
          initiatorUserId: user.userId,
          correlationId: 'corr-0268f',
          creditNoteWaiverReason: 'invoice_voided',
          initiatedAt: new Date(),
        });
      });

      const updated = await runInTenant(tenantA.ctx, async (tx) =>
        repo.updateStatus(tx, {
          refundId,
          tenantId: tenantA.ctx.slug,
          nextStatus: 'failed',
          rejectionProof: proveProcessorSettledFailed('failed'),
          failureReasonCode: 'retryable',
          completedAt: new Date(),
        }),
      );

      expect(updated?.status).toBe('failed');

      // Read the waiver columns straight from Postgres: `RefundRow` (the repo's
      // return shape) does not carry them, so the assertion has to go to the
      // source rather than trust a projection that cannot see the fields.
      const row = await runInTenant(tenantA.ctx, async (tx) => {
        const rows = (await tx.execute(sql`
          SELECT credit_note_waiver_reason, credit_note_waived_at
            FROM refunds
           WHERE tenant_id = ${tenantA.ctx.slug} AND id = ${refundId}
        `)) as unknown as Array<{
          credit_note_waiver_reason: string | null;
          credit_note_waived_at: Date | null;
        }>;
        return rows[0];
      });

      // The decision is retained; only the OUTCOME column stayed null. This is
      // precisely why the completeness CHECK cannot key on the reason.
      expect(row?.credit_note_waiver_reason).toBe('invoice_voided');
      expect(row?.credit_note_waived_at).toBeNull();
    });

    it('REJECTS succeeded with neither a credit note nor a waiver (refunds_succeeded_iff_documented)', async () => {
      await expectConstraintViolation(
        insertRefund({
          status: 'succeeded',
          processorRefundId: `re_0268u_${Date.now()}`,
          completedAt: new Date(),
          creditNoteId: null,
          creditNoteWaivedAt: null,
        }),
        'refunds_succeeded_iff_documented',
      );
    });

    it('REJECTS a waiver stamped without a reason (refunds_waived_at_requires_reason)', async () => {
      // The reason is the only field telling the accountant WHY no §86/10
      // exists. A waiver without one is an unexplained hole in the tax trail.
      await expectConstraintViolation(
        insertRefund({
          status: 'succeeded',
          processorRefundId: `re_0268r_${Date.now()}`,
          completedAt: new Date(),
          creditNoteWaivedAt: new Date(),
          creditNoteWaiverReason: null,
        }),
        'refunds_waived_at_requires_reason',
      );
    });

    it('REJECTS an unknown waiver reason (refunds_waiver_reason_enum)', async () => {
      // The reason strings are a STORAGE contract — renaming one needs a
      // migration, not just an edit to the Domain union.
      await expectConstraintViolation(
        insertRefund({
          status: 'pending',
          creditNoteWaiverReason: 'invoice_cancelled',
        }),
        'refunds_waiver_reason_enum',
      );
    });
  });

});
