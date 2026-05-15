/**
 * T105 — F4 auto-email outbox integration test (Phase 10).
 *
 * Verifies the end-to-end outbox enqueue contract on live Neon for the
 * subset of T105 that directly exercises the T107 manual-resend path +
 * the issue-invoice outbox enqueue it rides on:
 *
 *   (1) issue-invoice enqueues one `invoice_auto_email` outbox row with
 *       event_type=invoice_issued when `auto_email_enabled` is true on
 *       tenant settings. (T105 scenario 1 — issue enqueue.)
 *
 *   (4a) manual admin resend produces a FRESH outbox row with
 *        event_type=invoice_pdf_resent distinct from the issue row, plus
 *        a matching `invoice_pdf_resent` audit event carrying
 *        `member_id` (US7 / FR-033). (T105 scenario 4 — manual resend.)
 *
 *   (4b) manual admin resend of the RECEIPT variant after recordPayment
 *        produces a `receipt_pdf_resent` outbox + audit row, and the
 *        audit payload does NOT carry `member_id` (operational-duplicate
 *        rule — `invoice_paid` already surfaces on the member timeline).
 *
 *   (4c) portal-role member-ownership mismatch → no outbox row, no
 *        `invoice_pdf_resent` audit, but an `invoice_cross_tenant_probe`
 *        audit lands. Collapses to opaque not_found so sibling-member
 *        enumeration is not possible.
 *
 * T105 scenarios 2 (Resend-failure-no-rollback) + 3 (bounce webhook)
 * are deferred — scenario 2 is covered by the unit-level tests inside
 * issue-invoice.test.ts + record-payment.test.ts (throw-in-outbox
 * rolls back via `err(...)`) and scenario 3 requires the bounce-webhook
 * route which is not shipped in the T107 slice.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { db, runInTenant } from '@/lib/db';
import { auditLog, notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { GET as outboxDispatch } from '@/app/api/cron/outbox-dispatch/route';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import {
  resendPdf,
  makeResendPdfDeps,
} from '@/modules/invoicing';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { RecordPaymentDeps } from '@/modules/invoicing/application/use-cases/record-payment';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { resendEmailOutboxAdapter } from '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter';
import { vercelBlobAdapter } from '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { env } from '@/lib/env';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

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
  const planId = 't105-plan';
  const planYear = 2026;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear,
      planName: { en: 'T105 Plan' },
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
      registrationFeeSatang: 0n,
      legalNameTh: 'ทดสอบ',
      legalNameEn: 'Test',
      taxId: '0000000000000',
      registeredAddressTh: 'Bangkok',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'T105',
      creditNoteNumberPrefix: 'T105C',
      // Auto-email MUST be ON so the issue path enqueues the initial
      // outbox row the (1) assertion relies on.
      autoEmailEnabled: true,
      // Separate-mode so recordPayment creates a distinct receiptPdf,
      // which the (4b) "resend receipt" assertion requires.
      receiptNumberingMode: 'separate',
    });
  });

  const memberId = randomUUID();
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: 'T105 Test Co',
      country: 'TH',
      planId,
      planYear,
      // Primary contact email lives on `contacts` (separate table);
      // the mocked `memberIdentity.getForIssue` below supplies the
      // snapshot that lands on the invoice row at issue time, so the
      // resend flow has a deliverable address without inserting a
      // real contact row.
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
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: `ค่าสมาชิก ปี ${planYear}`,
      descriptionEn: `Membership ${planYear}`,
      unitPriceSatang: 1_000_000n,
      totalSatang: 1_000_000n,
      position: 1,
    });
  });
  return invoiceId;
}

function makeIssueDeps(tenant: TestTenant): IssueInvoiceDeps {
  // Same pattern as seq-number-atomicity.test.ts: mock expensive
  // PDF/Blob adapters so the test stays in-memory; BUT keep the REAL
  // audit + outbox adapters so the assertion surface (audit_log +
  // notifications_outbox rows) lands on live Neon. The scenarios here
  // specifically want to observe those rows.
  const settingsView: TenantInvoiceSettingsView = {
    tenantId: tenant.ctx.slug,
    currencyCode: 'THB',
    vatRate: VatRate.ofUnsafe('0.0700'),
    registrationFeeSatang: 0n,
    invoiceNumberPrefix: 'T105',
    creditNoteNumberPrefix: 'T105C',
    receiptNumberingMode: 'separate',
    fiscalYearStartMonth: 1,
    defaultNetDays: 30,
    proRatePolicy: 'monthly',
    autoEmailEnabled: true,
    identity: {
      legal_name_th: 'ทดสอบ',
      legal_name_en: 'Test',
      tax_id: '0000000000000',
      address_th: 'Bangkok',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
  };
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenant.ctx.slug),
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
          legal_name: 'T105 Test Co',
          tax_id: '1234567890123',
          address: 'Bangkok',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'recipient@t105.test',
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
    // REAL audit + outbox adapters — the test asserts rows they emit.
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-04-18T10:00:00Z' },
    outbox: resendEmailOutboxAdapter,
    currentTemplateVersion: 1,
  };
}

function makePaymentDeps(tenant: TestTenant): RecordPaymentDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenant.ctx.slug),
    tenantSettingsRepo: makeIssueDeps(tenant).tenantSettingsRepo,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: makeIssueDeps(tenant).pdfRender,
    blob: makeIssueDeps(tenant).blob,
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-04-20T10:00:00Z' },
    outbox: resendEmailOutboxAdapter,
    memberIdentity: makeIssueDeps(tenant).memberIdentity,
    currentTemplateVersion: 1,
  };
}

describe('T105 — F4 auto-email outbox + T107 manual resend (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('(1) + (4a) issue enqueues invoice_auto_email[invoice_issued]; admin resend adds fresh invoice_pdf_resent row + timeline audit', async () => {
    const seed = await seedTenantForIssuance(tenant, user);
    const draftId = await insertDraft(
      tenant,
      user,
      seed.memberId,
      seed.planId,
      seed.planYear,
    );

    // --- (1) Issue ---
    const issueDeps = makeIssueDeps(tenant);
    const issueResult = await issueInvoice(issueDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: 't105-req-1',
      invoiceId: draftId,
    });
    expect(issueResult.ok).toBe(true);

    const afterIssueOutbox = await db
      .select()
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          eq(notificationsOutbox.notificationType, 'invoice_auto_email'),
        ),
      );
    expect(afterIssueOutbox.length).toBeGreaterThanOrEqual(1);
    const issueOutbox = afterIssueOutbox.find(
      (r) => (r.contextData as Record<string, unknown>).event_type === 'invoice_issued',
    );
    expect(issueOutbox).toBeDefined();
    expect(issueOutbox!.toEmail).toBe('recipient@t105.test');

    // --- (4a) Admin resend invoice variant ---
    const resendResult = await resendPdf(
      makeResendPdfDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        kind: 'invoice',
        invoiceId: draftId,
        variant: 'invoice',
        actor: {
          userId: user.userId,
          role: 'admin',
          requestId: 't105-req-2',
        },
      },
    );
    expect(resendResult.ok).toBe(true);

    const resendOutbox = await db
      .select()
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          eq(notificationsOutbox.notificationType, 'invoice_auto_email'),
        ),
      );
    const resendRow = resendOutbox.find(
      (r) =>
        (r.contextData as Record<string, unknown>).event_type ===
        'invoice_pdf_resent',
    );
    expect(resendRow, 'expected a fresh invoice_pdf_resent outbox row').toBeDefined();
    expect(resendRow!.id).not.toBe(issueOutbox!.id);
    // Pinned template version carries through (R3-E4 — no render drift).
    expect(
      (resendRow!.contextData as Record<string, unknown>).pdf_template_version,
    ).toBe(1);

    const resendAudit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_pdf_resent'),
        ),
      );
    expect(resendAudit.length).toBeGreaterThanOrEqual(1);
    const matchingAudit = resendAudit.find(
      (r) => (r.payload as Record<string, unknown>).invoice_id === draftId,
    );
    expect(matchingAudit).toBeDefined();
    // US7 / FR-033 — member_id on the payload so the F3 timeline
    // surfaces the event under the invoice's owner.
    expect((matchingAudit!.payload as Record<string, unknown>).member_id).toBe(
      seed.memberId,
    );
  }, 120_000);

  it('(4b) resend receipt after recordPayment → receipt_pdf_resent outbox + audit WITHOUT member_id', async () => {
    const freshTenant = await createTestTenant('test-swecham');
    try {
      const seed = await seedTenantForIssuance(freshTenant, user);
      const draftId = await insertDraft(
        freshTenant,
        user,
        seed.memberId,
        seed.planId,
        seed.planYear,
      );
      const issueDeps = makeIssueDeps(freshTenant);
      const issueR = await issueInvoice(issueDeps, {
        tenantId: freshTenant.ctx.slug,
        actorUserId: user.userId,
        requestId: null,
        invoiceId: draftId,
      });
      expect(issueR.ok).toBe(true);

      // Pay to create a separate-mode receipt PDF on the invoice row.
      const payR = await recordPayment(makePaymentDeps(freshTenant), {
        tenantId: freshTenant.ctx.slug,
        actorUserId: user.userId,
        requestId: null,
        invoiceId: draftId,
        paymentMethod: 'bank_transfer',
        paymentDate: '2026-04-20',
        paymentReference: 'TXN-T105',
      });
      expect(payR.ok).toBe(true);

      const resendR = await resendPdf(
        makeResendPdfDeps(freshTenant.ctx.slug),
        {
          tenantId: freshTenant.ctx.slug,
          kind: 'invoice',
          invoiceId: draftId,
          variant: 'receipt',
          actor: {
            userId: user.userId,
            role: 'admin',
            requestId: null,
          },
        },
      );
      expect(resendR.ok).toBe(true);

      const receiptOutbox = await db
        .select()
        .from(notificationsOutbox)
        .where(
          and(
            eq(notificationsOutbox.tenantId, freshTenant.ctx.slug),
            eq(notificationsOutbox.notificationType, 'invoice_auto_email'),
          ),
        );
      const receiptRow = receiptOutbox.find(
        (r) =>
          (r.contextData as Record<string, unknown>).event_type ===
          'receipt_pdf_resent',
      );
      expect(receiptRow, 'expected a receipt_pdf_resent outbox row').toBeDefined();

      const receiptAudit = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, freshTenant.ctx.slug),
            eq(auditLog.eventType, 'receipt_pdf_resent'),
          ),
        );
      expect(receiptAudit.length).toBeGreaterThanOrEqual(1);
      // Operational-duplicate rule: receipt_pdf_resent intentionally
      // does NOT carry member_id (would double-render on the F3
      // timeline alongside invoice_paid).
      for (const row of receiptAudit) {
        expect((row.payload as Record<string, unknown>).member_id).toBeUndefined();
      }
    } finally {
      await freshTenant.cleanup().catch(() => {});
    }
  }, 120_000);

  it('(T106 dual-emit) dispatcher perm-fails F4 invoice_auto_email → emits BOTH email_dispatch_failed AND auto_email_delivery_failed', async () => {
    const freshTenant = await createTestTenant('test-swecham');
    // S2 — `vi.stubEnv` is preferred over manual `process.env` mutation:
    // it isolates the change to this test and auto-restores via
    // Vitest's `afterEach`, eliminating the leak risk if a concurrent
    // test or the `finally` block is skipped.
    vi.stubEnv('CRON_SECRET', 'test-t106-dual-emit-secret');
    const seededIds: string[] = [];
    try {
      // Seed an invoice_auto_email row at attempts=4 (next increment =
      // MAX_ATTEMPTS=5 → permanent) with context_data shaped so
      // `buildPayload` returns null (missing `pdf_blob_key` → the F4
      // branch's null-guard triggers no_template_handler → permanent).
      const outboxId = randomUUID();
      const pastTs = new Date(Date.now() - 60_000);
      await db.insert(notificationsOutbox).values({
        id: outboxId,
        tenantId: freshTenant.ctx.slug,
        notificationType: 'invoice_auto_email',
        toEmail: `t106-${outboxId.slice(0, 8)}@swecham.test`,
        locale: 'en',
        // event_type present but pdf_blob_key missing → buildPayload null.
        contextData: { event_type: 'invoice_issued', pdf_blob_key: '' },
        status: 'pending',
        attempts: 4,
        nextRetryAt: pastTs,
      });
      seededIds.push(outboxId);

      const req = new NextRequest('http://localhost/api/cron/outbox-dispatch', {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
      const response = await outboxDispatch(req);
      expect(response.status).toBe(200);

      // Row flipped to permanently_failed.
      const [row] = await db
        .select()
        .from(notificationsOutbox)
        .where(eq(notificationsOutbox.id, outboxId));
      expect(row?.status).toBe('permanently_failed');
      expect(row?.attempts).toBe(5);

      // BOTH audit rows land in the tenant's audit log.
      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, freshTenant.ctx.slug));
      const eventTypes = auditRows.map((r) => r.eventType);
      expect(eventTypes).toContain('email_dispatch_failed');
      expect(eventTypes).toContain('auto_email_delivery_failed');

      // F4-specific row references the outbox row id for forensic
      // correlation + carries the `reason` classification.
      const f4Row = auditRows.find(
        (r) => r.eventType === 'auto_email_delivery_failed',
      );
      expect(f4Row).toBeDefined();
      expect((f4Row!.payload as Record<string, unknown>).outbox_row_id).toBe(
        outboxId,
      );
      expect((f4Row!.payload as Record<string, unknown>).reason).toBe(
        'no_template_handler',
      );
    } finally {
      for (const id of seededIds) {
        await db.delete(notificationsOutbox).where(eq(notificationsOutbox.id, id));
      }
      vi.unstubAllEnvs();
      await freshTenant.cleanup().catch(() => {});
    }
  }, 120_000);

  it('(4c) portal member-mismatch → no outbox row, probe audit lands, opaque not_found', async () => {
    const freshTenant = await createTestTenant('test-swecham');
    try {
      const seed = await seedTenantForIssuance(freshTenant, user);
      const draftId = await insertDraft(
        freshTenant,
        user,
        seed.memberId,
        seed.planId,
        seed.planYear,
      );
      const issueDeps = makeIssueDeps(freshTenant);
      const issueR = await issueInvoice(issueDeps, {
        tenantId: freshTenant.ctx.slug,
        actorUserId: user.userId,
        requestId: null,
        invoiceId: draftId,
      });
      expect(issueR.ok).toBe(true);

      // Count outbox + audit BEFORE the mismatched resend so we can
      // assert the mismatched attempt did NOT enqueue anything.
      const outboxBefore = await db
        .select()
        .from(notificationsOutbox)
        .where(
          and(
            eq(notificationsOutbox.tenantId, freshTenant.ctx.slug),
            eq(notificationsOutbox.notificationType, 'invoice_auto_email'),
          ),
        );

      const resendR = await resendPdf(
        makeResendPdfDeps(freshTenant.ctx.slug),
        {
          tenantId: freshTenant.ctx.slug,
          kind: 'invoice',
          invoiceId: draftId,
          variant: 'invoice',
          actor: {
            userId: 'u-attacker',
            role: 'member',
            memberId: 'attacker-member-id',
            requestId: 'probe-req',
          },
        },
      );
      expect(resendR.ok).toBe(false);
      if (!resendR.ok) expect(resendR.error.code).toBe('not_found');

      const outboxAfter = await db
        .select()
        .from(notificationsOutbox)
        .where(
          and(
            eq(notificationsOutbox.tenantId, freshTenant.ctx.slug),
            eq(notificationsOutbox.notificationType, 'invoice_auto_email'),
          ),
        );
      expect(outboxAfter.length).toBe(outboxBefore.length);

      const probe = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, freshTenant.ctx.slug),
            eq(auditLog.eventType, 'invoice_cross_tenant_probe'),
          ),
        );
      expect(probe.length).toBeGreaterThanOrEqual(1);
      const matching = probe.find(
        (r) => (r.payload as Record<string, unknown>).actor_role === 'member',
      );
      expect(matching).toBeDefined();
    } finally {
      await freshTenant.cleanup().catch(() => {});
    }
  }, 120_000);

  it('(R18-01) dispatcher permanently-fails invoice_voided row when prefetched bytes sha256 mismatches expected_pdf_sha256', async () => {
    // Covers the R17-02 fix: the void two-phase commit's Phase 2 (post-
    // commit Blob overwrite) can fail while Phase 1 (DB commit + outbox
    // enqueue + audit) already landed. The dispatcher MUST verify the
    // prefetched PDF bytes match the sha256 committed by Phase 1 before
    // attaching — otherwise it would ship the ORIGINAL un-stamped
    // invoice bytes as a "cancellation" attachment.
    const freshTenant = await createTestTenant('test-swecham');
    vi.stubEnv('CRON_SECRET', 'test-r18-01-sha-mismatch-secret');

    // `env.features` is `as const` at the type level but NOT Object.frozen
    // at runtime (env.ts builds it as a plain object literal), so a direct
    // assignment + finally-restore is both sufficient and the only way to
    // flip the DPA-gated flag from a single-test scope without
    // `vi.mock('@/lib/env')` which would affect every other test in this
    // file. Cast through a local mutable alias so TS accepts the write.
    const originalFlag = env.features.f4VoidAttachment;
    (env.features as { f4VoidAttachment: boolean }).f4VoidAttachment = true;

    // Stub downloadBytes so the sha of prefetched bytes does NOT match
    // the `expected_pdf_sha256` we put in context_data → triggers the
    // integrity-violation branch. The real adapter hits Vercel Blob;
    // bypassing that keeps the test deterministic + offline-safe.
    const fakeBytes = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const downloadSpy = vi
      .spyOn(vercelBlobAdapter, 'downloadBytes')
      .mockResolvedValue(fakeBytes);

    const seededIds: string[] = [];
    try {
      // 64-hex-lowercase sha that definitely does not match sha(fakeBytes).
      const wrongSha = 'f'.repeat(64);
      const outboxId = randomUUID();
      await db.insert(notificationsOutbox).values({
        id: outboxId,
        tenantId: freshTenant.ctx.slug,
        notificationType: 'invoice_auto_email',
        toEmail: `r18-${outboxId.slice(0, 8)}@swecham.test`,
        locale: 'en',
        contextData: {
          event_type: 'invoice_voided',
          pdf_blob_key: `invoicing/${freshTenant.ctx.slug}/2026/fake.pdf`,
          pdf_template_version: 1,
          document_number: 'T105-2026-000001',
          // Deliberately wrong → must drive the dispatcher into the
          // permanent-fail branch instead of sending.
          expected_pdf_sha256: wrongSha,
          void_reason: 'test r18-01',
        },
        status: 'pending',
        attempts: 0,
        nextRetryAt: new Date(Date.now() - 60_000),
      });
      seededIds.push(outboxId);

      const req = new NextRequest('http://localhost/api/cron/outbox-dispatch', {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
      const response = await outboxDispatch(req);
      expect(response.status).toBe(200);

      // Prefetch path fired (integrity check only runs when it does).
      expect(downloadSpy).toHaveBeenCalled();

      // Row permanently failed with the distinct integrity-violation
      // reason — NOT 'max_retries' or 'no_template_handler'.
      const [row] = await db
        .select()
        .from(notificationsOutbox)
        .where(eq(notificationsOutbox.id, outboxId));
      expect(row?.status).toBe('permanently_failed');
      expect(row?.lastError).toBe('attachment_sha_mismatch');
      expect(row?.attempts).toBe(1);

      // Dual audit emission scoped to THIS row (we filter by
      // `outbox_row_id` so parallel T106 tests' audit rows don't
      // pollute the assertion).
      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, freshTenant.ctx.slug));
      const perms = auditRows.filter(
        (r) =>
          (r.payload as Record<string, unknown>).outbox_row_id === outboxId,
      );
      const eventTypes = perms.map((r) => r.eventType);
      expect(eventTypes).toContain('email_dispatch_failed');
      expect(eventTypes).toContain('auto_email_delivery_failed');

      const f4Row = perms.find(
        (r) => r.eventType === 'auto_email_delivery_failed',
      );
      expect(f4Row).toBeDefined();
      expect((f4Row!.payload as Record<string, unknown>).reason).toBe(
        'attachment_sha_mismatch',
      );
      expect((f4Row!.payload as Record<string, unknown>).outbox_row_id).toBe(
        outboxId,
      );

      // Generic row carries the same reason (label-parity so dashboards
      // can slice either event type on reason without a JOIN).
      const genericRow = perms.find(
        (r) => r.eventType === 'email_dispatch_failed',
      );
      expect(genericRow).toBeDefined();
      expect((genericRow!.payload as Record<string, unknown>).reason).toBe(
        'attachment_sha_mismatch',
      );
    } finally {
      downloadSpy.mockRestore();
      (env.features as { f4VoidAttachment: boolean }).f4VoidAttachment = originalFlag;
      for (const id of seededIds) {
        await db.delete(notificationsOutbox).where(eq(notificationsOutbox.id, id));
      }
      vi.unstubAllEnvs();
      await freshTenant.cleanup().catch(() => {});
    }
  }, 120_000);
});
