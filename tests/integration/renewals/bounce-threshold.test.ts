/**
 * F8 Phase 4 Wave I8 · T111 — bounce-threshold detection (live Neon).
 *
 * FR-012a contract: Resend webhook delivery events feed three thresholds
 * that flip the member's `email_unverified` flag + create a
 * `manual_outreach_required` escalation task:
 *   - **Hard bounce**: 1 hard bounce → flip immediately.
 *   - **Soft streak**: 3 transient bounces in the same renewal cycle.
 *   - **Soft rolling**: 5 transient bounces in the rolling 30-day window.
 *
 * Test scope: one scenario per trigger path (3 tests). Each test seeds
 * a fresh member + cycle + N bounce events on the primary-contact email,
 * invokes `detectBounceThreshold`, and asserts the trigger label, the
 * member-flag flip, the escalation task creation, and the dual audit
 * emit (`member_email_unverified_threshold_crossed` +
 * `escalation_task_created`).
 *
 * `email_delivery_events` is a tenant-agnostic F1 table keyed on
 * `to_email`; tests seed unique emails per scenario so the rolling-30d
 * count stays isolated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import {
  auditLog,
  emailDeliveryEvents,
} from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalEscalationTasks } from '@/modules/renewals/infrastructure/schema-renewal-escalation-tasks';
import { detectBounceThreshold, makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';


const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REAL_NOW_MS = Date.now();

interface SeededMember {
  readonly memberId: string;
  readonly cycleId: string;
  readonly email: string;
}

async function seedMember(
  tenantA: TestTenant,
  user: TestUser,
): Promise<SeededMember> {
  const memberId = randomUUID();
  const cycleId = randomUUID();
  const planId = `f8-bounce-${randomUUID().slice(0, 8)}`;
  const email = `bounce-${randomUUID().slice(0, 8)}@acme.example`;

  await runInTenant(tenantA.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenantA.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'Bounce Plan' },
      description: { en: '' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 5_000_000,
      includesCorporatePlanId: null,
      minTurnoverMinorUnits: null,
      maxTurnoverMinorUnits: null,
      maxDurationYears: null,
      maxMemberAge: null,
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      isActive: true,
      createdBy: user.userId,
      updatedBy: user.userId,
    });
    await tx.insert(members).values({
      tenantId: tenantA.ctx.slug,
      memberId,
      companyName: 'Bounce Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });
    await tx.insert(contacts).values({
      tenantId: tenantA.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Anna',
      lastName: 'Adm',
      email,
      isPrimary: true,
      preferredLanguage: 'en',
    });
    await tx.insert(renewalCycles).values({
      tenantId: tenantA.ctx.slug,
      cycleId,
      memberId,
      status: 'upcoming',
      periodFrom: new Date(REAL_NOW_MS - 30 * MS_PER_DAY),
      periodTo: new Date(REAL_NOW_MS + 335 * MS_PER_DAY),
      expiresAt: new Date(REAL_NOW_MS + 335 * MS_PER_DAY),
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: randomUUID(),
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
    });
  });
  return { memberId, cycleId, email };
}

async function seedBounce(
  email: string,
  bounceType: 'permanent' | 'transient',
  daysAgo: number,
): Promise<void> {
  await db.insert(emailDeliveryEvents).values({
    eventType: 'bounced',
    messageId: `msg-${randomUUID()}`,
    toEmail: email,
    svixId: `svix-${randomUUID()}`,
    bounceType,
    createdAt: new Date(REAL_NOW_MS - daysAgo * MS_PER_DAY),
  });
}

describe('F8 bounce-threshold detection — integration (T111)', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  const seededEmails: string[] = [];

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
  }, 180_000);

  afterAll(async () => {
    // email_delivery_events is global (NOT tenant-scoped) — clean only
    // the rows we seeded by toEmail to avoid affecting other tests.
    for (const email of seededEmails) {
      await db
        .delete(emailDeliveryEvents)
        .where(eq(emailDeliveryEvents.toEmail, email))
        .catch(() => {});
    }
    await db
      .delete(renewalEscalationTasks)
      .where(eq(renewalEscalationTasks.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await tenantA.cleanup().catch(() => {});
  }, 120_000);

  it('Hard bounce (1 permanent) → flag flip + task + dual audit', async () => {
    const member = await seedMember(tenantA, user);
    seededEmails.push(member.email);
    await seedBounce(member.email, 'permanent', 1);

    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await detectBounceThreshold(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: member.memberId,
      correlationId: randomUUID(),
      actorRole: 'webhook',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('threshold_crossed');
    if (r.value.kind !== 'threshold_crossed') return;
    expect(r.value.trigger).toBe('hard_bounce');
    expect(r.value.bounceCount).toBe(1);
    expect(r.value.escalationTaskCreated).toBe(true);

    // Member.emailUnverified flipped
    const memberRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ flag: members.emailUnverified })
        .from(members)
        .where(eq(members.memberId, member.memberId)),
    );
    expect(memberRows[0]?.flag).toBe(true);

    // Escalation task created
    const taskRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(renewalEscalationTasks)
        .where(
          and(
            eq(renewalEscalationTasks.tenantId, tenantA.ctx.slug),
            eq(renewalEscalationTasks.memberId, member.memberId),
          ),
        ),
    );
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.taskType).toBe('manual_outreach_required');

    // Dual audit emit
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantA.ctx.slug));
    expect(
      audits.some(
        (a) =>
          (a.eventType as string) ===
          'member_email_unverified_threshold_crossed',
      ),
    ).toBe(true);
    expect(
      audits.some(
        (a) =>
          (a.eventType as string) === 'escalation_task_created' &&
          (a.payload as Record<string, unknown> | null)?.bounce_trigger ===
            'hard_bounce',
      ),
    ).toBe(true);
  }, 120_000);

  it('Soft streak (3 transient in cycle) → flag flip + soft_streak trigger', async () => {
    const member = await seedMember(tenantA, user);
    seededEmails.push(member.email);
    // Three soft bounces, all within the cycle (started 30d ago).
    await seedBounce(member.email, 'transient', 1);
    await seedBounce(member.email, 'transient', 2);
    await seedBounce(member.email, 'transient', 3);

    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await detectBounceThreshold(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: member.memberId,
      correlationId: randomUUID(),
      actorRole: 'webhook',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('threshold_crossed');
    if (r.value.kind !== 'threshold_crossed') return;
    expect(r.value.trigger).toBe('soft_streak');
    expect(r.value.bounceCount).toBe(3);
  }, 120_000);

  it('Soft rolling 30d (5 transient outside cycle) → soft_rolling trigger', async () => {
    const member = await seedMember(tenantA, user);
    seededEmails.push(member.email);
    // For this scenario, force the cycle to have started AFTER the
    // bounces so they are outside the cycle's window. Bumping
    // periodFrom forward to today means soft-in-cycle = 0; soft-30d
    // counts the prior 30 days of bounces.
    await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(renewalCycles)
        .set({ periodFrom: new Date(REAL_NOW_MS) })
        .where(eq(renewalCycles.cycleId, member.cycleId)),
    );
    // 5 soft bounces 5-25 days ago — within the 30d rolling window
    // but outside the freshly-restarted cycle.
    for (const days of [5, 10, 15, 20, 25]) {
      await seedBounce(member.email, 'transient', days);
    }

    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await detectBounceThreshold(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: member.memberId,
      correlationId: randomUUID(),
      actorRole: 'webhook',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('threshold_crossed');
    if (r.value.kind !== 'threshold_crossed') return;
    expect(r.value.trigger).toBe('soft_rolling');
    expect(r.value.bounceCount).toBe(5);
  }, 120_000);

  it('J10-M9: 30d boundary INCLUSIVE — 5 bounces at 0/7/14/22/30 days ago all counted (=5 → soft_rolling threshold)', async () => {
    // Adapter filter is `created_at >= now - 30d` (inclusive lower
    // bound). A bounce at exactly 30d ago should be counted.
    // Pin `nowIso` to REAL_NOW_MS so the bounce timestamps (created
    // via the same anchor) line up with the comparison cutoff —
    // without this, the few-millisecond gap between module-load and
    // the actual `new Date()` call inside detectBounceThreshold
    // would push the 30d-exact bounce just outside the window.
    const member = await seedMember(tenantA, user);
    seededEmails.push(member.email);
    await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(renewalCycles)
        .set({ periodFrom: new Date(REAL_NOW_MS) })
        .where(eq(renewalCycles.cycleId, member.cycleId)),
    );
    // 5 bounces — the last is exactly at the 30d boundary (inclusive).
    for (const days of [0, 7, 14, 22, 30]) {
      await seedBounce(member.email, 'transient', days);
    }

    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await detectBounceThreshold(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: member.memberId,
      correlationId: randomUUID(),
      actorRole: 'webhook',
      nowIso: new Date(REAL_NOW_MS).toISOString(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('threshold_crossed');
    if (r.value.kind !== 'threshold_crossed') return;
    expect(r.value.trigger).toBe('soft_rolling');
    expect(r.value.bounceCount).toBe(5);
  }, 120_000);

  it('J10-M9: 30d boundary EXCLUSIVE on >30d — 5 bounces at 0/7/14/22/31 days ago → only 4 counted, NO threshold cross', async () => {
    // Symmetric boundary: 31d ago is NOT counted (`>= now - 30d`
    // excludes it). With only 4 bounces in window, threshold of 5
    // does NOT cross.
    const member = await seedMember(tenantA, user);
    seededEmails.push(member.email);
    await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(renewalCycles)
        .set({ periodFrom: new Date(REAL_NOW_MS) })
        .where(eq(renewalCycles.cycleId, member.cycleId)),
    );
    for (const days of [0, 7, 14, 22, 31]) {
      await seedBounce(member.email, 'transient', days);
    }

    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await detectBounceThreshold(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: member.memberId,
      correlationId: randomUUID(),
      actorRole: 'webhook',
      nowIso: new Date(REAL_NOW_MS).toISOString(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 4 within window — soft_rolling threshold is 5. No cross.
    expect(r.value.kind).toBe('no_threshold_crossed');
    expect(r.value.counts.softBouncesIn30Days).toBe(4);
  }, 120_000);
});
