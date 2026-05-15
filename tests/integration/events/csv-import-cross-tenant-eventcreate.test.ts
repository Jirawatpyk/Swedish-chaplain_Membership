/**
 * T017 (Feature 013 · F6.1) — Cross-tenant CSV-import isolation
 * (REVIEW-GATE BLOCKER per Constitution v1.4.0 Principle I clause 3).
 *
 * Tenant B uploads a CSV through `runImportCsv` against an event seeded
 * under Tenant A's slug. The RLS+FORCE policy on `csv_import_records`
 * + the application-layer `runInTenant(...)` context boundary MUST
 * prevent ANY DB write to Tenant A's namespace.
 *
 * Probes:
 *   1. csv_import_records under Tenant A stays empty.
 *   2. event_registrations under Tenant A stays empty.
 *   3. The cross-tenant probe surface (route layer event lookup with a
 *      tenant-mismatched event_id) emits `csv_import_cross_tenant_probe`
 *      audit — verified indirectly via the route handler's
 *      `lookupEventByIdTimingSafe` shape returning `wrong_tenant`
 *      when the event_id belongs to another tenant.
 *
 * Note: the route handler at `/api/admin/events/import` is NOT exercised
 * here — that's the contract test (T012) territory. This integration
 * test pokes the lower-level `lookupEventByIdTimingSafe` + `runImportCsv`
 * to verify the DB-layer isolation is intact + the lookup correctly
 * identifies cross-tenant access without leaking event metadata.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  csvImportRecords,
  type NewEventRow,
} from '@/modules/events/infrastructure/schema';
import {
  runImportCsv,
  lookupEventByIdTimingSafe,
} from '@/lib/events-csv-import-deps';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

const EVENTCREATE_CSV = [
  'Basic Info,Status,First Name,Last Name,Email,Attendee ID,Notes,Personal Data Protection Consent',
  'foo,Attending,Anna,Andersson,anna@example.com,attendee-001,Paid,I hereby acknowledge',
  'foo,Attending,Björn,Berg,bjorn@example.com,attendee-002,Paid,I hereby acknowledge',
  '',
].join('\n');

describe('T017 — Cross-tenant CSV-import isolation (Principle I clause 3 blocker)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let aEventId: string;
  let actor: TestUser;

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
    aEventId = randomUUID();
    actor = await createActiveTestUser('admin');

    // Seed an event under Tenant A ONLY. Tenant B has nothing.
    await db.insert(events).values({
      tenantId: tenantA.ctx.slug,
      eventId: aEventId,
      source: 'eventcreate',
      externalId: 'event-iso-a',
      name: 'Tenant A event',
      startDate: new Date('2026-06-21T18:00:00Z'),
    } satisfies NewEventRow);
  });

  afterAll(async () => {
    try {
      await tenantA?.cleanup();
      await tenantB?.cleanup();
      if (actor) await deleteTestUser(actor);
    } catch {
      /* uuid-suffixed slugs isolate other suites */
    }
  });

  it('lookupEventByIdTimingSafe(B, A_event) returns wrong_tenant (probe detection)', async () => {
    const result = await lookupEventByIdTimingSafe(
      tenantB.ctx.slug,
      aEventId,
    );
    expect(result.kind).toBe('wrong_tenant');
    if (result.kind === 'wrong_tenant') {
      expect(result.ownerTenantSlug).toBe(tenantA.ctx.slug);
    }
  });

  it('Tenant B runImportCsv targeting Tenant A event seed → does NOT write any rows under Tenant A', async () => {
    // Tenant B caller; eventId points to Tenant A's event. The route
    // layer would normally block this via lookupEventByIdTimingSafe →
    // wrong_tenant → 404 — but `runImportCsv` itself MUST also be
    // safe: even if the route were bypassed (test surface, future API
    // regression), the DB-layer isolation prevents any cross-tenant
    // write because every Drizzle path runs through `runInTenant(B, ...)`.
    //
    // Expected behavior: csv_import_records placeholder INSERT will
    // fail FK validation (events table has no event_id=aEventId under
    // tenantId=B) — and that failure is silently swallowed by the
    // use-case's try/catch (it logs + continues). The batch processing
    // upserts a NEW event under tenant B's namespace (event_external_id
    // 'event-iso-a' is the FR-027 webhook-equivalent path), then
    // attempts to insert event_registrations — those rows land under
    // tenant B, NOT under tenant A.
    //
    // Critical invariant: tenant A's tables stay empty regardless of
    // tenant B's batch tx outcome.
    const result = await runImportCsv({
      tenantSlug: tenantB.ctx.slug,
      actorUserId: actor.userId,
      bytes: new TextEncoder().encode(EVENTCREATE_CSV),
      // Pass A's eventId — use-case will try to insert csv_import_records
      // under (tenant=B, event_id=A's) which FK-fails silently.
      selectedEvent: {
        eventId: aEventId,
        externalId: 'event-iso-a',
        name: 'Tenant A event',
        startDate: new Date('2026-06-21T18:00:00Z'),
        category: null,
      },
    });

    // The use-case may return 'completed' (with events upserted under
    // tenant B) or other outcomes — what matters is the cross-tenant
    // invariant below, NOT the specific outcome.
    expect(['completed', 'unexpected_error', 'invalid_header']).toContain(
      result.kind,
    );

    // Tenant A's event_registrations stays empty.
    const aRegs = await runInTenant(tenantA.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(eq(eventRegistrations.tenantId, tenantA.ctx.slug)),
    );
    expect(aRegs).toHaveLength(0);

    // Tenant A's csv_import_records stays empty.
    const aRecords = await db
      .select()
      .from(csvImportRecords)
      .where(eq(csvImportRecords.tenantId, tenantA.ctx.slug));
    expect(aRecords).toHaveLength(0);

    // Tenant A's events list still has exactly 1 row (the seed).
    const aEvents = await runInTenant(tenantA.ctx, async (tx) =>
      tx
        .select()
        .from(events)
        .where(eq(events.tenantId, tenantA.ctx.slug)),
    );
    expect(aEvents).toHaveLength(1);
    expect(aEvents[0]?.eventId).toBe(aEventId);
  });

  it('Tenant A and Tenant B CANNOT see each other csv_import_records (RLS+FORCE)', async () => {
    // Manually seed a csv_import_records row under tenant A (via root
    // db — BYPASSRLS) to ensure there's something to probe.
    const recordId = randomUUID();
    await db.insert(csvImportRecords).values({
      recordId,
      tenantId: tenantA.ctx.slug,
      actorUserId: actor.userId,
      eventId: aEventId,
      sourceFormat: 'eventcreate_csv',
      originalFilename: 'cross-tenant-probe.csv',
      originalSizeBytes: 1024,
      rowsTotal: 0,
      rowsProcessed: 0,
      rowsAlreadyImported: 0,
      rowsSkipped: 0,
      rowsFailed: 0,
      outcome: 'completed',
      durationMs: 0,
    });

    // Probe from Tenant B's runInTenant context — RLS filters to zero rows.
    const bView = await runInTenant(tenantB.ctx, async (tx) =>
      tx
        .select()
        .from(csvImportRecords)
        .where(eq(csvImportRecords.recordId, recordId)),
    );
    expect(bView).toHaveLength(0);

    // Probe from Tenant A's context returns the row.
    const aView = await runInTenant(tenantA.ctx, async (tx) =>
      tx
        .select()
        .from(csvImportRecords)
        .where(eq(csvImportRecords.recordId, recordId)),
    );
    expect(aView).toHaveLength(1);
  });
});
