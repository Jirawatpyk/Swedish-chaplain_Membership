/**
 * 065 §5.2 — `lapseCyclesOnGraceExpiry` termination clock driven by the
 * member's OLDEST-DUE unpaid membership invoice `due_date + 60` (Bangkok
 * calendar days), member-scoped, with `expires_at + grace_period_days` as
 * the no-invoice backstop. Live Neon.
 *
 * Proves the four behaviours §5.2 requires (design §8):
 *   1. terminate at `due_date + 60`, not before;
 *   2. defer while the invoice is not yet due (059 guard preserved);
 *   3. the §5.2⇄§5.3 coupling — a §5.3 born-`awaiting_payment` new member
 *      with a FAR-FUTURE `expires_at` but an unpaid membership invoice past
 *      `due_date + 60` MUST terminate (proves `listCyclesEligibleForLapse`
 *      no longer hides it behind the removed `expires_at` gate, AND that
 *      `deriveMembershipAccess` resolves the lapsed cycle to `terminated`
 *      despite the future `expires_at`);
 *   4. no-invoice backstop — a member with no membership invoice terminates
 *      at `expires_at + grace`.
 *
 * A fresh tenant per test isolates the tenant-wide lapse cron (it mutates
 * every `awaiting_payment` cycle in the tenant on each run).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantRenewalSettings } from '@/modules/renewals/infrastructure/schema-tenant-renewal-config';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  deriveMembershipAccess,
  lapseCyclesOnGraceExpiry,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const GRACE_DAYS = 60;

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Due60 Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

/** A UTC instant at Bangkok noon → `bangkokLocalDate()` === `ymd`. */
function bkk(ymd: string): Date {
  return new Date(`${ymd}T05:00:00.000Z`);
}

