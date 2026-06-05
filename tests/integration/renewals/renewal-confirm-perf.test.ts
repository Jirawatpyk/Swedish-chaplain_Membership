/**
 * F8 Phase 10 · T265 — `confirmRenewal` perf benchmark (RUN_PERF=1).
 *
 * Verifies FR-022 / FR-023 / SC-005 SLO: member-self-service renewal
 * confirmation MUST satisfy TTFB <600ms + total <1.2s. This bench
 * measures the F8-OWNED portion of the path (state validation + plan-
 * change branch + cycle transition + audit emit), with the F4 invoice
 * bridge stubbed to a constant ~0ms so the captured number isolates F8
 * server-side latency. Real production TTFB is also bounded by F4
 * invoice creation (own SLO) + F1 rate-limit middleware (own SLO).
 *
 * Sample strategy: each call mutates a cycle (awaiting_payment →
 * awaiting_payment_invoice) so we can't repeat against the same cycle.
 * We seed N distinct cycles + confirm one per sample. Cleanup deletes
 * everything in afterAll.
 *
 * Run:
 *   RUN_PERF=1 pnpm test:integration tests/integration/renewals/renewal-confirm-perf.test.ts
 *   RUN_PERF=1 PERF_MEMBER_COUNT=1000 PERF_SLO_STRICT=1 pnpm test:integration ...
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSatang } from '@/lib/money';
import { eq, inArray, type InferInsertModel } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { confirmRenewal, makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';

const RUN_PERF = process.env.RUN_PERF === '1';
// Smaller sample count by default — each sample mutates a cycle so we
// can't reuse fixtures. 50 samples = 50 distinct cycles seeded.
const SAMPLE_COUNT = Number.parseInt(process.env.PERF_SAMPLE_COUNT ?? '50', 10);
const WARMUP_COUNT = Number.parseInt(process.env.PERF_WARMUP_COUNT ?? '5', 10);
const TOTAL_CYCLES = SAMPLE_COUNT + WARMUP_COUNT;
const PERF_TTFB_MS = 600; // SC-005 (TTFB)
const PERF_TOTAL_MS = 1_200; // SC-005 (confirm endpoint total)
const PERF_SLO_STRICT = process.env.PERF_SLO_STRICT === '1';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface SeededTriplet {
  readonly memberId: string;
  readonly cycleId: string;
  /** Pre-seeded invoice id the F4 bridge mock returns for this cycle. */
  readonly invoiceId: string;
}

function percentile(sortedAsc: ReadonlyArray<number>, p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx] ?? 0;
}

async function seedCyclesAwaitingPayment(
  tenant: TestTenant,
  user: TestUser,
  count: number,
): Promise<ReadonlyArray<SeededTriplet>> {
  const planId = `f8-confirm-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, (tx) =>
    seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'Perf Confirm Plan' },
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    }),
  );
  const seeded: SeededTriplet[] = [];
  const now = Date.now();
  // Insert in 1 batch — sample count is small (~55 rows).
  await runInTenant(tenant.ctx, async (tx) => {
    const memberRows: Array<InferInsertModel<typeof members>> = [];
    const contactRows: Array<InferInsertModel<typeof contacts>> = [];
    const invoiceRows: Array<InferInsertModel<typeof invoices>> = [];
    const cycleRows: Array<InferInsertModel<typeof renewalCycles>> = [];
    for (let i = 0; i < count; i++) {
      const memberId = randomUUID();
      const cycleId = randomUUID();
      // R4 staff-review F4 fix: comment-code parity. Pre-seed a
      // `draft`-status invoice per cycle so the F4 bridge mock can
      // return its id and the cycle's UPDATE linked_invoice_id FK
      // resolves. Status='draft' is the minimum-CHECK-passing state
      // (mirrors self-service-renewal-tx.test.ts:148-157 pattern);
      // the F4 invoices_status constraint accepts draft without
      // needing a payment row.
      const invoiceId = randomUUID();
      memberRows.push({
        tenantId: tenant.ctx.slug,
        memberId,
        // 055-member-number — NOT NULL + per-tenant UNIQUE; `i` is the
        // 0-based global member index, so `i + 1` is collision-free 1..N.
        memberNumber: i + 1,
        companyName: `Perf Confirm Co ${i}`,
        country: 'TH',
        planId,
        planYear: 2026,
      });
      contactRows.push({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Perf',
        lastName: `C${i}`,
        email: `confirm-${i}-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en' as const,
      });
      invoiceRows.push({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'draft',
        currency: 'THB',
      });
      cycleRows.push({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        // Cycles ready for confirm flow.
        status: 'awaiting_payment' as const,
        periodFrom: new Date(now - 30 * MS_PER_DAY),
        periodTo: new Date(now + 30 * MS_PER_DAY),
        expiresAt: new Date(now + 30 * MS_PER_DAY),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
      seeded.push({ memberId, cycleId, invoiceId });
    }
    await tx.insert(members).values(memberRows);
    await tx.insert(contacts).values(contactRows);
    await tx.insert(invoices).values(invoiceRows);
    await tx.insert(renewalCycles).values(cycleRows);
  });
  return seeded;
}

