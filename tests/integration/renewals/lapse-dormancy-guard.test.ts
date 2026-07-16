/**
 * 066 Round-2 §3.2(3) — the DORMANCY GUARD: "never terminate someone the
 * system never warned" (permanent invariant, due_plus_60 basis only).
 *
 * Geometry (review C1): born-awaiting cycles use expiresAt ~12 months out.
 * NOW is injected; bills are seeded due 70+ days ago so today > due+60.
 *
 * Cases:
 *  1. No statutory warning ever sent  → DEFER (deferred_no_prior_warning),
 *     cycle stays awaiting_payment, listed in deferredNoPriorWarningCycles.
 *  2. due+30.email sent ≥14d ago      → TERMINATE (renewal_lapsed audit
 *     carries termination_basis 'due_plus_60').
 *  3. Ladder t+7.email sent ≥14d ago  → accepted in lieu of due+30.email.
 *  4. due+30.email sent 5d ago        → still deferred (min-notice 14d).
 *  5. no_invoice_backstop basis is NOT guarded (never-invoiced cycle past
 *     expires_at + grace terminates without any due-track rows).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { tenantRenewalSettings } from '@/modules/renewals/infrastructure/schema-tenant-renewal-config';
import { lapseCyclesOnGraceExpiry, makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-30T08:00:00Z');
function dateOnly(msFromNow: number): string {
  return new Date(NOW.getTime() + msFromNow).toISOString().slice(0, 10);
}
/** Bill due 70 days before NOW → today > due+60 (terminate window open). */
const PAST_DUE_70 = dateOnly(-70 * MS_PER_DAY);

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Dormancy Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'dormancy@example.com',
};

interface CaseIds {
  memberId: string;
  cycleId: string;
}
function ids(): CaseIds {
  return { memberId: randomUUID(), cycleId: randomUUID() };
}

