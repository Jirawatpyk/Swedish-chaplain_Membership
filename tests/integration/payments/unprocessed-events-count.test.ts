/**
 * Money-remediation Task 1 — `processor_events` unreconciled sweeper gauge.
 *
 * Spec authority: `.superpowers/reviews/money-remediation-plan.md` Task 1.
 *
 * WHAT THIS INSTRUMENT MEASURES — and why the predicate is narrower than
 * the remediation plan's first draft (`processed_at IS NULL` alone):
 *
 * `processor_events.outcome` is written OPTIMISTICALLY at ingest
 * (`process-webhook-event.ts:374` inserts `outcome:'processed'` in its own
 * step-6 tx) while `processed_at` is set only at the TAIL of the dispatch tx
 * (`markProcessed`). So `outcome='processed' AND processed_at IS NULL` means
 * exactly "the dispatcher started and never finished" — the F-1 divergence
 * shape (money-side state committed, event never marked reconciled).
 *
 * Three OTHER row classes are `processed_at IS NULL` **by design** and are
 * permanently terminal — counting them would pin the gauge at a large
 * non-zero constant and destroy the baseline this instrument exists to
 * establish:
 *   - `acknowledged_only` written by the unknown-processor-account branch
 *     (`api/webhooks/stripe/route.ts:608`) — 200-acked, nothing to process,
 *     `processed_at` never set. (135 such rows on the dev branch today.)
 *   - `rejected_signature` / `rejected_environment_mismatch` /
 *     `rejected_api_version_mismatch` — rejection-audit rows, never dispatched.
 *
 * (The unknown-EVENT-TYPE `acknowledged_only` branch at
 * `process-webhook-event.ts:831` DOES set `processed_at` atomically, so it is
 * excluded by the `processed_at IS NULL` half regardless.)
 *
 * This test pins all four axes with one seeded row each so a future widening
 * of the predicate reddens here rather than silently flooding the gauge.
 *
 * Mocking policy: NONE — live Neon via the actual route handler.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { processorEvents } from '@/modules/payments/infrastructure/schema';
import { __test__readGaugeValues } from '@/lib/metrics';
import { GET } from '@/app/api/internal/metrics/unprocessed-events-count/route';

interface CronResponseBody {
  readonly ok: boolean;
  readonly tenantCount: number;
  readonly totalUnprocessed: number;
  readonly ageMinutes: number;
  readonly tenants: ReadonlyArray<{ tenantId: string; count: number }>;
}

const MINUTE_MS = 60_000;

/**
 * Isolated synthetic tenant — `processor_events.tenant_id` carries NO foreign
 * key (verified against live Neon: only the outcome/sha/PK/sig-reject CHECKs),
 * so an ad-hoc id is safe and keeps the assertion immune to the 16 unrelated
 * unreconciled rows already sitting on the shared dev branch.
 */
const TEST_TENANT = `t-unproc-${randomUUID().slice(0, 8)}`;

function sha(): string {
  return createHash('sha256').update(randomUUID()).digest('hex');
}

function makeRequest(authHeader: string | null): Request {
  const headers = new Headers();
  if (authHeader !== null) headers.set('Authorization', authHeader);
  headers.set('x-request-id', `task1-${randomUUID().slice(0, 8)}`);
  return new Request(
    'http://localhost:3100/api/internal/metrics/unprocessed-events-count',
    { method: 'GET', headers },
  );
}

const seededIds: string[] = [];

async function seed(input: {
  readonly label: string;
  readonly outcome: string;
  readonly processedAt: Date | null;
  readonly ageMs: number;
}): Promise<void> {
  const id = `evt_task1_${input.label}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  seededIds.push(id);
  const createdAt = new Date(Date.now() - input.ageMs);
  await db.insert(processorEvents).values({
    id,
    tenantId: TEST_TENANT,
    eventType: 'payment_intent.succeeded',
    apiVersion: '2025-01-01',
    livemode: false,
    processorAccountId: 'acct_task1_fixture',
    receivedAt: createdAt,
    processedAt: input.processedAt,
    outcome: input.outcome,
    payloadSha256: sha(),
    correlationId: randomUUID(),
    createdAt,
  });
}

describe('processor_events unreconciled gauge — live Neon (money-remediation Task 1)', () => {
  afterAll(async () => {
    if (seededIds.length === 0) return;
    // `processor_events` is append-only under `chamber_app`
    // (policy `processor_events_no_delete` = `FOR DELETE USING (false)`).
    // `SET LOCAL ROLE` only takes effect inside an explicit transaction —
    // mirrors the cleanup idiom in `processor-events-idempotency.test.ts`.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE neondb_owner`);
      for (const id of seededIds) {
        await tx.delete(processorEvents).where(eq(processorEvents.id, id));
      }
    });
  });

  it('rejects a request with no Bearer token', async () => {
    if (!process.env.CRON_SECRET) return;
    const res = await GET(makeRequest(null) as never);
    expect(res.status).toBe(401);
  });

  it('rejects a request with a wrong Bearer token', async () => {
    if (!process.env.CRON_SECRET) return;
    const res = await GET(makeRequest('Bearer not-the-real-secret') as never);
    expect(res.status).toBe(401);
  });

  it('counts ONLY the aged, dispatch-started, never-marked row (1 of 4 seeded)', async () => {
    // (a) THE SIGNAL — dispatch started, never marked, older than the window.
    await seed({
      label: 'aged_unreconciled',
      outcome: 'processed',
      processedAt: null,
      ageMs: 60 * MINUTE_MS,
    });
    // (b) In-flight — same shape but younger than the window. A webhook
    //     dispatch legitimately in progress must NOT page anyone.
    await seed({
      label: 'fresh_inflight',
      outcome: 'processed',
      processedAt: null,
      ageMs: 1 * MINUTE_MS,
    });
    // (c) Reconciled — aged but `markProcessed` committed. The healthy case.
    await seed({
      label: 'aged_reconciled',
      outcome: 'processed',
      processedAt: new Date(Date.now() - 30 * MINUTE_MS),
      ageMs: 60 * MINUTE_MS,
    });
    // (d) By-design terminal — unknown-processor-account ack. Permanently
    //     `processed_at IS NULL`; counting it would pin the gauge non-zero
    //     forever and destroy the baseline.
    await seed({
      label: 'aged_ack_only',
      outcome: 'acknowledged_only',
      processedAt: null,
      ageMs: 60 * MINUTE_MS,
    });

    const auth = process.env.CRON_SECRET
      ? `Bearer ${process.env.CRON_SECRET}`
      : null;
    const res = await GET(makeRequest(auth) as never);
    expect(res.status).toBe(200);

    const body = (await res.json()) as CronResponseBody;
    expect(body.ok).toBe(true);
    expect(body.ageMinutes).toBe(15);

    const mine = body.tenants.filter((t) => t.tenantId === TEST_TENANT);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.count).toBe(1);
  });

  it('publishes the per-tenant count as the `payments_unprocessed_events_count` gauge', async () => {
    // Guards the emit itself: without this the route could compute the
    // right number and never hand it to OTel, leaving a silent instrument.
    const observed = __test__readGaugeValues('payments_unprocessed_events_count');
    expect(observed?.get(JSON.stringify({ tenant: TEST_TENANT }))).toBe(1);
  });
});
