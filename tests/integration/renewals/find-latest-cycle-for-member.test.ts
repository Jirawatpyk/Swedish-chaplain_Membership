/**
 * 059-membership-suspension Task 2 — `findLatestCycleForMember` repo read.
 * Live Neon.
 *
 * Backs the Domain predicate `deriveMembershipAccess` (Task 1). The bug
 * class this guards against: a repo method whose status filter makes a
 * `lapsed`/`cancelled` row UNREACHABLE would silently defeat the
 * suspension gate (a member whose only cycle is `lapsed` would read as
 * "no cycle" instead of "lapsed" and the gate would never fire). This
 * method therefore returns ALL statuses — no filter — ordered
 * `created_at DESC, cycle_id DESC`, the SAME tiebreak key
 * `findLatestCyclesForMembers` (the lapsed-badge batch query) already
 * uses, so the suspension gate and the admin badge never disagree about
 * which cycle is "latest" for a member.
 *
 * The single most important assertion in this file is the first test:
 * seed a real `lapsed` cycle and assert the repo returns it, unmocked,
 * against live Neon.
 *
 * Constitution Principle II (test-first) + Principle I (RLS via
 * runInTenant — cross-tenant probe at the bottom is a Review-Gate
 * blocker).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('findLatestCycleForMember — integration (059 Task 2)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `f8-latest-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Latest-Cycle Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  async function seedMember(t: TestTenant): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(t.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: t.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Latest Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    return memberId;
  }

  /**
   * `renewal_cycles_completed_requires_invoice_check` requires a real
   * linked invoice for a `completed` cycle — seed a minimal issued F4
   * invoice (fields modelled on
   * `tests/integration/renewals/find-most-recent-for-member.test.ts`).
   */
  async function seedIssuedInvoice(memberId: string): Promise<string> {
    const invoiceId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: user.userId,
        fiscalYear: 2025,
        sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
        documentNumber: `INV-2025-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        issueDate: '2025-01-15',
        dueDate: '2025-02-14',
        currency: 'THB',
        subtotalSatang: asSatang(5_000_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(350_000n),
        totalSatang: asSatang(5_350_000n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'Latest Co',
          country: 'TH',
          legal_name: 'Latest Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'latest@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2025/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      }),
    );
    return invoiceId;
  }

  interface SeedCycleOpts {
    readonly t: TestTenant;
    readonly memberId: string;
    readonly status: 'upcoming' | 'completed' | 'lapsed' | 'cancelled';
    /** ISO 8601 UTC. Drives the created_at DESC ordering under test. */
    readonly createdAt: string;
    /** ISO 8601 UTC. period_to is derived as +365 days. */
    readonly periodFrom: string;
    readonly linkedInvoiceId?: string;
  }

  /**
   * Terminal statuses (`completed`/`lapsed`/`cancelled`) require
   * `closed_at IS NOT NULL` + a matching `closed_reason`
   * (`renewal_cycles_closed_at_iff_terminal_check` +
   * `renewal_cycles_closed_reason_check`, migration 0087).
   */
  async function seedCycle(opts: SeedCycleOpts): Promise<string> {
    const cycleId = randomUUID();
    const periodFrom = new Date(opts.periodFrom);
    const periodTo = new Date(periodFrom.getTime() + 365 * MS_PER_DAY);
    const isTerminal =
      opts.status === 'completed' || opts.status === 'lapsed' || opts.status === 'cancelled';
    const closedReason =
      opts.status === 'completed' ? 'paid' : opts.status === 'lapsed' ? 'lapsed' : 'cancelled';
    await runInTenant(opts.t.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: opts.t.ctx.slug,
        cycleId,
        memberId: opts.memberId,
        status: opts.status,
        periodFrom,
        periodTo,
        expiresAt: periodTo,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        createdAt: new Date(opts.createdAt),
        ...(isTerminal ? { closedAt: new Date(opts.createdAt), closedReason } : {}),
        ...(opts.linkedInvoiceId ? { linkedInvoiceId: opts.linkedInvoiceId } : {}),
      }),
    );
    return cycleId;
  }

  it('returns a LAPSED cycle (the assertion that catches the original dead-gate bug)', async () => {
    const memberId = await seedMember(tenant);
    await seedCycle({
      t: tenant,
      memberId,
      status: 'lapsed',
      createdAt: '2025-01-01T00:00:00Z',
      periodFrom: '2025-01-01T00:00:00Z',
    });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const got = await deps.cyclesRepo.findLatestCycleForMember(tenant.ctx.slug, memberId);
    expect(got?.status).toBe('lapsed');
  });

  it('completed-2025 + upcoming-2026 → returns the 2026 (newest created_at)', async () => {
    const memberId = await seedMember(tenant);
    const invoiceId = await seedIssuedInvoice(memberId);
    await seedCycle({
      t: tenant,
      memberId,
      status: 'completed',
      createdAt: '2025-01-01T00:00:00Z',
      periodFrom: '2025-01-01T00:00:00Z',
      linkedInvoiceId: invoiceId,
    });
    await seedCycle({
      t: tenant,
      memberId,
      status: 'upcoming',
      createdAt: '2026-01-02T00:00:00Z',
      periodFrom: '2026-01-01T00:00:00Z',
    });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const got = await deps.cyclesRepo.findLatestCycleForMember(tenant.ctx.slug, memberId);
    expect(got?.status).toBe('upcoming');
  });

  it('lapsed-2025 + admin-renewed upcoming-2026 → returns the renewed cycle, NOT the stale lapsed', async () => {
    const memberId = await seedMember(tenant);
    await seedCycle({
      t: tenant,
      memberId,
      status: 'lapsed',
      createdAt: '2025-01-01T00:00:00Z',
      periodFrom: '2025-01-01T00:00:00Z',
    });
    await seedCycle({
      t: tenant,
      memberId,
      status: 'upcoming',
      createdAt: '2026-06-01T00:00:00Z',
      periodFrom: '2026-06-01T00:00:00Z',
    });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const got = await deps.cyclesRepo.findLatestCycleForMember(tenant.ctx.slug, memberId);
    expect(got?.status).toBe('upcoming');
  });

  it('no cycle → null', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const got = await deps.cyclesRepo.findLatestCycleForMember(tenant.ctx.slug, randomUUID());
    expect(got).toBeNull();
  });

  it("cross-tenant: tenant B cannot read tenant A's member cycle (RLS)", async () => {
    const tenantB = await createTestTenant('test-chamber');
    try {
      const memberId = await seedMember(tenant);
      await seedCycle({
        t: tenant,
        memberId,
        status: 'upcoming',
        createdAt: '2026-01-01T00:00:00Z',
        periodFrom: '2026-01-01T00:00:00Z',
      });

      const depsB = makeRenewalsDeps(tenantB.ctx.slug);
      const gotUnderB = await depsB.cyclesRepo.findLatestCycleForMember(
        tenantB.ctx.slug,
        memberId,
      );
      expect(gotUnderB).toBeNull();
    } finally {
      await tenantB.cleanup().catch(() => {});
    }
  });
});
