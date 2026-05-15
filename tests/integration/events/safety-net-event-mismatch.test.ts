/**
 * T018 (Feature 013 · F6.1) — FR-019b event-mismatch safety-net integration.
 *
 * Scenario walk:
 *   1. Seed two events under the same tenant: eventA + eventB.
 *   2. Upload the SAME EventCreate CSV against eventA → completed with
 *      attendee_fingerprint persisted to csv_import_records.
 *   3. Upload the SAME CSV against eventB (no force_proceed) → safety
 *      net fires: returns `event_mismatch_warning` with priorImports
 *      pointing at the eventA import. ZERO side effects under eventB.
 *   4. Re-upload same CSV against eventB WITH force_proceed=true →
 *      completed; emits `csv_import_event_mismatch_overridden` audit;
 *      eventB now has its own csv_import_records row + registrations.
 *
 * Asserts on live Neon Singapore.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  csvImportRecords,
  type NewEventRow,
} from '@/modules/events/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { runImportCsv } from '@/lib/events-csv-import-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

const EVENTCREATE_CSV = [
  'Basic Info,Status,First Name,Last Name,Email,Attendee ID,Notes,Personal Data Protection Consent',
  'evt,Attending,Anna,Andersson,anna-safety@example.com,att-001,Paid,I hereby acknowledge',
  'evt,Attending,Björn,Berg,bjorn-safety@example.com,att-002,Paid,I hereby acknowledge',
  'evt,Attending,Charlie,Carlsson,charlie-safety@example.com,att-003,Paid,I hereby acknowledge',
  '',
].join('\n');

async function seedEvent(
  tenant: TestTenant,
  name: string,
  externalId: string,
): Promise<{ readonly eventId: string; readonly externalId: string; readonly name: string; readonly startDate: Date; readonly category: string | null }> {
  const eventId = randomUUID();
  await db.insert(events).values({
    tenantId: tenant.ctx.slug,
    eventId,
    source: 'eventcreate',
    externalId,
    name,
    startDate: new Date('2026-06-21T18:00:00Z'),
  } satisfies NewEventRow);
  return {
    eventId,
    externalId,
    name,
    startDate: new Date('2026-06-21T18:00:00Z'),
    category: null,
  };
}

describe('T018 — FR-019b safety-net event-mismatch integration (live Neon)', () => {
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
      /* uuid-suffixed slug */
    }
  });

  it('uploads same fingerprint against event B after event A → event_mismatch_warning + ZERO side effects → force_proceed override commits + emits audit', async () => {
    const eventA = await seedEvent(tenant, 'Event Alpha', 'event-alpha');
    const eventB = await seedEvent(tenant, 'Event Beta', 'event-beta');
    const actorUserId = actor.userId;
    const bytes = new TextEncoder().encode(EVENTCREATE_CSV);

    // Step 1 — first import targets event A.
    const r1 = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId,
      bytes,
      selectedEvent: { ...eventA, eventId: eventA.eventId },
    });
    expect(r1.kind).toBe('completed');
    if (r1.kind !== 'completed') return;
    const firstRecordId = r1.recordId;

    // Step 2 — same CSV → event B → safety net fires.
    const r2 = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId,
      bytes,
      selectedEvent: { ...eventB, eventId: eventB.eventId },
    });
    expect(r2.kind).toBe('event_mismatch_warning');
    if (r2.kind !== 'event_mismatch_warning') return;
    expect(r2.priorImports.length).toBeGreaterThan(0);
    // First entry should reference the eventA import.
    expect(r2.priorImports[0]?.eventId).toBe(eventA.eventId);
    expect(r2.priorImports[0]?.recordId).toBe(firstRecordId);

    // ZERO side effects under eventB — no csv_import_records row, no registrations.
    const bRecordsAfterWarning = await db
      .select()
      .from(csvImportRecords)
      .where(
        and(
          eq(csvImportRecords.tenantId, tenant.ctx.slug),
          eq(csvImportRecords.eventId, eventB.eventId),
        ),
      );
    expect(bRecordsAfterWarning).toHaveLength(0);

    const bRegsAfterWarning = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.tenantId, tenant.ctx.slug),
            eq(eventRegistrations.eventId, eventB.eventId),
          ),
        ),
    );
    expect(bRegsAfterWarning).toHaveLength(0);

    // Step 3 — re-submit with force_proceed=true → bypass + commit.
    const r3 = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId,
      bytes,
      selectedEvent: { ...eventB, eventId: eventB.eventId },
      forceProceed: true,
    });
    expect(r3.kind).toBe('completed');
    if (r3.kind !== 'completed') return;

    // eventB now has its own csv_import_records row + registrations.
    const bRecordsAfterOverride = await db
      .select()
      .from(csvImportRecords)
      .where(
        and(
          eq(csvImportRecords.tenantId, tenant.ctx.slug),
          eq(csvImportRecords.eventId, eventB.eventId),
        ),
      );
    expect(bRecordsAfterOverride).toHaveLength(1);
    expect(bRecordsAfterOverride[0]?.recordId).toBe(r3.recordId);

    // csv_import_event_mismatch_overridden audit emitted.
    // Note: the Drizzle pgEnum declaration in auth/schema.ts predates F6
    // (F6 + F6.1 enum values added via ALTER TYPE migrations) — query
    // by tenantId only + cast-filter in app code, matching the existing
    // F6 integration-test pattern (see `emit-standalone.test.ts:89`).
    const allTenantAudit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug));
    const overrideAudit = allTenantAudit.filter(
      (r) =>
        (r.eventType as string) === 'csv_import_event_mismatch_overridden',
    );
    expect(overrideAudit.length).toBeGreaterThan(0);
    // Most-recent row should reference r3's recordId in payload.
    const latest = overrideAudit[overrideAudit.length - 1];
    expect(latest).toBeDefined();
    if (latest) {
      const payload = latest.payload as Record<string, unknown>;
      expect(payload['recordId']).toBe(r3.recordId);
      expect(payload['currentEventId']).toBe(eventB.eventId);
    }
  });
});
