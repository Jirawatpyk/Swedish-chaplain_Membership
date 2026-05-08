/**
 * F8 Phase 6 Wave F · T175 — at-risk snooze + outreach (live Neon).
 *
 * Verifies the FR-032 snooze flow + FR-033 outreach + FR-052a manager
 * exception against a live Neon ap-southeast-1 tenant. Test scope:
 *
 *   1. Snooze hides member from widget query for `duration_days`
 *      (members.risk_snoozed_until in future ⇒ excluded).
 *   2. Snooze auto-expires — when `risk_snoozed_until < NOW()`, the
 *      member reappears in the widget query.
 *   3. Manager records outreach successfully (FR-052a manager exception)
 *      — at_risk_outreach row inserted + at_risk_outreach_recorded
 *      audit emitted with actor_role='manager'.
 *   4. Manager attempts snooze → use-case-layer 403 (defence-in-depth
 *      for the route-helper guard) — the use-case rejects the
 *      `actorRole: 'manager'` literal at zod parse time.
 *   5. Outreach insert is auto-picked up by the existing
 *      pause-reminders-after-outreach use-case (Phase 4 T092 — already
 *      covered by reminder-pause-after-outreach.test.ts; this file
 *      just verifies the INSERT side of the contract).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { atRiskOutreach } from '@/modules/renewals/infrastructure/schema-at-risk-outreach';
import {
  snoozeAtRiskMember,
  recordAtRiskOutreach,
  makeRenewalsDeps,
  pauseRemindersAfterOutreach,
} from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW_MS = Date.now();
const PERIOD_FROM = new Date(NOW_MS - 30 * MS_PER_DAY);
const PERIOD_TO = new Date(NOW_MS + 30 * MS_PER_DAY);

interface SeededMember {
  readonly memberId: string;
  readonly cycleId: string;
}

async function seedAtRiskMember(
  tenant: TestTenant,
  user: TestUser,
  opts: { riskScore: number; riskScoreBand: 'warning' | 'at-risk' | 'critical' },
): Promise<SeededMember> {
  const memberId = randomUUID();
  const cycleId = randomUUID();
  const planId = `f8-snooze-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, async (tx) => {
    await seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'Snooze Plan' },
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    });
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: 'Snooze Co',
      country: 'TH',
      planId,
      planYear: 2026,
      riskScore: opts.riskScore,
      riskScoreBand: opts.riskScoreBand,
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Test',
      lastName: 'Person',
      email: `snooze-${randomUUID().slice(0, 6)}@acme.example`,
      isPrimary: true,
      preferredLanguage: 'en',
    });
    await tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      status: 'upcoming',
      periodFrom: PERIOD_FROM,
      periodTo: PERIOD_TO,
      expiresAt: PERIOD_TO,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: randomUUID(),
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
    });
  });
  return { memberId, cycleId };
}

describe('F8 at-risk snooze + outreach — integration (T175)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let manager: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    manager = await createActiveTestUser('manager');
    tenant = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenant.ctx);
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(atRiskOutreach)
      .where(eq(atRiskOutreach.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    await db
      .delete(atRiskOutreach)
      .where(eq(atRiskOutreach.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
  });

  it('snooze hides member from widget query (risk_snoozed_until in future)', async () => {
    const seeded = await seedAtRiskMember(tenant, admin, {
      riskScore: 78,
      riskScoreBand: 'critical',
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // Pre-snooze: widget query returns member.
    const before = await runInTenant(tenant.ctx, (tx) =>
      deps.memberRenewalFlagsRepo.listAtRiskWidgetMembers(tx, tenant.ctx.slug, {
        limit: 50,
      }),
    );
    expect(before.items.some((m) => m.memberId === seeded.memberId)).toBe(true);

    // Snooze 30 days.
    const snooze = await snoozeAtRiskMember(deps, {
      tenantId: tenant.ctx.slug,
      memberId: seeded.memberId,
      durationDays: 30,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(snooze.ok).toBe(true);

    // Post-snooze: widget query excludes member (snoozed > now).
    const after = await runInTenant(tenant.ctx, (tx) =>
      deps.memberRenewalFlagsRepo.listAtRiskWidgetMembers(tx, tenant.ctx.slug, {
        limit: 50,
      }),
    );
    expect(after.items.some((m) => m.memberId === seeded.memberId)).toBe(
      false,
    );

    // Verify members.risk_snoozed_until persisted.
    const memberRow = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ snoozedUntil: members.riskSnoozedUntil })
        .from(members)
        .where(eq(members.memberId, seeded.memberId))
        .limit(1),
    );
    expect(memberRow[0]?.snoozedUntil).not.toBeNull();
    expect(memberRow[0]?.snoozedUntil!.getTime()).toBeGreaterThan(NOW_MS);

    // at_risk_snoozed audit emitted.
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'at_risk_snoozed' as never),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('snooze auto-expires — past timestamp lets member reappear in widget', async () => {
    const seeded = await seedAtRiskMember(tenant, admin, {
      riskScore: 80,
      riskScoreBand: 'critical',
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // Manually set risk_snoozed_until to 1 day in the past (simulates
    // a snooze that's already expired). The widget query treats this
    // as "no active snooze" and surfaces the member.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(members)
        .set({ riskSnoozedUntil: new Date(NOW_MS - MS_PER_DAY) })
        .where(eq(members.memberId, seeded.memberId));
    });

    const widget = await runInTenant(tenant.ctx, (tx) =>
      deps.memberRenewalFlagsRepo.listAtRiskWidgetMembers(tx, tenant.ctx.slug, {
        limit: 50,
      }),
    );
    expect(widget.items.some((m) => m.memberId === seeded.memberId)).toBe(
      true,
    );
  }, 60_000);

  it('manager records outreach (FR-052a exception) — INSERT + audit succeed', async () => {
    const seeded = await seedAtRiskMember(tenant, manager, {
      riskScore: 65,
      riskScoreBand: 'at-risk',
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const r = await recordAtRiskOutreach(deps, {
      tenantId: tenant.ctx.slug,
      memberId: seeded.memberId,
      channel: 'phone',
      outcomeNote: 'Manager spoke with the executive director.',
      actorUserId: manager.userId,
      actorRole: 'manager',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Outreach row inserted.
    const outreachRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(atRiskOutreach)
        .where(
          and(
            eq(atRiskOutreach.tenantId, tenant.ctx.slug),
            eq(atRiskOutreach.memberId, seeded.memberId),
          ),
        ),
    );
    expect(outreachRows).toHaveLength(1);
    expect(outreachRows[0]?.channel).toBe('phone');
    expect(outreachRows[0]?.actorUserId).toBe(manager.userId);

    // Audit row emitted with actor_role='manager'.
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'at_risk_outreach_recorded' as never),
        ),
      );
    const matchingAudit = audits.find(
      (a) =>
        (a.payload as Record<string, unknown> | null)?.member_id ===
        seeded.memberId,
    );
    expect(matchingAudit).toBeDefined();
    expect(
      (matchingAudit?.payload as Record<string, unknown>)?.actor_role,
    ).toBe('manager');
  }, 60_000);

  it('manager attempts snooze → use-case-layer 403 (zod literal rejects "manager")', async () => {
    const seeded = await seedAtRiskMember(tenant, manager, {
      riskScore: 60,
      riskScoreBand: 'at-risk',
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const r = await snoozeAtRiskMember(deps, {
      tenantId: tenant.ctx.slug,
      memberId: seeded.memberId,
      durationDays: 30,
      actorUserId: manager.userId,
      // Cast to bypass TS literal — simulate a manager-bypass attempt.
      actorRole: 'manager' as unknown as 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');

    // Verify no UPDATE happened — risk_snoozed_until is still NULL.
    const memberRow = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ snoozedUntil: members.riskSnoozedUntil })
        .from(members)
        .where(eq(members.memberId, seeded.memberId))
        .limit(1),
    );
    expect(memberRow[0]?.snoozedUntil).toBeNull();
  }, 60_000);

  it('outreach insert is picked up by pause-reminders read (FR-033 cascade)', async () => {
    const seeded = await seedAtRiskMember(tenant, admin, {
      riskScore: 72,
      riskScoreBand: 'at-risk',
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // Pre-outreach: pause check returns paused=false.
    const beforeOutreach = await pauseRemindersAfterOutreach(deps, {
      tenantId: tenant.ctx.slug,
      memberId: seeded.memberId,
    });
    expect(beforeOutreach.ok).toBe(true);
    if (beforeOutreach.ok) expect(beforeOutreach.value.paused).toBe(false);

    // Record outreach.
    const r = await recordAtRiskOutreach(deps, {
      tenantId: tenant.ctx.slug,
      memberId: seeded.memberId,
      channel: 'meeting',
      outcomeNote: 'In-person meeting at the chamber.',
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);

    // Post-outreach: pause check returns paused=true.
    const afterOutreach = await pauseRemindersAfterOutreach(deps, {
      tenantId: tenant.ctx.slug,
      memberId: seeded.memberId,
    });
    expect(afterOutreach.ok).toBe(true);
    if (afterOutreach.ok) expect(afterOutreach.value.paused).toBe(true);
  }, 60_000);
});
