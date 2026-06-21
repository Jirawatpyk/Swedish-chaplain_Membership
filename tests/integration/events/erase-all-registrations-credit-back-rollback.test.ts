/**
 * COMP-1 US2c (code-review wave) — live-Neon proof that the per-registration
 * `eraseOne` wired by `makeEraseAllRegistrationsForMemberDeps(tenant)` runs
 * under a ROLLBACK-ON-`Result.err` tenant tx, NOT plain `runInTenant`.
 *
 * THE DEFECT (root of 4 collapsed /code-review findings): the factory's
 * `eraseOne` was wired with plain `runInTenant` (= `db.transaction(fn)`), which
 * Postgres only ROLLS BACK when the callback THROWS. A resolved `Result.err`
 * from `eraseAttendeePii` is treated as SUCCESS by the DB driver → the tx
 * COMMITS partial state. `eraseAttendeePii` emits `quota_credit_back_archive`
 * (step 4) BEFORE `hardDelete` (step 5), so a `hardDelete` err AFTER the
 * credit-back emit would, under plain `runInTenant`, COMMIT the credit-back
 * audit while leaving the row alive → the US2d reconciler re-drives → a SECOND
 * `quota_credit_back_archive` for the same (registration, scope) = a
 * DPO/forensic DOUBLE credit-back over-count.
 *
 * The route-facing `runEraseAttendeePii` deliberately uses the module-private
 * `runInTenantWithRollbackOnErr` for exactly this reason. The fix re-wires the
 * factory's `eraseOne` to REUSE the exported `runEraseAttendeePii` so a
 * per-registration `Result.err` ROLLS BACK that registration's tx.
 *
 * THE ORACLE (this test):
 *   PASS 1 — drive the REAL factory `eraseOne` for ONE quota-COUNTED
 *   registration, but inject a deterministic `hardDelete` err AFTER the
 *   credit-back emit (via a thin wrap of the real registrations repo that
 *   returns `err` on the first hardDelete call). With the FIX, the tx rolls
 *   back → the row SURVIVES and ZERO `quota_credit_back_archive` audit rows are
 *   committed for it. Against the BROKEN plain-`runInTenant` code this fails:
 *   the credit-back audit COMMITS even though the row survives.
 *
 *   PASS 2 (re-drive) — stop injecting the failure and drive the REAL factory
 *   `eraseOne` again. It erases the survivor cleanly and emits EXACTLY ONE
 *   `quota_credit_back_archive`. Against the BROKEN code the assertion of
 *   exactly-one fails (the PASS-1 committed credit-back + this one = TWO).
 *
 * Seeding: a quota-COUNTED row needs `match_type='member_contact'` (NOT in the
 * `event_registrations_non_member_no_quota` forbid-list) + a non-null
 * `matched_member_id` + `counted_against_partnership=true`. The credit-back
 * branch in `eraseAttendeePii` fires only when a counted flag is set AND
 * `matchedMemberId !== null`. Direct `tx` inserts are threaded from
 * `runInTenant` per the RLS gotcha (writes inside a tenant scope must use the
 * scoped tx, never the global `db`).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import type { RegistrationsRepository } from '@/modules/events/application/ports/registrations-repository';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

// ---------------------------------------------------------------------------
// Injection seam: wrap the REAL registrations-repository factory and override
// ONLY `hardDelete` so we can deterministically force an err AFTER the
// credit-back emit while every other read/write stays real. This exercises the
// REAL `makeEraseAllRegistrationsForMemberDeps` → `runEraseAttendeePii` →
// `runInTenantWithRollbackOnErr` → `eraseAttendeePii` composition; only step 5
// (hardDelete) is intercepted. The factory wires this same module, so the
// fan-out under test goes through the wrapped repo.
// ---------------------------------------------------------------------------
let hardDeleteShouldFail = false;

vi.mock(
  '@/modules/events/infrastructure/drizzle-registrations-repository',
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import('@/modules/events/infrastructure/drizzle-registrations-repository')
    >();
    return {
      ...actual,
      makeDrizzleRegistrationsRepository: (
        executor: Parameters<typeof actual.makeDrizzleRegistrationsRepository>[0],
      ): RegistrationsRepository => {
        const real = actual.makeDrizzleRegistrationsRepository(executor);
        return {
          ...real,
          hardDelete: async (tenantId, registrationId) => {
            if (hardDeleteShouldFail) {
              // Deterministic mid-tx failure AFTER the credit-back emit. The
              // real eraseAttendeePii has already loaded the row, emitted
              // `pii_erasure_requested`, acquired the lock, and emitted
              // `quota_credit_back_archive` — this err is the step-5 boundary.
              return { ok: false, error: { kind: 'db_error', message: 'injected hardDelete failure' } };
            }
            return real.hardDelete(tenantId, registrationId);
          },
        };
      },
    };
  },
);

// Import AFTER vi.mock so the factory binds the wrapped repo module.
const { makeEraseAllRegistrationsForMemberDeps } = await import('@/modules/events');

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

/** Seed a quota-COUNTED registration matched to `memberId` on `eventId`. */
async function seedCountedRegistration(
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
      attendeeName: 'Credit Back Attendee',
      attendeeCompany: 'Credit Back Co',
      // member_contact is NOT in the non_member/unmatched forbid-list, so the
      // counted_against_partnership=true + matched_member_id row satisfies the
      // `event_registrations_non_member_no_quota` CHECK.
      matchType: 'member_contact',
      matchedMemberId: memberId,
      countedAgainstPartnership: true,
      countedAgainstCulturalQuota: false,
      registeredAt: new Date(),
    } as unknown as NewEventRegistrationRow),
  );
  return registrationId;
}