describe('065 §5.2 — termination at invoice due_date + 60 (integration)', () => {
  let user: TestUser;
  let tenant: TestTenant;
  let planId: string;
  let seq: number;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
  }, 120_000);

  beforeEach(async () => {
    tenant = await createTestTenant();
    planId = `f8-due60-${randomUUID().slice(0, 8)}`;
    seq = 900_001;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Due60 Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .insert(tenantRenewalSettings)
        .values({
          tenantId: tenant.ctx.slug,
          gracePeriodDays: GRACE_DAYS,
          autoUpgradeEnabled: true,
          minTenureDaysForAtRisk: 30,
          dispatchCronEnabled: true,
        })
        .onConflictDoNothing(),
    );
  }, 120_000);

  afterEach(async () => {
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  async function seedMember(): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Due60 Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    return memberId;
  }

  /** Seeds an `issued` MEMBERSHIP invoice (full snapshot to satisfy the
   *  `invoices_non_draft_has_snapshots` CHECK). */
  async function seedMembershipInvoice(memberId: string, dueDate: string): Promise<void> {
    const invoiceId = randomUUID();
    const n = seq++;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'issued',
        dueDate,
        pdfDocKind: 'invoice',
        fiscalYear: 2025,
        sequenceNumber: n,
        documentNumber: `INV-2025-${String(n).padStart(6, '0')}`,
        issueDate: '2025-01-15',
        currency: 'THB',
        subtotalSatang: 5_000_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 350_000n,
        totalSatang: 5_350_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2025/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      }),
    );
  }

  /** Seeds an `awaiting_payment` cycle with an explicit `expires_at`.
   *  `linkedInvoiceId` is intentionally left NULL — the lapse clock is
   *  member-scoped, NOT anchored on the cycle's linked invoice. */
  async function seedAwaitingCycle(memberId: string, expiresAt: Date): Promise<void> {
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date(expiresAt.getTime() - 365 * 86_400_000),
        periodTo: expiresAt,
        expiresAt,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      }),
    );
  }

  async function runLapse(now: Date): Promise<{
    readonly graceExpired: number;
    readonly deferredInvoiceNotDue: number;
    readonly deferredWithinTerminationWindow: number;
    readonly deferredNoInvoiceBackstop: number;
  }> {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const r = await lapseCyclesOnGraceExpiry(deps, {
      tenantId: tenant.ctx.slug,
      now,
      correlationId: randomUUID(),
    });
    if (!r.ok) throw new Error(`lapse failed: ${r.error.kind}`);
    return r.value;
  }

  async function access(memberId: string, now: Date): Promise<string> {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const cycle = await deps.cyclesRepo.findLatestCycleForMember(
      tenant.ctx.slug,
      memberId,
    );
    return deriveMembershipAccess(cycle, now).access;
  }

  async function cycleStatus(memberId: string): Promise<string | undefined> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ status: renewalCycles.status })
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, memberId)),
    );
    return rows[0]?.status;
  }

  it('terminates at due_date + 60, not before', async () => {
    const m = await seedMember();
    await seedMembershipInvoice(m, '2026-01-01'); // due+60 = 2026-03-02
    await seedAwaitingCycle(m, bkk('2026-01-01')); // expires_at in the past

    // due+59 (2026-03-01): past due but inside the 60-day window → stay
    // suspended, no transition.
    const t59 = await runLapse(bkk('2026-03-01'));
    expect(t59.deferredWithinTerminationWindow).toBe(1);
    expect(t59.graceExpired).toBe(0);
    expect(await access(m, bkk('2026-03-01'))).toBe('suspended');

    // due+61 (2026-03-03): today > due+60 → terminate.
    const t61 = await runLapse(bkk('2026-03-03'));
    expect(t61.graceExpired).toBe(1);
    expect(await cycleStatus(m)).toBe('lapsed');
    expect(await access(m, bkk('2026-03-03'))).toBe('terminated');
  });

  it('defers while the invoice is not yet due (059 not-yet-due guard preserved)', async () => {
    const m = await seedMember();
    await seedMembershipInvoice(m, '2026-06-01'); // future due date
    await seedAwaitingCycle(m, bkk('2026-05-01'));

    const r = await runLapse(bkk('2026-05-01'));
    expect(r.deferredInvoiceNotDue).toBe(1);
    expect(r.graceExpired).toBe(0);
    expect(await cycleStatus(m)).toBe('awaiting_payment');
    expect(await access(m, bkk('2026-05-01'))).toBe('suspended');
  });

  it('terminates a born-awaiting new member (far-future expires_at) at due+60 — the §5.2⇄§5.3 coupling', async () => {
    // §5.3 born-`awaiting_payment` shape: initial cycle carries a far-future
    // `expires_at ≈ registration + 12 months`, no linked invoice, but an
    // unpaid membership invoice whose due date is already > 60 days past.
    const m = await seedMember();
    await seedMembershipInvoice(m, '2026-01-01'); // due+60 = 2026-03-02
    // `seedAwaitingCycle` sets period_from = expires_at − 365d = 2026-01-01,
    // so the invoice's due_date (2026-01-01) lands exactly at period start —
    // WELL within the `sinceDueDate = period_from − 60d` floor (2025-11-02),
    // i.e. this is a real CURRENT-period invoice that must still anchor the
    // clock and terminate (065 §5.2 review floor does not exclude it).
    await seedAwaitingCycle(m, bkk('2027-01-01')); // expires_at ~9mo AFTER the run

    const r = await runLapse(bkk('2026-03-03')); // due+61, expires_at still far future
    expect(r.graceExpired).toBe(1);
    // NOT hidden by the (removed) expires_at selection gate → the cron
    // processed and lapsed it.
    expect(await cycleStatus(m)).toBe('lapsed');
    // AND the access predicate resolves the lapsed cycle to `terminated`
    // despite the future expires_at (065 §5.2⇄§5.3 domain fix) — a never-paid
    // member must lose benefits, not regain `full`.
    expect(await access(m, bkk('2026-03-03'))).toBe('terminated');
  });

  it('065 §5.2 review — a STALE prior-period invoice does NOT anchor the current period (member falls to the no-invoice backstop, not terminated)', async () => {
    // An ACTIVE member mid-current-period (awaiting_payment, expires_at in the
    // FUTURE) whose ONLY unpaid `issued` membership invoice is a STALE one
    // from a prior lapsed cycle — due ~13 months before this period's start.
    // Without the `sinceDueDate` floor the lapse cron would anchor on that
    // ancient invoice (due+60 long past) and terminate the member the day
    // after period-end, SKIPPING the 60-day grace on the current invoice. The
    // floor (`period_from − 60d = 2026-04-02`) excludes the stale invoice
    // (due 2025-05-01) → the bridge returns null → the member falls to the
    // `expires_at + grace` backstop, which has NOT elapsed.
    const m = await seedMember();
    await seedMembershipInvoice(m, '2025-05-01'); // stale: due+60 = 2025-06-30
    await seedAwaitingCycle(m, bkk('2027-06-01')); // period_from 2026-06-01, expires 2027-06-01

    const r = await runLapse(bkk('2026-07-15'));
    expect(r.deferredNoInvoiceBackstop).toBe(1);
    expect(r.graceExpired).toBe(0);
    expect(await cycleStatus(m)).toBe('awaiting_payment');
    expect(await access(m, bkk('2026-07-15'))).toBe('suspended');
  });

  it('065 §5.2 review — a stale invoice is IGNORED; the current-period invoice governs the due+60 clock (terminate)', async () => {
    // Same shape, but WITH a current-period invoice (due at period start) that
    // is now past due+60. The stale invoice is the OLDEST-due row, so without
    // the floor `ORDER BY due_date ASC LIMIT 1` would pick it; the floor
    // excludes it → the current invoice is the anchor → terminate at its
    // due+60, NOT the stale one's.
    const m = await seedMember();
    await seedMembershipInvoice(m, '2025-05-01'); // stale (excluded by the floor)
    await seedMembershipInvoice(m, '2026-06-01'); // current: due+60 = 2026-07-31
    await seedAwaitingCycle(m, bkk('2027-06-01')); // period_from 2026-06-01

    const r = await runLapse(bkk('2026-08-01')); // current due+61
    expect(r.graceExpired).toBe(1);
    expect(await cycleStatus(m)).toBe('lapsed');
    expect(await access(m, bkk('2026-08-01'))).toBe('terminated');
  });

  it('no-invoice backstop: terminates at expires_at + grace when the member has no membership invoice', async () => {
    const m = await seedMember();
    // No membership invoice → the `expires_at + grace_period_days` (60)
    // backstop governs. expires 2026-01-01; now 2026-03-03 is > 60 days past.
    await seedAwaitingCycle(m, bkk('2026-01-01'));

    const r = await runLapse(bkk('2026-03-03'));
    expect(r.graceExpired).toBe(1);
    expect(r.deferredNoInvoiceBackstop).toBe(0);
    expect(await cycleStatus(m)).toBe('lapsed');
    expect(await access(m, bkk('2026-03-03'))).toBe('terminated');
  });

  it('no-invoice backstop: defers while still inside expires_at + grace', async () => {
    const m = await seedMember();
    // expires 2026-01-01, grace 60 → backstop elapses ~2026-03-02. Run on
    // 2026-02-01 (31 days past expiry) → still inside grace → defer.
    await seedAwaitingCycle(m, bkk('2026-01-01'));

    const r = await runLapse(bkk('2026-02-01'));
    expect(r.deferredNoInvoiceBackstop).toBe(1);
    expect(r.graceExpired).toBe(0);
    expect(await cycleStatus(m)).toBe('awaiting_payment');
    expect(await access(m, bkk('2026-02-01'))).toBe('suspended');
  });
});
