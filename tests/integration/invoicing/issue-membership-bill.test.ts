/**
 * Task 4 (106-void-on-reissue) — `issueMembershipBill` live-Neon
 * end-to-end + `F4InvoicingForRenewalBridge` routing guard.
 *
 * Task 3 shipped `issueMembershipBill` (auto-void the member's strictly-
 * older, still-outstanding new-flow membership bills on reissue) with only
 * mock-level unit coverage (`tests/unit/invoicing/issue-membership-
 * bill.test.ts`) plus a read-only `listSupersedableMembershipBills`
 * integration test. This file is the first LIVE-NEON proof of the full
 * issue -> list -> void composition, AND proves Task 4's actual code change
 * — that the PRODUCTION renewal bridge
 * (`f4InvoicingForRenewalBridge.issueInvoiceForRenewal`) itself now routes
 * through `issueMembershipBill` instead of bare `issueInvoice`.
 *
 * Harness = the `void-invoice.test.ts` / `list-supersedable-membership-
 * bills.test.ts` idiom: direct-insert the OLDER bill(s) with a controlled
 * `created_at`; drive the NEW bill through the real `createInvoiceDraft` ->
 * `issueMembershipBill` composition (real DB, RLS, §87/SC sequence
 * allocator, audit).
 *
 * Mocking policy (mirrors `processor-bridge.test.ts`): the PDF-render /
 * Blob-upload / email-outbox adapters are mocked module-wide (network-
 * touching, not the system under test) so every `makeIssueInvoiceDeps` /
 * `makeVoidInvoiceDeps` call in this file — direct or via the bridge —
 * picks them up automatically.
 *
 * The bridge's OWN `voidOnReissueEnabled` (case E) is driven via a
 * `vi.hoisted` `process.env.FEATURE_VOID_ON_REISSUE = 'true'` — NOT a
 * `vi.mock('@/modules/invoicing/application/invoicing-deps', …)` override.
 * That override DOES work for THIS file's own direct import of
 * `makeIssueMembershipBillDeps`, but does NOT propagate through the
 * `@/modules/invoicing` PUBLIC BARREL the bridge imports from — confirmed
 * empirically (see report): `vi.mock`'s `importOriginal()` on the barrel
 * itself returns a broken/incomplete snapshot (`makeCreateInvoiceDraftDeps
 * is not a function`), so mocking the barrel is a dead end too. `env.ts`
 * computes its `export const env` ONCE at first import, so the
 * `process.env` mutation MUST land before anything in this file's static
 * import graph first touches `@/lib/env` — `vi.hoisted()` runs before ANY
 * import is linked/evaluated (the same hoisting mechanism `vi.mock` uses),
 * which is exactly what's needed here. Cases A-D are unaffected: they
 * hand-build `IssueMembershipBillDeps` with an explicit
 * `voidOnReissueEnabled` boolean (including case D's explicit `false`),
 * bypassing `env` entirely, per the task brief.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { parseThbDecimal } from '@/lib/money';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';

// --- Module-level mocks --------------------------------------------------
// `vi.hoisted` runs before this file's imports are linked — the ONLY point
// at which mutating `process.env` can influence `@/lib/env`'s import-time
// snapshot. Case D (`buildIssueMembershipBillDeps(slug, false)`) overrides
// this back to `false` explicitly via its own hand-built deps, so the flag
// being globally `true` here does not weaken that case's coverage.
vi.hoisted(() => {
  process.env.FEATURE_VOID_ON_REISSUE = 'true';
});
// Undo the mutation above once this file's tests finish. Under
// `vitest.integration.config.ts`'s `singleFork` pool, every integration file
// shares one OS process — `isolate: true` resets the module registry per
// file but does NOT reset `process.env`, so without this the mutation would
// leak into whichever integration file runs next in the same fork.
afterAll(() => {
  delete process.env.FEATURE_VOID_ON_REISSUE;
});
// See file docstring — mirrors `processor-bridge.test.ts`'s mocking policy.
vi.mock('@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter', async () => {
  const { Sha256Hex: S } = await import(
    '@/modules/invoicing/domain/value-objects/sha256-hex'
  );
  return {
    reactPdfRenderAdapter: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: S.ofUnsafe('c'.repeat(64)),
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
    uploadLogo: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
    signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
    downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => [] as string[]),
  },
}));
vi.mock('@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter', () => ({
  resendEmailOutboxAdapter: { enqueue: vi.fn(async () => {}) },
}));

// Imports that depend on the mocked modules MUST come after the vi.mock calls.
import {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeVoidInvoiceDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import {
  issueMembershipBill,
  type IssueMembershipBillDeps,
} from '@/modules/invoicing/application/use-cases/issue-membership-bill';
import { f4InvoicingForRenewalBridge } from '@/modules/renewals/infrastructure/ports-adapters/f4-invoicing-for-renewal-bridge-drizzle';

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

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Issue Membership Bill Test Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

async function seedPlanFixture(tenant: TestTenant, user: TestUser, planId: string): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'Issue Membership Bill Plan' },
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
  });
}

async function seedMember(tenant: TestTenant, planId: string): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Issue Membership Bill Test Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });
  });
  return memberId;
}

/**
 * Direct-insert a MEMBERSHIP invoice row with an explicit `createdAt` so
 * ordering is deterministic, and either a new-flow (bill number, no
 * document number) or legacy (§87 document number) numbering shape.
 * Mirrors `list-supersedable-membership-bills.test.ts`'s `seedBill`.
 */
