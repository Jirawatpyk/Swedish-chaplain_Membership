/**
 * 107-auto-invoice Task 16 review MAJOR-3 — `readAutoInvoiceGaugeRow`
 * integration test (live Neon).
 *
 * Pins the aggregate behind the three auto-invoice observable gauges against
 * real Postgres + RLS. Before this file the SQL was covered by NOTHING: it
 * lived inline in a Next.js route (which cannot export symbols for a test to
 * import), and the coordinator unit test mocks `runInTenant` so the gauge path
 * no-ops entirely. A rename of `invoices.origin`, `invoice_subject`,
 * `members.erased_at` or the cycle-status enum would have broken it silently
 * into a `logger.warn` — a dead gauge that still reports a plausible 0.
 *
 * Cases:
 *   (a) empty queue → queue_size 0 AND oldest_age_seconds 0, NOT NULL
 *       (the COALESCE path — a NULL here would observe NaN on the gauge).
 *   (b) queue_size counts ONLY origin='auto_renewal' AND status='draft';
 *       a manual draft and an issued auto-renewal invoice are both excluded.
 *   (c) oldest_age_seconds tracks the OLDEST qualifying draft, and is
 *       measured from the right row — a much older MANUAL invoice must not
 *       drag it (the bug the WHERE-per-subquery restructure prevents).
 *   (d) a wedged cycle (awaiting_payment, billable member, no live invoice)
 *       is counted.
 *   (e) BLOCKER-1 — archived / erased members are NOT
 *       counted, and a member holding a live invoice is NOT counted.
 *   (f) tenant isolation — a second tenant's rows never leak in.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { readAutoInvoiceGaugeRow } from '@/modules/renewals';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const PLAN_YEAR = 2025;

interface SeedMemberOpts {
  readonly t: TestTenant;
  readonly planId: string;
  /**
   * Sets BOTH `status='archived'` and `archivedAt` — the DB CHECK
   * `members_archived_at_iff_archived` (migration 0009) makes them an IFF,
   * so "archived_at set" and "status archived" are not independently
   * seedable states. Worth knowing when reading the gauge's member gate:
   * its `archived_at IS NULL AND status <> 'archived'` pair is redundant by
   * construction. It is kept as a verbatim copy of the shipped
   * `listCyclesEligibleForAutoDraft` predicate rather than trimmed, so the
   * detector and the drafter stay textually comparable.
   */
  readonly archived?: boolean;
  readonly erased?: boolean;
}

