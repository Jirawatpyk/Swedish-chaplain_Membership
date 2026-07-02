/**
 * 088 US8 UX-B2 (T061f) — live-Neon proof of the orphaned zero-rate cert-scan
 * TTL sweep's KEEP gate + cross-tenant isolation (Constitution Principle I
 * clause 3 Review-gate blocker).
 *
 * `existsInvoiceWithCertBlobKey` (drizzle-zero-rate-cert-prune-repo) is the SOLE
 * guard that stops the daily prune cron from deleting a PINNED §80/1(5)
 * certificate blob — 10-year legal tax evidence (Thai RD §87/3). It is a NEW
 * tenant-scoped SELECT on `invoices`; a false-NEGATIVE (probe says "not pinned"
 * when it is) = catastrophic legal-evidence loss. Its mock-based unit coverage
 * (prune-orphaned-zero-rate-certs.test.ts) cannot prove the real SQL + RLS
 * behaviour, so this suite exercises the REAL `makeDrizzleZeroRateCertPruneRepo`
 * under `runInTenant` against live Neon.
 *
 * Reuses the UX-B1 draft → upload-cert → issue-zero-rated flow (from
 * zero-rate-cert-upload.integration.test.ts) to pin a REAL server-derived cert
 * key onto an issued invoice.
 *
 * Assertions:
 *   (1) KEEP        — real probe returns `true` for the pinned key under
 *                     runInTenant(A). Proves the sweep would NOT delete it.
 *   (2) orphan-false — a key no invoice pins returns `false` (→ sweep considers
 *                      it for deletion past grace).
 *   (3) CROSS-TENANT — tenant B's scope cannot see tenant A's pinned cert:
 *       (3a) production-shape probe (B ctx, B filter, A's key) → false;
 *       (3b) RLS-load-bearing probe (B ctx, A filter, A's key) → false. Here the
 *            EXPLICIT `tenant_id = A` filter WOULD match A's pinning row — so the
 *            only thing producing `false` is RLS scoping the read to B. Proves
 *            RLS isolates the probe independently of the explicit filter.
 *   (4) full-sweep KEEP — `pruneOrphanedZeroRateCerts` with a MOCK blob whose
 *       `list` returns [pinnedKey] and a far-future (past-grace) clock, wired to
 *       the REAL repo probe: `blob.delete` is NEVER called for the pinned key.
 *
 * Migrations 0230→0234 MUST be applied to the `dev` Neon branch first.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
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
import { pruneOrphanedZeroRateCerts } from '@/modules/invoicing/application/use-cases/prune-orphaned-zero-rate-certs';
import { makeDrizzleZeroRateCertPruneRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-zero-rate-cert-prune-repo';
import {
  makeCreateEventInvoiceDraftDeps,
  makeIssueInvoiceDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const UPLOAD_NOW = '2026-07-02T09:00:00.000Z';
/** 29 days after the upload — unambiguously past the 48h ORPHAN_CERT_GRACE_MS. */
const SWEEP_NOW_PAST_GRACE = '2026-07-31T00:00:00.000Z';
const CERT_NO = 'กต 0404/5678';
const CERT_DATE = '2026-04-01';

