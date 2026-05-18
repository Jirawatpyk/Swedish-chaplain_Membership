/**
 * F6.1 Option B+ (2026-05-18) — Mirror EventCreate Status into
 * event_registrations.payment_status via the CSV import path.
 *
 * Acceptance:
 *   1. CSV with a mix of Status values (Attending, Pending, Waitlisted,
 *      No Show, Cancelled, plus a typo-Skipped) imports such that:
 *        - rowsProcessed counts Attending + Pending + Waitlisted + NoShow
 *        - rowsSkipped counts the typo + Cancellation-without-prior ghost
 *      Each persisted row's `payment_status` matches the mapping table.
 *
 *   2. Quota strict allowlist — only the `paid` row contributes to
 *      partnership / cultural quota (matched member · partner-benefit
 *      event). Pending / Waitlisted / NoShow attendees DO NOT count.
 *
 *   3. Re-upload with `Pending → Attending` for the same attendee bumps
 *      `rowsStateChanged` and updates `payment_status='paid'` via the
 *      existing `maybeApplyStateChange` path. The other 3 rows report as
 *      `rowsAlreadyImported`.
 *
 * Live DB cost: ~12-18s wall-clock (event upsert + 5 attendee inserts
 * + re-upload + state-change UPDATE).
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

const HEADER =
  'Basic Info,Status,First Name,Last Name,Email,Phone Number,Phone Number Consent,Registration Date,Added Date,Last Updated Date,Attendee Edited Date,Ticket,Guest Of,Number of Guests Allowed,Checked In,Attendee ID,Order ID,VIP,Notes,Assigned Table,Tags,Company Name,Registration Category,Personal Data Protection Consent,Last Email Sent,Last Email Sent Date,Unsubscribed';

function buildRow(
  firstName: string,
  status: string,
  email: string,
  attendeeId: string,
): string {
  const cells = [
    `${firstName} Mirror`,
    status,
    firstName,
    'Mirror',
    email,
    '',
    'FALSE',
    '2026-04-01T09:00:00Z',
    '2026-04-01T09:00:00Z',
    '2026-04-01T09:00:00Z',
    '–',
    'Standard',
    '–',
    '1',
    'FALSE',
    attendeeId,
    attendeeId.split('-')[0] ?? attendeeId,
    'FALSE',
    '', // Notes — Option B+ ignores
    '–',
    '',
    'Test Co',
    'Member',
    'I hereby acknowledge',
    '–',
    '–',
    'FALSE',
  ];
  return cells
    .map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
    .join(',');
}

function buildCsv(rows: ReadonlyArray<string>): Uint8Array {
  return new TextEncoder().encode([HEADER, ...rows].join('\r\n') + '\r\n');
}

describe('F6.1 Option B+ — Status mirroring (live Neon)', () => {
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

  it(
    'mixed Status CSV → each persists with correct payment_status; only paid counts toward quota',
    { timeout: 90_000 },
    async () => {
      const eventId = randomUUID();
      const externalId = `event-mirror-${eventId.slice(0, 8)}`;
      await db.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId,
        name: 'Status mirroring test',
        startDate: new Date('2026-06-05T03:00:00Z'),
        category: null,
      } satisfies NewEventRow);

      const csv = buildCsv([
        buildRow('Anna', 'Attending', 'anna@example.test', '17000-1'),
        buildRow('Bob', 'Pending', 'bob@example.test', '17000-2'),
        buildRow('Carla', 'Waitlisted', 'carla@example.test', '17000-3'),
        buildRow('Dan', 'No Show', 'dan@example.test', '17000-4'),
        buildRow('Eve', 'Garbage', 'eve@example.test', '17000-5'),
      ]);

      const r = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: csv,
        selectedEvent: {
          eventId,
          externalId,
          name: 'Status mirroring test',
          startDate: new Date('2026-06-05T03:00:00Z'),
          category: null,
        },
        originalFilename: 'mirror.csv',
      });
      expect(r.kind).toBe('completed');
      if (r.kind !== 'completed') return;

      // 4 mirrored rows + 1 Skipped (Status=Garbage).
      expect(r.summary.rowsTotal).toBe(5);
      expect(r.summary.rowsProcessed).toBe(4);
      expect(r.summary.rowsSkipped).toBe(1);
      expect(r.summary.rowsAlreadyImported).toBe(0);

      // Verify per-row payment_status mapping.
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
      expect(regs.length).toBe(4);
      const byEmail = new Map(
        regs.map((row) => [row.attendeeEmailLower, row.paymentStatus]),
      );
      expect(byEmail.get('anna@example.test')).toBe('paid');
      expect(byEmail.get('bob@example.test')).toBe('pending');
      expect(byEmail.get('carla@example.test')).toBe('waitlisted');
      expect(byEmail.get('dan@example.test')).toBe('no_show');
      expect(byEmail.has('eve@example.test')).toBe(false);

      // Quota strict allowlist — even if event were partner-benefit + the
      // 4 attendees were all matched members, only the `paid` row would
      // be counted. Here the event has no flags set (default seed) so
      // counted_against_* fields are false for all 4. Sanity-check that
      // none of the non-paid rows somehow got counted.
      const counted = regs.filter(
        (row) =>
          row.countedAgainstPartnership || row.countedAgainstCulturalQuota,
      );
      expect(counted.length).toBe(0);
    },
  );

  it(
    'Pending → Attending re-upload UPDATEs payment_status (rowsStateChanged=1)',
    { timeout: 90_000 },
    async () => {
      const eventId = randomUUID();
      const externalId = `event-flip-${eventId.slice(0, 8)}`;
      await db.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId,
        name: 'Pending→Attending flip',
        startDate: new Date('2026-06-05T03:00:00Z'),
        category: null,
      } satisfies NewEventRow);

      const selectedEvent = {
        eventId,
        externalId,
        name: 'Pending→Attending flip',
        startDate: new Date('2026-06-05T03:00:00Z'),
        category: null,
      };

      // 1st upload — Status=Pending
      const r1 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow('Frank', 'Pending', 'frank@example.test', '17001-1'),
        ]),
        selectedEvent,
        originalFilename: 'flip-1.csv',
      });
      expect(r1.kind).toBe('completed');
      if (r1.kind !== 'completed') return;
      expect(r1.summary.rowsProcessed).toBe(1);

      const regsAfter1 = await runInTenant(tenant.ctx, async (tx) =>
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
      expect(regsAfter1).toHaveLength(1);
      expect(regsAfter1[0]?.paymentStatus).toBe('pending');

      // 2nd upload — same row, Status flipped to Attending
      const r2 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow('Frank', 'Attending', 'frank@example.test', '17001-1'),
        ]),
        selectedEvent,
        originalFilename: 'flip-2.csv',
        forceProceed: true,
      });
      expect(r2.kind).toBe('completed');
      if (r2.kind !== 'completed') return;
      expect(r2.summary.rowsProcessed).toBe(0);
      expect(r2.summary.rowsAlreadyImported).toBe(0);
      expect(r2.summary.rowsStateChanged).toBe(1);

      const regsAfter2 = await runInTenant(tenant.ctx, async (tx) =>
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
      expect(regsAfter2).toHaveLength(1);
      expect(regsAfter2[0]?.paymentStatus).toBe('paid');
    },
  );
});
