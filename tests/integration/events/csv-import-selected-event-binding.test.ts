/**
 * 095 — CSV import binds attendees to the admin-selected event
 * (no duplicate `eventcreate` event) — regression on live Neon Singapore.
 *
 * ## The bug (CONFIRMED via prod data — tenant `swecham`)
 * On `/admin/events/import`, an admin does "Create new event" (which
 * persists an event with `source='admin_manual'`), SELECTS it in the
 * picker, then uploads a CSV. TWO events end up representing the same
 * real-world event:
 *   - the admin_manual event the admin created + selected → 0 regs
 *   - a NEW `eventcreate` event spawned by the import → all the regs
 *
 * Root cause: the shared `processAttendeeInTx` helper unconditionally
 * upserted the event with a hard-coded `source:'eventcreate'` keyed on
 * the CSV's `event_external_id`. The events unique key is
 * `(tenant_id, source, external_id)`, so an `admin_manual` selected
 * event can never match the `eventcreate` upsert → duplicate.
 *
 * ## The fix
 * When the CSV import has a selected/bound event, attendees MUST attach
 * to THAT event (resolved via `EventsRepository.findById`) and NO second
 * event row is created. The picker selection is the authoritative
 * binding (FR-019b is the mismatch guard, not a silent second event).
 *
 * ## Why this scenario (and not the existing equivalence tests)
 * Every pre-existing CSV integration test seeds a `source='eventcreate'`
 * event whose external_id equals the selected event's external_id, so
 * the buggy upsert accidentally MERGED onto the selected event (masking
 * the bug). This test seeds a `source='admin_manual'` event — exactly
 * the prod repro — which the buggy upsert cannot match.
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
import { ingestWebhookAttendee } from '@/modules/events';
import { makeIngestWebhookAttendeeDeps } from '@/lib/events-webhook-deps';
import { runImportCsv } from '@/lib/events-csv-import-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

// Generic-CSV header (5 required columns). The parser overrides
// `event_external_id` / `event_name` / `event_start` with the selected
// event's own values, so the CSV's event_* cells are metadata-only.
function buildGenericCsv(
  eventExternalId: string,
  eventName: string,
  attendeeEmails: ReadonlyArray<string>,
): Uint8Array {
  const header =
    'event_external_id,event_name,event_start,attendee_email,attendee_name';
  const lines = [header];
  for (let i = 0; i < attendeeEmails.length; i++) {
    lines.push(
      `${eventExternalId},${eventName},2026-03-15T13:00:00Z,${attendeeEmails[i]},Attendee ${i}`,
    );
  }
  return new TextEncoder().encode(lines.join('\n') + '\n');
}

describe('095 — CSV import binds to selected event (no eventcreate duplicate)', () => {
  let csvTenant: TestTenant;
  let webhookTenant: TestTenant;
  let actor: TestUser;

  beforeAll(async () => {
    csvTenant = await createTestTenant('test-chamber');
    webhookTenant = await createTestTenant('test-chamber');
    actor = await createActiveTestUser('admin');
  });

  afterAll(async () => {
    try {
      await csvTenant?.cleanup();
    } catch {
      /* uuid-suffixed slug isolates other suites */
    }
    try {
      await webhookTenant?.cleanup();
    } catch {
      /* uuid-suffixed slug isolates other suites */
    }
    try {
      if (actor) await deleteTestUser(actor);
    } catch {
      /* best-effort */
    }
  });

  it('attaches attendees to the admin_manual selected event and spawns NO duplicate', async () => {
    // 1. Admin creates an event via the inline-create modal → persisted
    //    with source='admin_manual' (see create-event.ts). Selected in
    //    the picker for the upload.
    const eventId = randomUUID();
    const externalId = '2000';
    const eventName = 'Annual Gala 2026';
    const startDate = new Date('2026-03-15T13:00:00Z');
    await db.insert(events).values({
      tenantId: csvTenant.ctx.slug,
      eventId,
      source: 'admin_manual',
      externalId,
      name: eventName,
      startDate,
      category: null,
    } satisfies NewEventRow);

    // 2. Import a CSV of 3 attendees against the SELECTED event.
    const emails = [
      `alice-${randomUUID().slice(0, 8)}@example.com`,
      `bob-${randomUUID().slice(0, 8)}@example.com`,
      `carol-${randomUUID().slice(0, 8)}@example.com`,
    ];
    const result = await runImportCsv({
      tenantSlug: csvTenant.ctx.slug,
      actorUserId: actor.userId,
      bytes: buildGenericCsv(externalId, eventName, emails),
      selectedEvent: { eventId, externalId, name: eventName, startDate, category: null },
      originalFilename: 'gala.csv',
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.summary.rowsProcessed).toBe(3);
    expect(result.summary.errorRows).toHaveLength(0);
    // A bound import neither creates NOR updates an event — it attaches
    // registrations to the pre-existing admin-selected event. The
    // "events created/updated" counters must both be 0 (they previously
    // reported eventsUpdated === rowsProcessed, which lied: no event row
    // was written at all).
    expect(result.summary.eventsCreated).toBe(0);
    expect(result.summary.eventsUpdated).toBe(0);

    // 3. There must be EXACTLY ONE event in the tenant — the selected
    //    admin_manual one. No `eventcreate` duplicate.
    const tenantEvents = await runInTenant(csvTenant.ctx, async (tx) =>
      tx.select().from(events).where(eq(events.tenantId, csvTenant.ctx.slug)),
    );
    expect(tenantEvents).toHaveLength(1);
    expect(tenantEvents[0]?.eventId).toBe(eventId);
    expect(tenantEvents[0]?.source).toBe('admin_manual');
    // Belt-and-braces: no row with source='eventcreate' was spawned.
    expect(
      tenantEvents.filter((e) => e.source === 'eventcreate'),
    ).toHaveLength(0);

    // 4. The registrations landed on the SELECTED event (not a duplicate).
    const regs = await runInTenant(csvTenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.tenantId, csvTenant.ctx.slug),
            eq(eventRegistrations.eventId, eventId),
          ),
        ),
    );
    expect(regs).toHaveLength(3);
  });

  it('webhook path is unchanged: no pre-selected event → upserts an eventcreate event', async () => {
    // The webhook has NO selected event, so it MUST keep upserting a
    // `source='eventcreate'` event from the payload (FR-010). This
    // proves the bound-event branch does not regress the webhook path.
    const webhookExternalId = `wh-${randomUUID().slice(0, 8)}`;
    const deps = makeIngestWebhookAttendeeDeps();
    const result = await ingestWebhookAttendee(
      {
        tenantId: webhookTenant.ctx.slug,
        requestId: `req-${randomUUID()}`,
        source: 'eventcreate_webhook',
        rawPayload: {
          eventType: 'attendee.registered',
          tenantSlug: webhookTenant.ctx.slug,
          event: {
            externalId: webhookExternalId,
            name: 'Webhook Event',
            startDate: '2026-04-01T10:00:00Z',
            category: 'networking',
          },
          attendee: {
            externalId: `att-${randomUUID().slice(0, 8)}`,
            email: `dave-${randomUUID().slice(0, 8)}@example.com`,
            fullName: 'Dave',
            paymentStatus: 'paid',
            registeredAt: '2026-03-20T09:00:00Z',
          },
        },
        sourceIp: '127.0.0.1',
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Webhook created the event fresh (no pre-selected binding).
    expect(result.value.eventCreated).toBe(true);

    const upserted = await runInTenant(webhookTenant.ctx, async (tx) =>
      tx
        .select()
        .from(events)
        .where(
          and(
            eq(events.tenantId, webhookTenant.ctx.slug),
            eq(events.externalId, webhookExternalId),
          ),
        ),
    );
    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.source).toBe('eventcreate');
  });
});
