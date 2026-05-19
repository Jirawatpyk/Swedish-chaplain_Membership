/**
 * F6.1 bug-fix 2026-05-18 — Family-email rowHash collision regression.
 *
 * EventCreate "Guestlist" CSVs can list multiple attendees under a
 * single primary registrant's email (family / group bookings). Each
 * attendee has a UNIQUE EventCreate "Attendee ID" (e.g.,
 * `17368626-1`, `17368626-2`, … `17368626-5` for a family of five),
 * but they all share one email like `crusselth@yahoo.com`.
 *
 * Bug (pre-fix): `computeRowHash` was
 *   sha256(event_external_id ⨯ email ⨯ ts)
 * so all five Wittebrood family rows produced the SAME rowHash. The
 * idempotency-receipt INSERT for row #1 succeeded; rows #2-5 hit the
 * receipt collision and were silently reported as `rowsAlreadyImported`
 * — only 1 of the 5 family members got persisted.
 *
 * Fix: include `attendee_external_id` in the hash. Each family member
 * now hashes distinctly so they all reach `processAttendeeInTx` and
 * land on unique (tenant, event, external_id) registrations.
 *
 * Live DB cost: ~5-8s wall-clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { runInTenant, db } from '@/lib/db';
import {
  events,
  eventRegistrations,
  type NewEventRow,
} from '@/modules/events/infrastructure/schema';
import { runImportCsv } from '@/lib/events-csv-import-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

/**
 * Synthetic EventCreate CSV with a family ticket (5 attendees sharing
 * one email + unique Attendee IDs) plus 2 other unique attendees so
 * the test asserts both family-collision-safe + lone-attendee paths.
 */
function buildFamilyCsv(): Uint8Array {
  const header =
    'Basic Info,Status,First Name,Last Name,Email,Phone Number,Phone Number Consent,Registration Date,Added Date,Last Updated Date,Attendee Edited Date,Ticket,Guest Of,Number of Guests Allowed,Checked In,Attendee ID,Order ID,VIP,Notes,Assigned Table,Tags,Company Name,Registration Category,Personal Data Protection Consent,Last Email Sent,Last Email Sent Date,Unsubscribed';

  const rows = [
    // Family of 5 sharing crusselth@yahoo.com, unique Attendee IDs
    'Vendela Gyllin,Attending,Vendela,Gyllin,crusselth@yahoo.com,,FALSE,2026-04-10,2026-04-10,2026-04-10,–,Adults,–,5,FALSE,17368626-1,17368626,FALSE,paid,–,,Acme,Members,I hereby acknowledge,–,–,–',
    'Monique Wittebrood,Attending,Monique,Wittebrood,crusselth@yahoo.com,,FALSE,2026-04-10,2026-04-10,2026-04-10,–,Adults,–,5,FALSE,17368626-2,17368626,FALSE,paid,–,,Acme,Members,I hereby acknowledge,–,–,–',
    'Chloe Wittebrood,Attending,Chloe,Wittebrood,crusselth@yahoo.com,,FALSE,2026-04-10,2026-04-10,2026-04-10,–,Adults,–,5,FALSE,17368626-3,17368626,FALSE,paid,–,,Acme,Members,I hereby acknowledge,–,–,–',
    'Robert Wittebrood,Attending,Robert,Wittebrood,crusselth@yahoo.com,,FALSE,2026-04-10,2026-04-10,2026-04-10,–,Adults,–,5,FALSE,17368626-4,17368626,FALSE,paid,–,,Acme,Members,I hereby acknowledge,–,–,–',
    'Christine Russel-Wittebrood,Attending,Christine,Russel-Wittebrood,crusselth@yahoo.com,,FALSE,2026-04-10,2026-04-10,2026-04-10,–,Adults,–,5,FALSE,17368626-5,17368626,FALSE,paid,–,,Acme,Members,I hereby acknowledge,–,–,–',
    // Two lone attendees (no shared email)
    'Sharifah Binti,Attending,Sharifah,Binti,sharifah@example.test,,FALSE,2026-04-10,2026-04-10,2026-04-10,–,Adults,–,1,FALSE,17447930-1,17447930,FALSE,paid,–,,Acme,Members,I hereby acknowledge,–,–,–',
    'Jonathan Vaknine,Attending,Jonathan,Vaknine,vaknine@example.test,,FALSE,2026-04-10,2026-04-10,2026-04-10,–,Adults,–,1,FALSE,17440517-1,17440517,FALSE,paid,–,,Acme,Members,I hereby acknowledge,–,–,–',
  ];

  return new TextEncoder().encode([header, ...rows].join('\n'));
}