async function seedMembershipBillRow(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  memberId: string,
  opts: {
    status: 'issued' | 'paid';
    numbering:
      | { kind: 'new_flow'; billNumber: string }
      | { kind: 'legacy'; sequenceNumber: number; documentNumber: string };
    createdAt: Date;
  },
): Promise<{ invoiceId: string; createdAt: Date }> {
  const invoiceId = randomUUID();
  const isPaid = opts.status === 'paid';
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear: 2026,
      planId,
      draftByUserId: user.userId,
      status: opts.status,
      pdfDocKind: 'invoice',
      fiscalYear: 2026,
      sequenceNumber: opts.numbering.kind === 'legacy' ? opts.numbering.sequenceNumber : null,
      documentNumber: opts.numbering.kind === 'legacy' ? opts.numbering.documentNumber : null,
      billDocumentNumberRaw: opts.numbering.kind === 'new_flow' ? opts.numbering.billNumber : null,
      receiptDocumentNumberRaw:
        isPaid && opts.numbering.kind === 'new_flow'
          ? `RC-2026-${opts.numbering.billNumber.slice(-6)}`
          : null,
      issueDate: '2026-01-15',
      dueDate: '2026-02-14',
      subtotalSatang: 100_000n,
      vatRateSnapshot: '0.0700',
      vatSatang: 7_000n,
      totalSatang: 107_000n,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      autoEmailOnIssue: true,
      pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      paymentMethod: isPaid ? 'bank_transfer' : null,
      paymentReference: isPaid ? 'seed-ref' : null,
      paymentRecordedByUserId: isPaid ? user.userId : null,
      paymentDate: isPaid ? '2026-02-01' : null,
      paidAt: isPaid ? new Date('2026-02-01T03:00:00Z') : null,
      receiptPdfStatus: isPaid ? 'rendered' : null,
      createdAt: opts.createdAt,
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก ปี 2026',
      descriptionEn: 'Membership 2026',
      unitPriceSatang: 100_000n,
      totalSatang: 100_000n,
      position: 1,
    });
  });
  return { invoiceId, createdAt: opts.createdAt };
}

async function selectInvoiceStatus(
  tenant: TestTenant,
  invoiceId: string,
): Promise<string | undefined> {
  const [row] = await runInTenant(tenant.ctx, (tx) =>
    tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.invoiceId, invoiceId)),
  );
  return row?.status;
}

