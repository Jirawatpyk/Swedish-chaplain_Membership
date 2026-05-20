/**
 * R2.1 M-test-6 (Phase 5 Round 1 close-out) — SC-007a perf bench.
 *
 * Spec budget: snapshotTemplateToDraft p95 < 500ms over 100 samples
 * against live Neon Singapore (Constitution Principle VII — Performance).
 *
 * Approach: pre-seed 1 template + 100 empty drafts, then run
 * snapshotTemplateToDraft on each in sequence + capture wall-clock
 * timings. Network-distance caveat applies (same as benefits-page-perf):
 * production = Vercel sin1 ↔ Neon ap-southeast-1 ≈ 1–3 ms RTT; local =
 * Bangkok ↔ Singapore ≈ 25 ms RTT. Override the env var
 * `PERF_SNAPSHOT_P95_MS` for cross-region runs.
 *
 * Gating: RUN_PERF=1. The bench takes ~100 × ~80ms = ~8s locally;
 * cheap enough to run frequently when investigating regressions but
 * skipped by default to keep `pnpm test:integration` fast.
 *
 * Run locally:
 *   RUN_PERF=1 pnpm test:integration tests/integration/broadcasts/snapshot-template-perf.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  broadcasts,
  broadcastTemplates,
} from '@/modules/broadcasts/infrastructure/schema';
import {
  snapshotTemplateToDraft,
  makeSnapshotTemplateToDraftDeps,
} from '@/modules/broadcasts';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const RUN_PERF = process.env.RUN_PERF === '1';
const SAMPLE_COUNT = 100;
const SNAPSHOT_P95_MS = Number(
  process.env.PERF_SNAPSHOT_P95_MS ?? '500',
);

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx]!;
}

describe.skipIf(!RUN_PERF)(
  'F7.1a snapshotTemplateToDraft perf — SC-007a (M-test-6, RUN_PERF=1)',
  () => {
    let tenant: TestTenant;
    let templateId: string;
    const draftIds: string[] = [];
    const memberId = randomUUID();
    const userId = randomUUID();

    beforeAll(async () => {
      tenant = await createTestTenant('test');

      const [tpl] = await db
        .insert(broadcastTemplates)
        .values({
          tenantId: tenant.ctx.slug,
          name: 'Perf bench template',
          subject:
            'Welcome to {{chamber_name}} — Q2 newsletter highlights',
          bodyHtml:
            '<p>Dear member,</p><p>Greetings from {{chamber_name}}! ' +
            'Here are this quarter\'s [event name], [date], and the ' +
            'usual reminder to update your [contact info]. Best wishes ' +
            'from the {{chamber_name}} team.</p>',
          locale: 'en',
          isSeeded: false,
          createdByUserId: null,
        })
        .returning({ id: broadcastTemplates.id });
      templateId = tpl!.id;

      // R3.5 M-6 — pre-seed 100 empty drafts in ONE batch INSERT
      // (was sequential loop = 100 × ~25ms RTT = 2.5s minimum).
      // Batch reduces seed time to ~30ms total + makes connection
      // pool state consistent for all measurement samples.
      const draftValues = Array.from({ length: SAMPLE_COUNT }, () => {
        const id = randomUUID();
        draftIds.push(id);
        return {
          tenantId: tenant.ctx.slug,
          broadcastId: id,
          requestedByMemberId: memberId,
          requestedByMemberPlanIdSnapshot: 'corporate',
          submittedByUserId: userId,
          actorRole: 'member_self_service' as const,
          subject: 'placeholder',
          bodyHtml: '<p>placeholder</p>',
          bodySource: 'placeholder',
          fromName: 'Member',
          replyToEmail: 'reply@example.com',
          segmentType: 'all_members' as const,
          estimatedRecipientCount: 1,
          status: 'draft' as const,
        };
      });
      await db.insert(broadcasts).values(draftValues);
    }, 60_000);

    afterAll(async () => {
      await db
        .delete(broadcasts)
        .where(eq(broadcasts.tenantId, tenant.ctx.slug));
      await db
        .delete(broadcastTemplates)
        .where(eq(broadcastTemplates.tenantId, tenant.ctx.slug));
      await tenant.cleanup();
    }, 60_000);

    it(`p95 < ${SNAPSHOT_P95_MS}ms over ${SAMPLE_COUNT} sequential samples`, async () => {
      const deps = makeSnapshotTemplateToDraftDeps(tenant.ctx.slug);

      // R3.5 M-6 — warm-up call: eliminates first-sample connection-
      // acquire cold-start bias (typically 20-40ms on cold pool).
      // Uses the FIRST draftId; that sample is replaced post-warmup
      // by re-seeding the broadcast row back to placeholder state.
      const warmupId = draftIds[0]!;
      await runInTenant(tenant.ctx, async () =>
        snapshotTemplateToDraft(deps, {
          tenantId: tenant.ctx.slug,
          actorUserId: userId,
          memberId,
          draftId: warmupId,
          templateId,
          requestId: 'req-perf-warmup',
        }),
      );
      // Reset the warmup draft so the measurement loop snapshots it
      // again from the original placeholder state.
      await db
        .update(broadcasts)
        .set({
          subject: 'placeholder',
          bodyHtml: '<p>placeholder</p>',
          bodySource: 'placeholder',
          startedFromTemplateId: null,
          templateNameSnapshot: null,
        })
        .where(eq(broadcasts.broadcastId, warmupId));

      const samples: number[] = [];
      for (const draftId of draftIds) {
        const t0 = performance.now();
        const r = await runInTenant(tenant.ctx, async () =>
          snapshotTemplateToDraft(deps, {
            tenantId: tenant.ctx.slug,
            actorUserId: userId,
            memberId,
            draftId,
            templateId,
            requestId: `req-perf-${draftId}`,
          }),
        );
        const t1 = performance.now();
        expect(r.ok).toBe(true);
        samples.push(t1 - t0);
      }

      const p50 = percentile(samples, 50);
      const p95 = percentile(samples, 95);
      const p99 = percentile(samples, 99);

      // eslint-disable-next-line no-console
      console.log(
        `[M-test-6] snapshotTemplateToDraft samples=${samples.length} ` +
          `p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms p99=${p99.toFixed(0)}ms`,
      );

      expect(p95).toBeLessThan(SNAPSHOT_P95_MS);
    }, 120_000);
  },
);
