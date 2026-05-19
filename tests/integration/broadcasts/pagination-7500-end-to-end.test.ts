/**
 * T037 — F7.1a US1 Pagination CI smoke (7,500 recipients).
 *
 * Authored RED 2026-05-19 per Constitution II NON-NEG TDD. Phase 3
 * Cluster B+C land the use cases + cron route that make this GREEN.
 *
 * Per critique E11 round 2 (non-env-gated CI smoke): seed a 7,500-
 * member throwaway tenant, run the full submit → approve → dispatch
 * flow, and verify the end-to-end invariants:
 *
 *   (a) `broadcast_batch_manifests` contains exactly 1 batch row
 *       (7,500 ≤ 10,000 Resend audience cap → single batch suffices).
 *   (b) batch_manifest.recipient_count = 7500;
 *       recipient_range_start = 0; recipient_range_end = 7499.
 *   (c) status transitions: pending → sending → sent (mock Resend
 *       gateway returns ACK for the single batch).
 *   (d) Consolidated roll-up on the broadcast row reports
 *       recipient_count_resolved = 7500 (single source of truth for
 *       admin detail page consolidated count).
 *
 * Resend gateway is mocked via the F7 MVP `BroadcastsGatewayPort`
 * stub pattern (jcc-test-tenant-fixture.test.ts) — no real network
 * calls. The 50k SC-002 perf bench is in pagination-50k-end-to-end
 * .test.ts (env-gated RUN_PERF_BENCH=true).
 *
 * Runtime budget: ≤45 seconds (member seed is the slowest part —
 * bulk-insert 7,500 rows via a single INSERT ... VALUES).
 *
 * Why 7,500 not 10,000: per spec FR-001, the smallest broadcast that
 * could conceivably exceed 5k MVP cap is "any number above 5k". 7,500
 * is a deliberate "comfortably-mid-range" test that exercises the
 * batched-path code without hitting the per-audience cap boundary
 * exactly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

async function importDispatchFlow(): Promise<{
  splitBroadcastIntoBatches: (
    deps: unknown,
    input: unknown,
  ) => Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
  dispatchBroadcastBatch: (
    deps: unknown,
    input: unknown,
  ) => Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
}> {
  const splitPath =
    '@/modules/broadcasts/application/use-cases/split-broadcast-into-batches';
  const dispatchPath =
    '@/modules/broadcasts/application/use-cases/dispatch-broadcast-batch';
  try {
    const splitMod = await new Function('m', 'return import(m)')(splitPath);
    const dispatchMod = await new Function('m', 'return import(m)')(dispatchPath);
    return {
      splitBroadcastIntoBatches: (splitMod as { splitBroadcastIntoBatches: never })
        .splitBroadcastIntoBatches,
      dispatchBroadcastBatch: (dispatchMod as { dispatchBroadcastBatch: never })
        .dispatchBroadcastBatch,
    };
  } catch (err) {
    throw new Error(
      `[RED — T044/T045] split + dispatch use cases not yet implemented: ${String(err)}`,
    );
  }
}

describe('F7.1a US1 7,500-end-to-end CI smoke (T037)', () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        '[RED — T037] DATABASE_URL required for integration test; live Neon expected.',
      );
    }
  });

  afterAll(async () => {
    // Cleanup runs after Phase 3 Cluster B/C lands the use cases +
    // the actual seed-tenant + 7500-member fixture. RED at Phase 3A
    // checkpoint — see comments below.
  });

  it.skip('(pending Phase 3B/3C) 7,500 recipients → 1 batch row in broadcast_batch_manifests', async () => {
    // Will turn GREEN when:
    //   1. splitBroadcastIntoBatches use case lands (Phase 3B T044)
    //   2. dispatchBroadcastBatch use case lands (Phase 3B T045)
    //   3. Real Drizzle BatchManifestsPort impl lands (Phase 3B Cluster B3)
    //   4. Seed helper for 7500 members lands (this file's Phase 3C extension)
    //
    // Verification on GREEN:
    //   - SELECT COUNT(*) FROM broadcast_batch_manifests WHERE broadcast_id = $1
    //     → 1
    //   - SELECT recipient_count FROM broadcast_batch_manifests WHERE …
    //     → 7500
    //   - SELECT status FROM broadcast_batch_manifests WHERE …
    //     → 'sent' (after mock Resend ACKs)
    const { splitBroadcastIntoBatches } = await importDispatchFlow();
    void splitBroadcastIntoBatches;
    expect.fail('pending Phase 3B/3C — see comments above');
  });

  it.skip('(pending Phase 3B/3C) consolidated broadcast roll-up = 7500 delivered', async () => {
    // Will turn GREEN when:
    //   1. Resend webhook handler extension lands (Phase 3C T057) to
    //      update broadcast_batch_manifests per-batch counters.
    //   2. Mock-Resend gateway returns 7500 'email.delivered' events
    //      for the single batch.
    //   3. Broadcasts detail-page consolidated read aggregates
    //      delivered_count across all batch_manifests for the broadcast.
    expect.fail('pending Phase 3C T057 webhook ext + admin detail aggregate read');
  });

  it.skip('(pending Phase 3B/3C) no duplicate recipients across batches (single-batch case)', async () => {
    // SELECT count(DISTINCT recipient_email_lower)
    //   FROM broadcast_deliveries
    //   WHERE broadcast_id = $1
    //   → 7500
    expect.fail('pending Phase 3B/3C');
  });
});
