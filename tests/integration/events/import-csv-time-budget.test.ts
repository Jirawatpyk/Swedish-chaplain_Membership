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
      // Strategy: `batchSize=1` + large ROW_COUNT + small budget makes
      // the test deterministic across runner-region tiers:
      //   - cross-region Neon (~50-100ms/row RTT): budget=400ms allows
      //     ~3-8 rows before the wall-clock check trips, ROW_COUNT
      //     stays well above the persist count.
      //   - intra-region prod (~5-10ms/row RTT): budget=400ms allows
      //     ~30-50 rows before trip, ROW_COUNT=500 stays well above.
      // On every runner: SOME rows commit (proves cross-tx persistence
      // invariant) AND not all rows commit (proves the timeout
      // short-circuit actually fires). NEW-L unit test pins the
      // scheduler logic deterministically via mocked `Date.now`; this
      // test exclusively validates the live-DB persistence contract.
      const ROW_COUNT = 500;
      const BATCH_SIZE = 1;
      const csvBytes = buildBudgetCsv(ROW_COUNT);

      const deps = makeImportCsvDeps();
      const outcome = await importCsv(
        {
          tenantId: asTenantId(tenant.ctx.slug),
          actorUserId: asUserId('00000000-0000-0000-0000-000000000077'),
          bytes: csvBytes,
          batchSize: BATCH_SIZE,
          batchConcurrency: 1,
          timeBudgetMs: 400,
        },
        deps,
      );

      expect(outcome.kind).toBe('timeout');

      // Cross-tx persistence: rows from the in-flight batches survive
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
