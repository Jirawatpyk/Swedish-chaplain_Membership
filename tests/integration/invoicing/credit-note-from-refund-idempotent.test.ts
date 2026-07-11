/**
 * CRITICAL-1 (F5 refund-lifecycle, Task A.7) — idempotent credit-note issuance
 * per `source_refund_id`.
 *
 * `issueCreditNoteFromRefund` MUST be idempotent per (tenant_id,
 * source_refund_id): a repeat call for a refund that already has a credit note
 * returns the EXISTING CN (same creditNoteId + document number) WITHOUT
 * allocating a new §87 sequence number or rendering a new PDF. A concurrent
 * race across the SAME refund yields exactly ONE credit note and advances the
 * §87 credit-note counter by exactly 1 (Thai RD §87 no-gaps invariant).
 *
 * Backed by migration 0242's partial unique index
 * `credit_notes_source_refund_id_uniq ON (tenant_id, source_refund_id) WHERE
 * source_refund_id IS NOT NULL` (the DB backstop). This suite proves the
 * APPLICATION-layer behaviour: the repeat resolves to a clean idempotent
 * success rather than a `concurrent_state_change` error, and the losing racer's
 * rollback returns its §87 number to the pool.
 *
 * Uses live Neon Singapore. PDF render + Blob upload + outbox are module-mocked
 * (deterministic stubs) so the SYSTEM UNDER TEST is the DB persistence + RLS +
 * sequence allocator + idempotency logic, not the external PDF/Blob/email
 * round-trip (covered by F4's own suites). Run this file in isolation to avoid
 * shared-Neon concurrent-suite flake:
 *   pnpm test:integration tests/integration/invoicing/credit-note-from-refund-idempotent.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { asSatang } from '@/lib/money';
import { runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { payments, refunds } from '@/modules/payments/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// --- Module-level mocks of external adapters --------------------------------
// The bridge wrapper calls makeIssueCreditNoteDeps() which wires these
// adapters. Mock the whole adapter surface so every call returns deterministic
// stubs. The DB side (invoice repo, credit-note repo, sequence allocator, audit
// adapter) stays real so the idempotency + no-gap guarantees are genuinely
// exercised against live Neon.
vi.mock('@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter', async () => {
  const { Sha256Hex: S } = await import(
    '@/modules/invoicing/domain/value-objects/sha256-hex'
  );
  return {
    reactPdfRenderAdapter: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // '%PDF'
        sha256: S.ofUnsafe('b'.repeat(64)),
      })),
    },
  };
});
vi.mock('@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter', () => ({
  vercelBlobAdapter: {
    uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
      key,
      url: `https://blob.test/${key}`,
    })),
    uploadLogo: vi.fn(async ({ key }: { key: string }) => ({
      key,
      url: `https://blob.test/${key}`,
    })),
    signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
    downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => [] as string[]),
  },
}));
vi.mock('@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter', () => ({
  resendEmailOutboxAdapter: {
    enqueue: vi.fn(async () => {}),
  },
}));

// Imports that depend on the mocked modules MUST come after the vi.mock calls.
import { issueCreditNoteFromRefund } from '@/modules/invoicing/application/use-cases/issue-credit-note-from-refund';
import { issueCreditNote } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import { makeIssueCreditNoteDeps } from '@/modules/invoicing/application/invoicing-deps';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';

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

const INVOICE_TOTAL = 107_000n;
const INVOICE_SUBTOTAL = 100_000n;
const INVOICE_VAT = 7_000n;
const FISCAL_YEAR = 2026;

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Idem Test Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

/**
 * Seed a `paid` membership invoice + a real Payment + Refund so the CN's
 * `source_refund_id` FK (→ refunds.id, ON DELETE RESTRICT) resolves. Returns
 * the ids the caller needs to drive `issueCreditNoteFromRefund`.
 */