describe('F6.1 family-email rowHash collision (live Neon)', () => {
  let tenant: TestTenant;
  let actor: TestUser;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    actor = await createActiveTestUser('admin');
  });

  afterAll(async () => {
    try {
      await tenant?.cleanup();
      if (actor) await deleteTestUser(actor);
    } catch {
      // uuid-suffixed slug isolates from other suites
    }
  });

  it('5 family members sharing one email all land as registrations (not deduped on rowHash)', { timeout: 60_000 }, async () => {
    const eventId = randomUUID();
    const externalId = `event-family-${eventId.slice(0, 8)}`;
    await db.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId,
      name: 'Family-collision test',
      startDate: new Date('2026-06-05T03:00:00Z'),
      category: null,
    } satisfies NewEventRow);

    const bytes = buildFamilyCsv();

    const r = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes,
      selectedEvent: {
        eventId,
        externalId,
        name: 'Family-collision test',
        startDate: new Date('2026-06-05T03:00:00Z'),
        category: null,
      },
      originalFilename: 'family.csv',
    });

    expect(r.kind).toBe('completed');
    if (r.kind !== 'completed') return;

    // All 7 rows imported (5 family + 2 lone) — none silently deduped.
    expect(r.summary.rowsTotal).toBe(7);
    expect(r.summary.rowsProcessed).toBe(7);
    expect(r.summary.rowsAlreadyImported).toBe(0);

    // DB has 7 rows with 5 distinct external_ids for the family.
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
    expect(regs.length).toBe(7);

    const familyExternalIds = regs
      .filter((r) => r.attendeeEmailLower === 'crusselth@yahoo.com')
      .map((r) => r.externalId)
      .sort();
    expect(familyExternalIds).toEqual([
      '17368626-1',
      '17368626-2',
      '17368626-3',
      '17368626-4',
      '17368626-5',
    ]);

    // Sanity: re-upload reports all 7 as already_imported (steady-state).
    const r2 = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes,
      selectedEvent: {
        eventId,
        externalId,
        name: 'Family-collision test',
        startDate: new Date('2026-06-05T03:00:00Z'),
        category: null,
      },
      originalFilename: 'family.csv',
      forceProceed: true,
    });
    expect(r2.kind).toBe('completed');
    if (r2.kind !== 'completed') return;
    expect(r2.summary.rowsProcessed).toBe(0);
    expect(r2.summary.rowsAlreadyImported).toBe(7);
  });

  /**
   * D6 follow-up (Option B+ /speckit-review): family bookings can
   * arrive with mixed statuses — the registrant locked in the table
   * while one child is still `Pending` (payment unverified) and
   * another fell to `Waitlisted`. The rowHash must still distinguish
   * each guest by `attendee_external_id`, AND each `payment_status`
   * MUST mirror the per-row Status — same dedup safety as the
   * all-Attending fixture but with the Option B+ mapping table
   * exercised across statuses.
   */
  it(
    'family bookings with mixed Status (Attending + Pending + Waitlisted) all persist with correct payment_status',
    { timeout: 60_000 },
    async () => {
      const eventId = randomUUID();
      const externalId = `event-family-mixed-${eventId.slice(0, 8)}`;
      await db.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId,
        name: 'Family mixed-status test',
        startDate: new Date('2026-06-05T03:00:00Z'),
        category: null,
      } satisfies NewEventRow);

      const header =
        'Basic Info,Status,First Name,Last Name,Email,Phone Number,Phone Number Consent,Registration Date,Added Date,Last Updated Date,Attendee Edited Date,Ticket,Guest Of,Number of Guests Allowed,Checked In,Attendee ID,Order ID,VIP,Notes,Assigned Table,Tags,Company Name,Registration Category,Personal Data Protection Consent,Last Email Sent,Last Email Sent Date,Unsubscribed';
      const family = [
        ['Vendela', 'Gyllin', 'Attending', '17400000-1'],
        ['Monique', 'Wittebrood', 'Pending', '17400000-2'],
        ['Chloe', 'Wittebrood', 'Waitlisted', '17400000-3'],
        ['Robert', 'Wittebrood', 'Attending', '17400000-4'],
        ['Christine', 'Russel-Wittebrood', 'Pending', '17400000-5'],
      ] as const;
      const SHARED_EMAIL = 'family-mixed@example.test';
      const lines = family.map(
        ([first, last, status, attId]) =>
          `${first} ${last},${status},${first},${last},${SHARED_EMAIL},,FALSE,2026-04-10,2026-04-10,2026-04-10,–,Adults,–,5,FALSE,${attId},17400000,FALSE,–,–,,Acme,Members,I hereby acknowledge,–,–,–`,
      );
      const bytes = new TextEncoder().encode([header, ...lines].join('\n'));

      const r = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes,
        selectedEvent: {
          eventId,
          externalId,
          name: 'Family mixed-status test',
          startDate: new Date('2026-06-05T03:00:00Z'),
          category: null,
        },
        originalFilename: 'family-mixed.csv',
      });
      expect(r.kind).toBe('completed');
      if (r.kind !== 'completed') return;

      // All 5 family members persist — no rowHash collision dedup even
      // though they share an email AND have different statuses.
      expect(r.summary.rowsProcessed).toBe(5);
      expect(r.summary.rowsSkipped).toBe(0);

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
      expect(regs.length).toBe(5);

      const byExternalId = new Map(regs.map((row) => [row.externalId, row]));
      for (const [, , status, attId] of family) {
        const row = byExternalId.get(attId);
        const expected =
          status === 'Attending'
            ? 'paid'
            : status === 'Pending'
              ? 'pending'
              : 'waitlisted';
        expect(row?.paymentStatus).toBe(expected);
      }
    },
  );
});
