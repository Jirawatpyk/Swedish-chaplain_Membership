/**
 * #707 — live Neon: a renewal reminder carries its tenant's reply-to, the
 * value is snapshotted on the reminder row at the first attempt, and the
 * retry sends that snapshot even after the tenant changes its setting (so
 * Resend's Idempotency-Key sees the same request, not a 409).
 *
 * Cross-tenant (Principle I): tenant B's reply-to never lands on tenant A's
 * rows, and B's own row holds B's value.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { tenantRenewalSettings } from '@/modules/renewals/infrastructure/schema-tenant-renewal-config';
import { dispatchRenewalCycle, makeRenewalsDeps, retryFailedReminders } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// Regular tier T-30 step due on NOW (expiry 30 days out).
const NOW_ISO = '2026-06-15T08:00:00.000Z';
const RETRY_NOW_ISO = '2026-06-15T09:00:00.000Z';
const EXPIRES_AT = new Date('2026-07-15T00:00:00.000Z');
const PERIOD_FROM = new Date('2025-07-15T00:00:00.000Z');

const A_REPLY = 'renewals-a@example.invalid';
const A_REPLY_CHANGED = 'changed-a@example.invalid';
const B_REPLY = 'renewals-b@example.invalid';

async function seedCycle(t: TestTenant, user: TestUser): Promise<string> {
  const planId = `f8-replyto-${randomUUID().slice(0, 8)}`;
  const memberId = randomUUID();
  const cycleId = randomUUID();
  await runInTenant(t.ctx, async (tx) => {
    await seedF8MembershipPlan(tx, {
      tenantSlug: t.ctx.slug,
      planId,
      planName: { en: 'Reply-to Plan' },
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    });
    await tx.insert(members).values({
      tenantId: t.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Reply-to Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });
    await tx.insert(contacts).values({
      tenantId: t.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Anna',
      lastName: 'Adm',
      email: `replyto-${randomUUID().slice(0, 6)}@example.invalid`,
      isPrimary: true,
      preferredLanguage: 'en',
    });
    await tx.insert(renewalCycles).values({
      tenantId: t.ctx.slug,
      cycleId,
      memberId,
      status: 'upcoming',
      periodFrom: PERIOD_FROM,
      periodTo: EXPIRES_AT,
      expiresAt: EXPIRES_AT,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: randomUUID(),
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
    });
  });
  return cycleId;
}

async function setReplyTo(t: TestTenant, email: string, displayName: string | null): Promise<void> {
  await runInTenant(t.ctx, (tx) =>
    tx
      .update(tenantRenewalSettings)
      .set({ replyToEmail: email, replyToDisplayName: displayName })
      .where(eq(tenantRenewalSettings.tenantId, t.ctx.slug)),
  );
}

async function reminderRow(t: TestTenant, cycleId: string) {
  const rows = await runInTenant(t.ctx, (tx) =>
    tx
      .select()
      .from(renewalReminderEvents)
      .where(and(eq(renewalReminderEvents.tenantId, t.ctx.slug), eq(renewalReminderEvents.cycleId, cycleId))),
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('#707 renewal reminder reply-to snapshot (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let cycleA: string;
  let cycleB: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-replyto-a');
    tenantB = await createTestTenant('test-replyto-b');
    await seedRenewalPolicies(tenantA.ctx);
    await seedRenewalPolicies(tenantB.ctx);
    cycleA = await seedCycle(tenantA, user);
    cycleB = await seedCycle(tenantB, user);
    await setReplyTo(tenantA, A_REPLY, 'Chamber A');
    await setReplyTo(tenantB, B_REPLY, null);
  }, 180_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      if (!t) continue;
      await db.delete(renewalReminderEvents).where(eq(renewalReminderEvents.tenantId, t.ctx.slug)).catch(() => {});
      await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, t.ctx.slug)).catch(() => {});
      await db.delete(auditLog).where(eq(auditLog.tenantId, t.ctx.slug)).catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  it('the first attempt snapshots the reply-to on the row; the retry sends the snapshot after the setting changed', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const gatewaySpy = vi
      .spyOn(deps.renewalGateway, 'sendRenewalEmail')
      .mockResolvedValueOnce({ ok: false, error: { kind: 'gateway_5xx', retryable: true, message: 'http_503' } } as never)
      .mockResolvedValueOnce({ ok: true, value: { deliveryId: `mock-${randomUUID().slice(0, 8)}`, dispatchedAt: RETRY_NOW_ISO } } as never);

    const first = await dispatchRenewalCycle(deps, { tenantId: tenantA.ctx.slug, correlationId: randomUUID(), nowIso: NOW_ISO });
    expect(first.ok).toBe(true);
    expect(gatewaySpy).toHaveBeenCalledTimes(1);
    expect(gatewaySpy.mock.calls[0]![0]).toMatchObject({ replyToEmail: A_REPLY, replyToDisplayName: 'Chamber A' });

    const failed = await reminderRow(tenantA, cycleA);
    expect(failed.status).toBe('failed');
    expect(failed.replyToEmail).toBe(A_REPLY);
    expect(failed.replyToDisplayName).toBe('Chamber A');

    // The tenant edits its reply-to between the attempts.
    await setReplyTo(tenantA, A_REPLY_CHANGED, 'Changed');

    const retry = await retryFailedReminders(deps, { tenantId: tenantA.ctx.slug, correlationId: randomUUID(), nowIso: RETRY_NOW_ISO });
    expect(retry.ok).toBe(true);
    expect(gatewaySpy).toHaveBeenCalledTimes(2);
    expect(gatewaySpy.mock.calls[1]![0]).toMatchObject({ replyToEmail: A_REPLY, replyToDisplayName: 'Chamber A' });
    expect((await reminderRow(tenantA, cycleA)).status).toBe('sent');
    gatewaySpy.mockRestore();
  }, 120_000);

  it("cross-tenant: tenant B's row holds B's reply-to, and A's row is untouched", async () => {
    const deps = makeRenewalsDeps(tenantB.ctx.slug);
    const gatewaySpy = vi
      .spyOn(deps.renewalGateway, 'sendRenewalEmail')
      .mockResolvedValue({ ok: true, value: { deliveryId: `mock-${randomUUID().slice(0, 8)}`, dispatchedAt: NOW_ISO } } as never);
    const r = await dispatchRenewalCycle(deps, { tenantId: tenantB.ctx.slug, correlationId: randomUUID(), nowIso: NOW_ISO });
    expect(r.ok).toBe(true);
    expect(gatewaySpy).toHaveBeenCalledTimes(1);
    const sent = gatewaySpy.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(sent['replyToEmail']).toBe(B_REPLY);
    expect('replyToDisplayName' in sent).toBe(false);

    const rowB = await reminderRow(tenantB, cycleB);
    expect(rowB.replyToEmail).toBe(B_REPLY);
    expect(rowB.replyToDisplayName).toBeNull();
    const rowA = await reminderRow(tenantA, cycleA);
    expect(rowA.replyToEmail).toBe(A_REPLY);
    gatewaySpy.mockRestore();
  }, 120_000);
});
