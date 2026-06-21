/**
 * COMP-1 US2c (Task 6, throw-path resumability) — live-Neon proof that the F6
 * registration fan-out (`eraseAllRegistrationsForMember`) is BEST-EFFORT and
 * IDEMPOTENTLY RE-DRIVABLE (design §10 "F6 fan-out throw-path" oracle), NOT a
 * silent abort.
 *
 * Injecting a per-registration failure through the full production `eraseMember`
 * is hard (the cascade is post-commit best-effort and the adapter never throws),
 * so we exercise the fan-out DIRECTLY against live Neon with the REAL
 * collaborators, wrapping only `eraseOne` to fail on ONE targeted registration:
 *
 *   PASS 1 — wrapper deps: real `list` (`listMemberRegistrationsInTx`) + a
 *   wrapper around the real per-registration `eraseOne`
 *   (`makeEraseAllRegistrationsForMemberDeps(tenant).eraseOne`, which opens its
 *   own `runInTenant` tx and runs the real `eraseAttendeePii` hard-delete) that
 *   THROWS on the 2nd registration. The other two registrations are erased for
 *   real (their per-registration tx commits independently — the best-effort
 *   guarantee). Assert: registrations 1 + 3 are HARD-DELETED, `failedCount === 1`,
 *   `erasedCount === 2`, and reg 2 still exists in the DB. This proves a failure
 *   does NOT roll back the siblings and is TALLIED, not swallowed.
 *
 *   RE-DRIVE (PASS 2) — REAL non-failing deps
 *   (`makeEraseAllRegistrationsForMemberDeps(tenant)`). `list` now re-enumerates
 *   ONLY the surviving reg 2 (regs 1 + 3 are already gone), so the fan-out
 *   completes reg 2 with `erasedCount === 1` and does NOT re-process regs 1 + 3
 *   as failures (`failedCount === 0`). Assert: reg 2 is now hard-deleted, the
 *   member has 0 matched registrations, and the re-drive reported the remaining
 *   work cleanly. This proves idempotent re-drive resumability.
 *
 * No member/plan/contact seed is needed: `matched_member_id` is a plain uuid
 * column with NO FK to `members` (members live in a different module; F6 stores
 * a denormalised id), so seeding the parent `events` row + the registration rows
 * directly is sufficient. Direct `tx` inserts (threaded from `runInTenant` per
 * the RLS gotcha) use `match_type = 'member_contact'` to satisfy the
 * `event_registrations_non_member_no_quota` CHECK.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import {
  eraseAllRegistrationsForMember,
  makeEraseAllRegistrationsForMemberDeps,
  type EraseAllRegistrationsForMemberDeps,
} from '@/modules/events';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

/** Seed a parent event row (FK target for registrations). */
async function seedEvent(tenant: TestTenant, name: string): Promise<string> {
  const eventId = randomUUID();
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId: `ext_${randomUUID()}`,
      name,
      startDate: new Date('2026-07-21T18:00:00Z'),
    } satisfies NewEventRow),
  );
  return eventId;
}

/** Seed a registration matched to `memberId` on `eventId`. */
async function seedRegistration(
  tenant: TestTenant,
  memberId: string,
  eventId: string,
  attendeeEmail: string,
): Promise<string> {
  const registrationId = randomUUID();
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(eventRegistrations).values({
      tenantId: tenant.ctx.slug,
      registrationId,
      eventId,
      externalId: `att_${randomUUID()}`,
      attendeeEmail,
      attendeeName: 'Throw Path Attendee',
      attendeeCompany: 'Throw Path Co',
      matchType: 'member_contact',
      matchedMemberId: memberId,
      countedAgainstPartnership: false,
      countedAgainstCulturalQuota: false,
      registeredAt: new Date(),
    } as unknown as NewEventRegistrationRow),
  );
  return registrationId;
}

/** Rows still matched to the member (the hard-delete oracle). */
async function rawSelectRegistrationsForMember(
  tenantSlug: string,
  memberId: string,
) {
  return db
    .select({ registrationId: eventRegistrations.registrationId })
    .from(eventRegistrations)
    .where(
      and(
        eq(eventRegistrations.tenantId, tenantSlug),
        eq(eventRegistrations.matchedMemberId, memberId),
      ),
    );
}

