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
      // I6 (Round 1 — pr-test-analyzer): assert priorRecordIds +
      // priorEventIds populated for FR-019c forensic-trail value.
      const priorRecordIds = payload['priorRecordIds'] as string[];
      const priorEventIds = payload['priorEventIds'] as string[];
      expect(Array.isArray(priorRecordIds)).toBe(true);
      expect(priorRecordIds).toContain(firstRecordId);
      expect(Array.isArray(priorEventIds)).toBe(true);
      expect(priorEventIds).toContain(eventA.eventId);
    }
  });

  // TESTS-I4 (Round 1 — pr-test-analyzer) — FR-019b boundary semantics.
  it('TESTS-I4 30-day boundary: priors at 31d ago are OUT-OF-WINDOW; 29d23h59m are IN-WINDOW', async () => {
    const eventX = await seedEvent(tenant, 'Boundary X', 'boundary-x');
    const eventY = await seedEvent(tenant, 'Boundary Y', 'boundary-y');
    const eventZ = await seedEvent(tenant, 'Boundary Z', 'boundary-z');
    const actorUserId = actor.userId;
    const bytes = new TextEncoder().encode(EVENTCREATE_CSV);

    // Seed a "31 days ago" import directly via db.insert (the use-case
    // path can't backdate `uploaded_at`). Fingerprint matches the
    // CSV's attendee set — would trigger safety-net if in-window.
    // Run safety-net query on a SECOND attempt; we expect the 31d-old
    // record to be EXCLUDED from priorImports.
    //
    // Strategy: directly write a csv_import_records row with
    // uploaded_at = NOW - 31d targeting eventX. Then call runImportCsv
    // on eventY — safety net should fire, but priorImports should NOT
    // include the 31d-old record.
    const recordId31 = randomUUID();
    const fingerprint = '5a827858800f6452'; // ✗ stale literal — recompute below
    // Compute the actual fingerprint via importing the helper:
    const { computeAttendeeFingerprintFromEmails } = await import(
      '@/modules/events/domain/eventcreate-csv-format'
    );
    const realFingerprint = computeAttendeeFingerprintFromEmails([
      'anna-safety@example.com',
      'bjorn-safety@example.com',
      'charlie-safety@example.com',
    ]);
    if (!realFingerprint) throw new Error('fingerprint helper returned null');
    void fingerprint;

    const thirtyOneDaysAgo = new Date(
      Date.now() - 31 * 24 * 60 * 60 * 1000,
    );
    await db.insert(csvImportRecords).values({
      recordId: recordId31,
      tenantId: tenant.ctx.slug,
      actorUserId: actorUserId,
      eventId: eventX.eventId,
      sourceFormat: 'eventcreate_csv',
      originalFilename: 'boundary-31d.csv',
      originalSizeBytes: bytes.byteLength,
      uploadedAt: thirtyOneDaysAgo,
      rowsTotal: 3,
      rowsProcessed: 3,
      rowsAlreadyImported: 0,
      rowsSkipped: 0,
      rowsFailed: 0,
      outcome: 'completed',
      durationMs: 1_000,
      attendeeFingerprint: realFingerprint,
    });

    // Also seed a record at 29d 23h 59m ago — should be IN-WINDOW.
    const recordId29 = randomUUID();
    const twentyNineDays23h59m = new Date(
      Date.now() - (29 * 24 + 23) * 60 * 60 * 1000 - 59 * 60 * 1000,
    );
    await db.insert(csvImportRecords).values({
      recordId: recordId29,
      tenantId: tenant.ctx.slug,
      actorUserId: actorUserId,
      eventId: eventY.eventId,
      sourceFormat: 'eventcreate_csv',
      originalFilename: 'boundary-29d.csv',
      originalSizeBytes: bytes.byteLength,
      uploadedAt: twentyNineDays23h59m,
      rowsTotal: 3,
      rowsProcessed: 3,
      rowsAlreadyImported: 0,
      rowsSkipped: 0,
      rowsFailed: 0,
      outcome: 'completed',
      durationMs: 1_000,
      attendeeFingerprint: realFingerprint,
    });

    // Also seed a NULL-fingerprint record at 1d ago — should be EXCLUDED
    // (FR-019b explicit null exclusion).
    const recordIdNull = randomUUID();
    await db.insert(csvImportRecords).values({
      recordId: recordIdNull,
      tenantId: tenant.ctx.slug,
      actorUserId: actorUserId,
      eventId: eventX.eventId,
      sourceFormat: 'eventcreate_csv',
      originalFilename: 'boundary-null.csv',
      originalSizeBytes: bytes.byteLength,
      uploadedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      rowsTotal: 0,
      rowsProcessed: 0,
      rowsAlreadyImported: 0,
      rowsSkipped: 0,
      rowsFailed: 0,
      outcome: 'completed',
      durationMs: 0,
      attendeeFingerprint: null,
    });

    // Run an import to eventZ — safety net query inspects priors.
    const result = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId,
      bytes,
      selectedEvent: { ...eventZ, eventId: eventZ.eventId },
    });

    // Should fire warning (eventY's 29d-23h59m record IS in-window).
    expect(result.kind).toBe('event_mismatch_warning');
    if (result.kind !== 'event_mismatch_warning') return;
    const priorIds = result.priorImports.map((p) => p.recordId as string);

    // Boundary 1: 31d-old record EXCLUDED (out of window).
    expect(priorIds).not.toContain(recordId31);
    // Boundary 2: 29d-23h59m record INCLUDED (in window).
    expect(priorIds).toContain(recordId29);
    // Boundary 3: NULL fingerprint record EXCLUDED (FR-019a edge case).
    expect(priorIds).not.toContain(recordIdNull);
  });
});
