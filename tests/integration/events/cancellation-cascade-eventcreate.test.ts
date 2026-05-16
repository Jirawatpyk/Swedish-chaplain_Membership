/**
 * T032 (F6.1 · Feature 013 — Phase 4 US2) — Cancellation cascade on the
 * EventCreate adapter path against live Neon Singapore (FR-018 / Q3).
 *
 * Acceptance:
 *   1. Upload CSV with attendee Status=Attending + payment_status=paid
 *      → registration row created with payment_status='paid'.
 *   2. Re-upload with the SAME attendee changed to Status=Cancelled
 *      → registration row's payment_status flips 'paid' → 'refunded'.
 *   3. NO F4 invoice mutation occurs (Q2 cross-cutting drop verified —
 *      `invoices` row count for this tenant remains 0).
 *   4. NO Stripe processor event recorded (we never call out of F6).
 *
 * Quota credit-back is exercised by F6 Phase 6 tests (apply-quota-effect
 * + transactional-ingest); this test focuses on the CSV-driven flip path.
 *
 * Live DB cost: ~6-10s per run × 2 = ~15-20s wall-clock.
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
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { processorEvents } from '@/modules/payments/infrastructure/schema';
import { runImportCsv } from '@/lib/events-csv-import-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

const EVENTCREATE_HEADER =
  'Basic Info,Status,First Name,Last Name,Email,Phone Number,Phone Number Consent,Registration Date,Added Date,Last Updated Date,Attendee Edited Date,Ticket,Guest Of,Checked In,Attendee ID,Order ID,VIP,Notes,Assigned Table,Tags,Company Name,Registration Category,Personal Data Protection Consent,Last Email Sent,Last Email Sent Date,Unsubscribed';

interface SyntheticAttendee {
  readonly status: 'Attending' | 'Cancelled';
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly attendeeId: string;
  readonly notes: string;
  readonly company: string;
}

/**
 * Build a minimal EventCreate-format CSV with the given attendee rows.
 * Header is the canonical 26-column real-export shape (no inline newlines
 * in any cell — we don't need RFC 4180 quoted-cell coverage here).
 */
function buildEventCreateCsv(attendees: ReadonlyArray<SyntheticAttendee>): Uint8Array {
  const rows: string[] = [EVENTCREATE_HEADER];
  for (const a of attendees) {
    const cells = [
      'Workshop',                  // Basic Info
      a.status,                    // Status
      a.firstName,                 // First Name
      a.lastName,                  // Last Name
      a.email,                     // Email
      '',                          // Phone Number
      '',                          // Phone Number Consent
      '2026-03-10T09:00:00Z',      // Registration Date
      '2026-03-10T09:00:00Z',      // Added Date
      '2026-03-10T09:00:00Z',      // Last Updated Date
      '2026-03-10T09:00:00Z',      // Attendee Edited Date
      'Standard',                  // Ticket
      '',                          // Guest Of
      'No',                        // Checked In
      a.attendeeId,                // Attendee ID
      'ord-1',                     // Order ID
      'No',                        // VIP
      a.notes,                     // Notes (drives payment_status inference)
      '',                          // Assigned Table
      '',                          // Tags
      a.company,                   // Company Name
      'Member',                    // Registration Category
      'I hereby acknowledge',      // Personal Data Protection Consent
      '',                          // Last Email Sent
      '',                          // Last Email Sent Date
      'No',                        // Unsubscribed
    ];
    rows.push(cells.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','));
  }
  return new TextEncoder().encode(rows.join('\r\n') + '\r\n');
}

describe('T032 — Cancellation cascade on EventCreate adapter (live Neon)', () => {
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

  it('Status: Attending → Cancelled flips payment_status to refunded; no F4 invoice + no Stripe processor row', async () => {
    // Seed event
    const eventId = randomUUID();
    const externalId = `event-${eventId.slice(0, 8)}`;
    await db.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId,
      name: 'Cancellation Test Workshop',
      startDate: new Date('2026-04-10T13:00:00Z'),
      category: null,
    } satisfies NewEventRow);

    const attendee = {
      status: 'Attending' as const,
      firstName: 'Cancellation',
      lastName: 'Subject',
      email: 'cancellation.subject@example.test',
      attendeeId: 'ec-cancel-001',
      notes: 'Paid',
      company: 'Test Co Ltd',
    };

    // ---- First upload — Attending + Paid ------------------------------
    const r1 = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes: buildEventCreateCsv([attendee]),
      selectedEvent: {
        eventId,
        externalId,
        name: 'Cancellation Test Workshop',
        startDate: new Date('2026-04-10T13:00:00Z'),
        category: null,
      },
      originalFilename: 'cancel-test-attending.csv',
    });
    expect(r1.kind).toBe('completed');
    if (r1.kind !== 'completed') return;
    expect(r1.sourceFormat).toBe('eventcreate_csv');
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
    expect(regsAfter1[0]?.paymentStatus).toBe('paid');

    // ---- Second upload — same attendee, Status=Cancelled --------------
    const r2 = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes: buildEventCreateCsv([{ ...attendee, status: 'Cancelled' }]),
      selectedEvent: {
        eventId,
        externalId,
        name: 'Cancellation Test Workshop',
        startDate: new Date('2026-04-10T13:00:00Z'),
        category: null,
      },
      originalFilename: 'cancel-test-cancelled.csv',
      forceProceed: true,
    });
    expect(r2.kind).toBe('completed');

    // The registration row flipped to refunded.
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
    expect(regsAfter2[0]?.paymentStatus).toBe('refunded');

    // ---- Q2 verification: NO F4 invoice mutation ----------------------
    const invoiceRows = await db
      .select()
      .from(invoices)
      .where(eq(invoices.tenantId, tenant.ctx.slug));
    expect(invoiceRows).toHaveLength(0);

    // ---- F5 verification: NO Stripe processor event ------------------
    const processorRows = await db
      .select()
      .from(processorEvents)
      .where(eq(processorEvents.tenantId, tenant.ctx.slug));
    expect(processorRows).toHaveLength(0);
  });
});
