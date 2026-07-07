/**
 * F6 remediation PR 2.1 / P1 (FR-032a by-email erasure BACKEND) —
 * integration test for `RegistrationsRepository.findByEmailLower` (live Neon
 * Singapore).
 *
 * The admin by-email cross-event attendee erasure sweep (P2 search + P3 bulk
 * fan-out) needs to enumerate EVERY registration whose `attendee_email_lower`
 * equals the DSR subject's email, across all of a tenant's events. This method
 * returns the full `EventRegistrationAggregate` for every matching row, scoped
 * to the tenant by RLS + the explicit `tenant_id` predicate, ordered
 * `registered_at DESC, registration_id ASC`. It rides the existing
 * `event_regs_tenant_email_lower_idx (tenant_id, attendee_email_lower)` index
 * (migration 0131) — no new index/migration needed.
 *
 * Coverage:
 *   - returns EXACTLY the rows sharing `lower(attendeeEmail)` across MULTIPLE
 *     events, ordered `registered_at DESC`;
 *   - a DIFFERENT-email row is excluded;
 *   - a PSEUDONYMISED row (whose `attendee_email_lower` is a salted hash, not
 *     the real email) is NOT returned — exact-email equality means the hash
 *     never collides with the real address (P1 brief: "no extra filter");
 *   - mixed-case caller input (`'GUEST@x.COM'`) hits the lowered column;
 *   - cross-tenant probe: tenant B searching tenant A's email → `[]`
 *     (Principle I Review-Gate blocker).
 *
 * Seeding uses direct `tx` inserts (threaded from `runInTenant` per the RLS
 * gotcha) so the query is exercised against precisely the rows we control.
 * `attendee_email_lower` is a STORED generated column — we OMIT it and let
 * Postgres derive `lower(attendee_email)`. Non-member guest rows use
 * `match_type = 'non_member'` (matched_member_id NULL, quota flags false) which
 * satisfies the `event_registrations_non_member_no_quota` CHECK. Parent
 * `events` rows are seeded first to satisfy the composite FK
 * `event_registrations_event_fk (tenant_id, event_id)`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { makeDrizzleRegistrationsRepository } from '@/modules/events/infrastructure/drizzle-registrations-repository';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import type { TenantId } from '@/modules/members';

describe('F6 P1 — RegistrationsRepository.findByEmailLower (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  // Three registrations sharing the SAME lowered email across TWO events,
  // with distinct registered_at so the DESC ordering is deterministic.
  const eventA = randomUUID();
  const eventB = randomUUID();

  const reg1 = randomUUID(); // eventA, registered 2026-06-01 (oldest)
  const reg2 = randomUUID(); // eventA, registered 2026-06-02
  const reg3 = randomUUID(); // eventB, registered 2026-06-03 (newest)
  const regOther = randomUUID(); // eventA, DIFFERENT email — excluded
  const regPseudo = randomUUID(); // eventB, pseudonymised (hashed email) — excluded

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
          name: 'Event A',
          startDate: new Date('2026-06-21T18:00:00Z'),
        },
        {
          tenantId: slug,
          eventId: eventB,
          source: 'eventcreate',
          externalId: `ext_b_${randomUUID()}`,
          name: 'Event B',
          startDate: new Date('2026-07-21T18:00:00Z'),
        },
      ] satisfies NewEventRow[]);

      await tx.insert(eventRegistrations).values([
        // Same person, mixed-case source emails → all lower to 'guest@x.com'.
        {
          tenantId: slug,
          registrationId: reg1,
          eventId: eventA,
          externalId: `att_1_${randomUUID()}`,
          attendeeEmail: 'Guest@X.com',
          attendeeName: 'Guest One',
          matchType: 'non_member',
          registeredAt: new Date('2026-06-01T10:00:00Z'),
        },
        {
          tenantId: slug,
          registrationId: reg2,
          eventId: eventA,
          externalId: `att_2_${randomUUID()}`,
          attendeeEmail: 'guest@x.com',
          attendeeName: 'Guest Two',
          matchType: 'non_member',
          registeredAt: new Date('2026-06-02T10:00:00Z'),
        },
        {
          tenantId: slug,
          registrationId: reg3,
          eventId: eventB,
          externalId: `att_3_${randomUUID()}`,
          attendeeEmail: 'GUEST@x.COM',
          attendeeName: 'Guest Three',
          matchType: 'non_member',
          registeredAt: new Date('2026-06-03T10:00:00Z'),
        },
        // Different email — must be excluded.
        {
          tenantId: slug,
          registrationId: regOther,
          eventId: eventA,
          externalId: `att_other_${randomUUID()}`,
          attendeeEmail: 'someone-else@y.com',
          attendeeName: 'Someone Else',
          matchType: 'non_member',
          registeredAt: new Date('2026-06-04T10:00:00Z'),
        },
        // Pseudonymised: the retention sweep overwrote attendee_email with a
        // salted hash, so attendee_email_lower is the hash — it does NOT equal
        // the real 'guest@x.com' and must be excluded (exact-email equality,
        // no extra filter needed).
        {
          tenantId: slug,
          registrationId: regPseudo,
          eventId: eventB,
          externalId: `att_pseudo_${randomUUID()}`,
          attendeeEmail: 'a1b2c3d4e5f6a7b8@pseudonymised.invalid',
          attendeeName: 'a1b2c3d4e5f6a7b8',
          matchType: 'non_member',
          registeredAt: new Date('2026-06-05T10:00:00Z'),
          piiPseudonymisedAt: new Date('2026-06-10T00:00:00Z'),
        },
      ] as unknown as NewEventRegistrationRow[]);
    });
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  it('returns exactly the rows sharing the lowered email across events, registered_at DESC, excluding different-email + pseudonymised rows', async () => {
    const result = await runInTenant(tenantA.ctx, (tx) =>
      makeDrizzleRegistrationsRepository(tx).findByEmailLower(
        tenantA.ctx.slug as TenantId,
        'guest@x.com',
      ),
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const rows = result.value.rows;
    // Well under FIND_BY_EMAIL_CAP → not truncated (completeness signal).
    expect(result.value.truncated).toBe(false);

    // Exactly the 3 same-email rows — regOther + regPseudo excluded.
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => String(r.registrationId))).toEqual([reg3, reg2, reg1]);
    // None of the returned rows is the different-email or pseudonymised row.
    const ids = new Set(rows.map((r) => String(r.registrationId)));
    expect(ids.has(regOther)).toBe(false);
    expect(ids.has(regPseudo)).toBe(false);
    // All returned rows are live (not pseudonymised).
    expect(rows.every((r) => r.piiPseudonymisedAt === null)).toBe(true);
    // Every returned row carries its correct event pairing.
    const byReg = new Map(rows.map((r) => [String(r.registrationId), String(r.eventId)]));
    expect(byReg.get(reg1)).toBe(eventA);
    expect(byReg.get(reg2)).toBe(eventA);
    expect(byReg.get(reg3)).toBe(eventB);
  }, 120_000);

  it('lowercases mixed-case caller input before hitting the lowered column', async () => {
    const result = await runInTenant(tenantA.ctx, (tx) =>
      makeDrizzleRegistrationsRepository(tx).findByEmailLower(
        tenantA.ctx.slug as TenantId,
        'GUEST@x.COM',
      ),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toHaveLength(3);
  }, 120_000);

  it('cross-tenant probe — tenant B searching tenant A\'s email sees nothing (Principle I)', async () => {
    const result = await runInTenant(tenantB.ctx, (tx) =>
      makeDrizzleRegistrationsRepository(tx).findByEmailLower(
        tenantB.ctx.slug as TenantId,
        'guest@x.com',
      ),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toEqual([]);
    expect(result.value.truncated).toBe(false);
  }, 120_000);
});
