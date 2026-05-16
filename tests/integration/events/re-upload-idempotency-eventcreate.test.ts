/**
 * T031 (F6.1 · Feature 013 — Phase 4 US2) — Re-upload idempotency on
 * the EventCreate adapter path against live Neon Singapore.
 *
 * Acceptance (FR-017 + FR-018):
 *   1. First upload: rowsProcessed = N (attending rows), rowsAlreadyImported = 0
 *   2. Second upload of the SAME bytes: rowsProcessed = 0, rowsAlreadyImported = N
 *   3. csv_import_records carries a fresh recordId on each upload
 *   4. event_registrations row count remains N (no duplicates)
 *   5. **State-change on re-upload (FR-018)**: modify one row's Notes
 *      between runs (`verifying payment` → `Paid`) → that row's
 *      payment_status flips `pending` → `paid` on the 2nd run AND
 *      `rowsStateChanged` is incremented (the row's receipt is
 *      duplicate, but the use-case detects the field divergence via
 *      `findByEventAndEmail` + `updatePaymentStatus`).
 *
 * Live DB cost: ~6-10s per scenario; 3 scenarios = ~20-30s wall-clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { runInTenant, db } from '@/lib/db';
import {
  events,
  eventRegistrations,
  csvImportRecords,
  type NewEventRow,
} from '@/modules/events/infrastructure/schema';
import { runImportCsv } from '@/lib/events-csv-import-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

const FIXTURE_DIR = join(process.cwd(), 'docs', 'Attendee list');
const FIXTURE_NAME = 'EventCreate_Guestlist-grant-thornton-workshop.csv';

interface SeededEvent {
  readonly eventId: string;
  readonly externalId: string;
  readonly name: string;
  readonly startDate: Date;
  readonly category: string | null;
}

async function seedEvent(tenant: TestTenant): Promise<SeededEvent> {
  const eventId = randomUUID();
  const externalId = `event-${eventId.slice(0, 8)}`;
  const name = 'Grant Thornton Workshop 2026';
  const startDate = new Date('2026-03-15T13:00:00Z');
  await db.insert(events).values({
    tenantId: tenant.ctx.slug,
    eventId,
    source: 'eventcreate',
    externalId,
    name,
    startDate,
    category: null,
  } satisfies NewEventRow);
  return { eventId, externalId, name, startDate, category: null };
}

describe('T031 — Re-upload idempotency on EventCreate adapter (live Neon)', () => {
  let tenant: TestTenant;
  let actor: TestUser;
  let bytes: Uint8Array;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    actor = await createActiveTestUser('admin');
    const buf = await readFile(join(FIXTURE_DIR, FIXTURE_NAME));
    bytes = new Uint8Array(buf);
  });

  afterAll(async () => {
    try {
      await tenant?.cleanup();
      if (actor) await deleteTestUser(actor);
    } catch {
      // uuid-suffixed slug isolates from other suites
    }
  });

  it('first upload processes attending rows; second upload reports them all as already-imported', async () => {
    const event = await seedEvent(tenant);

    // ---- First upload --------------------------------------------------
    const r1 = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes,
      selectedEvent: { ...event, eventId: event.eventId },
      originalFilename: FIXTURE_NAME,
    });

    expect(r1.kind).toBe('completed');
    if (r1.kind !== 'completed') return;

    const processedFirstRun = r1.summary.rowsProcessed;
    expect(processedFirstRun).toBeGreaterThan(0);
    expect(r1.summary.rowsAlreadyImported).toBe(0);
    const firstRecordId = r1.recordId;

    // Verify event_registrations actually received the rows.
    const regsAfterFirst = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.tenantId, tenant.ctx.slug),
            eq(eventRegistrations.eventId, event.eventId),
          ),
        ),
    );
    expect(regsAfterFirst.length).toBe(processedFirstRun);

    // ---- Second upload (same bytes) ------------------------------------
    const r2 = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes,
      selectedEvent: { ...event, eventId: event.eventId },
      originalFilename: FIXTURE_NAME,
      // T031 — pass forceProceed=true if the FR-019b safety net is wired
      // for same-event re-uploads. (Same-event matches are EXCLUDED from
      // the safety net by `findByFingerprintAcrossEvents` — but we pass
      // it defensively to keep the test deterministic across spec drift.)
      forceProceed: true,
    });

    expect(r2.kind).toBe('completed');
    if (r2.kind !== 'completed') return;

    // FR-017 — every row that landed on run 1 should idempotency-skip on run 2.
    expect(r2.summary.rowsProcessed).toBe(0);
    expect(r2.summary.rowsAlreadyImported).toBe(processedFirstRun);
    // Fresh recordId each upload.
    expect(r2.recordId).not.toBe(firstRecordId);

    // event_registrations count unchanged (no duplicate INSERTs).
    const regsAfterSecond = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.tenantId, tenant.ctx.slug),
            eq(eventRegistrations.eventId, event.eventId),
          ),
        ),
    );
    expect(regsAfterSecond.length).toBe(processedFirstRun);

    // Both csv_import_records rows are present (history preserves each attempt).
    const records = await db
      .select()
      .from(csvImportRecords)
      .where(
        and(
          eq(csvImportRecords.tenantId, tenant.ctx.slug),
          eq(csvImportRecords.eventId, event.eventId),
        ),
      );
    expect(records.length).toBe(2);
  });

  it('FR-018 — modifying Notes between runs flips payment_status + bumps rowsStateChanged', async () => {
    // Seed a separate event so this scenario does not collide with the
    // first test's records.
    const seEventId = randomUUID();
    const seExternalId = `event-${seEventId.slice(0, 8)}`;
    await db.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId: seEventId,
      source: 'eventcreate',
      externalId: seExternalId,
      name: 'State-change event',
      startDate: new Date('2026-05-10T13:00:00Z'),
      category: null,
    });

    const buildCsv = (notesValue: string): Uint8Array => {
      const header =
        'Basic Info,Status,First Name,Last Name,Email,Phone Number,Phone Number Consent,Registration Date,Added Date,Last Updated Date,Attendee Edited Date,Ticket,Guest Of,Checked In,Attendee ID,Order ID,VIP,Notes,Assigned Table,Tags,Company Name,Registration Category,Personal Data Protection Consent,Last Email Sent,Last Email Sent Date,Unsubscribed';
      const cells = [
        'Workshop',
        'Attending',
        'State',
        'Changer',
        'state.changer@example.test',
        '',
        '',
        '2026-04-10T09:00:00Z',
        '2026-04-10T09:00:00Z',
        '2026-04-10T09:00:00Z',
        '2026-04-10T09:00:00Z',
        'Standard',
        '',
        'No',
        'state-changer-001',
        'ord-sc',
        'No',
        notesValue,
        '',
        '',
        'Test Co',
        'Member',
        'I hereby acknowledge',
        '',
        '',
        'No',
      ];
      const row = cells
        .map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
        .join(',');
      return new TextEncoder().encode(`${header}\r\n${row}\r\n`);
    };

    const selectedEvent = {
      eventId: seEventId,
      externalId: seExternalId,
      name: 'State-change event',
      startDate: new Date('2026-05-10T13:00:00Z'),
      category: null,
    };

    // 1st upload — Notes='verifying payment' → payment_status='pending'
    const r1 = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes: buildCsv('verifying payment'),
      selectedEvent,
      originalFilename: 'state-change-1.csv',
    });
    expect(r1.kind).toBe('completed');
    if (r1.kind !== 'completed') return;
    expect(r1.summary.rowsProcessed).toBe(1);
    expect(r1.summary.rowsStateChanged).toBe(0);

    const regsAfter1 = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.tenantId, tenant.ctx.slug),
            eq(eventRegistrations.eventId, seEventId),
          ),
        ),
    );
    expect(regsAfter1).toHaveLength(1);
    expect(regsAfter1[0]?.paymentStatus).toBe('pending');

    // 2nd upload — same canonical row (event_external_id + email +
    // registered_at unchanged → same rowHash → receipt duplicate),
    // but Notes='Paid' → inferred payment_status='paid'.
    const r2 = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes: buildCsv('Paid'),
      selectedEvent,
      originalFilename: 'state-change-2.csv',
      forceProceed: true,
    });
    expect(r2.kind).toBe('completed');
    if (r2.kind !== 'completed') return;
    // FR-018 — state-change detection picked up the new payment_status,
    // applied the UPDATE, + counted in `rowsStateChanged` (NOT
    // `rowsAlreadyImported`).
    expect(r2.summary.rowsStateChanged).toBe(1);
    expect(r2.summary.rowsAlreadyImported).toBe(0);
    expect(r2.summary.rowsProcessed).toBe(0);

    // DB-side verification — payment_status flipped to 'paid'.
    const regsAfter2 = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.tenantId, tenant.ctx.slug),
            eq(eventRegistrations.eventId, seEventId),
          ),
        ),
    );
    expect(regsAfter2).toHaveLength(1);
    expect(regsAfter2[0]?.paymentStatus).toBe('paid');

    // 3rd upload — same Notes='Paid'; should detect no change + count
    // as plain duplicate (rowsAlreadyImported), NOT state-change.
    const r3 = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes: buildCsv('Paid'),
      selectedEvent,
      originalFilename: 'state-change-3.csv',
      forceProceed: true,
    });
    expect(r3.kind).toBe('completed');
    if (r3.kind !== 'completed') return;
    expect(r3.summary.rowsStateChanged).toBe(0);
    expect(r3.summary.rowsAlreadyImported).toBe(1);
    expect(r3.summary.rowsProcessed).toBe(0);
  });
});