/** Whether a specific registration row still exists (BYPASSRLS). */
async function registrationExists(registrationId: string): Promise<boolean> {
  const rows = await db
    .select({ registrationId: eventRegistrations.registrationId })
    .from(eventRegistrations)
    .where(eq(eventRegistrations.registrationId, registrationId));
  return rows.length === 1;
}

/** Count committed `quota_credit_back_archive` audit rows for a registration (BYPASSRLS). */
async function countCreditBackAudits(
  tenantSlug: string,
  registrationId: string,
): Promise<number> {
  // payload->>'registrationId' is how erase-attendee-pii records the per-scope
  // credit-back audit (see step 4 of the use-case).
  const result = await db.execute(sql`
    SELECT COUNT(*)::text AS count
    FROM audit_log
    WHERE tenant_id = ${tenantSlug}
      AND event_type = 'quota_credit_back_archive'::audit_event_type
      AND payload->>'registrationId' = ${registrationId}
  `);
  const rows = result as unknown as ReadonlyArray<{ count: string }>;
  return Number(rows[0]?.count ?? '0');
}

describe('COMP-1 US2c — factory eraseOne rolls back credit-back on err (no partial commit, no double credit-back) [live Neon]', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  const memberId = randomUUID();
  let eventA: string;
  let reg1: string; // the quota-counted registration we fail then re-drive

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    eventA = await seedEvent(tenant, 'Credit Back Event A');
    reg1 = await seedCountedRegistration(
      tenant,
      memberId,
      eventA,
      'creditback1@example.com',
    );
  }, 120_000);

  afterAll(async () => {
    hardDeleteShouldFail = false;
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('rolls back the credit-back audit when hardDelete errs, then a clean re-drive emits EXACTLY ONE credit-back', async () => {
    // Sanity: the counted row exists and no credit-back audit yet.
    expect(await registrationExists(reg1)).toBe(true);
    expect(await countCreditBackAudits(tenant.ctx.slug, reg1)).toBe(0);

    const realDeps = makeEraseAllRegistrationsForMemberDeps(tenant.ctx);
    const eraseInput = {
      tenantId: tenant.ctx.slug,
      actorUserId: admin.userId,
      reasonText: `member_erasure ${memberId}`,
      occurredAt: new Date(),
    } as const;

    // ---- PASS 1: hardDelete errs AFTER the credit-back emit -----------------
    hardDeleteShouldFail = true;
    const pass1 = await realDeps.eraseOne(reg1, eventA, eraseInput);
    // eraseAttendeePii surfaces the hardDelete err as a Result.err.
    expect(pass1.ok).toBe(false);

    // FIX BEHAVIOUR: the tx ROLLED BACK — the row SURVIVES and ZERO credit-back
    // audit rows were committed. Under the BROKEN plain-runInTenant code the
    // credit-back audit COMMITS here even though the row survives → this
    // assertion FAILS (count === 1).
    expect(await registrationExists(reg1)).toBe(true);
    expect(await countCreditBackAudits(tenant.ctx.slug, reg1)).toBe(0);

    // ---- PASS 2 (re-drive): clean run, no injection ------------------------
    hardDeleteShouldFail = false;
    const pass2 = await realDeps.eraseOne(reg1, eventA, eraseInput);
    expect(pass2.ok, JSON.stringify(pass2)).toBe(true);

    // The row is now hard-deleted and EXACTLY ONE credit-back audit exists.
    // Under the BROKEN code the PASS-1 committed credit-back + this one = TWO,
    // so the exactly-one assertion FAILS.
    expect(await registrationExists(reg1)).toBe(false);
    expect(await countCreditBackAudits(tenant.ctx.slug, reg1)).toBe(1);
  }, 120_000);
});