/** Whether a specific registration row still exists (BYPASSRLS). */
async function registrationExists(registrationId: string): Promise<boolean> {
  const rows = await db
    .select({ registrationId: eventRegistrations.registrationId })
    .from(eventRegistrations)
    .where(eq(eventRegistrations.registrationId, registrationId));
  return rows.length === 1;
}

describe('COMP-1 US2c — eraseAllRegistrationsForMember throw-path resumability (live Neon, real per-registration erasure)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  const memberId = randomUUID();
  let eventA: string;
  let eventB: string;
  let reg1: string;
  let reg2: string; // the one whose eraseOne is forced to throw on pass 1
  let reg3: string;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    eventA = await seedEvent(tenant, 'Throw Path Event A');
    eventB = await seedEvent(tenant, 'Throw Path Event B');

    reg1 = await seedRegistration(tenant, memberId, eventA, 'tp1@example.com');
    reg2 = await seedRegistration(tenant, memberId, eventA, 'tp2@example.com');
    reg3 = await seedRegistration(tenant, memberId, eventB, 'tp3@example.com');
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('continues past a throwing registration (best-effort) and an idempotent re-drive completes the survivor (NOT a silent abort)', async () => {
    // Sanity: all 3 registrations exist before the fan-out runs.
    const beforeRows = await rawSelectRegistrationsForMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(new Set(beforeRows.map((r) => String(r.registrationId)))).toEqual(
      new Set([reg1, reg2, reg3]),
    );

    const input = {
      tenantId: tenant.ctx.slug,
      memberId,
      actorUserId: admin.userId,
      requestId: `rq-throw-path-${Date.now()}`,
      occurredAt: new Date(),
    } as const;

    // ---- PASS 1: real deps, but eraseOne THROWS on the 2nd registration -----
    // The wrapper delegates to the REAL per-registration erasure (own runInTenant
    // tx + real `eraseAttendeePii` hard-delete) for reg1/reg3 and throws for reg2.
    // reg1 + reg3 commit independently (best-effort); reg2 is tallied as a failure.
    const realDeps = makeEraseAllRegistrationsForMemberDeps(tenant.ctx);
    const pass1Deps: EraseAllRegistrationsForMemberDeps = {
      list: realDeps.list,
      eraseOne: (registrationId, eventId, eraseInput) => {
        if (registrationId === reg2) {
          throw new Error('injected failure on reg2');
        }
        return realDeps.eraseOne(registrationId, eventId, eraseInput);
      },
    };

    const pass1 = await eraseAllRegistrationsForMember(input, pass1Deps);
    expect(pass1.ok, JSON.stringify(pass1)).toBe(true);
    if (!pass1.ok) return;
    // reg1 + reg3 erased; reg2 failed; none already-erased.
    expect(pass1.value).toMatchObject({
      erasedCount: 2,
      failedCount: 1,
      alreadyErasedCount: 0,
    });

    // reg1 + reg3 HARD-DELETED; reg2 SURVIVES (the throw did not erase it AND
    // did not abort the siblings).
    expect(await registrationExists(reg1)).toBe(false);
    expect(await registrationExists(reg3)).toBe(false);
    expect(await registrationExists(reg2)).toBe(true);
    const afterPass1 = await rawSelectRegistrationsForMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(afterPass1.map((r) => String(r.registrationId))).toEqual([reg2]);

    // ---- RE-DRIVE (PASS 2): REAL non-failing deps --------------------------
    // `list` re-enumerates ONLY the surviving reg2 (reg1/reg3 already gone), so
    // the fan-out completes reg2 and does NOT re-process the already-deleted
    // siblings as failures — idempotent re-drive resumability.
    const pass2 = await eraseAllRegistrationsForMember(input, realDeps);
    expect(pass2.ok, JSON.stringify(pass2)).toBe(true);
    if (!pass2.ok) return;
    expect(pass2.value).toMatchObject({
      erasedCount: 1, // only the surviving reg2
      failedCount: 0, // the already-deleted reg1/reg3 are NOT re-processed
      alreadyErasedCount: 0,
    });

    // reg2 now hard-deleted → the member has 0 matched registrations.
    expect(await registrationExists(reg2)).toBe(false);
    const afterPass2 = await rawSelectRegistrationsForMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(afterPass2).toHaveLength(0);
  }, 120_000);
});
