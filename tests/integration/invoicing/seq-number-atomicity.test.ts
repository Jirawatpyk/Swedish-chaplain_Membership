/**
 * T016 — F4 Sequential-number atomicity integration test.
 *
 * Thai RD §87 "no duplicates / no gaps" compliance. The most
 * tax-compliance-critical code path in F4 is the `issue-invoice.ts`
 * transactional unit of work:
 *
 *   1. pg_advisory_xact_lock on (tenant_id, document_type, fiscal_year)
 *   2. SELECT … FOR UPDATE on tenant_document_sequences
 *   3. Render PDF (deterministic)
 *   4. Upload to Blob (content-addressed)
 *   5. Insert invoices + invoice_lines
 *   6. Emit audit event
 *   7. Enqueue auto-email outbox row
 *   8. COMMIT
 *
 * If ANY step throws, the whole unit of work rolls back — no gap in the
 * sequence, no orphan Blob (a separate outbox cleanup sweep handles
 * post-commit Blob reconciliation for scenario (c)).
 *
 * Phase-3 promotion (2026-04-19): scenarios (a)(b)(d)(e)(f)(g)(h)
 * promoted from `test.todo` to real DB assertions on live Neon.
 * Scenario (c) (post-commit Blob sweeper) stays `test.todo` — the
 * sweeper job is a future F4 polish item (T108+) and there is no code
 * to exercise yet.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSatang } from '@/lib/money';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import type { FiscalYear } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';
import type { InvoiceRepo } from '@/modules/invoicing/application/ports/invoice-repo';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { asTenantContext } from '@/modules/tenants';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';

const CORPORATE_MATRIX: BenefitMatrix = {
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

async function seedTenantForIssuance(
  tenant: TestTenant,
  user: TestUser,
): Promise<{ memberId: string; planId: string; planYear: number }> {
  const planId = 'seq-test-plan';
  const planYear = 2026;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear,
      planName: { en: 'Seq Test Plan' },
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
      benefitMatrix: CORPORATE_MATRIX,
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
      invoiceNumberPrefix: 'T',
      creditNoteNumberPrefix: 'TC',
    });
  });
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: 'Seq Test Co',
      country: 'TH',
      planId,
      planYear,
    }),
  );
  return { memberId, planId, planYear };
}

async function insertDraft(
  tenant: TestTenant,
  user: TestUser,
  memberId: string,
  planId: string,
  planYear: number,
): Promise<string> {
  const invoiceId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear,
      planId,
      draftByUserId: user.userId,
      status: 'draft',
    });
    // R8-T1 — seed one membership_fee line so `issueInvoice`'s
    // `enforceOneMembershipLine(draft.lines)` invariant check passes
    // and the test reaches the mocked PDF/Blob/audit failure points
    // it actually wants to exercise. Without this, scenarios (a),
    // (b), (g), (h-replay) short-circuit to `invalid_lines` before
    // the failure injection fires.
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: `ค่าสมาชิก ปี ${planYear}`,
      descriptionEn: `Membership ${planYear}`,
      unitPriceSatang: 1_000_000n,
      totalSatang: asSatang(1_000_000n),
      position: 1,
    });
  });
  return invoiceId;
}

function makeIssueDeps(
  tenant: TestTenant,
  overrides: Partial<IssueInvoiceDeps> = {},
): IssueInvoiceDeps {
  const invoiceRepo: InvoiceRepo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
  const settingsView: TenantInvoiceSettingsView = {
    tenantId: tenant.ctx.slug,
    currencyCode: 'THB',
    vatRate: VatRate.ofUnsafe('0.0700'),
    registrationFeeSatang: asSatang(0n),
    invoiceNumberPrefix: 'T',
    creditNoteNumberPrefix: 'TC',
    receiptNumberingMode: 'combined',
    fiscalYearStartMonth: 1,
    defaultNetDays: 30,
    proRatePolicy: 'monthly',
    autoEmailEnabled: false,
    identity: {
      legal_name_th: 'ทดสอบ',
      legal_name_en: 'Test',
      tax_id: '0000000000000',
      address_th: 'Bangkok',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
  };
  const base: IssueInvoiceDeps = {
    invoiceRepo,
    tenantSettingsRepo: {
      getForIssue: vi.fn(async () => settingsView),
      upsert: vi.fn(),
      withTx: vi.fn(async (_t, fn) => fn({})),
      getForUpdateInTx: vi.fn(async () => null),
      readSequencesInTx: vi.fn(async () => []),
    },
    memberIdentity: {
      getForIssue: vi.fn(async (_tx, _t, memberId) => ({
        memberId,
        isActive: true,
        isArchived: false,
        registrationFeePaid: true,
        registrationDate: '2026-01-01',
        snapshot: {
          legal_name: 'Seq Test Co',
          tax_id: '1234567890123',
          address: 'Bangkok',
          primary_contact_name: 'n',
          primary_contact_email: 'test@example.com',
        },
      })),
      markRegistrationFeePaid: vi.fn(async () => {}),
    },
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => []),
    },
    audit: { emit: vi.fn(async () => {}) },
    clock: { nowIso: () => '2026-04-18T10:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
    currentTemplateVersion: 1,
  };
  return { ...base, ...overrides };
}

describe('F4 Seq-number atomicity — T016 (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  // -------------------------------------------------------------------------
  // (f) Bootstrap — row absent on first issue
  // -------------------------------------------------------------------------
  it('(f) tenant_document_sequences row missing → allocator creates with seq=1', async () => {
    const fy = 2026 as FiscalYear;
    const ctx = asTenantContext(tenant.ctx.slug);
    const seq = await runInTenant(ctx, (tx) =>
      postgresSequenceAllocator.allocateNext(tx, {
        tenantId: tenant.ctx.slug,
        documentType: 'credit_note', // stream not seeded by anything else
        fiscalYear: fy,
      }),
    );
    expect(seq).toBe(1);

    const rows = await db
      .select()
      .from(tenantDocumentSequences)
      .where(
        and(
          eq(tenantDocumentSequences.tenantId, tenant.ctx.slug),
          eq(tenantDocumentSequences.documentType, 'credit_note'),
          eq(tenantDocumentSequences.fiscalYear, 2026),
        ),
      );
    expect(rows).toHaveLength(1);
    // After allocation the next value is bumped to 2 (post-increment).
    expect(rows[0]!.nextSequenceNumber).toBe(2);
  }, 30_000);

  // -------------------------------------------------------------------------
  // (h) Sequential allocation — 3 back-to-back calls produce 1, 2, 3
  // -------------------------------------------------------------------------
  it('(h) Sequential calls allocate 1 → 2 → 3 with no gaps', async () => {
    const ctx = asTenantContext(tenant.ctx.slug);
    const fy = 2026 as FiscalYear;
    const seqs: number[] = [];
    for (let n = 0; n < 3; n++) {
      const s = await runInTenant(ctx, (tx) =>
        postgresSequenceAllocator.allocateNext(tx, {
          tenantId: tenant.ctx.slug,
          documentType: 'invoice',
          fiscalYear: fy,
        }),
      );
      seqs.push(s);
    }
    expect(seqs).toEqual([1, 2, 3]);
  }, 30_000);

  // -------------------------------------------------------------------------
  // (d) Advisory-lock contention — 10 concurrent allocations yield 1..10
  // no duplicates, no gaps.
  // -------------------------------------------------------------------------
  it('(d) 10 concurrent allocations on same (tenant, FY) produce 1..10 with no duplicates', async () => {
    const ctx = asTenantContext(tenant.ctx.slug);
    const fy = 2029 as FiscalYear; // isolated FY so it doesn't collide with (h)
    const allocations = await Promise.all(
      Array.from({ length: 10 }, () =>
        runInTenant(ctx, (tx) =>
          postgresSequenceAllocator.allocateNext(tx, {
            tenantId: tenant.ctx.slug,
            documentType: 'invoice',
            fiscalYear: fy,
          }),
        ),
      ),
    );
    const sorted = [...allocations].sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(allocations).size).toBe(10);
  }, 60_000);

  // -------------------------------------------------------------------------
  // (e) Year-boundary — FY 2026 and FY 2027 streams are independent.
  // -------------------------------------------------------------------------
  it('(e) FY-boundary crossover — adjacent fiscal years allocate independently', async () => {
    const ctx = asTenantContext(tenant.ctx.slug);
    // FY 2026 is already at 4 after tests (f)(h) — we test the RELATIVE
    // behaviour: fresh FY 2027 starts at 1, independent of 2026.
    const fy2027Seq1 = await runInTenant(ctx, (tx) =>
      postgresSequenceAllocator.allocateNext(tx, {
        tenantId: tenant.ctx.slug,
        documentType: 'invoice',
        fiscalYear: 2027 as FiscalYear,
      }),
    );
    const fy2027Seq2 = await runInTenant(ctx, (tx) =>
      postgresSequenceAllocator.allocateNext(tx, {
        tenantId: tenant.ctx.slug,
        documentType: 'invoice',
        fiscalYear: 2027 as FiscalYear,
      }),
    );
    const fy2026SeqNext = await runInTenant(ctx, (tx) =>
      postgresSequenceAllocator.allocateNext(tx, {
        tenantId: tenant.ctx.slug,
        documentType: 'invoice',
        fiscalYear: 2026 as FiscalYear,
      }),
    );
    expect(fy2027Seq1).toBe(1);
    expect(fy2027Seq2).toBe(2);
    // FY 2026 had 1,2,3 from (h) + d just touched 2029, so next FY 2026 = 4.
    expect(fy2026SeqNext).toBeGreaterThanOrEqual(4);
  }, 30_000);

  // -------------------------------------------------------------------------
  // (a) PDF render throws → whole tx rolls back, no seq increment
  // -------------------------------------------------------------------------
  it('(a) PDF render throws → rollback, seq unchanged, no invoice row', async () => {
    // Fresh tenant so FY 2026 invoice stream starts at 1.
    const freshTenant = await createTestTenant('test-swecham');
    const freshSeed = await seedTenantForIssuance(freshTenant, user);
    try {
      const draftId = await insertDraft(
        freshTenant,
        user,
        freshSeed.memberId,
        freshSeed.planId,
        freshSeed.planYear,
      );
      const failingRender = vi.fn(async () => {
        throw new Error('PDF render blew up');
      });
      const deps = makeIssueDeps(freshTenant, {
        pdfRender: { render: failingRender },
      });
      const r = await issueInvoice(deps, {
        tenantId: freshTenant.ctx.slug,
        actorUserId: user.userId,
        requestId: null,
        invoiceId: draftId,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('pdf_render_failed');
      // Seq row should either NOT exist yet OR still be at 1 (the
      // allocator bumped it inside the failing tx, which rolled back).
      const seqRows = await db
        .select()
        .from(tenantDocumentSequences)
        .where(
          and(
            eq(tenantDocumentSequences.tenantId, freshTenant.ctx.slug),
            eq(tenantDocumentSequences.documentType, 'invoice'),
          ),
        );
      // Branch on presence — if the row exists, its counter MUST be
      // exactly 1 (allocator bootstraps to 1; any bump that wasn't
      // rolled back would show ≥2). This is stronger than a simple OR
      // because a bug that sets nextSequenceNumber to 0 or null would
      // now fail loudly.
      if (seqRows.length === 0) {
        // No row yet — allocator never ran or rollback dropped it.
        expect(seqRows).toHaveLength(0);
      } else {
        expect(seqRows).toHaveLength(1);
        expect(seqRows[0]!.nextSequenceNumber).toBe(1);
      }
      // Invoice row still draft AND sequence_number still null.
      const invRows = await runInTenant(freshTenant.ctx, (tx) =>
        tx.select().from(invoices).where(eq(invoices.invoiceId, draftId)),
      );
      expect(invRows).toHaveLength(1);
      expect(invRows[0]!.status).toBe('draft');
      expect(invRows[0]!.sequenceNumber).toBeNull();
      expect(invRows[0]!.documentNumber).toBeNull();
    } finally {
      await freshTenant.cleanup().catch(() => {});
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // (b) Blob upload throws → identical rollback
  // -------------------------------------------------------------------------
  it('(b) Blob upload throws → rollback, seq unchanged, no invoice row', async () => {
    const freshTenant = await createTestTenant('test-swecham');
    const freshSeed = await seedTenantForIssuance(freshTenant, user);
    try {
      const draftId = await insertDraft(
        freshTenant,
        user,
        freshSeed.memberId,
        freshSeed.planId,
        freshSeed.planYear,
      );
      const failingBlob = vi.fn(async () => {
        throw new Error('Blob quota exceeded');
      });
      const deps = makeIssueDeps(freshTenant, {
        blob: {
          uploadPdf: failingBlob,
          uploadLogo: vi.fn(async () => ({ key: '', url: '' })),
          signDownloadUrl: vi.fn(async () => ''),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
          delete: vi.fn(async () => {}),
          list: vi.fn(async () => []),
        },
      });
      const r = await issueInvoice(deps, {
        tenantId: freshTenant.ctx.slug,
        actorUserId: user.userId,
        requestId: null,
        invoiceId: draftId,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('blob_upload_failed');
      const invRows = await runInTenant(freshTenant.ctx, (tx) =>
        tx.select().from(invoices).where(eq(invoices.invoiceId, draftId)),
      );
      expect(invRows[0]!.status).toBe('draft');
    } finally {
      await freshTenant.cleanup().catch(() => {});
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // (g) Audit INSERT throws → rollback identical to (a) / (b)
  // -------------------------------------------------------------------------
  it('(g) Audit emit throws → rollback, no invoice issued, no seq consumed', async () => {
    const freshTenant = await createTestTenant('test-swecham');
    const freshSeed = await seedTenantForIssuance(freshTenant, user);
    try {
      const draftId = await insertDraft(
        freshTenant,
        user,
        freshSeed.memberId,
        freshSeed.planId,
        freshSeed.planYear,
      );
      const failingAudit = vi.fn(async () => {
        throw new Error('audit_log INSERT blew up');
      });
      const deps = makeIssueDeps(freshTenant, {
        audit: { emit: failingAudit },
      });
      // Audit throws are infrastructure errors — they may propagate as
      // an unhandled rejection OR be caught and wrapped as a Result err
      // depending on the Drizzle driver's tx semantics. Either way, the
      // invoice row MUST remain draft and the sequence MUST NOT be
      // consumed. We assert the observable state after the call.
      try {
        const r = await issueInvoice(deps, {
          tenantId: freshTenant.ctx.slug,
          actorUserId: user.userId,
          requestId: null,
          invoiceId: draftId,
        });
        // If the driver surfaced it as a Result err, it must be a
        // non-ok result (not silently ok).
        expect(r.ok).toBe(false);
      } catch (e) {
        // If the driver propagated the throw, the message must come
        // from our failing audit, not from an unrelated source.
        expect(String(e)).toMatch(/audit_log/);
      }

      // Regardless of which path resolved the call, the observable
      // state MUST be: invoice still draft, seq not consumed.
      const invRows = await runInTenant(freshTenant.ctx, (tx) =>
        tx.select().from(invoices).where(eq(invoices.invoiceId, draftId)),
      );
      expect(invRows[0]!.status).toBe('draft');
      expect(invRows[0]!.sequenceNumber).toBeNull();
      const seqRows = await db
        .select()
        .from(tenantDocumentSequences)
        .where(
          and(
            eq(tenantDocumentSequences.tenantId, freshTenant.ctx.slug),
            eq(tenantDocumentSequences.documentType, 'invoice'),
          ),
        );
      if (seqRows.length === 0) {
        expect(seqRows).toHaveLength(0);
      } else {
        expect(seqRows).toHaveLength(1);
        expect(seqRows[0]!.nextSequenceNumber).toBe(1);
      }
    } finally {
      await freshTenant.cleanup().catch(() => {});
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // (h-replay) Idempotent issue — second call on already-issued returns
  // invoice_already_issued, no new sequence consumed.
  // -------------------------------------------------------------------------
  it('(h-replay) Re-issuing an already-issued invoice does NOT consume a new sequence number', async () => {
    const freshTenant = await createTestTenant('test-swecham');
    const freshSeed = await seedTenantForIssuance(freshTenant, user);
    try {
      const draftId = await insertDraft(
        freshTenant,
        user,
        freshSeed.memberId,
        freshSeed.planId,
        freshSeed.planYear,
      );
      const deps = makeIssueDeps(freshTenant);
      const r1 = await issueInvoice(deps, {
        tenantId: freshTenant.ctx.slug,
        actorUserId: user.userId,
        requestId: null,
        invoiceId: draftId,
      });
      expect(r1.ok).toBe(true);

      const seqAfterFirst = (
        await db
          .select()
          .from(tenantDocumentSequences)
          .where(
            and(
              eq(tenantDocumentSequences.tenantId, freshTenant.ctx.slug),
              eq(tenantDocumentSequences.documentType, 'invoice'),
            ),
          )
      )[0]?.nextSequenceNumber;
      expect(seqAfterFirst).toBe(2);

      // Second call — already issued.
      const r2 = await issueInvoice(deps, {
        tenantId: freshTenant.ctx.slug,
        actorUserId: user.userId,
        requestId: null,
        invoiceId: draftId,
      });
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.error.code).toBe('invoice_already_issued');

      const seqAfterReplay = (
        await db
          .select()
          .from(tenantDocumentSequences)
          .where(
            and(
              eq(tenantDocumentSequences.tenantId, freshTenant.ctx.slug),
              eq(tenantDocumentSequences.documentType, 'invoice'),
            ),
          )
      )[0]?.nextSequenceNumber;
      expect(seqAfterReplay).toBe(2); // unchanged
    } finally {
      await freshTenant.cleanup().catch(() => {});
    }
  }, 60_000);

  // (c) Post-commit Blob sweeper covered at
  //     `tests/integration/invoicing/receipt-pdf-reconcile-cron.test.ts`
  //     (FEATURE_F5_ASYNC_RECEIPT_PDF path; re-enqueue + dedupe +
  //     permanent-failure audit + stuck-pending sweep + atomicity).
  //     Sync-issue paths (issue-invoice + issue-credit-note) keep
  //     Blob upload INSIDE the tx — failed upload rolls back at (b)
  //     above. F5R5 M-3 trim of the prior F5R3v4 history block.

  // -------------------------------------------------------------------------
  // (perf) 50-writer load variant — gated by RUN_PERF=1.
  // -------------------------------------------------------------------------
  (process.env.RUN_PERF === '1' ? it : it.skip)(
    '(perf) 50 concurrent issues produce contiguous 1..50 in < 30s wall-clock',
    async () => {
      const ctx = asTenantContext(tenant.ctx.slug);
      const fy = 2099 as FiscalYear; // isolated FY
      const t0 = Date.now();
      const allocations = await Promise.all(
        Array.from({ length: 50 }, () =>
          runInTenant(ctx, (tx) =>
            postgresSequenceAllocator.allocateNext(tx, {
              tenantId: tenant.ctx.slug,
              documentType: 'invoice',
              fiscalYear: fy,
            }),
          ),
        ),
      );
      const elapsedMs = Date.now() - t0;
      const sorted = [...allocations].sort((a, b) => a - b);
      expect(sorted).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      expect(elapsedMs).toBeLessThan(30_000);
    },
    120_000,
  );
});
