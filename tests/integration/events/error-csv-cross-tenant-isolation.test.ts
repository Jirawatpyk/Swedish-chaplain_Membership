/**
 * T037 (F6.1 · Feature 013 — Phase 5 US5) — Signed-URL cross-tenant
 * isolation integration test on live Neon Singapore.
 *
 * Constitution Principle I clause 3 BLOCKER coverage:
 *   - Tenant A admin requesting Tenant B's recordId via the signed-URL
 *     use-case must NEVER return a signed URL or leak the row data.
 *     The outcome must be `{kind:'not_found'}` (same response as
 *     truly-missing) AND a `csv_import_cross_tenant_probe` audit row
 *     must be emitted at `critical` severity.
 *
 * Strategy: run the use-case directly via `runGenerateErrorCsvSignedUrl`
 * (bypasses the route layer's RBAC/feature-flag/UUID gates), then
 * inspect `audit_log` for the probe event.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  csvImportRecords,
  events,
  type NewEventRow,
} from '@/modules/events/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { runGenerateErrorCsvSignedUrl } from '@/lib/events-csv-import-deps';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

async function seedEvent(tenant: TestTenant): Promise<string> {
  const eventId = randomUUID();
  await db.insert(events).values({
    tenantId: tenant.ctx.slug,
    eventId,
    source: 'eventcreate',
    externalId: `event-${eventId.slice(0, 8)}`,
    name: `Iso event for ${tenant.ctx.slug}`,
    startDate: new Date('2026-04-15T13:00:00Z'),
    category: null,
  } satisfies NewEventRow);
  return eventId;
}

async function seedImportWithBlob(
  tenant: TestTenant,
  eventId: string,
  actorUserId: string,
  withFreshBlob: boolean,
): Promise<string> {
  const recordId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(csvImportRecords).values({
      tenantId: tenant.ctx.slug,
      recordId,
      actorUserId,
      eventId,
      uploadedAt: new Date(),
      sourceFormat: 'eventcreate_csv',
      originalFilename: `iso-${recordId.slice(0, 8)}.csv`,
      originalSizeBytes: 256,
      rowsTotal: 5,
      rowsProcessed: 3,
      rowsAlreadyImported: 0,
      rowsSkipped: 0,
      rowsFailed: 2,
      outcome: 'partial_failure',
      durationMs: 1500,
      errorCsvBlobUrl: withFreshBlob
        ? `https://blob.vercel-storage.com/test/iso-${recordId}.csv`
        : null,
      errorCsvExpiresAt: withFreshBlob
        ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        : null,
    });
  });
  return recordId;
}

describe('T037 — error-csv signed-URL cross-tenant isolation (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let actorA: TestUser;
  let actorB: TestUser;

  beforeAll(async () => {
    const tenants = await createTwoTestTenants();
    tenantA = tenants.a;
    tenantB = tenants.b;
    actorA = await createActiveTestUser('admin');
    actorB = await createActiveTestUser('admin');
  });

  afterAll(async () => {
    try {
      await tenantA?.cleanup();
      await tenantB?.cleanup();
      if (actorA) await deleteTestUser(actorA);
      if (actorB) await deleteTestUser(actorB);
    } catch {
      // suite isolated by uuid-suffixed slug
    }
  });

  it('Tenant A request for Tenant B record → not_found + cross-tenant probe audit emitted', async () => {
    const eventB = await seedEvent(tenantB);
    const recordB = await seedImportWithBlob(
      tenantB,
      eventB,
      actorB.userId,
      true,
    );

    const beforeMs = Date.now();
    const outcome = await runGenerateErrorCsvSignedUrl({
      tenantSlug: tenantA.ctx.slug,
      actorUserId: actorA.userId,
      recordId: recordB,
      sourceIp: '127.0.0.1',
    });

    // Surface-disclosure invariant — same shape as truly-missing.
    expect(outcome.kind).toBe('not_found');

    // Constitution Principle I clause 4 — cross-tenant probe audit emit.
    const probeRows = await db
      .select({
        eventType: auditLog.eventType,
        tenantId: auditLog.tenantId,
        actorUserId: auditLog.actorUserId,
        payload: auditLog.payload,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantA.ctx.slug),
          // F6 audit event types are in the Postgres enum (added by
          // migration 0141) but absent from the auth schema's TS pgEnum —
          // cast to `never` matches the existing F6 test convention
          // (`admin-integration-deps.test.ts`).
          eq(auditLog.eventType, 'csv_import_cross_tenant_probe' as never),
          gt(auditLog.timestamp, new Date(beforeMs - 5000)),
        ),
      );
    expect(probeRows.length).toBeGreaterThanOrEqual(1);
    const probe = probeRows[probeRows.length - 1]!;
    expect(probe.actorUserId).toBe(actorA.userId);
    const payload = probe.payload as Record<string, unknown>;
    expect(payload['probedId']).toBe(recordB);
    expect(payload['probeSurface']).toBe('error_csv_record_id');
    expect(payload['severity']).toBe('critical');
  });

  it('Tenant B GET on own record → success path (signed URL would be returned if Blob were live)', async () => {
    // We can't easily hit live Vercel Blob from a unit-test harness
    // because the test fixture wrote a STATIC URL (no real blob object
    // backing it). The use-case will reach the signing step, where the
    // mock URL will fail. We assert kind ∈ {'success','signing_failure'}
    // — both prove the tenant-scoped lookup found the row + reached the
    // signing path, which is the cross-tenant invariant we care about.
    const eventB = await seedEvent(tenantB);
    const recordB = await seedImportWithBlob(
      tenantB,
      eventB,
      actorB.userId,
      true,
    );

    const beforeMs = Date.now();
    const outcome = await runGenerateErrorCsvSignedUrl({
      tenantSlug: tenantB.ctx.slug,
      actorUserId: actorB.userId,
      recordId: recordB,
      sourceIp: '127.0.0.1',
    });
    // Either success (signing succeeded) or signing_failure (Blob
    // rejected the synthetic URL). NEVER not_found because the tenant
    // owns the record.
    expect(['success', 'signing_failure']).toContain(outcome.kind);

    // CR-3 (R1 — pr-test-analyzer): strict-audit invariant. If the
    // use-case returned `success`, exactly one `csv_import_error_csv_downloaded`
    // row must exist for this (tenant, actor, recordId). If
    // `signing_failure`, the audit row MUST NOT exist (the use-case
    // returns the failure outcome BEFORE the audit emit when signing
    // fails).
    const downloadedRows = await db
      .select({
        eventType: auditLog.eventType,
        actorUserId: auditLog.actorUserId,
        payload: auditLog.payload,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantB.ctx.slug),
          eq(auditLog.eventType, 'csv_import_error_csv_downloaded' as never),
          gt(auditLog.timestamp, new Date(beforeMs - 5000)),
        ),
      );
    if (outcome.kind === 'success') {
      expect(downloadedRows.length).toBeGreaterThanOrEqual(1);
      const row = downloadedRows[downloadedRows.length - 1]!;
      expect(row.actorUserId).toBe(actorB.userId);
      const payload = row.payload as Record<string, unknown>;
      expect(payload['recordId']).toBe(recordB);
      expect(payload['severity']).toBe('info');
    } else {
      // signing_failure: NO audit row should be present.
      expect(downloadedRows.length).toBe(0);
    }
  });

  it('Tenant A request for a recordId that does NOT exist anywhere → not_found + NO probe audit', async () => {
    const unknownRecordId = randomUUID();
    const beforeMs = Date.now();
    const outcome = await runGenerateErrorCsvSignedUrl({
      tenantSlug: tenantA.ctx.slug,
      actorUserId: actorA.userId,
      recordId: unknownRecordId,
      sourceIp: '127.0.0.1',
    });
    expect(outcome.kind).toBe('not_found');

    const probeRows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantA.ctx.slug),
          eq(auditLog.eventType, 'csv_import_cross_tenant_probe' as never),
          gt(auditLog.timestamp, new Date(beforeMs)),
        ),
      );
    // No probe row should have been emitted since the recordId truly
    // doesn't exist in ANY tenant.
    expect(probeRows.length).toBe(0);
  });
});