async function seedPaidInvoiceWithRefund(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  refundAmountSatang: bigint,
): Promise<{ invoiceId: string; memberId: string; refundId: string }> {
  const invoiceId = randomUUID();
  const memberId = randomUUID();
  const paymentId = `pay-${randomUUID()}`;
  const refundId = `rfnd-${randomUUID()}`;

  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Idem Test Co',
      country: 'TH',
      planId,
      planYear: FISCAL_YEAR,
    });

    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear: FISCAL_YEAR,
      planId,
      draftByUserId: user.userId,
      status: 'paid',
      pdfDocKind: 'invoice',
      receiptPdfStatus: 'rendered',
      fiscalYear: FISCAL_YEAR,
      sequenceNumber: 1,
      documentNumber: 'IDEM-2026-000001',
      issueDate: '2026-04-15',
      dueDate: '2026-05-14',
      subtotalSatang: INVOICE_SUBTOTAL,
      vatRateSnapshot: '0.0700',
      vatSatang: INVOICE_VAT,
      totalSatang: INVOICE_TOTAL,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: 'invoicing/x/2026/seed.pdf',
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      paymentMethod: 'bank_transfer',
      paymentReference: 'seed-ref',
      paymentNotes: null,
      paymentRecordedByUserId: user.userId,
      paymentDate: '2026-04-20',
      paidAt: new Date('2026-04-20T03:00:00Z'),
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก 2026',
      descriptionEn: 'Membership 2026',
      unitPriceSatang: INVOICE_SUBTOTAL,
      totalSatang: INVOICE_SUBTOTAL,
      position: 1,
    });
    await tx.insert(payments).values({
      id: paymentId,
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      method: 'card',
      status: 'succeeded',
      amountSatang: INVOICE_TOTAL,
      currency: 'THB',
      processorPaymentIntentId: `pi_test_${randomUUID()}`,
      processorChargeId: `ch_test_${randomUUID()}`,
      processorEnvironment: 'test',
      attemptSeq: 1,
      cardBrand: 'visa',
      cardLast4: '4242',
      cardExpMonth: 12,
      cardExpYear: 2030,
      initiatedAt: new Date('2026-04-20T03:00:00Z'),
      completedAt: new Date('2026-04-20T03:00:10Z'),
      actorUserId: user.userId,
      correlationId: 'test-corr-payment',
    });
    await tx.insert(refunds).values({
      id: refundId,
      tenantId: tenant.ctx.slug,
      paymentId,
      invoiceId,
      amountSatang: asSatang(refundAmountSatang),
      reason: 'Customer requested refund',
      status: 'pending',
      initiatedAt: new Date('2026-04-23T03:00:00Z'),
      initiatorUserId: user.userId,
      correlationId: 'test-corr-refund',
    });
  });

  return { invoiceId, memberId, refundId };
}

/**
 * Read the current `next_sequence_number` for the CN allocator stream (delta
 * measurement — beforeEach does NOT reset the counter, so tests share it).
 * Absent row = the bootstrap value 1 (nothing allocated yet).
 */
async function readCreditNoteSeq(tenant: TestTenant): Promise<number> {
  const rows = await runInTenant(tenant.ctx, (tx) =>
    tx
      .select({ next: tenantDocumentSequences.nextSequenceNumber })
      .from(tenantDocumentSequences)
      .where(
        and(
          eq(tenantDocumentSequences.tenantId, tenant.ctx.slug),
          eq(tenantDocumentSequences.documentType, 'credit_note'),
          eq(tenantDocumentSequences.fiscalYear, FISCAL_YEAR),
        ),
      ),
  );
  return rows[0]?.next ?? 1;
}

async function countCreditNotesForRefund(
  tenant: TestTenant,
  refundId: string,
): Promise<number> {
  const rows = await runInTenant(tenant.ctx, (tx) =>
    tx
      .select({ id: creditNotes.creditNoteId })
      .from(creditNotes)
      .where(
        and(
          eq(creditNotes.tenantId, tenant.ctx.slug),
          eq(creditNotes.sourceRefundId, refundId),
        ),
      ),
  );
  return rows.length;
}

