/**
 * Rolling-anchor refactor — Task 12 R4 backfill script integration test
 * (live Neon).
 *
 * Drives the SCRIPT's own orchestration (`loadPlanInputs` →
 * `buildBackfillPlan` → `applyPlan` from
 * `scripts/backfill-cycle-anchors.ts`), not just the underlying repo method
 * (that is `reanchor-period.test.ts`'s job). Covers:
 *
 *   1. the punctuation-insensitive company-name match against
 *      `members.company_name`,
 *   2. the full write flow: guarded re-anchor + `renewal_cycle_reanchored`
 *      audit row (invoice_id NULL — the R4-backfill arm) in the SAME tx,
 *   3. idempotent re-run: the re-built plan reports `already_anchored`,
 *      zero further writes,
 *   4. explicit `period_from`/`period_to` override landing verbatim in the
 *      DB (the legacy full-year member arm).
 *
 * Importing the script module does NOT auto-run its CLI `main()` — the
 * invokedDirectly guard checks `process.argv[1]`, which is vitest here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  applyPlan,
  loadPlanInputs,
} from '../../../scripts/backfill-cycle-anchors';
import {
  buildBackfillPlan,
  parseBackfillCsv,
  type ReanchorAction,
} from '../../../scripts/lib/backfill-cycle-anchors-core';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('backfill-cycle-anchors script — integration (Task 12 / R4)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    planId = `f8-backfill-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Backfill Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  async function seedMemberWithCycle(companyName: string): Promise<{
    memberId: string;
    cycleId: string;
  }> {
    const memberId = randomUUID();
    const cycleId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName,
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        // Provisional registration-date anchor the backfill replaces.
        periodFrom: new Date('2025-12-11T00:00:00Z'),
        periodTo: new Date('2026-12-11T00:00:00Z'),
        expiresAt: new Date('2026-12-11T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '17120.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });
    return { memberId, cycleId };
  }

  it('re-anchors a matched member from the CSV payment date + emits the audit row; re-run is an already_anchored no-op', async () => {
    const { memberId, cycleId } = await seedMemberWithCycle('Backfill Smoke Co., Ltd.');

    // Punctuation/casing deliberately differ from the seeded company_name —
    // the normalised match is the point of the name pipeline.
    const csv = ['company_name,payment_date', 'BACKFILL SMOKE CO LTD,2025-06-08'].join('\n');
    const parsed = parseBackfillCsv(csv);
    expect(parsed.issues).toEqual([]);

    const now = new Date('2026-07-09T00:00:00Z');
    const referencedNames = new Set(parsed.rows.map((r) => r.normalizedName));
    const inputs = await loadPlanInputs(tenant.ctx, referencedNames);
    const plan = buildBackfillPlan({ rows: parsed.rows, ...inputs, now });

    const reanchors = plan.actions.filter(
      (a): a is ReanchorAction => a.kind === 'reanchor',
    );
    expect(reanchors).toHaveLength(1);
    expect(reanchors[0]).toMatchObject({
      memberId,
      cycleId,
      newPeriodFrom: '2025-06-01T00:00:00.000Z', // month start of 2025-06-08
      newPeriodTo: '2026-06-01T00:00:00.000Z', // +12 months
      periodSource: 'derived_month_start_plus_12',
    });

    const runId = randomUUID();
    const nowIso = now.toISOString();
    const outcome = await applyPlan(tenant.ctx, reanchors, runId, nowIso);
    expect(outcome).toEqual({ reanchored: 1, raceLost: 0, failed: 0 });

    // DB state: period moved, anchored stamped, NO anchor invoice, status upcoming.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(renewalCycles).where(eq(renewalCycles.cycleId, cycleId)),
    );
    expect(rows[0]?.status).toBe('upcoming');
    expect(rows[0]?.periodFrom.toISOString()).toBe('2025-06-01T00:00:00.000Z');
    expect(rows[0]?.periodTo.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(rows[0]?.anchoredAt?.toISOString()).toBe(nowIso);
    expect(rows[0]?.anchorInvoiceId).toBeNull();
    // Frozen fields deliberately UNCHANGED (no re-freeze in the backfill).
    expect(rows[0]?.frozenPlanPriceThb).toBe('17120.00');

    // Audit row committed with the backfill (invoice_id null) payload.
    const audits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'renewal_cycle_reanchored'),
          ),
        ),
    );
    const forCycle = audits.filter(
      (a) => (a.payload as { cycle_id?: string }).cycle_id === cycleId,
    );
    expect(forCycle).toHaveLength(1);
    expect(forCycle[0]?.payload).toMatchObject({
      cycle_id: cycleId,
      member_id: memberId,
      invoice_id: null,
      old_period_from: '2025-12-11T00:00:00.000Z',
      new_period_from: '2025-06-01T00:00:00.000Z',
      new_period_to: '2026-06-01T00:00:00.000Z',
      old_status: 'upcoming',
      refroze_plan_fields: false,
      reminder_events_reset: 0,
    });

    // Idempotent re-run: the freshly rebuilt plan reports already_anchored.
    const inputs2 = await loadPlanInputs(tenant.ctx, referencedNames);
    const plan2 = buildBackfillPlan({ rows: parsed.rows, ...inputs2, now });
    expect(plan2.actions).toEqual([
      expect.objectContaining({ kind: 'skip', reason: 'already_anchored', memberId }),
    ]);
  }, 60_000);

  it('honours the explicit period_from/period_to override (legacy full-year member)', async () => {
    const { memberId, cycleId } = await seedMemberWithCycle('Legacy Fullyear AB');

    const csv = [
      'company_name,payment_date,period_from,period_to',
      'legacy fullyear ab,2025-11-20,2026-01-01,2026-12-31',
    ].join('\n');
    const parsed = parseBackfillCsv(csv);
    expect(parsed.issues).toEqual([]);

    const now = new Date('2026-07-09T00:00:00Z');
    const referencedNames = new Set(parsed.rows.map((r) => r.normalizedName));
    const inputs = await loadPlanInputs(tenant.ctx, referencedNames);
    const plan = buildBackfillPlan({ rows: parsed.rows, ...inputs, now });

    const reanchors = plan.actions.filter(
      (a): a is ReanchorAction => a.kind === 'reanchor',
    );
    expect(reanchors).toHaveLength(1);
    expect(reanchors[0]).toMatchObject({
      memberId,
      periodSource: 'explicit_override',
    });

    const outcome = await applyPlan(tenant.ctx, reanchors, randomUUID(), now.toISOString());
    expect(outcome).toEqual({ reanchored: 1, raceLost: 0, failed: 0 });

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(renewalCycles).where(eq(renewalCycles.cycleId, cycleId)),
    );
    expect(rows[0]?.periodFrom.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(rows[0]?.periodTo.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(rows[0]?.anchorInvoiceId).toBeNull();
  }, 60_000);
});
