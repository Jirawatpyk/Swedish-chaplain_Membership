/**
 * 059-membership-suspension Task 9 — `loadSettlementPreview` integration
 * test (live Neon).
 *
 * Proves the CORRECTED previewable gate — NOT the task brief's original
 * `status IN ('sent','partially_paid')` sketch, which referenced enum
 * values that DO NOT EXIST on `invoices.status`
 * (`draft|issued|paid|void|credited|partially_credited`; payment here is
 * whole-invoice `issued → paid`, never partial). The plan's financial-
 * integrity-reviewed rule: `previewable = TRUE` only when the cycle's
 * `linked_invoice_id` resolves to a real, tenant-owned invoice with
 * `status = 'issued'`.
 *
 * Five seeded cases ((c)-(e) are money-safety hardening beyond the task
 * brief's original two-case sketch):
 *   (a) an `awaiting_payment` cycle linked to a real `status='issued'`
 *       invoice with a known total → previewable:true, amountThbMinor =
 *       the seeded total net of credited (credited=0 here).
 *   (b) an `upcoming` cycle with NO linked invoice → previewable:false,
 *       amountThbMinor:null, invoiceId:null.
 *   (c) a cycle whose `linked_invoice_id` points at an already-`paid`
 *       invoice (stale/orphan link) → previewable:false, and its amount
 *       is EXCLUDED from `total_thb_minor` — the orphan-link guard the
 *       task brief omitted. Without this guard an operator bulk-marking
 *       a batch that includes an already-settled cycle would see an
 *       inflated bank-transfer total.
 *   (d) review round 1 fix C — a cycle linked to a `status='draft'`
 *       invoice with a non-zero total. 107-auto-invoice pre-drafts renewal
 *       invoices ahead of the due date (status='draft', linked via
 *       `linked_invoice_id`) — a state reachable in prod. previewable must
 *       be FALSE (a draft has no finalised, collectible total) and its
 *       amount must be excluded from `total_thb_minor`.
 *   (e) review round 1 fix E — a cycle linked to a `status='void'`
 *       invoice (highest-stake exclusion: a voided invoice's amount must
 *       NEVER appear in a bulk bank-transfer total). previewable must be
 *       FALSE and its amount excluded from `total_thb_minor`.
 *
 * Plus cross-tenant isolation: tenant B's own request never sees tenant
 * A's cycle, even when A's cycleId is explicitly included in the batch.
 *
 * Run in isolation (file PATH positional, not `-- <pattern>`):
 *   pnpm test:integration tests/integration/renewals/settlement-preview.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { loadSettlementPreview, makeRenewalsDeps } from '@/modules/renewals';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Settlement Preview Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

interface SeedInvoiceSpec {
  readonly status: 'draft' | 'issued' | 'paid' | 'void';
  readonly totalSatang: bigint;
  readonly creditedTotalSatang: bigint;
  readonly seq: number;
}

/** Mirrors `seedMembershipInvoice` in load-pipeline-money.test.ts (proven idiom). */
async function seedMembershipInvoice(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  memberId: string,
  spec: SeedInvoiceSpec,
): Promise<string> {
  const invoiceId = randomUUID();
  const hasPaidAt = spec.status === 'paid';
  // `invoices_void_has_reason` (hand-authored DB CHECK, not mirrored in
  // schema.ts) requires void_reason IS NOT NULL whenever status='void' —
  // discovered live when seeding the (e) void-linked case (review round 1
  // fix E).
  const isVoid = spec.status === 'void';
  const subtotal = (spec.totalSatang * 100n) / 107n;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear: 2026,
      planId,
      draftByUserId: user.userId,
      status: spec.status,
      pdfDocKind: 'invoice',
      fiscalYear: 2026,
      sequenceNumber: spec.seq,
      documentNumber: `SC-2026-${String(spec.seq).padStart(6, '0')}`,
      issueDate: '2026-06-01',
      dueDate: '2026-07-01',
      subtotalSatang: subtotal,
      vatRateSnapshot: '0.0700',
      vatSatang: spec.totalSatang - subtotal,
      totalSatang: spec.totalSatang,
      creditedTotalSatang: spec.creditedTotalSatang,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      paymentMethod: hasPaidAt ? 'bank_transfer' : null,
      paymentReference: hasPaidAt ? 'seed-ref' : null,
      paymentRecordedByUserId: hasPaidAt ? user.userId : null,
      paidAt: hasPaidAt ? new Date('2026-06-15T03:00:00Z') : null,
      receiptPdfStatus: hasPaidAt ? 'rendered' : null,
      voidReason: isVoid ? 'seed: settlement-preview void-link test case' : null,
      voidedByUserId: isVoid ? user.userId : null,
      voidedAt: isVoid ? new Date('2026-06-20T03:00:00Z') : null,
      autoEmailOnIssue: true,
    });
  });
  return invoiceId;
}

