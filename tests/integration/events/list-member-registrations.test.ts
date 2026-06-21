/**
 * COMP-1 US2c (F6 registration fan-out) Task 1 — integration test for
 * `RegistrationsRepository.listMemberRegistrationsInTx` (live Neon Singapore).
 *
 * The member-erasure F6 fan-out (`eraseAllRegistrationsForMember`, Task 2)
 * needs to enumerate every event registration matched to an erased member.
 * This method returns `{ registrationId, eventId }` for every row where
 * `matched_member_id = member`, scoped to the tenant by RLS + the explicit
 * `tenant_id` predicate. It rides the existing
 * `event_regs_tenant_matched_member_idx (tenant_id, matched_member_id)`
 * index (migration 0131) — no new index/migration needed.
 *
 * Coverage:
 *   - returns every registration id + eventId matched to the member,
 *     across MULTIPLE events;
 *   - excludes registrations matched to a DIFFERENT member;
 *   - returns an empty array for a member with no registrations
 *     (idempotent re-run after erasure path).
 *
 * Seeding uses direct `tx` inserts (threaded from `runInTenant` per the
 * RLS gotcha) rather than the full webhook ingest path, so the query is
 * exercised against precisely the rows we control. Member-matched rows
 * use `match_type = 'member_contact'` to satisfy the
 * `event_registrations_non_member_no_quota` CHECK (matched_member_id may
 * only be non-NULL for member_* match types). Parent `events` rows are
 * seeded first to satisfy the composite FK
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
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import type { TenantId, MemberId } from '@/modules/members';

describe('COMP-1 US2c — RegistrationsRepository.listMemberRegistrationsInTx (live Neon)', () => {
  let tenant: TestTenant;

  const memberId = randomUUID();
  const otherMemberId = randomUUID();

  // Two distinct events; member M has 2 regs on e1 + 1 on e2.
  const eventA = randomUUID();
  const eventB = randomUUID();

  // Member M's three registration ids (2 on eventA, 1 on eventB).
  const regA1 = randomUUID();
  const regA2 = randomUUID();
  const regB1 = randomUUID();
  // A registration matched to a DIFFERENT member on eventA — must be excluded.
  const regOther = randomUUID();

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    const slug = tenant.ctx.slug;

    await runInTenant(tenant.ctx, async (tx) => {
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
        {
          tenantId: slug,
          registrationId: regA1,
          eventId: eventA,
          externalId: `att_a1_${randomUUID()}`,
          attendeeEmail: 'm.a1@example.com',
          attendeeName: 'Member M',
          matchType: 'member_contact',
          matchedMemberId: memberId,
          registeredAt: new Date(),
        },
        {
          tenantId: slug,
          registrationId: regA2,
          eventId: eventA,
          externalId: `att_a2_${randomUUID()}`,
          attendeeEmail: 'm.a2@example.com',
          attendeeName: 'Member M',
          matchType: 'member_contact',
          matchedMemberId: memberId,
          registeredAt: new Date(),
        },
        {
          tenantId: slug,
          registrationId: regB1,
          eventId: eventB,
          externalId: `att_b1_${randomUUID()}`,
          attendeeEmail: 'm.b1@example.com',
          attendeeName: 'Member M',
          matchType: 'member_contact',
          matchedMemberId: memberId,
          registeredAt: new Date(),
        },
        {
          tenantId: slug,
          registrationId: regOther,
          eventId: eventA,
          externalId: `att_other_${randomUUID()}`,
          attendeeEmail: 'other@example.com',
          attendeeName: 'Other Member',
          matchType: 'member_contact',
          matchedMemberId: otherMemberId,
          registeredAt: new Date(),
        },
      ] as unknown as NewEventRegistrationRow[]);
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('returns every registration id + eventId matched to the member (across events), excluding other members', async () => {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      makeDrizzleRegistrationsRepository(tx).listMemberRegistrationsInTx(
        tenant.ctx.slug as TenantId,
        memberId as MemberId,
      ),
    );

    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => String(r.registrationId)))).toEqual(
      new Set([regA1, regA2, regB1]),
    );
    // The other member's registration must be absent.
    expect(rows.map((r) => String(r.registrationId))).not.toContain(regOther);

    // Each row carries the correct eventId pairing.
    const byReg = new Map(rows.map((r) => [String(r.registrationId), String(r.eventId)]));
    expect(byReg.get(regA1)).toBe(eventA);
    expect(byReg.get(regA2)).toBe(eventA);
    expect(byReg.get(regB1)).toBe(eventB);
  });

  it('returns an empty array for a member with no matched registrations (idempotent re-run shape)', async () => {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      makeDrizzleRegistrationsRepository(tx).listMemberRegistrationsInTx(
        tenant.ctx.slug as TenantId,
        randomUUID() as MemberId,
      ),
    );
    expect(rows).toEqual([]);
  });
});