async function seedMember(opts: SeedMemberOpts): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(opts.t.ctx, (tx) =>
    tx.insert(members).values({
      tenantId: opts.t.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Gauge T16 Co ${memberId.slice(0, 6)}`,
      country: 'TH' as const,
      planId: opts.planId,
      planYear: PLAN_YEAR,
      billingCycle: 'rolling',
      ...(opts.archived
        ? {
            status: 'archived' as const,
            archivedAt: new Date('2026-06-01T00:00:00Z'),
          }
        : {}),
      ...(opts.erased ? { erasedAt: new Date('2026-06-01T00:00:00Z') } : {}),
    }),
  );
  return memberId;
}

/** Seeds an `awaiting_payment` cycle — the wedged-state shape. */
async function seedAwaitingPaymentCycle(
  t: TestTenant,
  memberId: string,
  planId: string,
): Promise<string> {
  const cycleId = randomUUID();
  await runInTenant(t.ctx, (tx) =>
    tx.insert(renewalCycles).values({
      tenantId: t.ctx.slug,
      cycleId,
      memberId,
      status: 'awaiting_payment',
      periodFrom: new Date('2025-08-01T00:00:00Z'),
      periodTo: new Date('2026-08-01T00:00:00Z'),
      expiresAt: new Date('2026-08-01T00:00:00Z'),
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: planId,
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
      anchoredAt: new Date('2025-08-01T00:00:00Z'),
    }),
  );
  return cycleId;
}

interface SeedInvoiceOpts {
  readonly t: TestTenant;
  readonly memberId: string;
  readonly planId: string;
  readonly origin: 'manual' | 'auto_renewal';
  readonly status: 'draft' | 'issued';
  readonly createdAt?: string;
  readonly userId: string;
}

/**
 * Monotonic per-run sequence for ISSUED fixtures. The DB CHECK
 * `invoices_draft_has_no_number` requires a non-null `sequence_number` on
 * anything that is not a draft, and `invoices_tenant_fiscal_seq_unique`
 * requires it to be unique within (tenant, fiscal_year).
 */
let seqCounter = 0;

/**
 * Identity snapshots required by `invoices_non_draft_has_snapshots` on any
 * non-draft row. Shapes copied from the working F9 fixture in
 * `tests/integration/insights/invoice-status-distribution.integration.test.ts`.
 */
const SNAP_TENANT = {
  legal_name_th: 'ท', legal_name_en: 'T', tax_id: '0',
  address_th: 'B', address_en: 'B', logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'C', tax_id: '1', address: 'B',
  primary_contact_name: 'n', primary_contact_email: 't@e.com',
};

async function seedInvoice(opts: SeedInvoiceOpts): Promise<string> {
  const invoiceId = randomUUID();
  await runInTenant(opts.t.ctx, (tx) =>
    tx.insert(invoices).values({
      tenantId: opts.t.ctx.slug,
      invoiceId,
      memberId: opts.memberId,
      invoiceSubject: 'membership',
      planId: opts.planId,
      planYear: PLAN_YEAR,
      origin: opts.origin,
      status: opts.status,
      currency: 'THB',
      subtotalSatang: 5_000_000n,
      vatRateSnapshot: '0.0700',
      vatSatang: 350_000n,
      totalSatang: 5_350_000n,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'none',
      netDaysSnapshot: 30,
      issueDate: '2026-07-01',
      dueDate: '2026-07-31',
      draftByUserId: opts.userId,
      // A non-draft row must carry a §87 number, a pdf_doc_kind and both
      // identity snapshots — CHECKs invoices_draft_has_no_number,
      // invoices_non_draft_has_doc_kind, invoices_non_draft_has_snapshots.
      // Drafts must carry NONE of them.
      ...(opts.status === 'issued'
        ? {
            fiscalYear: PLAN_YEAR,
            sequenceNumber: ++seqCounter,
            documentNumber: `T16G-${PLAN_YEAR}-${String(seqCounter).padStart(6, '0')}`,
            pdfDocKind: 'invoice',
            tenantIdentitySnapshot: SNAP_TENANT,
            memberIdentitySnapshot: SNAP_MEMBER,
            pdfBlobKey: `invoicing/t16gauge/${invoiceId}.pdf`,
            pdfSha256: 'a'.repeat(64),
            pdfTemplateVersion: 1,
          }
        : {}),
      ...(opts.createdAt ? { createdAt: new Date(opts.createdAt) } : {}),
    }),
  );
  return invoiceId;
}

describe('107-auto-invoice Task 16 — readAutoInvoiceGaugeRow (live Neon)', () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
  });

  async function freshTenant(): Promise<{
    readonly t: TestTenant;
    readonly planId: string;
  }> {
    const t = await createTestTenant('test');
    const planId = `t16-gauge-plan-${randomUUID().slice(0, 8)}`;
    await seedTenantFiscal({
      tenant: t,
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });
    await runInTenant(t.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: t.ctx.slug,
        planId,
        planYear: PLAN_YEAR,
        planName: { en: 'Gauge T16 Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    return { t, planId };
  }

  it('(a) empty queue → queue_size 0 and oldest_age_seconds 0 (not NULL)', async () => {
    const { t } = await freshTenant();
    const row = await readAutoInvoiceGaugeRow(t.ctx.slug);
    expect(row).not.toBeNull();
    expect(row!.queue_size).toBe(0);
    // The COALESCE path. A NULL here would reach the gauge as NaN.
    expect(row!.oldest_age_seconds).toBe(0);
    expect(row!.oldest_age_seconds).not.toBeNull();
    expect(row!.awaiting_payment_no_invoice).toBe(0);
  });

  it('(b) queue_size counts ONLY origin=auto_renewal AND status=draft', async () => {
    const { t, planId } = await freshTenant();
    const m = await seedMember({ t, planId });
    await seedInvoice({ t, memberId: m, planId, origin: 'auto_renewal', status: 'draft', userId: user.userId });
    // Excluded: a manual draft (not the auto-renewal queue).
    await seedInvoice({ t, memberId: m, planId, origin: 'manual', status: 'draft', userId: user.userId });
    // Excluded: an auto-renewal invoice a treasurer already ISSUED — it has
    // left the review queue.
    await seedInvoice({ t, memberId: m, planId, origin: 'auto_renewal', status: 'issued', userId: user.userId });

    const row = await readAutoInvoiceGaugeRow(t.ctx.slug);
    expect(row!.queue_size).toBe(1);
  });

  it('(c) oldest_age_seconds tracks the oldest QUALIFYING draft, not the oldest invoice', async () => {
    const { t, planId } = await freshTenant();
    const m = await seedMember({ t, planId });
    // A much older MANUAL invoice. If the age were measured over all
    // invoices (the FILTER-omission bug the restructure prevents), this row
    // would dominate and the gauge would report ~2 years instead of ~2 days.
    await seedInvoice({
      t, memberId: m, planId, origin: 'manual', status: 'draft',
      createdAt: '2024-01-01T00:00:00Z', userId: user.userId,
    });
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    await seedInvoice({
      t, memberId: m, planId, origin: 'auto_renewal', status: 'draft',
      createdAt: twoDaysAgo, userId: user.userId,
    });
    await seedInvoice({
      t, memberId: m, planId, origin: 'auto_renewal', status: 'draft',
      createdAt: tenDaysAgo, userId: user.userId,
    });

    const row = await readAutoInvoiceGaugeRow(t.ctx.slug);
    expect(row!.queue_size).toBe(2);
    // ~10 days, from the oldest AUTO_RENEWAL draft. Generous window for
    // clock skew, but far tighter than the ~2-year manual row would give.
    expect(row!.oldest_age_seconds).toBeGreaterThan(9 * 24 * 3600);
    expect(row!.oldest_age_seconds).toBeLessThan(11 * 24 * 3600);
  });

  it('(d) a wedged cycle (awaiting_payment, billable member, no live invoice) is counted', async () => {
    const { t, planId } = await freshTenant();
    const m = await seedMember({ t, planId });
    await seedAwaitingPaymentCycle(t, m, planId);

    const row = await readAutoInvoiceGaugeRow(t.ctx.slug);
    expect(row!.awaiting_payment_no_invoice).toBe(1);
  });

  it('(e) BLOCKER-1 — archived / erased members and already-billed members are NOT counted', async () => {
    const { t, planId } = await freshTenant();

    // Each of these must be excluded from the wedged population.
    const archived = await seedMember({ t, planId, archived: true });
    await seedAwaitingPaymentCycle(t, archived, planId);

    const erased = await seedMember({ t, planId, erased: true });
    await seedAwaitingPaymentCycle(t, erased, planId);

    // Billable, but HAS a live invoice → not wedged, someone is chasing it.
    const billed = await seedMember({ t, planId });
    await seedAwaitingPaymentCycle(t, billed, planId);
    await seedInvoice({
      t, memberId: billed, planId, origin: 'manual', status: 'issued',
      userId: user.userId,
    });

    const row = await readAutoInvoiceGaugeRow(t.ctx.slug);
    expect(row!.awaiting_payment_no_invoice).toBe(0);

    // Control: a genuinely wedged member in the SAME tenant is still seen,
    // so the assertion above is not passing merely because the query is
    // broken and returns 0 for everything.
    const wedged = await seedMember({ t, planId });
    await seedAwaitingPaymentCycle(t, wedged, planId);
    const after = await readAutoInvoiceGaugeRow(t.ctx.slug);
    expect(after!.awaiting_payment_no_invoice).toBe(1);
  });

  it('(f) tenant isolation — another tenant rows never leak in', async () => {
    const a = await freshTenant();
    const b = await freshTenant();

    const mA = await seedMember({ t: a.t, planId: a.planId });
    await seedInvoice({
      t: a.t, memberId: mA, planId: a.planId,
      origin: 'auto_renewal', status: 'draft', userId: user.userId,
    });
    await seedAwaitingPaymentCycle(a.t, await seedMember({ t: a.t, planId: a.planId }), a.planId);

    const rowB = await readAutoInvoiceGaugeRow(b.t.ctx.slug);
    expect(rowB!.queue_size).toBe(0);
    expect(rowB!.awaiting_payment_no_invoice).toBe(0);

    const rowA = await readAutoInvoiceGaugeRow(a.t.ctx.slug);
    expect(rowA!.queue_size).toBe(1);
    expect(rowA!.awaiting_payment_no_invoice).toBe(1);
  });
});
