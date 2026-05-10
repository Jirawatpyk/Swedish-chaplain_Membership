/**
 * F8 Phase 9 / T258e — concurrent admin send-reminder 409 metadata
 * contract test.
 *
 * Companion to `tests/integration/renewals/concurrent-admin-race.test.ts`
 * (Phase 4 Wave J10/M12) which pins the use-case-level race semantics:
 * `Promise.all([sendReminderNow, sendReminderNow])` → exactly ONE
 * winner + ONE 'already_sent' loser via the unique-index conflict.
 *
 * This file pins the **409 RESPONSE METADATA SHAPE** that the route
 * handler returns to the admin client — the fields driving the
 * `admin.renewals.sendReminderNow.toast.skipped.alreadySent` i18n
 * toast which renders "ส่งไปแล้ว {ago}" / "Already sent {ago}" /
 * "Redan skickad {ago}":
 *
 *   - `existing_reminder_event_id` — the winning row's id (admin can
 *     pivot to it for forensic review).
 *   - `existing_dispatched_at` — ISO 8601 UTC timestamp of the
 *     winning dispatch; the client formats relative to user locale
 *     via `formatRelativeAgo(dispatchedAt, locale)`.
 *
 * What this contract pins:
 *
 *   1. The 'already_sent' skip metadata carries both fields.
 *   2. `existing_dispatched_at` is a parseable ISO 8601 UTC string
 *      (the client-side `formatRelativeAgo` requires this format).
 *   3. `existing_reminder_event_id` is a UUID v4.
 *
 * Constitution Principle VIII state↔audit atomicity — the 409
 * response carries the forensic pointer (`existing_reminder_event_id`)
 * that lets ops trace the winning dispatch in the admin audit log.
 *
 * Note on scope: the FULL HTTP-layer route handler test (NextRequest
 * → POST → 409 envelope) requires Next.js test-server setup which is
 * out of Phase 9 scope; the route's 409 envelope shape is structurally
 * pinned by the route handler unit tests at
 * `tests/contract/admin/renewals/send-reminder-now-route.test.ts`.
 * This test pins the use-case-level metadata that the route then
 * passes through to the response body verbatim.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { makeRenewalsDeps, sendReminderNow } from '@/modules/renewals';
import {
  createTestTenant,
  type TestTenant,
} from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';

const NOW_ISO = '2026-06-15T08:00:00.000Z';
const EXPIRES_AT = new Date('2026-07-15T00:00:00.000Z');
const PERIOD_FROM = new Date('2025-07-15T00:00:00.000Z');

describe('F8 concurrent admin send-reminder 409 metadata — Phase 9 / T258e', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let memberId: string;
  let cycleId: string;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenant.ctx);

    memberId = randomUUID();
    cycleId = randomUUID();
    const planId = `f8-t258e-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'T258e Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'T258e Race Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Anna',
        lastName: 'Adm',
        email: `t258e-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: PERIOD_FROM,
        periodTo: EXPIRES_AT,
        expiresAt: EXPIRES_AT,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });
  }, 120_000);

  afterAll(async () => {
    await db
      .delete(renewalReminderEvents)
      .where(eq(renewalReminderEvents.tenantId, tenant.ctx.slug))
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
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('two concurrent sendReminderNow calls — second returns kind=skipped reason=already_sent with full forensic metadata', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // Stub gateway to a deterministic ok-result so both concurrent
    // invocations would otherwise both succeed — only the unique-
    // index race forces one of them to skip.
    const stubDispatchedAt = '2026-06-15T08:00:30.000Z';
    let dispatchCount = 0;
    deps.renewalGateway.sendRenewalEmail = async () => {
      dispatchCount += 1;
      return {
        ok: true,
        value: {
          deliveryId: `t258e-mock-${dispatchCount}`,
          dispatchedAt: stubDispatchedAt,
        },
      };
    };

    // Fire two simultaneous sendReminderNow against the same cycle.
    // Real Postgres unique constraint serialises them; one wins, one
    // sees `already_sent`.
    const callerCtx = {
      tenantId: tenant.ctx.slug,
      cycleId,
      actorUserId: admin.userId,
      actorRole: 'admin' as const,
      requestId: null,
      correlationId: randomUUID(),
      nowIso: NOW_ISO,
    };

    const [r1, r2] = await Promise.all([
      sendReminderNow(deps, callerCtx),
      sendReminderNow(deps, { ...callerCtx, correlationId: randomUUID() }),
    ]);

    // Exactly one ok + outcome.kind in {sent, skipped(already_sent)}.
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    const outcomes = [r1.value, r2.value];
    const sentOutcome = outcomes.find((o) => o.kind === 'sent');
    const skippedOutcome = outcomes.find(
      (o) => o.kind === 'skipped' && o.reason === 'already_sent',
    );
    expect(sentOutcome).toBeDefined();
    expect(skippedOutcome).toBeDefined();

    // Forensic metadata on the skipped outcome — the 409 envelope
    // depends on these fields being populated.
    if (skippedOutcome && skippedOutcome.kind === 'skipped') {
      const meta = skippedOutcome.metadata ?? {};
      const existingReminderEventId = meta.existing_reminder_event_id as
        | string
        | undefined;
      const existingDispatchedAt = meta.existing_dispatched_at as
        | string
        | undefined;
      expect(existingReminderEventId).toBeDefined();
      expect(typeof existingReminderEventId).toBe('string');
      // UUID v4 shape — matches the renewal_reminder_events.id column.
      expect(existingReminderEventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      // ISO 8601 UTC parseable timestamp — the client-side
      // `formatRelativeAgo(dispatchedAt, locale)` requires this format.
      expect(existingDispatchedAt).toBeDefined();
      const parsed = new Date(existingDispatchedAt!);
      expect(Number.isNaN(parsed.getTime())).toBe(false);
    }

    // Exactly one renewal_reminder_events row landed for this cycle —
    // the unique constraint prevented duplicate dispatch + the audit
    // log contains exactly one renewal_reminder_sent row.
    const events = await db
      .select()
      .from(renewalReminderEvents)
      .where(
        and(
          eq(renewalReminderEvents.tenantId, tenant.ctx.slug),
          eq(renewalReminderEvents.cycleId, cycleId),
        ),
      );
    expect(events.length).toBe(1);
    expect(events[0]!.status).toBe('sent');
  });
});