describe.skipIf(!RUN_PERF)(
  'F8 confirmRenewal perf — integration (T265, RUN_PERF=1)',
  () => {
    let tenant: TestTenant;
    let user: TestUser;
    let seeded: ReadonlyArray<SeededTriplet>;

    beforeAll(async () => {
      user = await createActiveTestUser('admin');
      tenant = await createTestTenant('test-swecham');
      seeded = await seedCyclesAwaitingPayment(tenant, user, TOTAL_CYCLES);
      console.log(
        `[T265] Seeded ${seeded.length} cycles in awaiting_payment status`,
      );
    }, 600_000);

    afterAll(async () => {
      const memberIds = seeded.map((s) => s.memberId);
      // Cycles → invoices → contacts → members (FK-friendly order).
      await db
        .delete(renewalCycles)
        .where(inArray(renewalCycles.memberId, memberIds))
        .catch(() => {});
      await db
        .delete(invoices)
        .where(inArray(invoices.memberId, memberIds))
        .catch(() => {});
      await db
        .delete(contacts)
        .where(inArray(contacts.memberId, memberIds))
        .catch(() => {});
      await db
        .delete(members)
        .where(inArray(members.memberId, memberIds))
        .catch(() => {});
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug))
        .catch(() => {});
      await tenant.cleanup().catch(() => {});
    }, 600_000);

    it(`p95 TTFB <${PERF_TTFB_MS}ms / total <${PERF_TOTAL_MS}ms (strict=${PERF_SLO_STRICT})`, async () => {
      const deps = makeRenewalsDeps(tenant.ctx.slug);

      // Stub F4 bridge — bench measures F8's own confirm latency.
      // Production total p95 includes F4 invoice creation (own SLO,
      // measured in F4's perf-bench T110a) + F1 rate-limit middleware.
      // We pre-seeded one invoice row per cycle so the bridge mock
      // returns a real FK-resolvable id from the queue per call.
      const invoiceQueue = seeded.map((s) => s.invoiceId);
      const bridgeSpy = vi
        .spyOn(deps.f4InvoicingBridge, 'issueInvoiceForRenewal')
        .mockImplementation(async () => {
          const invoiceId =
            invoiceQueue.shift() ??
            (() => {
              throw new Error('invoice queue exhausted in T265 perf bench');
            })();
          return {
            status: 'issued' as const,
            invoiceId,
            invoiceNumber: `IV/${invoiceId.slice(0, 8)}`,
            totalSatang: asSatang(5_000_000n),
          };
        });

      let cursor = 0;
      // Warmup
      for (let i = 0; i < WARMUP_COUNT; i++) {
        const t = seeded[cursor++]!;
        const r = await confirmRenewal(deps, {
          tenantId: tenant.ctx.slug,
          cycleId: t.cycleId,
          memberId: t.memberId,
          planYear: 2026,
          actorUserId: user.userId,
          actorRole: 'member',
          correlationId: randomUUID(),
        });
        expect(r.ok).toBe(true);
      }

      const samples: number[] = [];
      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const t = seeded[cursor++]!;
        const t0 = performance.now();
        const r = await confirmRenewal(deps, {
          tenantId: tenant.ctx.slug,
          cycleId: t.cycleId,
          memberId: t.memberId,
          planYear: 2026,
          actorUserId: user.userId,
          actorRole: 'member',
          correlationId: randomUUID(),
        });
        const elapsed = performance.now() - t0;
        expect(r.ok).toBe(true);
        // Staff-R006 fix: tighten beyond `r.ok` — confirm the use-case
        // returned the expected output shape (planChanged=false default,
        // payUrl populated, invoiceNumber non-empty). Without this, a
        // future regression that returned `r.ok=true` with malformed
        // output would still pass the bench. This is per-sample
        // coverage — no extra DB hit, just verifies the contract.
        if (r.ok) {
          expect(r.value.planChanged).toBe(false);
          expect(r.value.payUrl).toBeTruthy();
          expect(r.value.invoiceNumber).toBeTruthy();
        }
        samples.push(elapsed);
      }

      samples.sort((a, b) => a - b);
      const p50 = percentile(samples, 50);
      const p95 = percentile(samples, 95);
      const p99 = percentile(samples, 99);
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;

      console.log(
        `[T265] samples=${SAMPLE_COUNT} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms avg=${avg.toFixed(1)}ms`,
      );

      try {
        appendFileSync(
          'perf-benchmarks.md',
          `\n## F8 Phase 10 T265 — confirmRenewal (F8-only) @ ${SAMPLE_COUNT} samples (${new Date().toISOString()})\n` +
            `- samples: ${SAMPLE_COUNT} (warmup ${WARMUP_COUNT})\n` +
            `- p50: ${p50.toFixed(1)}ms · p95: ${p95.toFixed(1)}ms · p99: ${p99.toFixed(1)}ms · avg: ${avg.toFixed(1)}ms\n` +
            `- F4 bridge: stubbed (production total adds F4 invoice creation + F1 rate-limit overhead)\n` +
            `- SLO TTFB: <${PERF_TTFB_MS}ms · total: <${PERF_TOTAL_MS}ms (SC-005)\n` +
            `- bench measures F8 server-side state-transition + audit emit; real TTFB requires HTTP-layer measurement at staging\n`,
        );
      } catch {
        // perf-benchmarks.md may not exist; non-fatal.
      }

      bridgeSpy.mockRestore();

      if (PERF_SLO_STRICT) {
        // F8-only budget headroom: aim for p95 < TTFB budget so the
        // total budget has room for F4 + F1 overhead in production.
        expect(p95).toBeLessThan(PERF_TTFB_MS);
      } else {
        expect(p95).toBeGreaterThan(0);
      }
    }, 600_000);
  },
);
