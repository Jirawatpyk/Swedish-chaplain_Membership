/**
 * F6 remediation PR 2.1 / P2 (FR-032a by-email erasure BACKEND) — integration
 * test for `runSearchAttendeesByEmail` (live Neon Singapore).
 *
 * Drives the full read composition: `runInTenant` → P1 `findByEmailLower` +
 * batched `findByIds` event enrichment → `searchAttendeeRegistrationsByEmail`.
 * Proves the preview lists every registration sharing an attendee email across
 * events, enriched with the event name + CE start date, with the counted-quota
 * flags surfaced, and that a cross-tenant caller sees nothing (Principle I).
 *
 * Seeding uses direct `tx` inserts (threaded from `runInTenant` per the RLS
 * gotcha). The partnership/cultural-counted rows use `match_type =
 * 'member_contact'` + a `matched_member_id` (a denormalised uuid — NO FK to
 * members) so the `event_registrations_non_member_no_quota` CHECK permits the
 * counted flags; the third row is a plain `non_member`. `attendee_email_lower`
 * is a STORED generated column — omitted so Postgres derives it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { runSearchAttendeesByEmail } from '@/lib/events-admin-deps';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

const SHARED_EMAIL = 'preview-guest@example.com';

describe('F6 P2 — runSearchAttendeesByEmail (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  const memberId = randomUUID(); // denormalised match id (no FK)
  const eventA = randomUUID();
  const eventB = randomUUID();

  const regPartnership = randomUUID(); // eventA, member_contact, partnership-counted
  const regCultural = randomUUID(); // eventA, member_contact, cultural-counted
  const regNonMember = randomUUID(); // eventB, non_member

  beforeAll(async () => {
    const two = await createTwoTestTenants();
    tenantA = two.a;
    tenantB = two.b;
    const slug = tenantA.ctx.slug;

    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(events).values([
        {
          tenantId: slug,
          eventId: eventA,
          source: 'eventcreate',
          externalId: `ext_a_${randomUUID()}`,
          name: 'Songkran Networking',
          startDate: new Date('2026-04-13T10:00:00Z'),
        },
        {
          tenantId: slug,
          eventId: eventB,
          source: 'eventcreate',
          externalId: `ext_b_${randomUUID()}`,
          name: 'Midsummer Mixer',
          startDate: new Date('2026-06-20T18:00:00Z'),
        },
      ] satisfies NewEventRow[]);

      await tx.insert(eventRegistrations).values([
        {
          tenantId: slug,
          registrationId: regPartnership,
          eventId: eventA,
          externalId: `att_p_${randomUUID()}`,
          attendeeEmail: SHARED_EMAIL,
          attendeeName: 'Preview Guest',
          attendeeCompany: 'Preview Co',
          matchType: 'member_contact',
          matchedMemberId: memberId,
          countedAgainstPartnership: true,
          countedAgainstCulturalQuota: false,
          registeredAt: new Date('2026-04-13T09:00:00Z'),
        },
        {
          tenantId: slug,
          registrationId: regCultural,
          eventId: eventA,
          externalId: `att_c_${randomUUID()}`,
          attendeeEmail: SHARED_EMAIL,
          attendeeName: 'Preview Guest',
          matchType: 'member_contact',
          matchedMemberId: memberId,
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: true,
          registeredAt: new Date('2026-04-13T09:30:00Z'),
        },
        {
          tenantId: slug,
          registrationId: regNonMember,
          eventId: eventB,
          externalId: `att_n_${randomUUID()}`,
          attendeeEmail: SHARED_EMAIL,
          attendeeName: 'Preview Guest',
          matchType: 'non_member',
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: false,
          registeredAt: new Date('2026-06-20T17:00:00Z'),
        },
      ] as unknown as NewEventRegistrationRow[]);
    });
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  it('returns 3 matches enriched with event name + CE start date + counted flags, and logs no attendee PII', async () => {
    const logSpy = vi.spyOn(logger, 'info');
    const warnSpy = vi.spyOn(logger, 'warn');
    const errSpy = vi.spyOn(logger, 'error');
    try {
      const result = await runSearchAttendeesByEmail(tenantA.ctx.slug, {
        emailLower: SHARED_EMAIL,
      });

      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      const { matches } = result.value;
      expect(matches).toHaveLength(3);

      const byId = new Map(matches.map((m) => [m.registrationId, m]));

      const p = byId.get(regPartnership)!;
      expect(p).toMatchObject({
        eventId: eventA,
        eventName: 'Songkran Networking',
        eventStartDateIso: '2026-04-13T10:00:00.000Z',
        matchType: 'member_contact',
        countedPartnership: true,
        countedCultural: false,
        isPseudonymised: false,
      });

      const c = byId.get(regCultural)!;
      expect(c).toMatchObject({
        eventId: eventA,
        eventName: 'Songkran Networking',
        matchType: 'member_contact',
        countedPartnership: false,
        countedCultural: true,
      });

      const n = byId.get(regNonMember)!;
      expect(n).toMatchObject({
        eventId: eventB,
        eventName: 'Midsummer Mixer',
        eventStartDateIso: '2026-06-20T18:00:00.000Z',
        matchType: 'non_member',
        countedPartnership: false,
        countedCultural: false,
      });

      // No attendee PII may leak into structured logs from this read path.
      const allLogArgs = [
        ...logSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errSpy.mock.calls,
      ]
        .flat()
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      expect(allLogArgs).not.toContain(SHARED_EMAIL);
      expect(allLogArgs).not.toContain('Preview Guest');
      expect(allLogArgs).not.toContain('Preview Co');
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  }, 120_000);

  it('cross-tenant probe — tenant B searching tenant A\'s email sees nothing (Principle I)', async () => {
    const result = await runSearchAttendeesByEmail(tenantB.ctx.slug, {
      emailLower: SHARED_EMAIL,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.matches).toEqual([]);
  }, 120_000);
});
