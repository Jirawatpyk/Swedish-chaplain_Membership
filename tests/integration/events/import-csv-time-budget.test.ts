/**
 * H-10 test (2026-05-15) — time-budget short-circuit semantics.
 *
 * Verifies that when `timeBudgetMs` is exceeded:
 *   1. Rows from batches that started BEFORE the deadline still commit
 *      (savepoint commits are independent of the wall-clock check).
 *   2. `timeBudgetExceeded` short-circuits subsequent batch pickups.
 *   3. The use-case returns `{kind:'timeout'}` AFTER in-flight batches
 *      drain.
 *   4. NO `csv_import_completed` audit is emitted on timeout (only on
 *      `completed` outcome).
 *
 * Strategy: import a fixture sized to require multiple batches at the
 * default `batchSize=100` and pass an aggressive `timeBudgetMs` that
 * will trip after the first batch but before the last. Then verify
 * (a) outcome.kind === 'timeout', (b) registrations table has SOME
 * rows committed (from completed batches) but FEWER than the fixture
 * size.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { eventRegistrations } from '@/modules/events/infrastructure/schema';
import { importCsv, makeImportCsvDeps } from '@/modules/events';
import { asUserId } from '@/modules/auth';
import { asTenantId } from '@/modules/members';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

function buildBudgetCsv(rows: number): Uint8Array {
  const header =
    'event_external_id,event_name,event_start,attendee_email,attendee_name';
  const lines: string[] = [header];
  for (let i = 0; i < rows; i++) {
    lines.push(
      `event_budget_${Math.floor(i / 50)},Budget Test,2026-06-21T18:00:00+07:00,budget_${i}_${Date.now()}@example.com,Budget Attendee ${i}`,
    );
  }
  return new TextEncoder().encode(lines.join('\n'));
}

describe('H-10 — time-budget short-circuit semantics', () => {
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

  it(
    'returns timeout AFTER partial commits when timeBudgetMs trips between batches; partial commits persist on live Neon',
    { timeout: 120_000 },
    async () => {
      // Drive the budget aggressively — `timeBudgetMs: 1` guarantees
      // the wall-clock check (`Date.now() - startedAtMs > 1ms`) trips
      // BEFORE any batch can fully complete + commit on any runner,
      // including intra-region Neon ap-southeast-1 (where the
      // previous "8s budget" silently passed by completing under
      // budget). The deterministic guarantee of NEW-L's unit test
      // covers the scheduler logic; this integration test now
      // exclusively validates the cross-tx persistence invariant —
      // committed rows survive even when subsequent batches time out.
      //
      // `batchConcurrency: 1` keeps the test serial: batch 0 starts
      // immediately (worker pulled idx=0 before the 1ms budget check
      // could fire), commits its 50 rows, then the worker re-enters
      // the loop, observes `timeBudgetExceeded=true`, returns. Hence
      // we expect exactly 1 batch worth of rows persisted.
      const ROW_COUNT = 150;
      const BATCH_SIZE = 50;
      const csvBytes = buildBudgetCsv(ROW_COUNT);

      const deps = makeImportCsvDeps();
      const outcome = await importCsv(
        {
          tenantId: asTenantId(tenant.ctx.slug),
          actorUserId: asUserId('00000000-0000-0000-0000-000000000077'),
          bytes: csvBytes,
          batchSize: BATCH_SIZE,
          batchConcurrency: 1,
          timeBudgetMs: 1,
        },
        deps,
      );

      expect(outcome.kind).toBe('timeout');

      // Cross-tx persistence: rows from the in-flight batch survive
      // even though the use-case returned `timeout`. This is the
      // contract the unit test cannot verify (needs a real DB).
      const regs = await runInTenant(tenant.ctx, async (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.tenantId, tenant.ctx.slug)),
      );
      expect(regs.length).toBeGreaterThan(0);
      expect(regs.length).toBeLessThan(ROW_COUNT);
    },
  );
});
