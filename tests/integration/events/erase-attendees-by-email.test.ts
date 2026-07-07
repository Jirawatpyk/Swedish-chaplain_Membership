/**
 * F6 remediation PR 2.1 / P3 (FR-032a by-email erasure BACKEND) — integration
 * test for `runEraseAttendeesByEmail` (live Neon Singapore, real per-row
 * erasure).
 *
 * Drives the full DESTRUCTIVE composition: `makeEraseAttendeesByEmailDeps`
 * (`list` → P1 `findByEmailLower` under one enumerate-tx; `eraseOne` →
 * `runEraseAttendeePii` in its OWN tx per row) → the best-effort fan-out
 * `eraseAttendeeRegistrationsByEmail`. Proves:
 *
 *   1. two registrations sharing an attendee email across two events are BOTH
 *      hard-deleted, with `pii_erasure_requested` + `pii_erasure_completed`
 *      audits per row and ≥1 `quota_credit_back_archive` for the
 *      partnership-counted row — `failedCount: 0`.
 *   2. CROSS-TENANT probe: tenant B bulk-erasing tenant A's email erases
 *      NOTHING (Principle I) — tenant A's rows survive the probe untouched.
 *   3. IDEMPOTENT re-run: after the rows are hard-deleted, re-running the
 *      sweep is a clean no-op — `{ 0, 0, 0 }` and NO new audits.
 *
 * NOTE on the idempotent tally (deviation from the task brief's literal
 * "alreadyErasedCount 2"): the enumeration keys on the LIVE
 * `event_registrations` table via `findByEmailLower`. Once the rows are
 * hard-deleted they are GONE, so a re-run enumerates ZERO rows and the tally
 * is `{ erasedCount: 0, alreadyErasedCount: 0, failedCount: 0 }` — not
 * `alreadyErasedCount: 2`. This is the CORRECT idempotent behaviour and mirrors
 * the member fan-out re-drive (`erase-all-registrations-throw-path.test.ts`),
 * where already-deleted rows are simply not re-enumerated. The per-row
 * `alreadyErased` tally (via `eraseAttendeePii`'s prior-audit probe) is covered
 * at the unit level in `erase-attendee-registrations-by-email.test.ts`; it is
 * unreachable here because a live-table enumeration never yields a deleted row.
 *
 * Seeding uses direct `tx` inserts (threaded from `runInTenant`). The
 * partnership-counted row uses `match_type = 'member_contact'` + a
 * `matched_member_id` (denormalised uuid — NO FK) so the credit-back path
 * fires; the second row is a plain `non_member`. `matched_member_id` needs no
 * seeded member row (F6 stores a denormalised id). Audit rows for F6 event
 * types are JS-filtered (the F6 types are absent from the auth pgEnum union).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { runEraseAttendeesByEmail } from '@/lib/events-admin-deps';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

const SHARED_EMAIL = `erase-guest-${randomUUID().slice(0, 8)}@example.com`;

// ---- BYPASSRLS raw reads (oracles) ----------------------------------------

async function rawSelectRegsByEmail(tenantSlug: string) {
  return db
    .select()
    .from(eventRegistrations)
    .where(
      and(
        eq(eventRegistrations.tenantId, tenantSlug),
        eq(eventRegistrations.attendeeEmailLower, SHARED_EMAIL.toLowerCase()),
      ),
    );
}

/** Audit rows of a given F6 event_type whose payload.registrationId is in the set. */
async function rawSelectF6Audits(
  tenantSlug: string,
  eventType: string,
  registrationIds: readonly string[],
) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.tenantId, tenantSlug));
  const idSet = new Set(registrationIds);
  return rows.filter(
    (r) =>
      String(r.eventType) === eventType &&
      idSet.has(
        String((r.payload as { registrationId?: string } | null)?.registrationId),
      ),
  );
}

