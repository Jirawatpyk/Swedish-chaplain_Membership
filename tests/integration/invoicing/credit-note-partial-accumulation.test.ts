/**
 * T075 — Credit-note partial accumulation + concurrent-race integration test.
 *
 * Covers (FR-020…FR-023 + post-critique R2-E1):
 *  - Two partial credit notes summing exactly to the invoice total flip
 *    the parent invoice `paid → partially_credited → credited`.
 *  - A third partial credit note against a fully-credited invoice is
 *    rejected with `credit_exceeds_remainder`.
 *  - A partial credit note exceeding the remainder (by 1 satang) is
 *    rejected cleanly and does NOT consume a sequence number (Thai RD
 *    §87 no-gaps).
 *  - **Concurrent race**: two admins simultaneously issue 60% credit
 *    notes via `Promise.all`. Exactly one succeeds; the other returns
 *    `credit_exceeds_remainder`. No sequence gap; no double-allocation.
 *
 * Uses live Neon Singapore via `runInTenant(ctx, fn)`. PDF render +
 * Blob upload + outbox are mocked to keep the test fast and avoid
 * external side-effects; the DB + sequence allocator + RLS paths are
 * real so the lock-ordering guarantee is genuinely exercised.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { makeDrizzleCreditNoteRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { issueCreditNote } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import type { IssueCreditNoteDeps } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
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

const INVOICE_TOTAL = 107_000n; // 1,000 THB subtotal + 7% VAT
const INVOICE_SUBTOTAL = 100_000n;
const INVOICE_VAT = 7_000n;

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'CN Test Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'n@n.n',
};

/**
 * Seed an invoice in a specified non-draft status. `paid` is the
 * happy-path shape for the credit-note flow; `issued` / `voided` /
 * `credited` are used by the rejection-branch tests below. The
 * `payment_*` fields satisfy the DB CHECK `invoices_paid_has_payment`
 * which is only relevant when status='paid'.
 */
async function seedInvoiceInStatus(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  status: 'paid' | 'issued' | 'void',
): Promise<{ invoiceId: string; memberId: string }> {
  const invoiceId = randomUUID();
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: 'CN Test Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });

    // Paid invoice with snapshots, money fields, and PDF metadata —
    // must satisfy invoices_non_draft_has_snapshots + invoices_paid_has_payment.
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear: 2026,
      planId,
      draftByUserId: user.userId,
      status,
      fiscalYear: 2026,
      sequenceNumber: 1,
      documentNumber: 'CNIT-2026-000001',
      issueDate: '2026-01-15',
      dueDate: '2026-02-14',
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
      paymentMethod: status === 'paid' ? 'bank_transfer' : null,
      paymentReference: status === 'paid' ? 'seed-ref' : null,
      paymentNotes: null,
      paymentRecordedByUserId: status === 'paid' ? user.userId : null,
      paymentDate: status === 'paid' ? '2026-02-01' : null,
      paidAt: status === 'paid' ? new Date('2026-02-01T03:00:00Z') : null,
      voidedAt: status === 'void' ? new Date('2026-03-01T03:00:00Z') : null,
      voidReason: status === 'void' ? 'seed void' : null,
      voidedByUserId: status === 'void' ? user.userId : null,
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก ปี 2026',
      descriptionEn: 'Membership 2026',
      unitPriceSatang: INVOICE_SUBTOTAL,
      totalSatang: INVOICE_SUBTOTAL,
      position: 1,
    });
  });
  return { invoiceId, memberId };
}

function makeDeps(tenantId: string): IssueCreditNoteDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    creditNoteRepo: makeDrizzleCreditNoteRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('b'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
      delete: vi.fn(async () => {}),
    },
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-04-18T10:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
    currentTemplateVersion: 1,
  };
}