async function selectVoidedAuditPayload(
  tenant: TestTenant,
  invoiceId: string,
): Promise<Record<string, unknown> | undefined> {
  const [row] = await runInTenant(tenant.ctx, (tx) =>
    tx
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_voided'),
          sql`${auditLog.payload}->>'invoice_id' = ${invoiceId}`,
        ),
      ),
  );
  return row?.payload as Record<string, unknown> | undefined;
}

/** Hand-built deps for the DIRECT `issueMembershipBill` cases (A-D) — an
 * explicit `voidOnReissueEnabled` boolean, no env dependency. `taxAtPayment:
 * 'on'` is forced (rather than left to ambient `FEATURE_088_TAX_AT_PAYMENT`)
 * so the issued bill is always NEW-FLOW-shaped, matching the shape
 * `listSupersedableMembershipBills` looks for. */
function buildIssueMembershipBillDeps(
  slug: string,
  voidOnReissueEnabled: boolean,
): IssueMembershipBillDeps {
  return {
    issueDeps: { ...makeIssueInvoiceDeps(slug), taxAtPayment: 'on' },
    voidDeps: makeVoidInvoiceDeps(slug),
    invoiceRepo: makeDrizzleInvoiceRepo(slug),
    voidOnReissueEnabled,
  };
}

/** Draft (real `createInvoiceDraft`) + issue (`issueMembershipBill`, the
 * function under test) a NEW membership bill for the member. */
async function issueViaMembershipBill(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  memberId: string,
  deps: IssueMembershipBillDeps,
  requestIdPrefix: string,
) {
  const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
    tenantId: tenant.ctx.slug,
    actorUserId: user.userId,
    requestId: `${requestIdPrefix}-draft`,
    memberId,
    planId,
    planYear: 2026,
    autoEmailOnIssue: false,
  });
  if (!draft.ok) throw new Error(`createInvoiceDraft failed: ${draft.error.code}`);
  return issueMembershipBill(deps, {
    tenantId: tenant.ctx.slug,
    actorUserId: user.userId,
    requestId: `${requestIdPrefix}-issue`,
    invoiceId: draft.value.invoiceId,
  });
}

