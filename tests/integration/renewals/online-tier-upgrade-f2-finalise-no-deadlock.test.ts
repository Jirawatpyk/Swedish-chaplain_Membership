/**
 * ONLINE tier-upgrade rail — the F2 scheduled-plan-change finaliser must NOT
 * self-deadlock, and the `plan_change_applied` audit MUST land. Live Neon
 * Singapore via .env.local.
 *
 * THE BUG (verified): on the ONLINE tier-upgrade payment rail the F2
 * scheduled-plan-change finaliser used to run IN-CALLBACK (inside F4's
 * `recordPayment` tx, via `f8OnPaidCallbacks[1]`), on a SEPARATE `runInTenant`
 * connection. The outer tx already holds an exclusive lock on the member row
 * (the tier-upgrade apply's `tier_upgrade_applied_at_renewal` audit +
 * `members.plan_id` write both fire the `members_audit_bump_last_activity`
 * trigger). The finaliser's own connection then INSERTs the `plan_change_applied`
 * audit — whose `member_id` payload re-fires that same trigger, which blocks on
 * the outer tx's member-row lock. The outer tx is parked in a JS `await`, so
 * Postgres cannot detect the cycle: in production it resolves only at
 * `statement_timeout=5s` (a ~5s webhook stall) AND leaves a SILENTLY missing
 * `plan_change_applied` audit on every online tier-upgrade renewal that has a
 * real pending `scheduled_plan_changes` row.
 *
 * THE OMISSION THIS TEST CLOSES: `tier-upgrade-reaches-billing.test.ts`
 * DELIBERATELY omits the `scheduled_plan_changes` row (its header, lines 28-38)
 * precisely to dodge this deadlock. This test ADDS that row — the real shape
 * `acceptTierUpgrade` writes — so the finaliser actually runs.
 *
 * THE FIX: the in-callback finaliser is removed (callback[1] only does the
 * atomic in-tx apply); the finaliser runs POST-commit instead — the same
 * structural point `mark-paid-offline.ts` already uses. Post-commit the outer
 * tx has released the member-row lock, so the finaliser's audit INSERT can no
 * longer deadlock.
 *
 * TEST SHAPE: drive the in-tx callback chain (`f8OnPaidCallbacks`) exactly like
 * the real F4 `recordPayment` fires them, THEN run the post-commit finaliser
 * (mirroring what `confirmPayment` / `markPaidOffline` do after the settlement
 * tx commits). ASSERT the `plan_change_applied` audit row exists for the member.
 *
 * ENV NOTE — the pooled Neon **dev** endpoint reports `statement_timeout=0`
 * (the connection-level 5s from `src/lib/db.ts` is dropped by the pooler), so
 * the self-deadlock would hang forever instead of resolving at 5s. A watchdog
 * reproduces the prod `statement_timeout` deterministically + with ZERO blast
 * radius: it cancels ONLY backends that THIS test's driving tx blocks (via
 * `pg_blocking_pids` keyed on the driver's own `pg_backend_pid`), which on
 * current code is exactly the finaliser's stuck audit INSERT and on fixed code
 * is nothing.
 *
 * RED on current code: the in-callback finaliser's `transitionStatus` flips
 * `scheduled_plan_changes.status` → applied on its own connection BEFORE the
 * audit INSERT (which the watchdog cancels, standing in for statement_timeout);
 * the finaliser swallows the cancel, so the post-commit finaliser finds NO
 * pending row and no-ops → `plan_change_applied` stays ABSENT (primary
 * assertion fails) and the watchdog had to cancel a deadlocked backend
 * (secondary assertion fails).
 *
 * GREEN after the fix: callback[1] no longer finalises in-callback, so the
 * `scheduled_plan_changes` row stays `pending` through the tx; the watchdog
 * cancels nothing (no deadlock); the post-commit finaliser then flips it →
 * applied + emits `plan_change_applied`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { tierUpgradeSuggestions } from '@/modules/renewals/infrastructure/schema-tier-upgrade-suggestions';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { scheduledPlanChanges } from '@/modules/plans/infrastructure/db/schema-scheduled-plan-changes';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  makeRenewalsDeps,
  f8OnPaidCallbacks,
  finaliseF2PlanChangeOnPaid,
  defaultOnlineF2Actor,
} from '@/modules/renewals';
import { asSuggestionId, type SuggestionId } from '@/modules/renewals/domain/tier-upgrade-suggestion';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const REGULAR_FEE_MINOR = 5_000_000; // 50,000.00 THB
const PREMIUM_FEE_MINOR = 9_000_000; // 90,000.00 THB

const PRIOR_PERIOD_FROM = new Date('2026-06-01T00:00:00.000Z');
const PRIOR_PERIOD_TO = new Date('2027-06-01T00:00:00.000Z');

interface UpgradeScenario {
  readonly memberId: string;
  readonly cycleId: string;
  readonly suggestionId: SuggestionId;
  readonly invoiceId: string;
}

describe('ONLINE tier-upgrade F2 finalise — no self-deadlock, audit lands', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  /**
   * Seed a member on 'regular' with a terminal predecessor (so the paying
   * cycle classifies as `renewal`), an awaiting_payment cycle on 'regular'
   * linked to a seeded issued invoice, a regular→premium suggestion in
   * `accepted_pending_apply`, AND — unlike tier-upgrade-reaches-billing — the
   * F2 `scheduled_plan_changes` pending row that `acceptTierUpgrade` writes.
   * That pending row is what makes the finaliser actually run (and, on current
   * code, deadlock).
   */
  async function seedAcceptedUpgradeWithScheduledChange(): Promise<UpgradeScenario> {
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const suggestionUuid = randomUUID();
    const invoiceId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Deadlock Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId: 'regular',
        planYear: 2026,
        turnoverThb: 120_000_000,
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Tier',
        lastName: 'Upgrade',
        email: `tuf-${memberId.slice(0, 8)}@example.com`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'cancelled',
        periodFrom: new Date('2024-01-01T00:00:00.000Z'),
        periodTo: new Date('2025-01-01T00:00:00.000Z'),
        expiresAt: new Date('2025-01-01T00:00:00.000Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date('2024-01-01T00:00:00.000Z'),
        closedAt: new Date('2025-01-01T00:00:00.000Z'),
        closedReason: 'cancelled',
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: 'regular',
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: admin.userId,
        fiscalYear: 2026,
        sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
        documentNumber: `INV-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        issueDate: '2026-05-15',
        dueDate: '2026-06-14',
        currency: 'THB',
        subtotalSatang: asSatang(5_000_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(350_000n),
        totalSatang: asSatang(5_350_000n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'Deadlock Co',
          country: 'TH',
          legal_name: 'Deadlock Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Tier Upgrade',
          primary_contact_email: 'tuf@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: PRIOR_PERIOD_FROM,
        periodTo: PRIOR_PERIOD_TO,
        expiresAt: PRIOR_PERIOD_TO,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        linkedInvoiceId: invoiceId,
      });
      await tx.insert(tierUpgradeSuggestions).values({
        tenantId: tenant.ctx.slug,
        suggestionId: suggestionUuid,
        memberId,
        fromPlanId: 'regular',
        toPlanId: 'premium',
        reasonCode: 'declared_turnover_above_threshold',
        evidenceJsonb: {
          reasonCode: 'declared_turnover_above_threshold',
          turnoverThb: 120_000_000,
          thresholdMetAt: new Date().toISOString(),
        },
        status: 'accepted_pending_apply',
        acceptedAt: new Date(),
        acceptedByUserId: admin.userId,
        targetApplyAtCycleId: cycleId,
      });
      // The F2 pending row acceptTierUpgrade writes. `reason` carries the
      // `tier_upgrade_accepted:<suggestionId>` prefix so the finaliser's
      // per-row gate resolves the linked suggestion.
      await tx.insert(scheduledPlanChanges).values({
        tenantId: tenant.ctx.slug,
        scheduledChangeId: randomUUID(),
        memberId,
        effectiveAtCycleId: cycleId,
        fromPlanId: 'regular',
        toPlanId: 'premium',
        scheduledByUserId: admin.userId,
        reason: `tier_upgrade_accepted:${suggestionUuid}`,
        status: 'pending',
      });
    });

    return {
      memberId,
      cycleId,
      suggestionId: asSuggestionId(suggestionUuid),
      invoiceId,
    };
  }

  function buildPaidEvent(scenario: UpgradeScenario): F4InvoicePaidEvent {
    return {
      tenantId: tenant.ctx.slug,
      invoiceId: scenario.invoiceId,
      memberId: scenario.memberId,
      paidAt: new Date('2026-06-05T09:00:00.000Z').toISOString(),
      amountSatang: asSatang(5_350_000n),
      vatSatang: asSatang(350_000n),
      currency: 'THB',
      paymentMethod: 'stripe_card',
      triggeredBy: 'webhook',
      invoiceSubject: 'membership',
      paymentDate: null,
    };
  }

  async function planChangeAppliedAuditForMember(memberId: string): Promise<boolean> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'plan_change_applied'),
          ),
        ),
    );
    return rows.some(
      (r) => (r.payload as { member_id?: string } | null)?.member_id === memberId,
    );
  }

  /**
   * Drive the in-tx callback chain with a watchdog that stands in for the prod
   * `statement_timeout` the pooled dev endpoint drops to 0. Returns how many
   * backends the watchdog had to cancel: 0 = no self-deadlock (fixed code),
   * ≥1 = the in-callback finaliser deadlocked (current code).
   */
  async function driveCallbacksWithDeadlockWatchdog(
    evt: F4InvoicePaidEvent,
  ): Promise<number> {
    const callbacks = f8OnPaidCallbacks(tenant.ctx.slug);
    let driverPid: number | null = null;
    let driveDone = false;
    let cancelled = 0;

    const drivePromise = runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT pg_backend_pid() AS pid`,
      )) as unknown as Array<{ pid: number }>;
      driverPid = Number(rows[0]!.pid);
      for (const cb of callbacks) {
        await cb(evt, tx);
      }
    }).finally(() => {
      driveDone = true;
    });

    const deadline = Date.now() + 25_000;
    while (!driveDone && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      if (driverPid === null || driveDone) continue;
      // Cancel ONLY backends blocked by our own driving tx (keyed on its
      // pg_backend_pid) — on current code that is precisely the finaliser's
      // stuck audit INSERT; on fixed code this set is always empty.
      const blocked = (await db.execute(
        sql`SELECT pid FROM pg_stat_activity
            WHERE datname = current_database()
              AND ${driverPid} = ANY (pg_blocking_pids(pid))`,
      )) as unknown as Array<{ pid: number }>;
      for (const b of blocked) {
        await db.execute(sql`SELECT pg_cancel_backend(${Number(b.pid)})`);
        cancelled += 1;
      }
    }
    await drivePromise;
    return cancelled;
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: 'regular',
        planName: { en: 'Regular' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
        annualFeeMinorUnits: REGULAR_FEE_MINOR,
        minTurnoverMinorUnits: 50_000_000,
        renewalTierBucket: 'regular',
      }),
    );
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: 'premium',
        planName: { en: 'Premium' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
        annualFeeMinorUnits: PREMIUM_FEE_MINOR,
        minTurnoverMinorUnits: 100_000_000,
        renewalTierBucket: 'premium',
      }),
    );
  }, 180_000);

  afterAll(async () => {
    for (const q of [
      db.delete(scheduledPlanChanges).where(eq(scheduledPlanChanges.tenantId, tenant.ctx.slug)),
      db.delete(tierUpgradeSuggestions).where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug)),
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
      db.delete(contacts).where(eq(contacts.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
      db.delete(membershipPlans).where(eq(membershipPlans.tenantId, tenant.ctx.slug)),
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    for (const q of [
      db.delete(scheduledPlanChanges).where(eq(scheduledPlanChanges.tenantId, tenant.ctx.slug)),
      db.delete(tierUpgradeSuggestions).where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug)),
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
      db.delete(contacts).where(eq(contacts.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
  });

  it('finalises the pending scheduled_plan_change (plan_change_applied lands) with no self-deadlock', async () => {
    const scenario = await seedAcceptedUpgradeWithScheduledChange();
    const evt = buildPaidEvent(scenario);

    // In-tx half of the rail — exactly how F4 `recordPayment` fires the
    // callbacks (inside one tenant tx that holds the member-row lock).
    const cancelledBackends = await driveCallbacksWithDeadlockWatchdog(evt);

    // Post-commit half of the rail — the SAME structural point `confirmPayment`
    // (webhook) and `markPaidOffline` (admin) finalise from, once the settlement
    // tx has committed and the member-row lock is released.
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    await finaliseF2PlanChangeOnPaid(
      deps,
      evt,
      scenario.cycleId,
      defaultOnlineF2Actor(evt),
    );

    // PRIMARY: the F2 `plan_change_applied` audit MUST exist for the member. On
    // current code the in-callback finaliser deadlocks (its audit INSERT is
    // cancelled) AFTER flipping the row → applied on its own connection, so the
    // post-commit finaliser finds no pending row and this row never lands.
    const applied = await planChangeAppliedAuditForMember(scenario.memberId);
    expect(
      applied,
      'plan_change_applied audit must land for the online tier-upgrade renewal',
    ).toBe(true);

    // SECONDARY: the in-tx callback drive must NOT have self-deadlocked — the
    // watchdog cancels a backend only when the in-callback finaliser is stuck.
    expect(
      cancelledBackends,
      'the in-tx callback drive must not self-deadlock (the finaliser must run post-commit, not in-callback)',
    ).toBe(0);
  }, 120_000);
});
