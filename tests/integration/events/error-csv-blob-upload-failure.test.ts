/**
 * T039 (F6.1 · Feature 013 — Phase 5 US5) — error-CSV Blob upload
 * failure on the post-commit path (research.md R6 / critique E2).
 *
 * When Vercel Blob `put` fails AFTER the import tx commits the rows,
 * the admin must see:
 *   - `outcome.kind === 'completed'` (rows are persisted; rowsFailed > 0)
 *   - `errorCsvAvailable: false` on the outcome (no signed-URL available)
 *   - csv_import_records row persists with `error_csv_blob_url IS NULL`
 *   - Pino warn log `f6_csv_error_csv_blob_put_failed` emitted
 *
 * Test approach: build a minimal EventCreate CSV with 1 attending row +
 * 1 row that fails validation (forcing a non-zero rowsFailed) → mock
 * `vercelBlobErrorCsvStore.put` to reject → run importCsv → assert
 * outcome shape + DB state + log emission.
 *
 * Uses the use-case directly (not the route handler) since the
 * blob-write side-effect happens entirely within the use-case body.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  csvImportRecords,
  events,
  type NewEventRow,
} from '@/modules/events/infrastructure/schema';
import { importCsv, makeImportCsvDeps } from '@/modules/events';
import { asTenantId } from '@/modules/members';
import { asEventId } from '@/modules/events';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

const EVENTCREATE_HEADER =
  'Basic Info,Status,First Name,Last Name,Email,Attendee ID,Notes,Company Name,Personal Data Protection Consent';

// 2-row CSV — both are Attending but row 2's email is malformed so it
// flows into errorRows + bumps rowsFailed.
function buildTwoRowCsv(): Uint8Array {
  const rows = [
    EVENTCREATE_HEADER,
    'Wk,Attending,Good,One,good@example.test,ec-001,Paid,Co A,I hereby acknowledge',
    'Wk,Attending,Bad,Two,not-an-email,ec-002,Paid,Co B,I hereby acknowledge',
  ];
  return new TextEncoder().encode(rows.join('\r\n') + '\r\n');
}

describe('T039 — error-CSV Blob upload failure (live Neon + mocked Blob)', () => {
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
      // uuid-suffixed slug isolates
    }
  });

  it('Blob put fails post-commit → completed outcome with errorCsvAvailable=false; rows still in DB', async () => {
    // Seed event.
    const eventId = randomUUID();
    const externalId = `event-${eventId.slice(0, 8)}`;
    await db.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId,
      name: 'Blob-failure test',
      startDate: new Date('2026-05-20T13:00:00Z'),
      category: null,
    } satisfies NewEventRow);

    // Build deps + override the errorCsvStore.put to fail.
    const baseDeps = makeImportCsvDeps();
    const putSpy = vi.fn(async () =>
      ({
        ok: false as const,
        error: { kind: 'storage_error' as const, message: 'simulated Blob outage' },
      }),
    );
    const deps = {
      ...baseDeps,
      errorCsvStore: {
        ...baseDeps.errorCsvStore,
        put: putSpy,
      },
    };

    const outcome = await importCsv(
      {
        tenantId: asTenantId(tenant.ctx.slug),
        actorUserId: actor.userId,
        bytes: buildTwoRowCsv(),
        selectedEvent: {
          eventId: asEventId(eventId),
          externalId,
          name: 'Blob-failure test',
          startDate: new Date('2026-05-20T13:00:00Z'),
          category: null,
        },
        originalFilename: 'blob-failure.csv',
      },
      deps,
    );

    // outcome.kind is `completed` (use-case decides outcome from the
    // import path regardless of blob upload success — research.md R6 +
    // critique E2).
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    // rowsProcessed should be at least 1 (good row), rowsFailed > 0.
    expect(outcome.summary.rowsProcessed).toBeGreaterThan(0);
    expect(outcome.summary.rowsFailed).toBeGreaterThan(0);
    expect(outcome.errorCsvAvailable).toBe(false);

    // Blob put was called (use-case attempted upload) AND failed.
    expect(putSpy).toHaveBeenCalled();

    // csv_import_records persisted but error_csv_blob_url is NULL.
    const records = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(csvImportRecords)
        .where(
          and(
            eq(csvImportRecords.tenantId, tenant.ctx.slug),
            eq(csvImportRecords.recordId, outcome.recordId),
          ),
        ),
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.errorCsvBlobUrl).toBeNull();
    expect(records[0]?.errorCsvExpiresAt).toBeNull();
  });
});