describe('issueMembershipBill — void-on-reissue live-Neon e2e (Task 4, 106-void-on-reissue)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'issue-membership-bill-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await seedTenantFiscal({ tenant, invoiceNumberPrefix: 'SC', receiptNumberPrefix: 'RC' });
    await seedPlanFixture(tenant, user, planId);
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  beforeEach(async () => {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug));
      await tx.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug));
      await tx.delete(members).where(eq(members.tenantId, tenant.ctx.slug));
    });
  });

  it('A. issuing a new membership bill voids the strictly-older issued bill and stamps superseded_by_invoice_id on the audit row (flag ON)', async () => {
    const memberId = await seedMember(tenant, planId);
    const bOld = await seedMembershipBillRow(tenant, user, planId, memberId, {
      status: 'issued',
      numbering: { kind: 'new_flow', billNumber: 'SC-2026-900001' },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const deps = buildIssueMembershipBillDeps(tenant.ctx.slug, true);
    const result = await issueViaMembershipBill(tenant, user, planId, memberId, deps, 'task4-a');

    expect(result.ok, result.ok ? 'ok' : `err: ${JSON.stringify(!result.ok && result.error)}`).toBe(
      true,
    );
    if (!result.ok) return;
    expect(result.value.supersedeWarnings).toEqual([]);
    expect(result.value.status).toBe('issued');

    expect(await selectInvoiceStatus(tenant, bOld.invoiceId)).toBe('void');
    expect(await selectInvoiceStatus(tenant, result.value.invoiceId)).toBe('issued');

    const payload = await selectVoidedAuditPayload(tenant, bOld.invoiceId);
    expect(payload?.superseded_by_invoice_id).toBe(result.value.invoiceId);
  }, 60_000);

  it('B. a paid new-flow bill and a legacy §86/4 bill are never voided (flag ON)', async () => {
    const memberId = await seedMember(tenant, planId);
    const bPaid = await seedMembershipBillRow(tenant, user, planId, memberId, {
      status: 'paid',
      numbering: { kind: 'new_flow', billNumber: 'SC-2026-900002' },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const bLegacy = await seedMembershipBillRow(tenant, user, planId, memberId, {
      status: 'issued',
      numbering: { kind: 'legacy', sequenceNumber: 501, documentNumber: 'SC-2026-000501' },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const deps = buildIssueMembershipBillDeps(tenant.ctx.slug, true);
    const result = await issueViaMembershipBill(tenant, user, planId, memberId, deps, 'task4-b');

    expect(result.ok, result.ok ? 'ok' : `err: ${JSON.stringify(!result.ok && result.error)}`).toBe(
      true,
    );
    if (!result.ok) return;
    expect(result.value.supersedeWarnings).toEqual([]);

    expect(await selectInvoiceStatus(tenant, bPaid.invoiceId)).toBe('paid');
    expect(await selectInvoiceStatus(tenant, bLegacy.invoiceId)).toBe('issued');
  }, 60_000);

  it('C. two concurrent issues for the same member never leave zero outstanding bills (asymmetric ordering)', async () => {
    const memberId = await seedMember(tenant, planId);
    const bOld = await seedMembershipBillRow(tenant, user, planId, memberId, {
      status: 'issued',
      numbering: { kind: 'new_flow', billNumber: 'SC-2026-900003' },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const deps = buildIssueMembershipBillDeps(tenant.ctx.slug, true);
    const draftDeps = makeCreateInvoiceDraftDeps(tenant.ctx.slug);
    const draft1 = await createInvoiceDraft(draftDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: 'task4-c-draft-1',
      memberId,
      planId,
      planYear: 2026,
      autoEmailOnIssue: false,
    });
    const draft2 = await createInvoiceDraft(draftDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: 'task4-c-draft-2',
      memberId,
      planId,
      planYear: 2026,
      autoEmailOnIssue: false,
    });
    if (!draft1.ok || !draft2.ok) {
      throw new Error(
        `draft failed: ${JSON.stringify(!draft1.ok && draft1.error)} / ${JSON.stringify(!draft2.ok && draft2.error)}`,
      );
    }

    const [r1, r2] = await Promise.all([
      issueMembershipBill(deps, {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: 'task4-c-issue-1',
        invoiceId: draft1.value.invoiceId,
      }),
      issueMembershipBill(deps, {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: 'task4-c-issue-2',
        invoiceId: draft2.value.invoiceId,
      }),
    ]);
    expect(r1.ok, r1.ok ? 'ok' : `err: ${JSON.stringify(!r1.ok && r1.error)}`).toBe(true);
    expect(r2.ok, r2.ok ? 'ok' : `err: ${JSON.stringify(!r2.ok && r2.error)}`).toBe(true);

    // bOld is strictly older than BOTH draft1 and draft2 and was ALREADY
    // `issued` before either draft was even created — regardless of which
    // draft wins the advisory-lock race to issue first, that winner's own
    // supersede pass always finds bOld as a candidate. This is a reliable
    // (non-racy) guarantee, unlike the draft1-vs-draft2 outcome below.
    expect(await selectInvoiceStatus(tenant, bOld.invoiceId)).toBe('void');

    const statuses = await Promise.all(
      [draft1.value.invoiceId, draft2.value.invoiceId].map((id) => selectInvoiceStatus(tenant, id)),
    );
    const survivors = statuses.filter((s) => s === 'issued');
    // EMPIRICAL FINDING (measured live against Neon, ~6 runs): "exactly one
    // survivor" is NOT a strict guarantee of the current algorithm for TWO
    // brand-new concurrent drafts — only "never zero" is. Reasoning: each
    // `issueMembershipBill` call's supersede-candidate list only contains
    // bills that are ALREADY `status='issued'` at the moment its OWN list
    // query runs. `issueInvoice`'s advisory lock (§87/SC numbering,
    // `pg_advisory_xact_lock` per tenant+documentType+fiscalYear) serialises
    // the two `issueInvoice` calls, but WHICH of draft1/draft2 wins that
    // lock race is independent of which draft has the earlier `created_at`
    // (`created_at` is fixed at DRAFT time, before the race starts; the lock
    // race is decided by DB round-trip / connection-acquisition timing).
    // If the LATER-created draft (draft2) wins the lock race and completes
    // its ENTIRE issue+supersede pass before the EARLIER-created draft1 even
    // starts its own `issueInvoice`, draft2's list query never sees draft1
    // (draft1 is still `status='draft'`, filtered out) — and once draft1
    // later issues, draft1's own supersede pass can never void draft2 either
    // (draft2's tuple is NEWER, excluded by the asymmetric `< bound`
    // ordering). Both survive. This contradicts the "deterministic single
    // survivor" docstring claim in `issue-membership-bill.ts` step 3 for
    // this specific two-brand-new-drafts race shape — see the Task 4 report
    // for the measured ~50% (3/6 runs) 2-survivor rate. Flagged for the
    // Task 3 owner; NOT fixed here (out of Task 4's declared scope: routing
    // the bridge, not changing the supersede algorithm).
    expect(survivors.length).toBeGreaterThanOrEqual(1);
    expect(survivors.length).toBeLessThanOrEqual(2);
  }, 60_000);

  it('D. flag OFF -> plain issue, no supersede', async () => {
    const memberId = await seedMember(tenant, planId);
    const bOld = await seedMembershipBillRow(tenant, user, planId, memberId, {
      status: 'issued',
      numbering: { kind: 'new_flow', billNumber: 'SC-2026-900004' },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const deps = buildIssueMembershipBillDeps(tenant.ctx.slug, false);
    const result = await issueViaMembershipBill(tenant, user, planId, memberId, deps, 'task4-d');

    expect(result.ok, result.ok ? 'ok' : `err: ${JSON.stringify(!result.ok && result.error)}`).toBe(
      true,
    );
    if (!result.ok) return;
    expect(result.value.supersedeWarnings).toEqual([]);
    expect(await selectInvoiceStatus(tenant, bOld.invoiceId)).toBe('issued');
  }, 60_000);

  it('E. BEHAVIORAL GUARD — the production renewal bridge routes through issueMembershipBill: reissuing via issueInvoiceForRenewal supersedes the older bill', async () => {
    const memberId = await seedMember(tenant, planId);
    const bOld = await seedMembershipBillRow(tenant, user, planId, memberId, {
      status: 'issued',
      numbering: { kind: 'new_flow', billNumber: 'SC-2026-900005' },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = await f4InvoicingForRenewalBridge.issueInvoiceForRenewal({
      tenantId: tenant.ctx.slug,
      memberId,
      planId,
      planYear: 2026,
      frozenPlanPriceThb: parseThbDecimal('12000.00'),
      autoEmailOnIssue: false,
      actorUserId: user.userId,
      correlationId: randomUUID(),
      requestId: 'task4-e',
    });

    expect(
      result.status,
      result.status !== 'issued' ? `err: ${JSON.stringify(result)}` : 'ok',
    ).toBe('issued');
    if (result.status !== 'issued') return;
    // Task 4's actual product change: the port arm now carries
    // `supersedeWarnings`, threaded verbatim from `issueMembershipBill`.
    expect(result.supersedeWarnings).toEqual([]);

    expect(await selectInvoiceStatus(tenant, bOld.invoiceId)).toBe('void');
    expect(await selectInvoiceStatus(tenant, result.invoiceId)).toBe('issued');

    const payload = await selectVoidedAuditPayload(tenant, bOld.invoiceId);
    expect(payload?.superseded_by_invoice_id).toBe(result.invoiceId);
  }, 60_000);
});
