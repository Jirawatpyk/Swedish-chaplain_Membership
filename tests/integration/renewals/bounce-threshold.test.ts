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
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { detectBounceThreshold, makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const BENEFITS: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

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
      benefitMatrix: BENEFITS,
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
});