/** Mock PDF render + Blob upload for the issue step (we only assert the DB pin). */
function issueDeps(slug: string): IssueInvoiceDeps {
  return {
    ...makeIssueInvoiceDeps(slug),
    clock: { nowIso: () => UPLOAD_NOW },
    taxAtPayment: true,
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
  primary_contact_email: 'sim.prune@zr-embassy.test',
} as const;

describe('088 US8 UX-B2 — orphaned zero-rate cert TTL-sweep pin-probe (live Neon)', () => {
  /** Tenant A owns the issued invoice that PINS the cert blob key. */
  let tenantA: TestTenant;
  /** Tenant B is an unrelated tenant used for the cross-tenant isolation probe. */
  let tenantB: TestTenant;
  let user: TestUser;
  let invoiceId: string;
  /** The REAL server-derived key A pins: invoicing/<A>/zero-rate-certs/<id>_<ms>.pdf */
  let pinnedKey: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');

    await seedTenantFiscal({
      tenant: tenantA,
      legalNameTh: 'หอการค้าไทย-สวีเดน',
      legalNameEn: 'Thailand-Swedish Chamber of Commerce',
      registeredAddressTh: 'กรุงเทพฯ',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });

    const eventId = randomUUID();
    const regId = randomUUID();
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenantA.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: `evt-prune-${eventId.slice(0, 8)}`,
        name: 'Embassy Expo Booth (prune)',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);
      await tx.insert(eventRegistrations).values({
        tenantId: tenantA.ctx.slug,
        eventId,
        registrationId: regId,
        externalId: `att-prune-${regId.slice(0, 8)}`,
        attendeeName: 'Sim Attaché',
        attendeeCompany: 'Embassy of Sweden (Simulated)',
        attendeeEmail: 'sim.prune@zr-embassy.test',
        matchType: 'non_member' as const,
        ticketType: 'Service',
        ticketPriceThb: 12000,
        paymentStatus: 'pending' as const,
        registeredAt: new Date('2026-01-20T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
    });

    // Draft (TIN buyer → bill→receipt flow).
    const draft = await createEventInvoiceDraft(
      makeCreateEventInvoiceDraftDeps(tenantA.ctx.slug),
      {
        tenantId: tenantA.ctx.slug,
        actorUserId: user.userId,
        requestId: `prune-draft-${regId}`,
        eventRegistrationId: regId,
        amountOverride: 1_200_000,
        buyer: TIN_BUYER,
      },
    );
    expect(draft.ok, draft.ok ? 'ok' : JSON.stringify(draft)).toBe(true);
    if (!draft.ok) throw new Error('draft failed');
    invoiceId = draft.value.invoiceId;

    // Upload the cert scan (mock scanner=clean + mock blob) → server-derived key.
    const uploaded = await uploadZeroRateCert(
      {
        scanner: { scan: vi.fn(async () => ({ verdict: 'clean' as const, durationMs: 3 })) },
        blob: {
          uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
            key,
            url: `https://blob.test/${key}`,
          })),
          uploadLogo: vi.fn(),
          signDownloadUrl: vi.fn(),
          downloadBytes: vi.fn(),
          delete: vi.fn(),
          list: vi.fn(),
        },
        clock: { nowIso: () => UPLOAD_NOW },
      },
      {
        tenantId: tenantA.ctx.slug,
        invoiceId,
        filename: 'embassy-cert.pdf',
        contentType: 'application/pdf',
        bytes: Buffer.from('%PDF-1.4 embassy cert'),
      },
    );
    expect(uploaded.ok, uploaded.ok ? 'ok' : JSON.stringify(uploaded)).toBe(true);
    if (!uploaded.ok) throw new Error('upload failed');
    pinnedKey = uploaded.value.blobKey;
    expect(pinnedKey).toContain(
      `invoicing/${tenantA.ctx.slug}/zero-rate-certs/${invoiceId}_`,
    );

    // Issue zero-rated WITH the cert blob key → the row PINS it.
    const issued = await issueInvoice(issueDeps(tenantA.ctx.slug), {
      tenantId: tenantA.ctx.slug,
      actorUserId: user.userId,
      requestId: `prune-issue-${invoiceId}`,
      invoiceId,
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: CERT_NO,
      zeroRateCertDate: CERT_DATE,
      zeroRateCertBlobKey: pinnedKey,
    });
    expect(issued.ok, issued.ok ? 'ok' : JSON.stringify(issued)).toBe(true);
    if (!issued.ok) throw new Error('issue failed');

    // Sanity: the pin landed on the row (owner-role read, RLS bypass).
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantA.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(row!.status).toBe('issued');
    expect(row!.zeroRateCertBlobKey).toBe(pinnedKey);
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('(1) KEEP — real repo probe returns TRUE for a pinned cert key under runInTenant(A)', async () => {
    const pinned = await runInTenant(tenantA.ctx, (tx) =>
      makeDrizzleZeroRateCertPruneRepo(tx).existsInvoiceWithCertBlobKey(
        tenantA.ctx.slug,
        pinnedKey,
      ),
    );
    // The paramount data-loss guard: a pinned §80/1(5) cert (10y evidence) is
    // reported as existing → the sweep short-circuits to KEEP, never deletes it.
    expect(pinned).toBe(true);
  });

  it('(2) orphan — real repo probe returns FALSE for a key no invoice pins', async () => {
    const orphanKey = `invoicing/${tenantA.ctx.slug}/zero-rate-certs/${randomUUID()}_1.pdf`;
    const exists = await runInTenant(tenantA.ctx, (tx) =>
      makeDrizzleZeroRateCertPruneRepo(tx).existsInvoiceWithCertBlobKey(
        tenantA.ctx.slug,
        orphanKey,
      ),
    );
    // Un-pinned → the sweep would (past grace) consider this blob for deletion.
    expect(exists).toBe(false);
  });

  it('(3a) CROSS-TENANT — tenant B cannot see tenant A pinned cert (production-shape probe)', async () => {
    // Mirrors the real `withTenantScope` wiring: same tenant for ctx AND filter.
    const exists = await runInTenant(tenantB.ctx, (tx) =>
      makeDrizzleZeroRateCertPruneRepo(tx).existsInvoiceWithCertBlobKey(
        tenantB.ctx.slug,
        pinnedKey,
      ),
    );
    expect(exists).toBe(false);
  });

  it('(3b) CROSS-TENANT — RLS is load-bearing: B scope + A filter + A key → FALSE', async () => {
    // Here the EXPLICIT `tenant_id = A` filter WOULD match A's pinning row — so
    // the ONLY thing that can make this return false is RLS scoping the read to
    // tenant B (the `SET LOCAL app.current_tenant = B` GUC). A `true` here would
    // mean RLS is not enforced on the probe — a Principle I isolation breach.
    const exists = await runInTenant(tenantB.ctx, (tx) =>
      makeDrizzleZeroRateCertPruneRepo(tx).existsInvoiceWithCertBlobKey(
        tenantA.ctx.slug,
        pinnedKey,
      ),
    );
    expect(exists).toBe(false);
  });

  it('(4) full sweep — pruneOrphanedZeroRateCerts KEEPS the pinned key (real probe, past grace)', async () => {
    const listMock = vi.fn(async () => [pinnedKey] as readonly string[]);
    const deleteMock = vi.fn(async () => {});

    const out = await pruneOrphanedZeroRateCerts(
      {},
      {
        blob: { list: listMock, delete: deleteMock },
        // Far-future clock: the key is well past the 48h grace, so ONLY the
        // pin-probe result can protect it from deletion.
        clock: { nowIso: () => SWEEP_NOW_PAST_GRACE },
        listCertTenantIds: async () => [tenantA.ctx.slug],
        // REAL per-tenant RLS scope + REAL drizzle probe (mirrors the production
        // src/lib/invoicing-cert-prune-deps.ts wrapper).
        withTenantScope: async (tenantId, fn) =>
          runInTenant(asTenantContext(tenantId), (tx) =>
            fn(makeDrizzleZeroRateCertPruneRepo(tx)),
          ),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    );

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(out.scanned).toBe(1);
    expect(out.swept).toBe(0);
    expect(out.skipped).toBe(1);
    // The pinned cert blob is NEVER deleted — end-to-end proof through the real repo.
    expect(deleteMock).not.toHaveBeenCalled();
  }, 60_000);
});
