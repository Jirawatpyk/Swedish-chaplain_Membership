/**
 * 088 US8 UX-B1 (T061e) — live-Neon proof of the OPTIONAL cert-scan attach flow.
 *
 *   1. `uploadZeroRateCert` (mock scanner=clean + mock blob) → a deterministic
 *      tenant/invoice-scoped blob key.
 *   2. `issueInvoice` zero-rated WITH that blob key → the row pins
 *      `zero_rate_cert_blob_key` (real repo/allocator/audit; PDF+Blob mocked).
 *   3. The pinned key is IMMUTABLE — a post-issue UPDATE is blocked by the 0234
 *      `invoices_enforce_immutability` trigger.
 *   4. `getZeroRateCertSignedUrl` (real repo + mock blob sign) returns a URL +
 *      filename for the pinned key.
 *
 * Zero-rate is a NON-membership sale, so the buyer is a non-member EVENT draft
 * with a TIN (→ bill→receipt flow, not §105 as-paid). Migrations 0230→0234 MUST
 * be applied to the `dev` Neon branch first.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { uploadZeroRateCert } from '@/modules/invoicing/application/use-cases/upload-zero-rate-cert';
import { getZeroRateCertSignedUrl } from '@/modules/invoicing/application/use-cases/get-zero-rate-cert-signed-url';
import {
  makeCreateEventInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeGetZeroRateCertSignedUrlDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const FIXED_NOW = '2026-07-02T09:00:00.000Z';
const CERT_NO = 'กต 0404/5678';
const CERT_DATE = '2026-04-01';

/** Mock PDF render + Blob upload for the issue step (we only assert the DB pin). */
function issueDeps(slug: string): IssueInvoiceDeps {
  return {
    ...makeIssueInvoiceDeps(slug),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: 'on',
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
        key,
        url: `https://blob.test/${key}`,
      })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(async () => {}),
      list: vi.fn(),
    },
  };
}

const TIN_BUYER = {
  legal_name: 'Embassy of Sweden (Simulated)',
  tax_id: '0994000000001',
  address: '1 Wireless Rd, Bangkok',
  primary_contact_name: 'Sim Attaché',
  primary_contact_email: 'sim.cert@zr-embassy.test',
} as const;

describe('088 US8 UX-B1 — cert-scan attach → pin → immutable → cert-view (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let eventId: string;
  let regId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    eventId = randomUUID();
    regId = randomUUID();

    await seedTenantFiscal({
      tenant,
      legalNameTh: 'หอการค้าไทย-สวีเดน',
      legalNameEn: 'Thailand-Swedish Chamber of Commerce',
      registeredAddressTh: 'กรุงเทพฯ',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: `evt-cert-${eventId.slice(0, 8)}`,
        name: 'Embassy Expo Booth (cert)',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        eventId,
        registrationId: regId,
        externalId: `att-cert-${regId.slice(0, 8)}`,
        attendeeName: 'Sim Attaché',
        attendeeCompany: 'Embassy of Sweden (Simulated)',
        attendeeEmail: 'sim.cert@zr-embassy.test',
        matchType: 'non_member' as const,
        ticketType: 'Service',
        ticketPriceThb: 12000,
        paymentStatus: 'pending' as const,
        registeredAt: new Date('2026-01-20T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('uploads → pins zero_rate_cert_blob_key → immutable → cert-view', async () => {
    // 1. Draft (TIN buyer → bill→receipt flow).
    const draft = await createEventInvoiceDraft(
      makeCreateEventInvoiceDraftDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `cert-draft-${regId}`,
        eventRegistrationId: regId,
        amountOverride: 1_200_000,
        buyer: TIN_BUYER,
      },
    );
    expect(draft.ok, draft.ok ? 'ok' : JSON.stringify(draft)).toBe(true);
    if (!draft.ok) throw new Error('draft failed');
    const invoiceId = draft.value.invoiceId;

    // 2. Upload the cert scan (mock scanner=clean + mock blob) → blob key.
    const uploadBlob = {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
        key,
        url: `https://blob.test/${key}`,
      })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    };
    const uploaded = await uploadZeroRateCert(
      {
        scanner: { scan: vi.fn(async () => ({ verdict: 'clean' as const, durationMs: 3 })) },
        blob: uploadBlob,
        clock: { nowIso: () => FIXED_NOW },
      },
      {
        tenantId: tenant.ctx.slug,
        invoiceId,
        filename: 'embassy-cert.pdf',
        contentType: 'application/pdf',
        bytes: Buffer.from('%PDF-1.4 embassy cert'),
      },
    );
    expect(uploaded.ok, uploaded.ok ? 'ok' : JSON.stringify(uploaded)).toBe(true);
    if (!uploaded.ok) throw new Error('upload failed');
    const blobKey = uploaded.value.blobKey;
    expect(blobKey).toContain(`invoicing/${tenant.ctx.slug}/zero-rate-certs/${invoiceId}_`);
    expect(uploadBlob.uploadPdf).toHaveBeenCalledOnce();

    // 3. Issue zero-rated WITH the cert blob key → the row pins it.
    const issued = await issueInvoice(issueDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `cert-issue-${invoiceId}`,
      invoiceId,
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: CERT_NO,
      zeroRateCertDate: CERT_DATE,
      zeroRateCertBlobKey: blobKey,
    });
    expect(issued.ok, issued.ok ? 'ok' : JSON.stringify(issued)).toBe(true);
    if (!issued.ok) throw new Error('issue failed');

    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(row!.status).toBe('issued');
    expect(row!.zeroRateCertBlobKey).toBe(blobKey);
    expect(row!.zeroRateCertNo).toBe(CERT_NO);

    // 4. IMMUTABLE — a post-issue UPDATE of the pinned key is blocked (0234 trigger).
    await expect(
      runInTenant(tenant.ctx, async (tx) => {
        await tx
          .update(invoices)
          .set({ zeroRateCertBlobKey: 'invoicing/tampered/x.pdf' })
          .where(
            and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)),
          );
      }),
    ).rejects.toThrow();

    // Key unchanged after the blocked tamper.
    const [afterRow] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(afterRow!.zeroRateCertBlobKey).toBe(blobKey);

    // 5. cert-view returns a signed URL + filename for the pinned key.
    const view = await getZeroRateCertSignedUrl(
      {
        ...makeGetZeroRateCertSignedUrlDeps(tenant.ctx.slug),
        blob: {
          uploadPdf: vi.fn(),
          uploadLogo: vi.fn(),
          signDownloadUrl: vi.fn(async (k: string) => `https://blob.test/signed/${k}`),
          downloadBytes: vi.fn(),
          delete: vi.fn(),
          list: vi.fn(),
        },
      },
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        actorRole: 'admin',
        requestId: `cert-view-${invoiceId}`,
        invoiceId,
      },
    );
    expect(view.ok, view.ok ? 'ok' : JSON.stringify(view)).toBe(true);
    if (!view.ok) throw new Error('cert-view failed');
    expect(view.value.url).toBe(`https://blob.test/signed/${blobKey}`);
    expect(view.value.filename).toMatch(/^zero-rate-cert-.*\.pdf$/);
  }, 120_000);
});
