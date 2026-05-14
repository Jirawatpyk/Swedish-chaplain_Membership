/**
 * H-8 test (2026-05-15) — savepoint isolation guarantee.
 *
 * Verifies the spec's headline reliability claim that `tasks.md` T094
 * line 225 calls out:
 *
 *   > "batched 100 rows per tx; per-row failure isolation"
 *
 * If a single row throws inside `processAttendeeInTx`, its SAVEPOINT
 * must roll back while sibling rows in the same batch tx commit
 * normally. A future refactor that accidentally lets a row-level throw
 * escape `processOneRowInSavepoint` (e.g., a missed try/catch around
 * the helper) would silently abort the entire batch and ALL 99 sibling
 * rows would be lost — the `csv_import_completed` summary would still
 * report `rowsProcessed: 0` with no integration-level signal.
 *
 * Strategy: seed a CSV with 5 rows where row 3 carries a malformed
 * `attendee_email` that zod rejects. Assert (a) `rowsProcessed === 4`,
 * (b) `errorRows.length === 1` with `rowNumber: 4` (CSV line 4 is the
 * 3rd data row + the 1-indexed header), (c) DB row count for
 * `event_registrations` is exactly 4.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { eventRegistrations } from '@/modules/events/infrastructure/schema';
import { runImportCsv } from '@/lib/events-csv-import-deps';
import { asUserId } from '@/modules/auth';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const CSV_WITH_BAD_ROW = [
  'event_external_id,event_name,event_start,attendee_email,attendee_name',
  'event_sp_1,Iso Test,2026-06-21T18:00:00+07:00,row1@example.com,Attendee 1',
  'event_sp_1,Iso Test,2026-06-21T18:00:00+07:00,row2@example.com,Attendee 2',
  'event_sp_1,Iso Test,2026-06-21T18:00:00+07:00,NOT-AN-EMAIL,Attendee 3',
  'event_sp_1,Iso Test,2026-06-21T18:00:00+07:00,row4@example.com,Attendee 4',
  'event_sp_1,Iso Test,2026-06-21T18:00:00+07:00,row5@example.com,Attendee 5',
  '',
].join('\n');

describe('H-8 — savepoint isolation (1 bad row of 5 must not poison 4 good rows)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-chamber');
  });

  afterAll(async () => {
    try {
      await tenant?.cleanup();
    } catch {
      /* uuid-suffixed slug isolates other suites */
    }
  });

  it('zod-rejected attendee_email in row 3 leaves rows 1+2+4+5 committed (sibling-row preservation)', async () => {
    const result = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: asUserId('00000000-0000-0000-0000-000000000088'),
      bytes: new TextEncoder().encode(CSV_WITH_BAD_ROW),
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;

    // Row 4 of CSV file = 3rd data row (1-indexed: header is line 1,
    // first data row is line 2). The bad row has rowNumber === 4
    // because parser counts physical CSV lines.
    expect(result.summary.rowsProcessed).toBe(4);
    expect(result.summary.errorRows).toHaveLength(1);
    expect(result.summary.errorRows[0]?.rowNumber).toBe(4);
    expect(result.summary.errorRows[0]?.reason).toMatch(/email/i);

    // Independent DB-side verification — the actual row count must
    // match the summary. If SAVEPOINT isolation were broken, all 5
    // rows would have rolled back together.
    const regs = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(eq(eventRegistrations.tenantId, tenant.ctx.slug)),
    );
    expect(regs).toHaveLength(4);
    // Verify the 4 surviving rows are the expected ones (not the bad row).
    const emails = regs.map((r) => r.attendeeEmailLower).sort();
    expect(emails).toEqual([
      'row1@example.com',
      'row2@example.com',
      'row4@example.com',
      'row5@example.com',
    ]);
  });
});