describe('F4 US6 — credit-note partial accumulation + concurrent race (T075)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'cn-acc-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'CN Acc Plan' },
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
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'CNIT',
        creditNoteNumberPrefix: 'CN',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  beforeEach(async () => {
    // Wipe credit-notes + reset any invoice writes between cases so
    // each test seeds its own `paid` invoice cleanly.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.delete(creditNotes).where(eq(creditNotes.tenantId, tenant.ctx.slug));
      await tx.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug));
      await tx.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug));
      await tx.delete(members).where(eq(members.tenantId, tenant.ctx.slug));
    });
  });

  it('two partials sum-to-total flip paid → partially_credited → credited', async () => {
    const { invoiceId } = await seedInvoiceInStatus(tenant, user, planId, 'paid');
    const deps = makeDeps(tenant.ctx.slug);

    // First partial — 60% of total.
    const r1 = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: 64_200n, // 60%
      reason: 'Partial refund 1',
    });
    expect(r1.ok).toBe(true);

    // Invoice should be partially_credited.
    const [afterFirst] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: invoices.status,
          creditedTotalSatang: invoices.creditedTotalSatang,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(afterFirst?.status).toBe('partially_credited');
    expect(BigInt(afterFirst!.creditedTotalSatang as unknown as string)).toBe(64_200n);

    // Second partial — exactly the remainder (40%).
    const r2 = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: 42_800n,
      reason: 'Partial refund 2',
    });
    expect(r2.ok).toBe(true);

    const [afterSecond] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: invoices.status,
          creditedTotalSatang: invoices.creditedTotalSatang,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(afterSecond?.status).toBe('credited');
    expect(BigInt(afterSecond!.creditedTotalSatang as unknown as string)).toBe(
      INVOICE_TOTAL,
    );

    // Two credit_note rows with own sequence numbers.
    const cnRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ seq: creditNotes.sequenceNumber, doc: creditNotes.documentNumber })
        .from(creditNotes)
        .where(eq(creditNotes.tenantId, tenant.ctx.slug)),
    );
    expect(cnRows).toHaveLength(2);
    const seqs = cnRows.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2]);
  }, 60_000);

  it('rejects a third partial against a fully-credited invoice', async () => {
    const { invoiceId } = await seedInvoiceInStatus(tenant, user, planId, 'paid');
    const deps = makeDeps(tenant.ctx.slug);

    const r1 = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: INVOICE_TOTAL, // full
      reason: 'Full refund',
    });
    expect(r1.ok).toBe(true);

    // Attempt any further credit — rejected.
    const r2 = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: 1n,
      reason: 'should fail',
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      // Parent invoice is now 'credited' (terminal) → invalid_status
      expect(r2.error.code).toBe('invalid_status');
    }
  }, 60_000);

  it('rejects partial that exceeds remainder by 1 satang (no seq gap)', async () => {
    const { invoiceId } = await seedInvoiceInStatus(tenant, user, planId, 'paid');
    const deps = makeDeps(tenant.ctx.slug);

    const r = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: INVOICE_TOTAL + 1n,
      reason: 'over by 1',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('credit_exceeds_remainder');
      if (r.error.code === 'credit_exceeds_remainder') {
        expect(r.error.remainingSatang).toBe(INVOICE_TOTAL);
      }
    }

    // No credit-note row, no sequence consumed.
    const cnCount = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(creditNotes).where(eq(creditNotes.tenantId, tenant.ctx.slug)),
    );
    expect(cnCount).toHaveLength(0);
  }, 60_000);

  // US6 AS4 — credited-invoice PDF annotation. After a credit note is
  // issued, the parent invoice's PDF MUST be re-rendered with a
  // CREDITED / PARTIALLY CREDITED overlay + a footer listing the
  // referencing CN(s). The bytes differ from the original (annotation
  // occupies real estate), the Blob key is the SAME (content-addressed
  // at the original pdfBlobKey), and `pdf_sha256` on the invoice row
  // is updated to match. An `invoice_pdf_regenerated` audit row is
  // emitted alongside the `credit_note_issued` row.
  it('AS4 — CN rollup re-renders invoice PDF with annotation + emits invoice_pdf_regenerated audit', async () => {
    const { invoiceId } = await seedInvoiceInStatus(tenant, user, planId, 'paid');

    // Capture the original sha256 from the seeded invoice row.
    const [beforeRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ sha: invoices.pdfSha256, blobKey: invoices.pdfBlobKey })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    const originalSha = beforeRow!.sha;
    const originalBlobKey = beforeRow!.blobKey;

    // Spy on the blob adapter AND the audit emitter so we can assert:
    //   (a) CN PDF upload at a NEW key (allowOverwrite unset/false)
    //   (b) invoice re-render upload at the ORIGINAL key with
    //       allowOverwrite=true (review fix CR-1 — without this the
    //       upload silently no-ops and the DB sha drifts)
    //   (c) the re-rendered bytes differ from the seeded placeholder
    //   (d) invoice_pdf_regenerated audit row is emitted with the
    //       correct payload (original_sha256, new_sha256,
    //       triggered_by_credit_note_id)
    const captured: Array<{
      key: string;
      bytes: Uint8Array;
      allowOverwrite: boolean | undefined;
    }> = [];
    const auditEvents: Array<{ eventType: string; payload: unknown }> = [];
    const deps = makeDeps(tenant.ctx.slug);
    const originalUpload = deps.blob.uploadPdf;
    const blobSpy = {
      ...deps.blob,
      uploadPdf: vi.fn(async (input: Parameters<typeof originalUpload>[0]) => {
        captured.push({
          key: input.key,
          bytes: input.body as Uint8Array,
          allowOverwrite: input.allowOverwrite,
        });
        return originalUpload(input);
      }),
    };
    const originalAuditEmit = deps.audit.emit;
    const auditSpy = {
      emit: vi.fn(async (tx: unknown, evt: { eventType: string; payload: unknown }) => {
        auditEvents.push({ eventType: evt.eventType, payload: evt.payload });
        return originalAuditEmit(tx, evt as never);
      }),
    };
    const depsWithSpy = { ...deps, blob: blobSpy, audit: auditSpy };

    const r = await issueCreditNote(depsWithSpy, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: 53_500n, // 50% partial
      reason: 'AS4 annotation test',
    });
    expect(r.ok).toBe(true);

    // (a) + (b): two uploads — CN (new key, overwrite not required)
    //            + invoice re-render (original key, allowOverwrite=true)
    expect(captured.length).toBeGreaterThanOrEqual(2);
    const reRenderUpload = captured.find((c) => c.key === originalBlobKey);
    expect(reRenderUpload, 'invoice re-render upload at original key').toBeDefined();
    expect(
      reRenderUpload!.allowOverwrite,
      'CR-1: AS4 re-upload MUST set allowOverwrite=true',
    ).toBe(true);

    // (c): re-rendered bytes are non-empty (the mocked renderer
    // returns a fixed 4-byte magic, so we don't assert size here;
    // the allowOverwrite=true flag above + the sha256 change below
    // are the load-bearing correctness assertions for CR-1).
    expect(reRenderUpload!.bytes.byteLength).toBeGreaterThan(0);

    // sha256 on the invoice row differs from the original (annotation
    // was rendered and the row was updated via applyInvoicePdfRegeneration).
    const [afterRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          sha: invoices.pdfSha256,
          blobKey: invoices.pdfBlobKey,
          status: invoices.status,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(afterRow!.blobKey).toBe(originalBlobKey); // same key
    expect(afterRow!.sha).not.toBe(originalSha); // new bytes
    // Review I-6 — pin that the DB row's sha is the EXACT value the
    // render adapter produced (mock returns 'b'*64). This catches a
    // regression where `applyInvoicePdfRegeneration` writes the wrong
    // value (e.g. the CN's sha instead of the re-render's sha).
    expect(afterRow!.sha).toBe('b'.repeat(64));
    expect(afterRow!.status).toBe('partially_credited');

    // (d): audit trail — both `credit_note_issued` and
    // `invoice_pdf_regenerated` emitted, with the regeneration payload
    // carrying the before/after sha + triggered_by_credit_note_id.
    const regenEvent = auditEvents.find(
      (e) => e.eventType === 'invoice_pdf_regenerated',
    );
    expect(regenEvent, 'invoice_pdf_regenerated audit must be emitted').toBeDefined();
    const payload = regenEvent!.payload as Record<string, unknown>;
    expect(payload.original_sha256).toBe(originalSha);
    expect(payload.new_sha256).toBe(afterRow!.sha);
    expect(payload.new_sha256).toBe('b'.repeat(64)); // audit mirrors DB row
    expect(payload.reason).toBe('credit_note_annotation');
    expect(payload.triggered_by_credit_note_id).toBeDefined();

    const cnIssuedEvent = auditEvents.find((e) => e.eventType === 'credit_note_issued');
    expect(cnIssuedEvent, 'credit_note_issued audit must be emitted').toBeDefined();
  }, 60_000);

  // IM-1 (US6 AS3) — unpaid invoice is rejected with invalid_status.
  // The use-case's `lockedStatus !== 'paid' && !== 'partially_credited'`
  // guard covers draft / issued / voided / credited-terminal. Here
  // we test `issued` (unpaid) and `voided`; `draft` is blocked at the
  // DB (no `documentNumber`, would fail earlier), `credited` terminal
  // is already exercised in the "rejects a 3rd partial" test.
  it('AS3 — issued (unpaid) invoice → invalid_status, no CN written', async () => {
    const { invoiceId } = await seedInvoiceInStatus(tenant, user, planId, 'issued');
    const deps = makeDeps(tenant.ctx.slug);

    const r = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: 53_500n,
      reason: 'should be rejected',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_status');
      if (r.error.code === 'invalid_status') {
        expect(r.error.status).toBe('issued');
      }
    }
    const cnCount = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(creditNotes).where(eq(creditNotes.tenantId, tenant.ctx.slug)),
    );
    expect(cnCount).toHaveLength(0);
  }, 60_000);

  it('AS3 — voided invoice → invalid_status, no CN written', async () => {
    const { invoiceId } = await seedInvoiceInStatus(tenant, user, planId, 'void');
    const deps = makeDeps(tenant.ctx.slug);
    const r = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: 53_500n,
      reason: 'should be rejected',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_status');
  }, 60_000);

  // SG-3 — settings_missing branch. Delete the tenant_invoice_settings
  // row before calling the use-case; the initial getForIssue returns
  // null and the flow bails at the settings_missing check.
  it('SG-3 — settings_missing branch surfaces cleanly when settings row is absent', async () => {
    const { invoiceId } = await seedInvoiceInStatus(tenant, user, planId, 'paid');
    // Temporarily drop the settings row (we restore via beforeEach +
    // the top-level afterAll tenant teardown).
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .delete(tenantInvoiceSettings)
        .where(eq(tenantInvoiceSettings.tenantId, tenant.ctx.slug)),
    );
    const deps = makeDeps(tenant.ctx.slug);
    const r = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: 53_500n,
      reason: 'test',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('settings_missing');
    // Restore settings for subsequent tests (beforeEach only wipes
    // CN + invoice + lines + members; it does NOT reset settings).
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'CNIT',
        creditNoteNumberPrefix: 'CN',
      }),
    );
  }, 60_000);

  it('R2-E1 concurrent race — 2 admins issue 60% each; exactly one succeeds', async () => {
    const { invoiceId } = await seedInvoiceInStatus(tenant, user, planId, 'paid');
    // Separate deps per caller so the mock `vi.fn` instances don't share
    // pending-promise state between the two concurrent withTx flows.
    const depsA = makeDeps(tenant.ctx.slug);
    const depsB = makeDeps(tenant.ctx.slug);

    const [a, b] = await Promise.all([
      issueCreditNote(depsA, {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        invoiceId,
        creditTotalSatang: 64_200n, // 60%
        reason: 'admin-A 60%',
      }),
      issueCreditNote(depsB, {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        invoiceId,
        creditTotalSatang: 64_200n, // 60%
        reason: 'admin-B 60%',
      }),
    ]);

    // Exactly one succeeds, one rejects with credit_exceeds_remainder.
    const successCount = [a, b].filter((r) => r.ok).length;
    const failCount = [a, b].filter((r) => !r.ok).length;
    expect(successCount).toBe(1);
    expect(failCount).toBe(1);

    const loser = [a, b].find((r) => !r.ok);
    if (loser && !loser.ok) {
      expect(loser.error.code).toBe('credit_exceeds_remainder');
    }

    // Exactly one credit-note row for this invoice — the losing caller
    // never allocated a sequence number (no §87 gap). We don't pin
    // `seq=1` because earlier tests in this suite already consumed
    // credit_note sequence numbers for the same tenant; the
    // allocator's monotonicity is verified separately in
    // seq-number-atomicity.test.ts.
    const cnRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ seq: creditNotes.sequenceNumber })
        .from(creditNotes)
        .where(
          and(
            eq(creditNotes.tenantId, tenant.ctx.slug),
            eq(creditNotes.originalInvoiceId, invoiceId),
          ),
        ),
    );
    expect(cnRows).toHaveLength(1);
    expect(cnRows[0]?.seq).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
