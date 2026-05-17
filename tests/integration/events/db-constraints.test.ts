/**
 * Phase B B10 — Negative tests for the migration 0136 CHECK constraint
 * (`event_registrations_non_member_no_quota`).
 *
 * Migration 0136 was specifically added to prevent a future relink-flow
 * regression from persisting inconsistent state invisibly. The
 * defence-in-depth value evaporates if no test holds the DB to it — a
 * `DROP CONSTRAINT` slipped into a later migration would not break any
 * test. This file pins the invariant in CI.
 *
 * Invariant: for rows with `match_type IN ('non_member','unmatched')`:
 *   - matched_member_id IS NULL
 *   - matched_contact_id IS NULL
 *   - counted_against_partnership = false
 *   - counted_against_cultural_quota = false
 *
 * Any INSERT violating any of these MUST raise constraint_violation
 * (Postgres SQLSTATE 23514).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { events, eventRegistrations } from '@/modules/events/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const SEED_FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

let tenant: TestTenant;
let eventId: string;

beforeAll(async () => {
  tenant = await createTestTenant();
  eventId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(events).values({
      eventId,
      tenantId: tenant.ctx.slug,
      externalId: `chk-constraint-${randomUUID().slice(0, 8)}`,
      source: 'admin_manual',
      name: 'CHECK constraint test event',
      startDate: SEED_FAR_FUTURE,
      isPartnerBenefit: false,
      isCulturalEvent: false,
    });
  });
});

afterAll(async () => {
  await runInTenant(tenant.ctx, async (tx) => {
    // Delete child rows first (FK constraint) then the parent event.
    await tx
      .delete(eventRegistrations)
      .where(sql`event_id = ${eventId}`);
    await tx.delete(events).where(sql`event_id = ${eventId}`);
  });
});

function baseRow(matchType: string, overrides: Record<string, unknown> = {}) {
  const externalId = `attendee-${randomUUID().slice(0, 8)}`;
  return {
    registrationId: randomUUID(),
    tenantId: tenant.ctx.slug,
    eventId,
    externalId,
    attendeeEmail: `${externalId}@chk.test`,
    attendeeName: 'CHK Test',
    attendeeCompany: null,
    matchType,
    matchedMemberId: null,
    matchedContactId: null,
    countedAgainstPartnership: false,
    countedAgainstCulturalQuota: false,
    paymentStatus: 'paid',
    registeredAt: new Date(),
    ...overrides,
  };
}

/**
 * Asserts the INSERT throws AND that the underlying Postgres error
 * matches our 0136 CHECK constraint signal. Drizzle wraps the
 * Postgres error so we inspect `.cause` (the original PostgresError)
 * which carries `.code === '23514'` + the constraint name in
 * `.constraint_name` or in the error message.
 */
async function expectCheckConstraintViolation(fn: () => Promise<unknown>) {
  let caught: unknown = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).not.toBeNull();
  const err = caught as { cause?: unknown; message?: string };
  const cause = err.cause as { code?: string; message?: string } | undefined;
  const fullMessage = `${err.message ?? ''} ${cause?.message ?? ''}`;
  const causeCode = cause?.code ?? null;
  const matchedCheck =
    causeCode === '23514' ||
    /check.*constraint|event_registrations_non_member_no_quota/i.test(fullMessage);
  expect(matchedCheck).toBe(true);
}

describe('Phase B B10 — migration 0136 event_registrations_non_member_no_quota CHECK', () => {
  describe('rejected (constraint violation expected)', () => {
    it('rejects non_member row with matched_contact_id', async () => {
      await expectCheckConstraintViolation(() =>
        runInTenant(tenant.ctx, async (tx) => {
          await tx
            .insert(eventRegistrations)
            .values(baseRow('non_member', {
              matchedContactId: randomUUID(),
            }) as typeof eventRegistrations.$inferInsert);
        }),
      );
    });

    it('rejects unmatched row with matched_member_id', async () => {
      await expectCheckConstraintViolation(() =>
        runInTenant(tenant.ctx, async (tx) => {
          await tx
            .insert(eventRegistrations)
            .values(baseRow('unmatched', {
              matchedMemberId: randomUUID(),
            }) as typeof eventRegistrations.$inferInsert);
        }),
      );
    });

    it('rejects non_member row with countedAgainstPartnership=true', async () => {
      await expectCheckConstraintViolation(() =>
        runInTenant(tenant.ctx, async (tx) => {
          await tx
            .insert(eventRegistrations)
            .values(baseRow('non_member', {
              countedAgainstPartnership: true,
            }) as typeof eventRegistrations.$inferInsert);
        }),
      );
    });

    it('rejects unmatched row with countedAgainstCulturalQuota=true', async () => {
      await expectCheckConstraintViolation(() =>
        runInTenant(tenant.ctx, async (tx) => {
          await tx
            .insert(eventRegistrations)
            .values(baseRow('unmatched', {
              countedAgainstCulturalQuota: true,
            }) as typeof eventRegistrations.$inferInsert);
        }),
      );
    });
  });

  describe('accepted (valid combinations)', () => {
    it('accepts member_contact row with matched_member_id + matched_contact_id', async () => {
      await runInTenant(tenant.ctx, async (tx) => {
        await tx
          .insert(eventRegistrations)
          .values(baseRow('member_contact', {
            matchedMemberId: randomUUID(),
            matchedContactId: randomUUID(),
            countedAgainstPartnership: true,
          }) as typeof eventRegistrations.$inferInsert);
      });
      // no throw = pass
    });

    it('accepts pure non_member row (all member fields null + counters false)', async () => {
      await runInTenant(tenant.ctx, async (tx) => {
        await tx
          .insert(eventRegistrations)
          .values(baseRow('non_member') as typeof eventRegistrations.$inferInsert);
      });
    });

    it('accepts pure unmatched row', async () => {
      await runInTenant(tenant.ctx, async (tx) => {
        await tx
          .insert(eventRegistrations)
          .values(baseRow('unmatched') as typeof eventRegistrations.$inferInsert);
      });
    });

    it('accepts member_domain row with matched_member_id + null contact', async () => {
      await runInTenant(tenant.ctx, async (tx) => {
        await tx
          .insert(eventRegistrations)
          .values(baseRow('member_domain', {
            matchedMemberId: randomUUID(),
          }) as typeof eventRegistrations.$inferInsert);
      });
    });
  });
});