describe('F6 P3 — runEraseAttendeesByEmail (live Neon, real per-row erasure)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;

  const memberId = randomUUID(); // denormalised match id (no FK to members)
  const eventA = randomUUID();
  const eventB = randomUUID();
  const regPartnership = randomUUID(); // eventA, member_contact, partnership-counted
  const regNonMember = randomUUID(); // eventB, non_member

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
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
          name: 'Erase Event A',
          startDate: new Date('2026-05-10T10:00:00Z'),
        },
        {
          tenantId: slug,
          eventId: eventB,
          source: 'eventcreate',
          externalId: `ext_b_${randomUUID()}`,
          name: 'Erase Event B',
          startDate: new Date('2026-06-10T10:00:00Z'),
        },
      ] satisfies NewEventRow[]);

      await tx.insert(eventRegistrations).values([
        {
          tenantId: slug,
          registrationId: regPartnership,
          eventId: eventA,
          externalId: `att_p_${randomUUID()}`,
          attendeeEmail: SHARED_EMAIL,
          attendeeName: 'Erase Guest',
          attendeeCompany: 'Erase Co',
          matchType: 'member_contact',
          matchedMemberId: memberId,
          countedAgainstPartnership: true,
          countedAgainstCulturalQuota: false,
          registeredAt: new Date('2026-05-10T09:00:00Z'),
        },
        {
          tenantId: slug,
          registrationId: regNonMember,
          eventId: eventB,
          externalId: `att_n_${randomUUID()}`,
          attendeeEmail: SHARED_EMAIL,
          attendeeName: 'Erase Guest',
          matchType: 'non_member',
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: false,
          registeredAt: new Date('2026-06-10T09:00:00Z'),
        },
      ] as unknown as NewEventRegistrationRow[]);
    });
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('bulk-erases both same-email regs (hard-delete + audits + credit-back), cross-tenant probe erases nothing, idempotent re-run is a clean no-op', async () => {
    const bothIds = [regPartnership, regNonMember];

    // Sanity: BEFORE any erase, both rows exist.
    expect(await rawSelectRegsByEmail(tenantA.ctx.slug)).toHaveLength(2);

    // ---- CROSS-TENANT PROBE (Principle I): tenant B erasing tenant A's email
    // must erase NOTHING — tenant A's rows survive. Run BEFORE tenant A's own
    // erase so the "survives" assertion is meaningful.
    const probe = await runEraseAttendeesByEmail(tenantB.ctx.slug, {
      emailLower: SHARED_EMAIL,
      actorUserId: admin.userId,
      reasonText: 'cross_tenant_probe',
      occurredAt: new Date(),
    });
    expect(probe.ok, JSON.stringify(probe)).toBe(true);
    if (!probe.ok) return;
    expect(probe.value).toEqual({
      erasedCount: 0,
      alreadyErasedCount: 0,
      failedCount: 0,
      truncated: false,
    });
    // Tenant A's rows are untouched by tenant B's probe.
    expect(await rawSelectRegsByEmail(tenantA.ctx.slug)).toHaveLength(2);
    // Tenant B saw no rows to erase (RLS + explicit predicate).
    expect(await rawSelectRegsByEmail(tenantB.ctx.slug)).toHaveLength(0);

    // ---- TENANT A bulk erase (destructive) --------------------------------
    const result = await runEraseAttendeesByEmail(tenantA.ctx.slug, {
      emailLower: SHARED_EMAIL,
      actorUserId: admin.userId,
      reasonText: 'gdpr_art_17_dsr_by_email',
      occurredAt: new Date(),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      erasedCount: 2,
      alreadyErasedCount: 0,
      failedCount: 0,
      truncated: false,
    });

    // Both rows HARD-DELETED — no residual PII under the email.
    expect(await rawSelectRegsByEmail(tenantA.ctx.slug)).toHaveLength(0);

    // Audits: 2 requested + 2 completed (one per registration).
    const requested = await rawSelectF6Audits(
      tenantA.ctx.slug,
      'pii_erasure_requested',
      bothIds,
    );
    expect(new Set(requested.map((r) =>
      String((r.payload as { registrationId?: string }).registrationId),
    ))).toEqual(new Set(bothIds));

    const completed = await rawSelectF6Audits(
      tenantA.ctx.slug,
      'pii_erasure_completed',
      bothIds,
    );
    expect(completed.length, 'expected exactly 2 pii_erasure_completed audits').toBe(2);
    expect(new Set(completed.map((r) =>
      String((r.payload as { registrationId?: string }).registrationId),
    ))).toEqual(new Set(bothIds));

    // ≥1 quota_credit_back_archive for the partnership-counted registration.
    const creditBacks = await rawSelectF6Audits(
      tenantA.ctx.slug,
      'quota_credit_back_archive',
      bothIds,
    );
    expect(creditBacks.length).toBeGreaterThanOrEqual(1);
    expect(
      creditBacks.some(
        (r) =>
          String((r.payload as { registrationId?: string }).registrationId) ===
            regPartnership &&
          (r.payload as { scope?: string }).scope === 'partnership',
      ),
    ).toBe(true);

    // ---- IDEMPOTENT re-run: rows are gone → clean zero tally, no new audits.
    const rerun = await runEraseAttendeesByEmail(tenantA.ctx.slug, {
      emailLower: SHARED_EMAIL,
      actorUserId: admin.userId,
      reasonText: 'gdpr_art_17_dsr_by_email',
      occurredAt: new Date(),
    });
    expect(rerun.ok, JSON.stringify(rerun)).toBe(true);
    if (!rerun.ok) return;
    expect(rerun.value).toEqual({
      erasedCount: 0,
      alreadyErasedCount: 0,
      failedCount: 0,
      truncated: false,
    });
    // No NEW pii_erasure_completed audits — still exactly 2.
    const completedAfterRerun = await rawSelectF6Audits(
      tenantA.ctx.slug,
      'pii_erasure_completed',
      bothIds,
    );
    expect(completedAfterRerun.length).toBe(2);
  }, 120_000);
});
