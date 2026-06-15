/**
 * F6 → F7 EventAttendees bridge — live-Neon integration test.
 *
 * Exercises the real query that backs the broadcasts
 * `event_attendees_last_90d` segment (replacing the T062 stub that
 * always returned []). Covers:
 *   1. Distinct attendees within the 90-day window are returned.
 *   2. Per-email dedup → one row carrying the MOST RECENT event's
 *      title + date.
 *   3. Events older than 90 days are EXCLUDED.
 *   4. Archived events are EXCLUDED.
 *   5. Pseudonymised (retention-purged) registrations are EXCLUDED.
 *   6. `getRecentEventAttendeeByEmail` returns the row / null correctly.
 *   7. The broadcasts barrel `eventAttendeesBridge` returns the same
 *      data with a branded `EmailLower` (full cross-module path).
 *   8. **Cross-tenant probe** (Constitution Principle I sub-clause 3,
 *      Review-Gate blocker): tenant B context cannot read tenant A's
 *      attendees.
 *
 * Dates are seeded RELATIVE to `new Date()` so the `now() - interval
 * '90 days'` window stays deterministic whenever the suite runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { events, eventRegistrations } from '@/modules/events/infrastructure/schema';
import {
  getRecentEventAttendees,
  getRecentEventAttendeeByEmail,
} from '@/modules/events';
import { eventAttendeesBridge } from '@/modules/broadcasts';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

function daysAgo(n: number): Date {
  return new Date(new Date().getTime() - n * 24 * 60 * 60 * 1000);
}

interface SeedEventArgs {
  readonly tenantSlug: string;
  readonly eventId: string;
  readonly name: string;
  readonly startDate: Date;
  readonly archivedAt?: Date | null;
}

interface SeedRegistrationArgs {
  readonly tenantSlug: string;
  readonly eventId: string;
  readonly email: string;
  readonly memberId?: string | null;
  readonly pseudonymisedAt?: Date | null;
}

function eventValues(a: SeedEventArgs) {
  return {
    tenantId: a.tenantSlug,
    eventId: a.eventId,
    source: 'eventcreate',
    externalId: `bridge-ev-${a.eventId}`,
    name: a.name,
    startDate: a.startDate,
    archivedAt: a.archivedAt ?? null,
    isPartnerBenefit: false,
    isCulturalEvent: false,
  } as unknown as typeof events.$inferInsert;
}

function registrationValues(a: SeedRegistrationArgs) {
  const matched = a.memberId ?? null;
  return {
    tenantId: a.tenantSlug,
    registrationId: randomUUID(),
    eventId: a.eventId,
    source: 'eventcreate',
    externalId: `bridge-reg-${a.eventId}-${randomUUID()}`,
    attendeeEmail: a.email,
    attendeeName: 'Bridge Attendee',
    matchType: matched === null ? 'unmatched' : 'member_contact',
    matchedMemberId: matched,
    paymentStatus: 'paid',
    ticketType: 'standard',
    countedAgainstPartnership: false,
    countedAgainstCulturalQuota: false,
    metadata: {},
    registeredAt: new Date(),
    piiPseudonymisedAt: a.pseudonymisedAt ?? null,
  } as unknown as typeof eventRegistrations.$inferInsert;
}

describe('F6 → F7 eventAttendees bridge (event_attendees_last_90d)', () => {
  describe('happy path — window, dedup, exclusions', () => {
    let tenant: TestTenant;
    const recentMemberId = randomUUID();
    const recentEventOld = randomUUID(); // same email, older recent
    const recentEventNew = randomUUID(); // same email, most recent
    const staleEventId = randomUUID(); // > 90 days
    const archivedEventId = randomUUID(); // archived
    const pseudoEventId = randomUUID(); // pseudonymised reg

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(events).values([
          eventValues({
            tenantSlug: tenant.ctx.slug,
            eventId: recentEventOld,
            name: 'Recent Event A (older)',
            startDate: daysAgo(40),
          }),
          eventValues({
            tenantSlug: tenant.ctx.slug,
            eventId: recentEventNew,
            name: 'Recent Event B (newest)',
            startDate: daysAgo(5),
          }),
          eventValues({
            tenantSlug: tenant.ctx.slug,
            eventId: staleEventId,
            name: 'Stale Event (>90d)',
            startDate: daysAgo(120),
          }),
          eventValues({
            tenantSlug: tenant.ctx.slug,
            eventId: archivedEventId,
            name: 'Archived Event',
            startDate: daysAgo(8),
            archivedAt: daysAgo(2),
          }),
          eventValues({
            tenantSlug: tenant.ctx.slug,
            eventId: pseudoEventId,
            name: 'Pseudonymised Reg Event',
            startDate: daysAgo(7),
          }),
        ]);
        await tx.insert(eventRegistrations).values([
          // Same email attended two in-window events → must dedup to the
          // most recent (Recent Event B).
          registrationValues({
            tenantSlug: tenant.ctx.slug,
            eventId: recentEventOld,
            email: 'recent@bridge.example',
            memberId: recentMemberId,
          }),
          registrationValues({
            tenantSlug: tenant.ctx.slug,
            eventId: recentEventNew,
            email: 'recent@bridge.example',
            memberId: recentMemberId,
          }),
          // > 90 days → excluded.
          registrationValues({
            tenantSlug: tenant.ctx.slug,
            eventId: staleEventId,
            email: 'old@bridge.example',
          }),
          // Archived event → excluded.
          registrationValues({
            tenantSlug: tenant.ctx.slug,
            eventId: archivedEventId,
            email: 'archived@bridge.example',
          }),
          // Pseudonymised registration → excluded.
          registrationValues({
            tenantSlug: tenant.ctx.slug,
            eventId: pseudoEventId,
            email: 'pseudo@bridge.example',
            pseudonymisedAt: daysAgo(1),
          }),
        ]);
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('returns exactly one deduped attendee (most-recent title wins)', async () => {
      const rows = await getRecentEventAttendees(tenant.ctx.slug);
      const seeded = rows.filter((r) =>
        r.emailLower.endsWith('@bridge.example'),
      );
      expect(seeded.length).toBe(1);
      const only = seeded[0]!;
      expect(only.emailLower).toBe('recent@bridge.example');
      expect(only.mostRecentEventTitle).toBe('Recent Event B (newest)');
      expect(only.memberId).toBe(recentMemberId);
      // Most-recent event date ≈ 5 days ago (within the 90d window).
      expect(only.mostRecentEventDate.getTime()).toBeGreaterThan(
        daysAgo(10).getTime(),
      );
    });

    it('excludes stale / archived / pseudonymised emails', async () => {
      const rows = await getRecentEventAttendees(tenant.ctx.slug);
      const emails = rows.map((r) => r.emailLower);
      expect(emails).not.toContain('old@bridge.example');
      expect(emails).not.toContain('archived@bridge.example');
      expect(emails).not.toContain('pseudo@bridge.example');
    });

    it('getRecentEventAttendeeByEmail returns the in-window attendee', async () => {
      const row = await getRecentEventAttendeeByEmail(
        tenant.ctx.slug,
        'recent@bridge.example',
      );
      expect(row).not.toBeNull();
      expect(row!.mostRecentEventTitle).toBe('Recent Event B (newest)');
    });

    it('getRecentEventAttendeeByEmail returns null for stale/archived/pseudo/unknown', async () => {
      await expect(
        getRecentEventAttendeeByEmail(tenant.ctx.slug, 'old@bridge.example'),
      ).resolves.toBeNull();
      await expect(
        getRecentEventAttendeeByEmail(
          tenant.ctx.slug,
          'archived@bridge.example',
        ),
      ).resolves.toBeNull();
      await expect(
        getRecentEventAttendeeByEmail(tenant.ctx.slug, 'pseudo@bridge.example'),
      ).resolves.toBeNull();
      await expect(
        getRecentEventAttendeeByEmail(tenant.ctx.slug, 'ghost@bridge.example'),
      ).resolves.toBeNull();
    });

    it('broadcasts bridge surfaces the same attendee with a branded EmailLower', async () => {
      const rows = await eventAttendeesBridge.getLastNinetyDayAttendees(
        tenant.ctx,
      );
      const seeded = rows.filter((r) =>
        String(r.emailLower).endsWith('@bridge.example'),
      );
      expect(seeded.length).toBe(1);
      expect(String(seeded[0]!.emailLower)).toBe('recent@bridge.example');

      const one = await eventAttendeesBridge.lookupAttendeeEmailInTenant(
        tenant.ctx,
        // brand-cast is fine — the bridge re-stringifies internally.
        'recent@bridge.example' as never,
      );
      expect(one).not.toBeNull();
      expect(String(one!.emailLower)).toBe('recent@bridge.example');
    });
  });

  describe('cross-tenant probe (Principle I sub-clause 3 Review-Gate blocker)', () => {
    let tenantA: TestTenant;
    let tenantB: TestTenant;
    const evIdInA = randomUUID();

    beforeAll(async () => {
      tenantA = await createTestTenant('test-swecham');
      tenantB = await createTestTenant('test-chamber');
      await runInTenant(tenantA.ctx, async (tx) => {
        await tx.insert(events).values(
          eventValues({
            tenantSlug: tenantA.ctx.slug,
            eventId: evIdInA,
            name: 'Tenant A Event',
            startDate: daysAgo(3),
          }),
        );
        await tx.insert(eventRegistrations).values(
          registrationValues({
            tenantSlug: tenantA.ctx.slug,
            eventId: evIdInA,
            email: 'cross@a.example',
          }),
        );
      });
    });

    afterAll(async () => {
      await tenantA.cleanup();
      await tenantB.cleanup();
    });

    it('tenant B context cannot read tenant A attendees', async () => {
      const rows = await getRecentEventAttendees(tenantB.ctx.slug);
      expect(rows.some((r) => r.emailLower === 'cross@a.example')).toBe(false);
      await expect(
        getRecentEventAttendeeByEmail(tenantB.ctx.slug, 'cross@a.example'),
      ).resolves.toBeNull();
    });

    it('tenant A context reads its own attendee (control)', async () => {
      const row = await getRecentEventAttendeeByEmail(
        tenantA.ctx.slug,
        'cross@a.example',
      );
      expect(row).not.toBeNull();
      expect(row!.emailLower).toBe('cross@a.example');
    });
  });
});
