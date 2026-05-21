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
 *
 * T154 fixture parameters (review finding pr-test-analyzer #3 closure
 * 2026-05-21): the documented worst-case fixture (200 KB body / 1000
 * members / TH locale) is **wired into this harness** via env-var
 * overrides — `PERF_BODY_BYTES + PERF_LOCALE + PERF_DRAFT_COUNT` are
 * read at lines ~60-63 + threaded into `buildPerfBody()` (lines ~75-103).
 * Defaults preserve the cheap-bench behaviour for local regression
 * detection (200-byte EN body, 100 drafts); the worst-case fixture
 * exercises at staging `/speckit.qa.run` pre-flag-flip.
 *
 * **OPERATOR INSTRUCTION** (R009 Round 2 staff-review closure 2026-05-21,
 * see `qa/ship-day-checklist.md § B.2`): when running this bench against
 * the **production-realistic worst-case workload**, the operator MUST
 * set the following env vars before invocation:
 *
 *   PERF_BODY_BYTES=204800 \
 *   PERF_LOCALE=th \
 *   PERF_DRAFT_COUNT=1000 \
 *   RUN_PERF=1 \
 *   pnpm test:integration tests/integration/broadcasts/snapshot-template-perf.test.ts
 *
 * Without these overrides the bench measures a CHEAP baseline (200-byte
 * EN body, 100 samples) — appropriate for local regression detection
 * but NOT a valid SC-007a budget verification. The previous file-header
 * comment claimed env-var wiring was "F7.1b polish" — that claim was
 * incorrect post-Round-5 H4 and is now corrected.
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

// H4 Round 2 fix 2026-05-21 (review finding pr-test-analyzer H1):
// wire the T154-documented env vars so the staging operator running
// `PERF_BODY_BYTES=204800 PERF_LOCALE=th PERF_DRAFT_COUNT=1000` per
// qa/ship-day-checklist.md § B.2 actually GETS the worst-case fixture
// (200 KB TH body / 1000 drafts) instead of silently getting the
// 200-byte EN baseline. Defaults preserve the original cheap-bench
// behaviour so `RUN_PERF=1` without env-var overrides keeps working.
const SAMPLE_COUNT = Number(process.env.PERF_DRAFT_COUNT ?? '100');
const PERF_BODY_BYTES = Number(process.env.PERF_BODY_BYTES ?? '0');
const PERF_LOCALE = (process.env.PERF_LOCALE ?? 'en') as 'en' | 'th' | 'sv';
const SNAPSHOT_P95_MS = Number(
  process.env.PERF_SNAPSHOT_P95_MS ?? '500',
);

/**
 * Build the perf-bench body. When `PERF_BODY_BYTES > 0`, generate a
 * realistic worst-case body of approximately that byte count using
 * the locale's native character set + bracket placeholders. TH locale
 * uses the densest UTF-8 character set (3 bytes/char for most Thai
 * codepoints + combining marks for AAT diacritics). Without env var,
 * use the cheap baseline body for fast regression detection.
 */
function buildPerfBody(): string {
  const baseline =
    '<p>Dear member,</p><p>Greetings from {{chamber_name}}! ' +
    "Here are this quarter's [event name], [date], and the " +
    'usual reminder to update your [contact info]. Best wishes ' +
    'from the {{chamber_name}} team.</p>';
  if (PERF_BODY_BYTES === 0) return baseline;

  // Filler paragraph in the requested locale's script.
  const filler =
    PERF_LOCALE === 'th'
      ? // Thai Buddhist business correspondence boilerplate; ~3 bytes/char UTF-8.
        '<p>เรียนสมาชิกผู้มีอุปการะคุณ ขอขอบคุณที่สนับสนุนกิจกรรมของหอการค้าตลอดมา ' +
        'ในไตรมาสนี้เราขอนำเสนอกิจกรรม [ชื่อกิจกรรม] ที่จะจัดขึ้นในวันที่ [วันที่] ' +
        'ณ สถานที่ [สถานที่] โปรดยืนยันการเข้าร่วมและอัปเดตข้อมูลติดต่อของท่าน</p>'
      : PERF_LOCALE === 'sv'
        ? '<p>Bästa medlem, vi vill informera om kvartalsmötet [datum] kl [tid]. ' +
          'Vänligen bekräfta ditt deltagande via [länk] och uppdatera dina ' +
          'kontaktuppgifter i medlemsportalen. Med vänliga hälsningar, kammarens team.</p>'
        : '<p>Quarterly chamber update — please review the agenda items ' +
          'and confirm attendance at the upcoming session [date] at [venue]. ' +
          'Update your [contact info] in the member portal. Best regards.</p>';

  // Estimate filler byte-length (UTF-8) then repeat until target reached.
  // TC-032 closure fix 2026-05-21: use `Math.floor` (not `Math.ceil`) and
  // cap the final body at `octet_length ≤ 200 KB` per the
  // `broadcasts_body_html_size` CHECK constraint at migration 0064. The
  // F7 MVP body cap is 204800 bytes; the fixture intentionally exercises
  // the upper boundary but MUST NOT exceed it. Note: when callers pass
  // `PERF_BODY_BYTES > 204800` we silently clamp to 204800 + log a warn
  // (operator may have miscounted the spec budget).
  const CHECK_CONSTRAINT_BYTES = 200 * 1024; // 204800
  const target = Math.min(PERF_BODY_BYTES, CHECK_CONSTRAINT_BYTES);
  if (PERF_BODY_BYTES > CHECK_CONSTRAINT_BYTES) {
    console.warn(
      `[perf-bench] PERF_BODY_BYTES=${PERF_BODY_BYTES} exceeds the ` +
        `broadcasts_body_html_size CHECK constraint (${CHECK_CONSTRAINT_BYTES}); ` +
        `clamping to ${CHECK_CONSTRAINT_BYTES} for the fixture body.`,
    );
  }
  const fillerBytes = Buffer.byteLength(filler, 'utf8');
  const baselineBytes = Buffer.byteLength(baseline, 'utf8');
  const remainingBytes = Math.max(0, target - baselineBytes);
  // floor → we want UNDER the cap, not over it. Final body byte-length:
  // baselineBytes + repetitions × fillerBytes ≤ target ≤ 204800.
  const repetitions = Math.floor(remainingBytes / fillerBytes);
  return baseline + filler.repeat(repetitions);
}

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

      // H4 Round 2: bodyHtml + locale honour the env-var fixture so the
      // staging operator gets the worst-case workload they requested.
      const [tpl] = await db
        .insert(broadcastTemplates)
        .values({
          tenantId: tenant.ctx.slug,
          name: 'Perf bench template',
          subject:
            'Welcome to {{chamber_name}} — Q2 newsletter highlights',
          bodyHtml: buildPerfBody(),
          locale: PERF_LOCALE,
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

      console.log(
        `[M-test-6] snapshotTemplateToDraft samples=${samples.length} ` +
          `p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms p99=${p99.toFixed(0)}ms`,
      );

      expect(p95).toBeLessThan(SNAPSHOT_P95_MS);
      // TC-032 closure fix 2026-05-21: bumped vitest test timeout from
      // 120s → 15 min so the worst-case fixture (`PERF_DRAFT_COUNT=1000`
      // × 200 KB TH body) has wall-clock headroom under Bangkok↔Singapore
      // ~25 ms RTT. The 500 ms p95 BUDGET still applies (it measures
      // PER-SAMPLE production latency, not the bench's wall-clock); the
      // timeout is purely an execution guard against an infinite hang.
      // Default 100-sample baseline still completes in ~8 s.
    }, 15 * 60 * 1000);
  },
);
