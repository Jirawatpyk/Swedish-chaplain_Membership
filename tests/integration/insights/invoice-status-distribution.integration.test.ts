/**
 * F9 067-dashboard-interactive-charts Task 4 —
 * `invoiceSourceAdapter.getInvoiceStatusDistribution` against LIVE Neon.
 *
 * Bucket rules (from the 067 design § Data & correctness, pinned by this
 * test) — a part-to-whole donut needs ONE consistent basis, so ALL THREE
 * buckets are VAT-INCLUSIVE, net-of-credit (`total − creditedTotal`), NOT
 * the ex-VAT `netPaidRevenueSatang` figure the separate revenue-KPI methods
 * (`getYtdPaidRevenueSatang` / `getMonthlyPaidRevenueSatang`) sum:
 *   - `paid`    = status 'paid' OR 'partially_credited'  → `total −
 *                 creditedTotal` (gross amount actually received/retained).
 *                 `partially_credited` is reachable ONLY from `paid`
 *                 (`canTransition` in invoice.ts: `paid →
 *                 ['partially_credited', 'credited', 'void']`), so it was
 *                 paid FIRST — its net balance is already-collected cash,
 *                 never an outstanding receivable, regardless of `dueDate`.
 *   - `unpaid`  = status 'issued' AND NOT computeIsOverdue → outstanding
 *                 balance (`total − creditedTotal`, VAT-INCLUSIVE — the
 *                 actual amount the member still owes).
 *   - `overdue` = status 'issued' AND computeIsOverdue      → same balance.
 *   - `draft` is counted separately (`draftCount`); `void` and fully
 *     `credited` are excluded from every bucket AND from `draftCount`.
 *
 * Two isolated tenants:
 *   - Tenant A — the base scenario (paid / issued-future / issued-past-due /
 *     draft / void) using REAL wall-clock time, so the OVERDUE COUNT can be
 *     pinned against `countOverdue(ctx, nowIso)` — this suite passes the real
 *     clock so the two sides stay comparable. Due dates
 *     are `bangkokLocalDate(now) ± 30 days` so the scenario is stable
 *     regardless of which real calendar day the suite executes on.
 *   - Tenant B — a FIXED synthetic `nowIso` ("2026-07-15T17:30:00.000Z" =
 *     2026-07-16T00:30 Asia/Bangkok, i.e. UTC is still on the PRIOR day)
 *     proves (a) the tz-boundary case (`due_date === today` → NOT overdue)
 *     and (b) the partially_credited → paid fold + full-credit exclusion.
 *     Kept OUT of Tenant A only to keep the two scenarios' fixtures
 *     independent — the `overdue == countOverdue` equivalence now holds
 *     regardless of whether a `partially_credited` row is present, since it
 *     never lands in `overdue` (or `unpaid`) at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { bangkokLocalDate, addDays } from '@/lib/fiscal-year';
import { invoiceSourceAdapter } from '@/modules/insights/infrastructure/sources/invoice-source-adapter';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

/**
 * Track B — the waived-refund netting map. Every case in this file predates
 * credit-note waivers and has none, so an empty map preserves exactly what
 * each assertion was written to test. The netting itself is exercised in the
 * dedicated cases that build a non-empty map.
 */
const NO_WAIVERS: ReadonlyMap<string, bigint> = new Map();

const SNAP_TENANT = {
  legal_name_th: 'ท', legal_name_en: 'T', tax_id: '0',
  address_th: 'B', address_en: 'B', logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'C', tax_id: '1', address: 'B',
  primary_contact_name: 'n', primary_contact_email: 't@e.com',
};

type SeedStatus = 'draft' | 'issued' | 'paid' | 'void' | 'partially_credited' | 'credited';

interface SeedInvoiceOpts {
  readonly tenant: TestTenant;
  readonly memberId: string;
  readonly status: SeedStatus;
  readonly dueDate: string | null;
  readonly subtotalSatang?: bigint;
  readonly vatSatang?: bigint;
  readonly totalSatang?: bigint;
  readonly creditedTotalSatang?: bigint;
}