describe('066 lapse dormancy guard (live Neon)', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  let planId: string;

  const unwarned = ids(); // 1 — defer
  const warnedDue30 = ids(); // 2 — terminate
  const warnedLadder = ids(); // 3 — terminate (t+7.email accepted)
  const warnedLate = ids(); // 4 — defer (min-notice)
  const backstop = ids(); // 5 — terminate (no bill, basis unguarded)

  let seq = 930_000;
  function bill(memberId: string) {
    seq += 1;
    return {
      tenantId: tenantA.ctx.slug,
      invoiceId: randomUUID(),
      memberId,
      planYear: 2026,
      planId,
      draftByUserId: user.userId,
      status: 'issued' as const,
      dueDate: PAST_DUE_70,
      pdfDocKind: 'invoice' as const,
      fiscalYear: 2026,
      sequenceNumber: seq,
      documentNumber: `INV-2026-${seq}`,
      issueDate: dateOnly(-100 * MS_PER_DAY),
      currency: 'THB' as const,
      subtotalSatang: 5_000_000n,
      vatRateSnapshot: '0.0700',
      vatSatang: 350_000n,
      totalSatang: 5_350_000n,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'none',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: `invoicing/${tenantA.ctx.slug}/2026/${seq}.pdf`,
      pdfSha256: 'c'.repeat(64),
      pdfTemplateVersion: 1,
    };
  }

  function cycleRow(c: CaseIds, opts?: { expiresMs?: number; periodFromMs?: number }) {
    const periodFrom = new Date(NOW.getTime() + (opts?.periodFromMs ?? -100 * MS_PER_DAY));
    const expiresAt = new Date(NOW.getTime() + (opts?.expiresMs ?? 265 * MS_PER_DAY));
    return {
      tenantId: tenantA.ctx.slug,
      cycleId: c.cycleId,
      memberId: c.memberId,
      status: 'awaiting_payment' as const,
      periodFrom,
      periodTo: expiresAt,
      expiresAt,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular' as const,
      planIdAtCycleStart: randomUUID(),
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB' as const,
    };
  }

  function sentWarning(c: CaseIds, stepId: string, dispatchedMsFromNow: number) {
    return {
      tenantId: tenantA.ctx.slug,
      reminderEventId: randomUUID(),
      cycleId: c.cycleId,
      stepId,
      channel: 'email',
      templateId: stepId.startsWith('due+') ? 'due-track' : 'renewal.t+7.regular',
      status: 'sent',
      dispatchedAt: new Date(NOW.getTime() + dispatchedMsFromNow),
      yearInCycle: 1,
    };
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    planId = `f8-dorm-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenantA.ctx, async (tx) => {
      await tx
        .insert(tenantRenewalSettings)
        .values({
          tenantId: tenantA.ctx.slug,
          gracePeriodDays: 14,
          autoUpgradeEnabled: true,
          minTenureDaysForAtRisk: 30,
          dispatchCronEnabled: true,
        })
        .onConflictDoNothing();
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Dormancy Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      for (const [c, name] of [
        [unwarned, 'Unwarned Co'],
        [warnedDue30, 'Warned Due30 Co'],
        [warnedLadder, 'Warned Ladder Co'],
        [warnedLate, 'Warned Late Co'],
        [backstop, 'Backstop Co'],
      ] as const) {
        await tx.insert(members).values({
          tenantId: tenantA.ctx.slug,
          memberId: c.memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: name,
          country: 'TH',
          planId,
          planYear: 2026,
        });
      }
      await tx.insert(renewalCycles).values([
        cycleRow(unwarned),
        cycleRow(warnedDue30),
        cycleRow(warnedLadder),
        cycleRow(warnedLate),
        // Backstop: never invoiced; expired 30d ago; grace 14d → past
        // expires_at + grace → terminates on the (unguarded) backstop.
        cycleRow(backstop, { periodFromMs: -395 * MS_PER_DAY, expiresMs: -30 * MS_PER_DAY }),
      ]);
      await tx.insert(invoices).values([
        bill(unwarned.memberId),
        bill(warnedDue30.memberId),
        bill(warnedLadder.memberId),
        bill(warnedLate.memberId),
        // backstop: NO bill.
      ]);
      await tx.insert(renewalReminderEvents).values([
        sentWarning(warnedDue30, 'due+30.email', -20 * MS_PER_DAY),
        sentWarning(warnedLadder, 't+7.email', -20 * MS_PER_DAY),
        sentWarning(warnedLate, 'due+30.email', -5 * MS_PER_DAY), // < 14d notice
      ]);
    });
  }, 180_000);

  afterAll(async () => {
    for (const table of [
      renewalReminderEvents,
      invoices,
      renewalCycles,
      members,
      auditLog,
    ] as const) {
      await db
        .delete(table)
        .where(eq(table.tenantId, tenantA.ctx.slug))
        .catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
  }, 120_000);

  it('guards due_plus_60, accepts either warning source, enforces min-notice, leaves the backstop unguarded', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await lapseCyclesOnGraceExpiry(deps, {
      tenantId: tenantA.ctx.slug,
      now: NOW,
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Counters: 2 deferred by the guard (unwarned + warnedLate);
    // 3 terminations (warnedDue30 + warnedLadder due_plus_60, backstop).
    expect(r.value.deferredNoPriorWarning).toBe(2);
    expect(r.value.graceExpired).toBe(3);
    expect(
      r.value.deferredNoPriorWarningCycles.map((d) => d.cycleId).sort(),
    ).toEqual([unwarned.cycleId, warnedLate.cycleId].sort());
    expect(
      r.value.deferredNoPriorWarningCycles.find((d) => d.cycleId === unwarned.cycleId)
        ?.memberId,
    ).toBe(unwarned.memberId);

    const statusOf = async (cycleId: string) => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select({ status: renewalCycles.status })
          .from(renewalCycles)
          .where(
            and(
              eq(renewalCycles.tenantId, tenantA.ctx.slug),
              eq(renewalCycles.cycleId, cycleId),
            ),
          ),
      );
      return rows[0]?.status;
    };
    expect(await statusOf(unwarned.cycleId)).toBe('awaiting_payment');
    expect(await statusOf(warnedLate.cycleId)).toBe('awaiting_payment');
    expect(await statusOf(warnedDue30.cycleId)).toBe('lapsed');
    expect(await statusOf(warnedLadder.cycleId)).toBe('lapsed');
    expect(await statusOf(backstop.cycleId)).toBe('lapsed');

    // Audit basis on the due_plus_60 termination.
    const lapsedAudits = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantA.ctx.slug),
            eq(auditLog.eventType, 'renewal_lapsed'),
          ),
        ),
    );
    const forWarned = lapsedAudits.find(
      (a) => (a.payload as { cycle_id?: string }).cycle_id === warnedDue30.cycleId,
    );
    expect(forWarned).toBeDefined();
    expect((forWarned!.payload as { termination_basis?: string }).termination_basis).toBe(
      'due_plus_60',
    );
    const forBackstop = lapsedAudits.find(
      (a) => (a.payload as { cycle_id?: string }).cycle_id === backstop.cycleId,
    );
    expect(forBackstop).toBeDefined();
    expect(
      (forBackstop!.payload as { termination_basis?: string }).termination_basis,
    ).toBe('no_invoice_backstop');
  }, 120_000);
});