describe('CRITICAL-1 — idempotent credit-note issuance per source_refund_id (A.7)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'idem-cn-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: FISCAL_YEAR,
        planName: { en: 'Idem CN Plan' },
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
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: asSatang(0n),
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'IDEM',
        creditNoteNumberPrefix: 'CN',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  beforeEach(async () => {
    // FK RESTRICT order: credit_notes → refunds → payments, refunds → invoices.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.delete(creditNotes).where(eq(creditNotes.tenantId, tenant.ctx.slug));
      await tx.delete(refunds).where(eq(refunds.tenantId, tenant.ctx.slug));
      await tx.delete(payments).where(eq(payments.tenantId, tenant.ctx.slug));
      await tx.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug));
      await tx.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug));
      await tx.delete(members).where(eq(members.tenantId, tenant.ctx.slug));
    });
  });

  it('repeat with the same refundId returns the SAME CN — no new §87 number, no new PDF', async () => {
    const { refundId } = await seedPaidInvoiceWithRefund(tenant, user, planId, 53_500n);
    const invoiceId = (
      await runInTenant(tenant.ctx, (tx) =>
        tx
          .select({ id: invoices.invoiceId })
          .from(invoices)
          .where(eq(invoices.tenantId, tenant.ctx.slug)),
      )
    )[0]!.id;

    const seqBefore = await readCreditNoteSeq(tenant);

    const r1 = await issueCreditNoteFromRefund({
      tenantId: tenant.ctx.slug,
      invoiceId,
      refundId,
      amountSatang: asSatang(53_500n),
      reason: 'Customer requested partial refund',
      actorUserId: user.userId,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const seqAfterFirst = await readCreditNoteSeq(tenant);
    expect(seqAfterFirst - seqBefore).toBe(1); // exactly one §87 number consumed
    const renderAfterFirst = (reactPdfRenderAdapter.render as ReturnType<typeof vi.fn>)
      .mock.calls.length;

    // Repeat — SAME refundId. Idempotent: returns the existing CN.
    const r2 = await issueCreditNoteFromRefund({
      tenantId: tenant.ctx.slug,
      invoiceId,
      refundId,
      amountSatang: asSatang(53_500n),
      reason: 'Customer requested partial refund',
      actorUserId: user.userId,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    // Same CN aggregate — same id + same §87 document number.
    expect(r2.value.creditNoteId).toBe(r1.value.creditNoteId);
    expect(r2.value.documentNumber.raw).toBe(r1.value.documentNumber.raw);
    expect(r2.value.sourceRefundId).toBe(refundId);

    // No new §87 number, no new PDF render on the repeat.
    const seqAfterSecond = await readCreditNoteSeq(tenant);
    expect(seqAfterSecond - seqBefore).toBe(1);
    expect(
      (reactPdfRenderAdapter.render as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(renderAfterFirst);

    // Exactly ONE credit_notes row for this refund.
    expect(await countCreditNotesForRefund(tenant, refundId)).toBe(1);

    // Parent invoice stays partially_credited (53_500 < 107_000) — the repeat
    // did NOT double-apply the rollup.
    const [inv] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ status: invoices.status, credited: invoices.creditedTotalSatang })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(inv?.status).toBe('partially_credited');
    expect(BigInt(inv!.credited as unknown as string)).toBe(53_500n);
  }, 60_000);

  it('repeat after a FULL refund (invoice → credited) still returns the existing CN, not invalid_status', async () => {
    // A full credit flips the invoice to the terminal `credited` status, which
    // is NOT in {paid, partially_credited}. The idempotency read MUST run
    // BEFORE the status gate so the repeat returns the existing CN rather than
    // failing `invalid_status`.
    const { refundId } = await seedPaidInvoiceWithRefund(tenant, user, planId, INVOICE_TOTAL);
    const invoiceId = (
      await runInTenant(tenant.ctx, (tx) =>
        tx
          .select({ id: invoices.invoiceId })
          .from(invoices)
          .where(eq(invoices.tenantId, tenant.ctx.slug)),
      )
    )[0]!.id;

    const r1 = await issueCreditNoteFromRefund({
      tenantId: tenant.ctx.slug,
      invoiceId,
      refundId,
      amountSatang: asSatang(INVOICE_TOTAL),
      reason: 'Full refund',
      actorUserId: user.userId,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const [inv1] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ status: invoices.status })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(inv1?.status).toBe('credited');

    const seqAfterFirst = await readCreditNoteSeq(tenant);

    const r2 = await issueCreditNoteFromRefund({
      tenantId: tenant.ctx.slug,
      invoiceId,
      refundId,
      amountSatang: asSatang(INVOICE_TOTAL),
      reason: 'Full refund',
      actorUserId: user.userId,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.creditNoteId).toBe(r1.value.creditNoteId);

    // No new §87 number on the repeat.
    expect(await readCreditNoteSeq(tenant)).toBe(seqAfterFirst);
    expect(await countCreditNotesForRefund(tenant, refundId)).toBe(1);
  }, 60_000);

  it('concurrent same-refund race (Promise.all) → exactly one CN, §87 advances by exactly 1', async () => {
    const { invoiceId, refundId } = await seedPaidInvoiceWithRefund(
      tenant,
      user,
      planId,
      53_500n,
    );
    const seqBefore = await readCreditNoteSeq(tenant);

    const input = {
      tenantId: tenant.ctx.slug,
      invoiceId,
      refundId,
      amountSatang: asSatang(53_500n),
      reason: 'Concurrent refund',
      actorUserId: user.userId,
    };
    // Two callers race the SAME refund. They serialise on the invoice
    // FOR UPDATE lock: the winner allocates + inserts + commits; the loser then
    // acquires the lock, hits the idempotency read, and returns the winner's
    // committed CN. Both see ONE credit note; the §87 counter moves by 1.
    const [a, b] = await Promise.all([
      issueCreditNoteFromRefund({ ...input }),
      issueCreditNoteFromRefund({ ...input }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Both callers observe the SAME single CN.
    expect(a.value.creditNoteId).toBe(b.value.creditNoteId);
    expect(a.value.documentNumber.raw).toBe(b.value.documentNumber.raw);

    // §87 credit-note counter advanced by EXACTLY 1 — no gap, no double-alloc.
    expect((await readCreditNoteSeq(tenant)) - seqBefore).toBe(1);
    expect(await countCreditNotesForRefund(tenant, refundId)).toBe(1);
  }, 90_000);

  it('lost insert race on the source_refund_id unique index reconciles the sibling CN in a fresh tx (no §87 gap)', async () => {
    // Direct coverage of the RR-2 fresh-tx reconcile branch. The invoice
    // FOR UPDATE lock normally routes the loser to the idempotency READ (see
    // the Promise.all test), so we simulate a TOCTOU miss by stubbing the FIRST
    // (under-lock) findBySourceRefundId to return null — forcing the REAL insert
    // to collide on `credit_notes_source_refund_id_uniq` (23505) and drive the
    // fresh-tx reconcile.
    const { invoiceId, refundId } = await seedPaidInvoiceWithRefund(
      tenant,
      user,
      planId,
      53_500n,
    );

    // 1) Create the winning sibling CN normally (partial, so the invoice stays
    //    partially_credited and the racer clears the status gate).
    const winner = await issueCreditNoteFromRefund({
      tenantId: tenant.ctx.slug,
      invoiceId,
      refundId,
      amountSatang: asSatang(53_500n),
      reason: 'winner',
      actorUserId: user.userId,
    });
    expect(winner.ok).toBe(true);
    if (!winner.ok) return;

    const seqAfterWinner = await readCreditNoteSeq(tenant);

    // 2) Deps whose under-lock read MISSES once (returns null), then reads real
    //    in the reconcile. Insert stays REAL → collides on the unique index.
    const deps = makeIssueCreditNoteDeps(tenant.ctx.slug);
    const realRepo = deps.creditNoteRepo;
    let findCalls = 0;
    const findStub = vi.fn(async (tx: unknown, tid: string, srid: string) => {
      findCalls += 1;
      if (findCalls === 1) return null; // simulate TOCTOU miss under the lock
      return realRepo.findBySourceRefundId(tx, tid, srid); // reconcile hit
    });
    const stubbedRepo = { ...realRepo, findBySourceRefundId: findStub };

    const raced = await issueCreditNote(
      { ...deps, creditNoteRepo: stubbedRepo },
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        invoiceId,
        creditTotalSatang: asSatang(53_500n),
        reason: 'racer',
        sourceRefundId: refundId,
        membershipEffect: 'keep',
      },
    );

    // Reconciled to the winner's CN — idempotent success, NOT concurrent_state_change.
    expect(raced.ok).toBe(true);
    if (!raced.ok) return;
    expect(raced.value.creditNote.creditNoteId).toBe(winner.value.creditNoteId);

    // findBySourceRefundId called twice: under-lock miss + fresh-tx reconcile hit.
    expect(findCalls).toBe(2);

    // The failed allocate rolled back → §87 counter UNCHANGED (no gap); one CN.
    expect(await readCreditNoteSeq(tenant)).toBe(seqAfterWinner);
    expect(await countCreditNotesForRefund(tenant, refundId)).toBe(1);
  }, 90_000);

  it('A.7 review fix #1 — a TRANSIENT failure on the fresh-tx reconcile read returns a typed err, not a throw', async () => {
    // Same TOCTOU-miss setup as the previous test (under-lock read misses →
    // the REAL insert collides on `credit_notes_source_refund_id_uniq` → 23505
    // → CreditNoteRefundRaceError → outer catch), but this time the SECOND
    // findBySourceRefundId call (the fresh-tx reconcile read) throws a
    // transient error instead of succeeding. `issueCreditNote` MUST catch it
    // and resolve to a typed `concurrent_state_change` err — a compound
    // 23505-race-plus-reconcile-failure must never escape as an unhandled
    // throw (→ HTTP 500). No data is at risk: the DB backstop already
    // blocked the duplicate insert and the failed tx already rolled the §87
    // counter back to the pool.
    const { invoiceId, refundId } = await seedPaidInvoiceWithRefund(
      tenant,
      user,
      planId,
      53_500n,
    );

    // 1) Create the winning sibling CN normally (partial, so the invoice
    //    stays partially_credited and the racer clears the status gate).
    const winner = await issueCreditNoteFromRefund({
      tenantId: tenant.ctx.slug,
      invoiceId,
      refundId,
      amountSatang: asSatang(53_500n),
      reason: 'winner',
      actorUserId: user.userId,
    });
    expect(winner.ok).toBe(true);
    if (!winner.ok) return;

    const seqAfterWinner = await readCreditNoteSeq(tenant);

    // 2) Deps whose under-lock read MISSES once (returns null, forcing the
    //    real insert to collide), then THROWS on the fresh-tx reconcile read.
    const deps = makeIssueCreditNoteDeps(tenant.ctx.slug);
    const realRepo = deps.creditNoteRepo;
    let findCalls = 0;
    const findStub = vi.fn(async (_tx: unknown, _tid: string, _srid: string) => {
      findCalls += 1;
      if (findCalls === 1) return null; // simulate TOCTOU miss under the lock
      // Simulate a transient DB failure on the fresh-tx reconcile read —
      // never reaches the real repo.
      throw new Error('simulated transient DB failure on fresh-tx reconcile read');
    });
    const stubbedRepo = { ...realRepo, findBySourceRefundId: findStub };

    const raced = await issueCreditNote(
      { ...deps, creditNoteRepo: stubbedRepo },
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        invoiceId,
        creditTotalSatang: asSatang(53_500n),
        reason: 'racer',
        sourceRefundId: refundId,
        membershipEffect: 'keep',
      },
    );

    // Typed err, NOT an unhandled throw — proves the reconcile-read
    // try/catch works. Before the fix this `await` REJECTS instead of
    // resolving.
    expect(raced.ok).toBe(false);
    if (raced.ok) return;
    expect(raced.error.code).toBe('concurrent_state_change');

    // findBySourceRefundId called twice: under-lock miss + the throwing
    // fresh-tx reconcile attempt.
    expect(findCalls).toBe(2);

    // The failed allocate rolled back → §87 counter UNCHANGED (no gap); the
    // winner's CN is still the only row for this refund.
    expect(await readCreditNoteSeq(tenant)).toBe(seqAfterWinner);
    expect(await countCreditNotesForRefund(tenant, refundId)).toBe(1);
  }, 90_000);
});