describe('F9 067 Task 4 — invoiceSourceAdapter.getInvoiceStatusDistribution (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;
  const planId = `f9-dist-${randomUUID().slice(0, 8)}`;
  const memberA = randomUUID();
  const memberB = randomUUID();
  let seq = 1;

  function nextSeq(): number {
    return seq++;
  }

  /**
   * Seeds ONE invoice. `draft` needs only the minimal identity fields (no
   * pricing/snapshot); `issued`/`paid`/`void`/`partially_credited`/`credited`
   * are non-draft and must satisfy `invoices_non_draft_has_snapshots` (full
   * snapshot + pdf set) plus the status-specific CHECKs
   * (`invoices_paid_has_payment`, `invoices_void_has_reason`,
   * `invoices_credited_status_matches`). Mirrors the shape used by
   * `tests/integration/renewals/invoice-due-bridge.test.ts`.
   */
  async function seedInvoice(opts: SeedInvoiceOpts): Promise<void> {
    const invoiceId = randomUUID();
    const base = {
      tenantId: opts.tenant.ctx.slug,
      invoiceId,
      memberId: opts.memberId,
      planYear: 2026,
      planId,
      draftByUserId: admin.userId,
      status: opts.status,
      dueDate: opts.dueDate,
    };
    if (opts.status === 'draft') {
      await runInTenant(opts.tenant.ctx, (tx) => tx.insert(invoices).values(base));
      return;
    }
    const n = nextSeq();
    await runInTenant(opts.tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        ...base,
        pdfDocKind: 'invoice',
        fiscalYear: 2026,
        sequenceNumber: n,
        documentNumber: `F9DIST-2026-${String(n).padStart(6, '0')}`,
        issueDate: opts.dueDate ?? '2026-01-01',
        currency: 'THB',
        subtotalSatang: opts.subtotalSatang ?? 0n,
        vatRateSnapshot: '0.0000',
        vatSatang: opts.vatSatang ?? 0n,
        totalSatang: opts.totalSatang ?? 0n,
        creditedTotalSatang: opts.creditedTotalSatang ?? 0n,
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        pdfBlobKey: `invoicing/f9dist/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        ...(opts.status === 'void'
          ? { voidedAt: new Date(), voidReason: 'test void', voidedByUserId: admin.userId }
          : {}),
        ...(opts.status === 'paid' ||
        opts.status === 'partially_credited' ||
        opts.status === 'credited'
          ? { paidAt: new Date(), paymentMethod: 'manual', receiptPdfStatus: 'rendered' as const }
          : {}),
      }),
    );
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    const two = await createTwoTestTenants();
    tenantA = two.a;
    tenantB = two.b;
    for (const [tenant, memberId] of [
      [tenantA, memberA],
      [tenantB, memberB],
    ] as const) {
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId,
          planName: { en: 'Dist Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: admin.userId,
        });
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Dist Co',
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active' as const,
          riskScore: null,
          riskScoreBand: null,
        });
      });
    }
  }, 180_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  function bucket(
    dist: { readonly buckets: ReadonlyArray<{ bucket: string; satang: bigint; count: number }> },
    name: 'paid' | 'unpaid' | 'overdue',
  ) {
    const found = dist.buckets.find((b) => b.bucket === name);
    if (!found) throw new Error(`bucket ${name} missing from distribution result`);
    return found;
  }

  describe('Tenant A — base scenario + countOverdue equivalence (real time)', () => {
    const todayBkk = bangkokLocalDate(new Date().toISOString());
    const futureDue = addDays(todayBkk, 30);
    const pastDue = addDays(todayBkk, -30);

    beforeAll(async () => {
      // paid: subtotal 100_000 + vat 7_000 = total 107_000 → the paid bucket
      // is the GROSS, net-of-credit amount (no credit here, so 107_000 −
      // 0 == 107_000), NOT the ex-VAT 100_000 `netPaidRevenueSatang` figure.
      await seedInvoice({
        tenant: tenantA,
        memberId: memberA,
        status: 'paid',
        dueDate: pastDue,
        subtotalSatang: 100_000n,
        vatSatang: 7_000n,
        totalSatang: 107_000n,
      });
      // issued, due in the future → unpaid bucket at the full (no-credit)
      // balance.
      await seedInvoice({
        tenant: tenantA,
        memberId: memberA,
        status: 'issued',
        dueDate: futureDue,
        subtotalSatang: 50_000n,
        vatSatang: 3_500n,
        totalSatang: 53_500n,
      });
      // issued, past its due date → overdue bucket.
      await seedInvoice({
        tenant: tenantA,
        memberId: memberA,
        status: 'issued',
        dueDate: pastDue,
        subtotalSatang: 80_000n,
        vatSatang: 5_600n,
        totalSatang: 85_600n,
      });
      // draft → draftCount only, no pricing at all.
      await seedInvoice({ tenant: tenantA, memberId: memberA, status: 'draft', dueDate: null });
      // void → excluded from every bucket AND draftCount. Distinct sentinel
      // amount so any leak into a bucket is unmistakable in the assertions.
      await seedInvoice({
        tenant: tenantA,
        memberId: memberA,
        status: 'void',
        dueDate: futureDue,
        subtotalSatang: 42_000n,
        totalSatang: 42_000n,
      });
    }, 60_000);

    it('buckets paid/unpaid/overdue at the correct net amounts + counts, and counts the draft', async () => {
      const nowIso = new Date().toISOString();
      const dist = await invoiceSourceAdapter.getInvoiceStatusDistribution(tenantA.ctx, nowIso, NO_WAIVERS);

      expect(bucket(dist, 'paid')).toEqual({ bucket: 'paid', satang: 107_000n, count: 1 });
      expect(bucket(dist, 'unpaid')).toEqual({ bucket: 'unpaid', satang: 53_500n, count: 1 });
      expect(bucket(dist, 'overdue')).toEqual({ bucket: 'overdue', satang: 85_600n, count: 1 });
      expect(dist.draftCount).toBe(1);
    });

    it('the overdue bucket COUNT equals countOverdue(ctx) — same underlying rule, independently derived', async () => {
      const nowIso = new Date().toISOString();
      const dist = await invoiceSourceAdapter.getInvoiceStatusDistribution(tenantA.ctx, nowIso, NO_WAIVERS);
      const overdueCount = await invoiceSourceAdapter.countOverdue(
        tenantA.ctx,
        new Date().toISOString(),
      );
      expect(bucket(dist, 'overdue').count).toBe(overdueCount);
    });
  });

  describe('Tenant B — tz boundary + partially_credited fold + full-credit exclusion (fixed synthetic now)', () => {
    // 2026-07-15T17:30:00.000Z UTC == 2026-07-16T00:30 Asia/Bangkok (UTC+7):
    // Bangkok has already crossed into "2026-07-16" while UTC is still on
    // "2026-07-15" ("prior day").
    const nowIso = '2026-07-15T17:30:00.000Z';
    const todayBkk = '2026-07-16';

    beforeAll(async () => {
      // due_date === today (Bangkok) at 00:30 Bangkok / prior-day UTC → must
      // NOT be overdue (dueDate === todayBkk is not STRICTLY less than it).
      await seedInvoice({
        tenant: tenantB,
        memberId: memberB,
        status: 'issued',
        dueDate: todayBkk,
        subtotalSatang: 10_000n,
        totalSatang: 10_000n,
      });
      // partially_credited, with a due date 30 days in the past — must fold
      // into PAID at its NET balance (120_000 − 20_000 = 100_000), NOT
      // overdue: it is reachable only from `paid`, so it was already
      // collected before this (irrelevant) due date. The past due date is
      // deliberately chosen to prove the fix — a naive due-date fold would
      // have misrouted this row into `overdue`.
      await seedInvoice({
        tenant: tenantB,
        memberId: memberB,
        status: 'partially_credited',
        dueDate: addDays(todayBkk, -30),
        subtotalSatang: 120_000n,
        totalSatang: 120_000n,
        creditedTotalSatang: 20_000n,
      });
      // fully credited → excluded from EVERY bucket (not paid, not
      // unpaid/overdue, not draftCount).
      await seedInvoice({
        tenant: tenantB,
        memberId: memberB,
        status: 'credited',
        dueDate: todayBkk,
        subtotalSatang: 30_000n,
        totalSatang: 30_000n,
        creditedTotalSatang: 30_000n,
      });
    }, 60_000);

    it('boundary invoice is NOT overdue; partially_credited folds into paid at NET balance; fully-credited is invisible', async () => {
      const dist = await invoiceSourceAdapter.getInvoiceStatusDistribution(tenantB.ctx, nowIso, NO_WAIVERS);

      // The partially_credited invoice (net 120_000 − 20_000 = 100_000) is
      // the only paid row — it was reached FROM `paid`, so its due date
      // (30 days in the past) is irrelevant to the bucket it lands in.
      expect(bucket(dist, 'paid')).toEqual({ bucket: 'paid', satang: 100_000n, count: 1 });
      // The boundary invoice (10_000, NOT overdue) is the only unpaid row.
      expect(bucket(dist, 'unpaid')).toEqual({ bucket: 'unpaid', satang: 10_000n, count: 1 });
      // Nothing lands in overdue: the boundary invoice isn't overdue, and
      // partially_credited never reaches this bucket regardless of due date.
      expect(bucket(dist, 'overdue')).toEqual({ bucket: 'overdue', satang: 0n, count: 0 });
      expect(dist.draftCount).toBe(0);
    });
  });
});