async function seedMember(
  tenant: TestTenant,
  planId: string,
  memberId: string,
  companyName: string,
): Promise<void> {
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName,
      country: 'TH',
      planId,
      planYear: 2026,
    }),
  );
}

async function seedCycle(
  tenant: TestTenant,
  args: {
    readonly cycleId: string;
    readonly memberId: string;
    readonly status: 'upcoming' | 'awaiting_payment';
    readonly linkedInvoiceId: string | null;
  },
): Promise<void> {
  const now = Date.now();
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId: args.cycleId,
      memberId: args.memberId,
      status: args.status,
      periodFrom: new Date(now - 365 * 86_400_000),
      periodTo: new Date(now + 30 * 86_400_000),
      expiresAt: new Date(now + 30 * 86_400_000),
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: randomUUID(),
      frozenPlanPriceThb: '1070.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
      ...(args.linkedInvoiceId !== null
        ? { linkedInvoiceId: args.linkedInvoiceId }
        : {}),
    }),
  );
}

describe('loadSettlementPreview — integration (live Neon)', () => {
  let a: TestTenant;
  let b: TestTenant;
  let user: TestUser;

  let cycleLive: string; // (a) awaiting_payment, linked to 'issued' invoice
  let cycleNoInvoice: string; // (b) upcoming, no invoice
  let cycleStaleLink: string; // (c) linked to an already-'paid' invoice
  let cycleDraftLink: string; // (d) linked to a 'draft' invoice
  let cycleVoidLink: string; // (e) linked to a 'void' invoice
  let liveInvoiceId: string;
  let staleInvoiceId: string;
  let draftInvoiceId: string;
  let voidInvoiceId: string;

  let cycleB: string; // tenant B's own cycle (cross-tenant control)
  let invoiceB: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    ({ a, b } = await createTwoTestTenants());

    // --- Tenant A ---
    const planA = `sp-plan-${randomUUID().slice(0, 8)}`;
    const memberLive = randomUUID();
    const memberNoInvoice = randomUUID();
    const memberStale = randomUUID();
    const memberDraft = randomUUID();
    const memberVoid = randomUUID();
    await runInTenant(a.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: a.ctx.slug,
        planId: planA,
        planName: { en: 'Settlement Preview Plan A' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    await seedMember(a, planA, memberLive, 'Acme Co');
    await seedMember(a, planA, memberNoInvoice, 'Beta Co');
    await seedMember(a, planA, memberStale, 'Gamma Co');
    await seedMember(a, planA, memberDraft, 'Delta Co');
    await seedMember(a, planA, memberVoid, 'Epsilon Co');

    liveInvoiceId = await seedMembershipInvoice(a, user, planA, memberLive, {
      status: 'issued',
      totalSatang: 107000n, // ฿1,070.00
      creditedTotalSatang: 0n,
      seq: 1,
    });
    cycleLive = randomUUID();
    await seedCycle(a, {
      cycleId: cycleLive,
      memberId: memberLive,
      status: 'awaiting_payment',
      linkedInvoiceId: liveInvoiceId,
    });

    cycleNoInvoice = randomUUID();
    await seedCycle(a, {
      cycleId: cycleNoInvoice,
      memberId: memberNoInvoice,
      status: 'upcoming',
      linkedInvoiceId: null,
    });

    // (c) Decision-3 hardening: the linked invoice is already PAID — a
    // stale/orphan link. previewable must be FALSE and its amount must
    // NOT contribute to total_thb_minor.
    staleInvoiceId = await seedMembershipInvoice(a, user, planA, memberStale, {
      status: 'paid',
      totalSatang: 99999n,
      creditedTotalSatang: 0n,
      seq: 2,
    });
    cycleStaleLink = randomUUID();
    await seedCycle(a, {
      cycleId: cycleStaleLink,
      memberId: memberStale,
      status: 'awaiting_payment',
      linkedInvoiceId: staleInvoiceId,
    });

    // (d) Review round 1 fix C — the linked invoice is still 'draft'
    // (107-auto-invoice pre-drafts renewal bills ahead of the due date,
    // linked via linked_invoice_id, before the treasurer issues them — a
    // state reachable in prod). previewable must be FALSE even though the
    // draft carries a non-zero total, and that total must NOT contribute
    // to total_thb_minor.
    draftInvoiceId = await seedMembershipInvoice(a, user, planA, memberDraft, {
      status: 'draft',
      totalSatang: 55555n,
      creditedTotalSatang: 0n,
      seq: 3,
    });
    cycleDraftLink = randomUUID();
    await seedCycle(a, {
      cycleId: cycleDraftLink,
      memberId: memberDraft,
      status: 'awaiting_payment',
      linkedInvoiceId: draftInvoiceId,
    });

    // (e) Review round 1 fix E — the linked invoice is 'void' (the
    // highest-stake exclusion: a voided invoice's amount must NEVER
    // surface on a bulk bank-transfer total). previewable must be FALSE.
    voidInvoiceId = await seedMembershipInvoice(a, user, planA, memberVoid, {
      status: 'void',
      totalSatang: 44444n,
      creditedTotalSatang: 0n,
      seq: 4,
    });
    cycleVoidLink = randomUUID();
    await seedCycle(a, {
      cycleId: cycleVoidLink,
      memberId: memberVoid,
      status: 'awaiting_payment',
      linkedInvoiceId: voidInvoiceId,
    });

    // --- Tenant B (cross-tenant leak guard) ---
    const planB = `sp-plan-${randomUUID().slice(0, 8)}`;
    const memberB = randomUUID();
    await runInTenant(b.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: b.ctx.slug,
        planId: planB,
        planName: { en: 'Settlement Preview Plan B' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await seedMember(b, planB, memberB, 'Leak Guard Co');
    invoiceB = await seedMembershipInvoice(b, user, planB, memberB, {
      status: 'issued',
      totalSatang: 55500n,
      creditedTotalSatang: 0n,
      seq: 1,
    });
    cycleB = randomUUID();
    await seedCycle(b, {
      cycleId: cycleB,
      memberId: memberB,
      status: 'awaiting_payment',
      linkedInvoiceId: invoiceB,
    });
  }, 120_000);

  afterAll(async () => {
    await a?.cleanup().catch(() => {});
    await b?.cleanup().catch(() => {});
  }, 120_000);

  it('previews a live-invoice cycle, a no-invoice cycle, a stale-link cycle, a draft-link cycle, and a void-link cycle correctly', async () => {
    const res = await loadSettlementPreview(
      { renewalCycleRepo: makeRenewalsDeps(a.ctx.slug).cyclesRepo },
      {
        tenantId: a.ctx.slug,
        cycleIds: [
          cycleLive,
          cycleNoInvoice,
          cycleStaleLink,
          cycleDraftLink,
          cycleVoidLink,
        ],
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.items).toHaveLength(5);

    const live = res.value.items.find((r) => r.cycleId === cycleLive);
    expect(live?.previewable).toBe(true);
    expect(live?.invoiceId).toBe(liveInvoiceId);
    expect(live?.amountThbMinor).toBe(107000);
    expect(live?.currency).toBe('THB');
    expect(live?.companyName).toBe('Acme Co');

    const noInvoice = res.value.items.find((r) => r.cycleId === cycleNoInvoice);
    expect(noInvoice?.previewable).toBe(false);
    expect(noInvoice?.invoiceId).toBeNull();
    expect(noInvoice?.amountThbMinor).toBeNull();
    expect(noInvoice?.currency).toBeNull();

    // (c) Decision-3 hardening — the orphan/stale-link guard the task
    // brief's original sketch omitted.
    const stale = res.value.items.find((r) => r.cycleId === cycleStaleLink);
    expect(stale?.previewable).toBe(false);
    expect(stale?.invoiceId).toBeNull();
    expect(stale?.amountThbMinor).toBeNull();
    expect(stale?.currency).toBeNull();

    // (d) Review round 1 fix C — a draft-linked cycle. A draft has no
    // finalised, collectible total; previewable must be FALSE regardless
    // of whatever total the draft row happens to carry.
    const draft = res.value.items.find((r) => r.cycleId === cycleDraftLink);
    expect(draft?.previewable).toBe(false);
    expect(draft?.invoiceId).toBeNull();
    expect(draft?.amountThbMinor).toBeNull();
    expect(draft?.currency).toBeNull();

    // (e) Review round 1 fix E — a void-linked cycle. A voided invoice's
    // amount must NEVER surface — highest-stake exclusion of the set.
    const voided = res.value.items.find((r) => r.cycleId === cycleVoidLink);
    expect(voided?.previewable).toBe(false);
    expect(voided?.invoiceId).toBeNull();
    expect(voided?.amountThbMinor).toBeNull();
    expect(voided?.currency).toBeNull();

    // total excludes the no-invoice, stale-paid (99999), draft (55555),
    // AND void (44444) rows — only the live 107000 contributes.
    expect(res.value.totalThbMinor).toBe(107000);
  });

  it('cross-tenant isolation: tenant B never sees tenant A\'s cycle even when explicitly requested', async () => {
    const res = await loadSettlementPreview(
      { renewalCycleRepo: makeRenewalsDeps(b.ctx.slug).cyclesRepo },
      { tenantId: b.ctx.slug, cycleIds: [cycleLive, cycleB] },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // RLS hides tenant A's row entirely — it is ABSENT, not merely
    // non-previewable.
    expect(res.value.items).toHaveLength(1);
    expect(res.value.items[0]?.cycleId).toBe(cycleB);
    expect(res.value.items[0]?.previewable).toBe(true);
    expect(res.value.totalThbMinor).toBe(55500);
  });
});
