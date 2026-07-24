/**
 * Bug 10 — void §86/4 PDF re-stamp reconcile cron (live Neon).
 *
 * Seeds a `void` invoice marked for reconcile (blob_upload-leg failure), then
 * drives the cron GET with a mocked render + blob adapter and asserts it
 * re-uploads the VOID overlay, syncs the sha, and clears the marker — plus the
 * corruption-park and auth branches.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const RESTAMP_SHA = 'f'.repeat(64);

vi.mock('@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter', () => ({
  reactPdfRenderAdapter: {
    render: vi.fn(async () => ({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x56]),
      // The domain Sha256Hex brand is a plain string at runtime.
      sha256: 'f'.repeat(64),
    })),
  },
}));
vi.mock('@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter', () => ({
  vercelBlobAdapter: {
    uploadPdf: vi.fn(async (input: { key: string }) => ({
      key: input.key,
      url: `https://blob.test/${input.key}`,
    })),
    signDownloadUrl: vi.fn(async (key: string) => `https://blob.test/${key}`),
    downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    delete: vi.fn(),
    list: vi.fn(async () => [] as string[]),
  },
}));

// Import AFTER the mocks so the route binds the mocked adapters.
const { GET: reconcileCron } = await import(
  '@/app/api/internal/cron/void-pdf-reconcile/route'
);
const { vercelBlobAdapter } = await import(
  '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter'
);
const { reactPdfRenderAdapter } = await import(
  '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter'
);

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
  legal_name: 'Void Reconcile Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
  member_number: null,
  member_number_display: null,
};

function cronReq(auth = `Bearer ${process.env.CRON_SECRET}`): NextRequest {
  return new NextRequest('http://localhost/api/internal/cron/void-pdf-reconcile', {
    headers: { authorization: auth },
  });
}

describe('void-pdf-reconcile cron (bug 10)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    planId = `vprc-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Void Reconcile Plan' },
        description: { en: 'Test' },
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
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  /** Seed a `void` invoice already marked for reconcile. */
  async function seedMarkedVoid(opts: {
    voidReason: string | null;
    attempts?: number;
    seq: number;
    /** When set, seed a PAID two-blob void (a distinct §86/4 receipt blob). */
    receipt?: { docNumberRaw: string };
  }): Promise<string> {
    const invoiceId = randomUUID();
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Void Reconcile Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'void',
        pdfDocKind: 'invoice',
        fiscalYear: 2026,
        sequenceNumber: opts.seq,
        documentNumber: `VPRC-2026-${String(opts.seq).padStart(6, '0')}`,
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
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}_v1.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        ...(opts.receipt
          ? {
              receiptPdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}_receipt.pdf`,
              receiptPdfSha256: 'c'.repeat(64),
              receiptPdfTemplateVersion: 1,
              receiptPdfStatus: 'rendered' as const,
              receiptDocumentNumberRaw: opts.receipt.docNumberRaw,
            }
          : { receiptPdfStatus: null }),
        voidedAt: new Date('2026-03-01T03:00:00Z'),
        voidReason: opts.voidReason,
        voidedByUserId: user.userId,
        voidPdfReconcilePendingAt: new Date('2026-03-01T03:05:00Z'),
        voidPdfReconcileAttempts: opts.attempts ?? 0,
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
    return invoiceId;
  }

  async function readMarker(invoiceId: string) {
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          pdfSha256: invoices.pdfSha256,
          receiptPdfSha256: invoices.receiptPdfSha256,
          pendingAt: invoices.voidPdfReconcilePendingAt,
          attempts: invoices.voidPdfReconcileAttempts,
          parkedAt: invoices.voidPdfReconcileParkedAt,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    return row;
  }

  it('D7 — 401 without a bearer, 500 on a misconfigured secret', async () => {
    const noAuth = await reconcileCron(cronReq(''));
    expect(noAuth.status).toBe(401);
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'short';
    const bad = await reconcileCron(cronReq('Bearer short'));
    expect(bad.status).toBe(500);
    process.env.CRON_SECRET = prev;
  });

  it('D1 — reconciles a marked void: re-uploads, syncs the sha, clears the marker', async () => {
    const invoiceId = await seedMarkedVoid({ voidReason: 'wrong tier', seq: 1 });
    (vercelBlobAdapter.uploadPdf as ReturnType<typeof vi.fn>).mockClear();

    const res = await reconcileCron(cronReq());
    expect(res.status).toBe(200);

    // The VOID-stamped bytes were re-uploaded at the content-addressed key.
    expect(vercelBlobAdapter.uploadPdf).toHaveBeenCalled();
    const row = await readMarker(invoiceId);
    // sha synced to the freshly-rendered value; marker cleared.
    expect(row?.pdfSha256).toBe(RESTAMP_SHA);
    expect(row?.pendingAt).toBeNull();
    expect(row?.attempts).toBe(0);
    expect(row?.parkedAt).toBeNull();

    // M1 — a 10-year `invoice_pdf_regenerated` forensic records the SERVED sha
    // (sha_cron), so the audit trail no longer disagrees with the blob (the
    // original void audit pinned sha_P1, which the blob_upload leg never served).
    const regen = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          newSha: sql<string>`${auditLog.payload}->>'new_sha256'`,
          reason: sql<string>`${auditLog.payload}->>'reason'`,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'invoice_pdf_regenerated'),
            sql`${auditLog.payload}->>'invoice_id' = ${invoiceId}`,
          ),
        ),
    );
    expect(regen).toHaveLength(1);
    expect(regen[0]?.newSha).toBe(RESTAMP_SHA);
    expect(regen[0]?.reason).toBe('void_pdf_reconcile');
  }, 60_000);

  // NOTE: the cron's corruption-PARK branch (null void_reason / no_snapshot) is
  // defensive-only — the DB CHECK `invoices_void_has_reason` forbids a void row
  // with a null reason, and every voided row carries its issue-time snapshots +
  // document number, so `buildVoidRenderTargets` never returns those on a legit
  // row. It is un-seedable through the constraint, so it stays untested-by-DB
  // (kept as a safety net for a future data-corruption bug).

  it('D2 — a re-upload failure bumps attempts + keeps the row pending (never parks)', async () => {
    const invoiceId = await seedMarkedVoid({
      voidReason: 'upload fails',
      attempts: 2,
      seq: 4,
    });
    (vercelBlobAdapter.uploadPdf as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('blob outage'),
    );

    const res = await reconcileCron(cronReq());
    expect(res.status).toBe(200);

    const row = await readMarker(invoiceId);
    expect(row?.attempts).toBe(3); // SQL-incremented
    expect(row?.pendingAt).not.toBeNull(); // still eligible — retries
    expect(row?.parkedAt).toBeNull(); // NEVER abandon a voided tax doc
    // Below the escalation threshold (3 < 5) → no alert yet.
    const alerts = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'pdf_render_permanently_failed'),
            sql`${auditLog.payload}->>'invoice_id' = ${invoiceId}`,
          ),
        ),
    );
    expect(alerts).toHaveLength(0);
  }, 60_000);

  it('D5 — idempotent under a double fire (re-render + sync + clear, no error)', async () => {
    const invoiceId = await seedMarkedVoid({ voidReason: 'double fire', seq: 3 });
    const r1 = await reconcileCron(cronReq());
    const r2 = await reconcileCron(cronReq());
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const row = await readMarker(invoiceId);
    expect(row?.pdfSha256).toBe(RESTAMP_SHA);
    expect(row?.pendingAt).toBeNull();
  }, 60_000);

  /** Seed a doomed `invoice_voided` auto-email row (pinned to the un-stamped
   *  sha_P1 the blob_upload leg never produced). */
  async function seedFailedVoidEmail(
    invoiceId: string,
    opts: { sha: string; status?: 'permanently_failed' | 'pending' | 'sent' },
  ): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.execute(sql`
        INSERT INTO notifications_outbox
          (tenant_id, notification_type, to_email, locale, context_data, status, attempts, next_retry_at)
        VALUES
          (${tenant.ctx.slug}, 'invoice_auto_email'::notification_type,
           'void.member@example.com', 'th',
           ${JSON.stringify({
             event_type: 'invoice_voided',
             invoice_id: invoiceId,
             credit_note_id: null,
             pdf_blob_key: `invoicing/${tenant.ctx.slug}/x.pdf`,
             pdf_template_version: 1,
             document_number: 'VPRC-DOOMED',
             void_reason: 'wrong tier',
             expected_pdf_sha256: opts.sha,
             depends_on_receipt_pdf: false,
             privacy_footer_kind: null,
           })}::jsonb,
           ${opts.status ?? 'permanently_failed'}::outbox_status, 5, now())
      `);
    });
  }

  async function voidEmailRows(
    invoiceId: string,
  ): Promise<Array<{ id: string; status: string; sha: string | null; to: string }>> {
    return runInTenant(tenant.ctx, (tx) =>
      tx.execute<{ id: string; status: string; sha: string | null; to: string }>(sql`
        SELECT id, status::text AS status,
               context_data->>'expected_pdf_sha256' AS sha,
               to_email AS "to"
          FROM notifications_outbox
         WHERE tenant_id = ${tenant.ctx.slug}
           AND notification_type = 'invoice_auto_email'::notification_type
           AND context_data->>'event_type' = 'invoice_voided'
           AND context_data->>'invoice_id' = ${invoiceId}
      `),
    );
  }

  it('D3 — escalation past the threshold PERSISTS a deduped alert (disposition=retrying)', async () => {
    const invoiceId = await seedMarkedVoid({
      voidReason: 'upload keeps failing',
      attempts: 4,
      seq: 5,
    });
    (vercelBlobAdapter.uploadPdf as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('blob outage'),
    );

    const res = await reconcileCron(cronReq());
    expect(res.status).toBe(200);

    const row = await readMarker(invoiceId);
    expect(row?.attempts).toBe(5); // 4 → 5, crosses ESCALATION_THRESHOLD
    expect(row?.pendingAt).not.toBeNull(); // still retrying — never abandoned

    // The null-tx audit emit inside runInTenant MUST persist (RLS resolves to
    // the row's tenant). This is the only signal a voided §86/4 is stuck.
    const alerts = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          disposition: sql<string>`${auditLog.payload}->>'disposition'`,
          attempts: sql<string>`${auditLog.payload}->>'attempts'`,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'pdf_render_permanently_failed'),
            sql`${auditLog.payload}->>'invoice_id' = ${invoiceId}`,
            sql`${auditLog.payload}->>'source' = 'cron.void_pdf_reconcile'`,
          ),
        ),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.disposition).toBe('escalated_retrying');
    expect(alerts[0]?.attempts).toBe('5');
  }, 60_000);

  it('D6 — re-enqueues the cancellation email on reconcile when the original was intended + failed', async () => {
    const invoiceId = await seedMarkedVoid({ voidReason: 'restamp + email', seq: 6 });
    // The original void email was pinned to the un-stamped sha and permanently
    // failed (blob_upload leg): the member never got the FR-036 notice.
    await seedFailedVoidEmail(invoiceId, { sha: 'a'.repeat(64) });

    const res = await reconcileCron(cronReq());
    expect(res.status).toBe(200);

    const rows = await voidEmailRows(invoiceId);
    // A FRESH pending row pinned to the freshly-uploaded sha_cron now exists.
    const fresh = rows.filter((r) => r.status === 'pending' && r.sha === RESTAMP_SHA);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.to).toBe('void.member@example.com'); // copied context
  }, 60_000);

  it('D6b — does NOT re-enqueue when no void email was ever intended (suppressed void)', async () => {
    const invoiceId = await seedMarkedVoid({ voidReason: 'suppressed', seq: 7 });
    // No outbox row seeded — a suppressed void-on-reissue never enqueued one.

    const res = await reconcileCron(cronReq());
    expect(res.status).toBe(200);

    const rows = await voidEmailRows(invoiceId);
    expect(rows).toHaveLength(0); // no spurious cancellation email
  }, 60_000);

  it('D6c — does NOT re-enqueue when a valid cancellation email already shipped (sent)', async () => {
    const invoiceId = await seedMarkedVoid({ voidReason: 'already sent', seq: 9 });
    // Ambiguous upload / two-blob-A-sent: the ORIGINAL already shipped a valid
    // VOID-stamped notice. Re-enqueuing would deliver a duplicate cancellation.
    await seedFailedVoidEmail(invoiceId, { sha: 'a'.repeat(64), status: 'sent' });

    const res = await reconcileCron(cronReq());
    expect(res.status).toBe(200);

    const rows = await voidEmailRows(invoiceId);
    // Still exactly the one sent row — NO fresh pending duplicate.
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(0);
    expect(rows.filter((r) => r.status === 'sent')).toHaveLength(1);
  }, 60_000);

  it('D6d — retires a still-pending doomed original + re-enqueues exactly one fresh row', async () => {
    const invoiceId = await seedMarkedVoid({ voidReason: 'pending doomed', seq: 10 });
    // The original is still pending (byte-deterministic template / dispatcher
    // lag): it must be retired so it cannot ALSO ship alongside the fresh row.
    await seedFailedVoidEmail(invoiceId, { sha: 'a'.repeat(64), status: 'pending' });

    const res = await reconcileCron(cronReq());
    expect(res.status).toBe(200);

    const rows = await voidEmailRows(invoiceId);
    const pending = rows.filter((r) => r.status === 'pending');
    expect(pending).toHaveLength(1); // exactly one send-able row
    expect(pending[0]?.sha).toBe(RESTAMP_SHA); // the fresh sha_cron row
    // The doomed original was retired → never ships a second copy.
    expect(rows.filter((r) => r.status === 'permanently_failed')).toHaveLength(1);
  }, 60_000);

  it('D9 — concurrent ticks re-enqueue the cancellation email exactly once', async () => {
    const invoiceId = await seedMarkedVoid({ voidReason: 'concurrent ticks', seq: 11 });
    await seedFailedVoidEmail(invoiceId, { sha: 'a'.repeat(64) }); // permanently_failed

    // Two ticks race: both scan the pending row, both take lockForUpdate. The
    // loser's under-lock marker re-check must see pendingAt=null and skip — no
    // second upload, no duplicate re-enqueue.
    const [r1, r2] = await Promise.all([
      reconcileCron(cronReq()),
      reconcileCron(cronReq()),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const rows = await voidEmailRows(invoiceId);
    expect(
      rows.filter((r) => r.status === 'pending' && r.sha === RESTAMP_SHA),
    ).toHaveLength(1);
    const marker = await readMarker(invoiceId);
    expect(marker?.pendingAt).toBeNull();
  }, 60_000);

  it('D10 — two-blob paid void re-stamps BOTH the §86/4 + §105 receipt, one M1 per target', async () => {
    const invoiceId = await seedMarkedVoid({
      voidReason: 'two blob',
      seq: 12,
      receipt: { docNumberRaw: 'VPRC-2026-000912' },
    });
    (vercelBlobAdapter.uploadPdf as ReturnType<typeof vi.fn>).mockClear();

    const res = await reconcileCron(cronReq());
    expect(res.status).toBe(200);

    // BOTH the main §86/4 blob AND the separate §105 receipt blob re-uploaded.
    expect(vercelBlobAdapter.uploadPdf).toHaveBeenCalledTimes(2);
    const row = await readMarker(invoiceId);
    expect(row?.pdfSha256).toBe(RESTAMP_SHA); // main sha synced
    expect(row?.receiptPdfSha256).toBe(RESTAMP_SHA); // receipt sha synced
    expect(row?.pendingAt).toBeNull(); // marker cleared

    // One invoice_pdf_regenerated per target, each labelled with ITS OWN number.
    const regen = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          target: sql<string>`${auditLog.payload}->>'target'`,
          num: sql<string>`${auditLog.payload}->>'invoice_number'`,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'invoice_pdf_regenerated'),
            sql`${auditLog.payload}->>'invoice_id' = ${invoiceId}`,
          ),
        ),
    );
    expect(regen).toHaveLength(2);
    const byTarget = Object.fromEntries(regen.map((r) => [r.target, r.num]));
    expect(byTarget.invoice).toBe('VPRC-2026-000012'); // main §86/4 number
    expect(byTarget.receipt).toBe('VPRC-2026-000912'); // RC — its OWN number
  }, 60_000);

  it('D8 — a hung blob upload times out + bumps (never holds the row lock forever)', async () => {
    const prev = process.env.VOID_RECONCILE_UPLOAD_TIMEOUT_MS;
    process.env.VOID_RECONCILE_UPLOAD_TIMEOUT_MS = '300';
    const invoiceId = await seedMarkedVoid({ voidReason: 'hung upload', seq: 8 });
    // Upload hangs ~2s; the 300ms timeout must fire first, roll back the tx,
    // release the lock, and let the catch bump attempts.
    (vercelBlobAdapter.uploadPdf as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ key: 'k', url: 'u' }), 2000),
        ),
    );

    const started = Date.now();
    const res = await reconcileCron(cronReq());
    const elapsed = Date.now() - started;
    process.env.VOID_RECONCILE_UPLOAD_TIMEOUT_MS = prev;

    expect(res.status).toBe(200);
    // Returned well before the 2s hang would have completed.
    expect(elapsed).toBeLessThan(1800);
    const row = await readMarker(invoiceId);
    expect(row?.attempts).toBe(1); // timeout → throw → catch → bump
    expect(row?.pendingAt).not.toBeNull();
  }, 60_000);

  // ── Two-blob (paid §86/4 + §105 receipt) FAILURE legs ────────────────────
  // H1 refuses a void-of-paid-membership, so the two-blob VOID-stamp path is now
  // reachable ONLY here — the cron re-rendering LEGACY pre-H1 voided-paid rows.
  // The deleted void-invoice unit tests "e2" (receipt render fail) + "e4"
  // (Phase-2 receipt upload fail) covered that path on the (now-refused)
  // use-case; D11/D12 restore that coverage through the surviving cron entry
  // point. D10 above is the two-blob HAPPY path; these are its failure legs.

  it('D11 — two-blob void: a receipt (targetB) UPLOAD failure rolls back BOTH sha syncs, bumps, stays pending (all-or-nothing per tick)', async () => {
    // Mirrors the deleted "e4" (Phase-2 receipt upload failure) — but the cron's
    // semantic is STRICTER: both targets sync inside ONE tx, so a targetB upload
    // failure ALSO rolls back targetA's sha sync (never signal "stamped" while
    // the receipt copy is still un-stamped). See route § "All-or-nothing per tick".
    const invoiceId = await seedMarkedVoid({
      voidReason: 'two-blob receipt upload fails',
      seq: 13,
      attempts: 1,
      receipt: { docNumberRaw: 'VPRC-2026-000913' },
    });
    const upload = vercelBlobAdapter.uploadPdf as ReturnType<typeof vi.fn>;
    upload.mockClear();
    // Key-based (contamination-proof regardless of scan order): the main §86/4
    // blob (`_v1.pdf`) uploads fine; the separate §86/4 receipt blob
    // (`_receipt.pdf` — targetB) throws.
    upload.mockImplementation(async (i: { key: string }) => {
      if (i.key.includes('_receipt.pdf')) throw new Error('receipt blob outage');
      return { key: i.key, url: `https://blob.test/${i.key}` };
    });
    try {
      const res = await reconcileCron(cronReq());
      expect(res.status).toBe(200);

      const row = await readMarker(invoiceId);
      // All-or-nothing: targetA's sha sync REVERTED with targetB's — NEITHER the
      // main nor the receipt sha advanced to the freshly-rendered value.
      expect(row?.pdfSha256).toBe('a'.repeat(64)); // main sha unchanged (rolled back)
      expect(row?.receiptPdfSha256).toBe('c'.repeat(64)); // receipt sha never synced
      expect(row?.attempts).toBe(2); // 1 → 2 (catch-block bump in a fresh tx)
      expect(row?.pendingAt).not.toBeNull(); // still retrying — never abandoned
      expect(row?.parkedAt).toBeNull(); // NEVER park a voided tax doc
    } finally {
      // Restore the default success impl so no later test inherits the failure.
      upload.mockImplementation(async (i: { key: string }) => ({
        key: i.key,
        url: `https://blob.test/${i.key}`,
      }));
    }
  }, 60_000);

  it('D12 — two-blob void: a receipt (targetB) RENDER failure → pdf_render_failed bumps, stays pending, never parks, no sha advance', async () => {
    // Mirrors the deleted "e2" (Target B receipt render failure).
    // buildVoidRenderTargets renders targetA (main §86/4) then targetB
    // (receipt_combined); a targetB render throw surfaces as pdf_render_failed →
    // the cron BUMPS (a possibly-transient render fault) and keeps the row
    // pending — a voided tax doc is never parked on a transient render error.
    // Also covers the otherwise-untested pdf_render_failed bump leg (route
    // `!built.ok` branch), distinct from the upload-throw catch leg (D2/D8/D11).
    const invoiceId = await seedMarkedVoid({
      voidReason: 'two-blob receipt render fails',
      seq: 14,
      receipt: { docNumberRaw: 'VPRC-2026-000914' },
    });
    const render = reactPdfRenderAdapter.render as ReturnType<typeof vi.fn>;
    // Kind-based (contamination-proof): targetA (voidUnderlyingKind='invoice')
    // renders fine; targetB (voidUnderlyingKind='receipt_combined') throws.
    render.mockImplementation(async (input: { voidUnderlyingKind?: string }) => {
      if (input.voidUnderlyingKind === 'receipt_combined') {
        throw new Error('receipt render boom');
      }
      return {
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x56]),
        sha256: 'f'.repeat(64),
      };
    });
    try {
      const res = await reconcileCron(cronReq());
      expect(res.status).toBe(200);

      const row = await readMarker(invoiceId);
      // Render failed BEFORE any upload/sync — neither sha advanced.
      expect(row?.pdfSha256).toBe('a'.repeat(64));
      expect(row?.receiptPdfSha256).toBe('c'.repeat(64));
      expect(row?.attempts).toBe(1); // 0 → 1 (pdf_render_failed bump)
      expect(row?.pendingAt).not.toBeNull(); // retries — never abandoned
      expect(row?.parkedAt).toBeNull(); // pdf_render_failed is NOT parked (only null_reason / no_snapshot park)
    } finally {
      // Restore the default success render impl.
      render.mockImplementation(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x56]),
        sha256: 'f'.repeat(64),
      }));
    }
  }, 60_000);
});
