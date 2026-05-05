/**
 * F8 Phase 4 Wave I8 · T109 — `dispatchRenewalCycle` idempotency (live Neon).
 *
 * FR-011 contract: re-running the cron 3× on the same calendar day MUST
 * produce zero duplicate reminder dispatches and zero duplicate audit
 * rows. The idempotency primitive is the unique index on
 * `renewal_reminder_events (tenant_id, cycle_id, step_id, year_in_cycle)`
 * — `insertIfAbsent` returns `created=false` on replay, and the
 * dispatcher short-circuits with `skipped: 'already_sent'` (no audit, no
 * gateway call).
 *
 * Test scope:
 *   1. First pass: 1 candidate cycle at T-30 + Regular schedule policy
 *      → 1 reminder_events row + 1 `renewal_reminder_sent` audit + the
 *      gateway sees exactly 1 send call.
 *   2. Second + third pass: same `nowIso` → ZERO new reminder_events,
 *      ZERO new audits, ZERO new gateway calls. Summary reports
 *      `skipped.already_sent = 1` per pass.
 *
 * Tenant isolation: insertion + cleanup scoped via `runInTenant(tenantA)`.
 * The seeded tenant is torn down by the test-tenant helper, which also
 * cascades the schedule policies + settings rows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { dispatchRenewalCycle, makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';

const TEST_BENEFIT_MATRIX: BenefitMatrix = {
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

// Pin the dispatcher's clock to a deterministic instant. Schedule
// policy: Regular tier T-30 step → expires_at 30d in the future.
const NOW_ISO = '2026-06-15T08:00:00.000Z';
const EXPIRES_AT = new Date('2026-07-15T00:00:00.000Z');
// `period_from` is 1y before expiry → year_in_cycle math resolves to 1.
const PERIOD_FROM = new Date('2025-07-15T00:00:00.000Z');

describe('F8 dispatchRenewalCycle — idempotency on live Neon (T109)', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  let memberId: string;
  let cycleId: string;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenantA.ctx);

    planId = `f8-idem-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();
    cycleId = randomUUID();

    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenantA.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Idem Plan' },
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
        benefitMatrix: TEST_BENEFIT_MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId,
        companyName: 'Idempotent Co',
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
        email: `idem-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: PERIOD_FROM,
        periodTo: EXPIRES_AT,
        expiresAt: EXPIRES_AT,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        // Frozen plan-id snapshot — UUID-typed; distinct from
        // `members.plan_id` (text). Mirror cancel-cycle test pattern.
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(renewalReminderEvents)
      .where(eq(renewalReminderEvents.tenantId, tenantA.ctx.slug))
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

  it('FR-011: cron run 3× same day → 1 reminder_event + 1 sent audit + 1 gateway call', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    // Stub the gateway so we can count send-attempts without hitting Resend.
    const gatewaySpy = vi
      .spyOn(deps.renewalGateway, 'sendRenewalEmail')
      .mockResolvedValue({
        ok: true,
        value: {
          deliveryId: `mock-delivery-${randomUUID().slice(0, 8)}`,
          dispatchedAt: NOW_ISO,
        },
      } as never);

    // ----- Pass 1: should send -------------------------------------------
    const r1 = await dispatchRenewalCycle(deps, {
      tenantId: tenantA.ctx.slug,
      correlationId: randomUUID(),
      nowIso: NOW_ISO,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.summary.candidatesProcessed).toBe(1);
    expect(r1.value.summary.emailsSent).toBe(1);
    expect(gatewaySpy).toHaveBeenCalledTimes(1);

    // ----- Pass 2: replay → already_sent ---------------------------------
    const r2 = await dispatchRenewalCycle(deps, {
      tenantId: tenantA.ctx.slug,
      correlationId: randomUUID(),
      nowIso: NOW_ISO,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.summary.emailsSent).toBe(0);
    expect(r2.value.summary.skipped.already_sent).toBe(1);
    expect(gatewaySpy).toHaveBeenCalledTimes(1); // unchanged

    // ----- Pass 3: replay again ------------------------------------------
    const r3 = await dispatchRenewalCycle(deps, {
      tenantId: tenantA.ctx.slug,
      correlationId: randomUUID(),
      nowIso: NOW_ISO,
    });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.value.summary.emailsSent).toBe(0);
    expect(r3.value.summary.skipped.already_sent).toBe(1);
    expect(gatewaySpy).toHaveBeenCalledTimes(1);

    // ----- DB invariants -------------------------------------------------
    const reminderRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(renewalReminderEvents)
        .where(
          and(
            eq(renewalReminderEvents.tenantId, tenantA.ctx.slug),
            eq(renewalReminderEvents.cycleId, cycleId),
          ),
        ),
    );
    expect(reminderRows).toHaveLength(1);
    expect(reminderRows[0]?.status).toBe('sent');
    expect(reminderRows[0]?.stepId).toBe('t-30.email');
    expect(reminderRows[0]?.yearInCycle).toBe(1);

    const sentAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantA.ctx.slug),
          eq(auditLog.eventType, 'renewal_reminder_sent' as never),
        ),
      );
    expect(sentAudits).toHaveLength(1);

    gatewaySpy.mockRestore();
  }, 120_000);
});
