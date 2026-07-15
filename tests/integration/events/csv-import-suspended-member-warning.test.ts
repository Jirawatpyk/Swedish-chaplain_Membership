/**
 * 059-membership-suspension Task 17 — F6 CSV import alert-only
 * suspended/terminated-member observability (live Neon Singapore).
 *
 * Seeds a real member + F8 renewal_cycle whose status resolves to
 * `suspended` (`awaiting_payment`) via `deriveMembershipAccess`, plus a
 * `contacts` row so the CSV attendee's email resolves a real
 * `member_contact` match (mirrors `match-attendee-to-member.test.ts`'s
 * fixture pattern). Imports a matching CSV row through the REAL
 * production composition (`runImportCsv` → `makeImportCsvDeps()` →
 * `membershipAccessBridge`) and asserts:
 *
 *   1. The registration IS persisted (never blocks).
 *   2. `summary.suspendedMemberWarnings` flags the row.
 *   3. A real `event_attendance_by_suspended_member` audit_log row exists.
 *
 * A control case (full-access member) proves the warning is NOT raised
 * when access is `full`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { runInTenant, db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import {
  events,
  eventRegistrations,
  type NewEventRow,
} from '@/modules/events/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { runImportCsv } from '@/lib/events-csv-import-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

function buildCsv(email: string, externalId: string): Uint8Array {
  const header =
    'event_external_id,event_name,event_start,attendee_email,attendee_name';
  const line = `${externalId},Suspended Member Test,2026-06-21T18:00:00+07:00,${email},Live Attendee`;
  return new TextEncoder().encode([header, line].join('\n'));
}

describe('059-membership-suspension Task 17 — F6 CSV import suspended-member warning (live Neon)', () => {
  let tenant: TestTenant;
  let actor: TestUser;
  const PLAN_ID = `test-plan-t17-${randomUUID()}`;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    actor = await createActiveTestUser('admin');
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: PLAN_ID,
        planName: { en: 'Task 17 Test Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: actor.userId,
      });
    });
  });

  afterAll(async () => {
    await tenant?.cleanup();
    if (actor) await deleteTestUser(actor);
  });

  it('matched SUSPENDED member: registration persisted + summary warning + real audit_log row', async () => {
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const attendeeEmail = `suspended-t17-${randomUUID().slice(0, 8)}@fixture.example`;
    const now = Date.now();
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Task 17 Suspended Co',
        country: 'TH',
        planId: PLAN_ID,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Susp',
        lastName: 'Contact',
        email: attendeeEmail,
        isPrimary: true,
      } as unknown as typeof contacts.$inferInsert);
      // `awaiting_payment` → deriveMembershipAccess resolves `suspended`
      // (reason: 'unpaid') regardless of expiresAt.
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date(now - 30 * MS_PER_DAY),
        periodTo: new Date(now + 60 * MS_PER_DAY),
        expiresAt: new Date(now + 60 * MS_PER_DAY),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: PLAN_ID,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });

    const eventId = randomUUID();
    const externalId = `event-t17-susp-${eventId.slice(0, 8)}`;
    await db.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId,
      name: 'Suspended Member Test',
      startDate: new Date('2026-06-21T18:00:00+07:00'),
      category: null,
    } satisfies NewEventRow);

    const result = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes: buildCsv(attendeeEmail, externalId),
      selectedEvent: {
        eventId,
        externalId,
        name: 'Suspended Member Test',
        startDate: new Date('2026-06-21T18:00:00+07:00'),
        category: null,
      },
      originalFilename: 'task17-suspended.csv',
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;

    // Never blocks — the row IS recorded.
    expect(result.summary.rowsProcessed).toBe(1);
    expect(result.summary.rowsFailed).toBe(0);

    // Flagged in the import result.
    expect(result.summary.suspendedMemberWarnings).toHaveLength(1);
    expect(result.summary.suspendedMemberWarnings[0]).toMatchObject({
      memberId,
      accessState: 'suspended',
    });

    // Registration genuinely persisted.
    const regs = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.tenantId, tenant.ctx.slug),
            eq(eventRegistrations.eventId, eventId),
          ),
        ),
    );
    expect(regs).toHaveLength(1);
    expect(regs[0]?.matchedMemberId).toBe(memberId);

    // Real audit_log row for the new event type.
    const auditRows = await db
      .select({
        eventType: auditLog.eventType,
        payload: auditLog.payload,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'event_attendance_by_suspended_member' as never),
        ),
      );
    expect(auditRows).toHaveLength(1);
    const payload = auditRows[0]?.payload as Record<string, unknown>;
    expect(payload['matchedMemberId']).toBe(memberId);
    expect(payload['accessState']).toBe('suspended');
  });

  it('matched FULL-access member: registration persisted, NO warning, NO audit row', async () => {
    const memberId = randomUUID();
    const attendeeEmail = `full-t17-${randomUUID().slice(0, 8)}@fixture.example`;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Task 17 Full-Access Co',
        country: 'TH',
        planId: PLAN_ID,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Full',
        lastName: 'Access',
        email: attendeeEmail,
        isPrimary: true,
      } as unknown as typeof contacts.$inferInsert);
      // No renewal_cycles row at all → deriveMembershipAccess(null, now)
      // === { access: 'full', reason: 'in_good_standing' }.
    });

    const eventId = randomUUID();
    const externalId = `event-t17-full-${eventId.slice(0, 8)}`;
    await db.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId,
      name: 'Full-Access Member Test',
      startDate: new Date('2026-06-21T18:00:00+07:00'),
      category: null,
    } satisfies NewEventRow);

    const result = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes: buildCsv(attendeeEmail, externalId),
      selectedEvent: {
        eventId,
        externalId,
        name: 'Full-Access Member Test',
        startDate: new Date('2026-06-21T18:00:00+07:00'),
        category: null,
      },
      originalFilename: 'task17-full-access.csv',
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.summary.rowsProcessed).toBe(1);
    expect(result.summary.suspendedMemberWarnings).toHaveLength(0);

    // No `event_attendance_by_suspended_member` audit row references THIS
    // member — the membership-access check ran (member matched) but
    // resolved 'full', so the warning path never fired.
    const auditRows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'event_attendance_by_suspended_member' as never),
        ),
      );
    const matchesThisMember = auditRows.some(
      (r) => (r.payload as Record<string, unknown>)['matchedMemberId'] === memberId,
    );
    expect(matchesThisMember).toBe(false);
  });
});
