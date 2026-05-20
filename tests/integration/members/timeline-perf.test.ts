/**
 * Timeline perf gate (E3 follow-up to US6).
 *
 * Target: p95 < 300ms for a 50-event timeline page on a member with
 * 1,000 total audit events, backed by:
 *   - `audit_log_member_id_idx` index on `((payload->>'member_id'))`
 *     (migration 0009)
 *   - `audit_log_timestamp_idx` DESC index (F1 migration 0001)
 *
 * Rationale: Constitution Principle VII mandates Members API p95 <
 * 400 ms — timeline is a Members read path, so the repo query is
 * subject to the same SLO. The 300ms local target leaves headroom for
 * cold-start / network overhead on Vercel.
 *
 * Gated by RUN_PERF=1 so the 1,000-event seed + enrichment JOIN
 * doesn't run on every CI tick. Skip is observable in the test report.
 *
 * Run locally:
 *   RUN_PERF=1 pnpm test:integration tests/integration/members/timeline-perf.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { createMember, timelineList } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const RUN_PERF = process.env.RUN_PERF === '1';
const SEED_EVENTS = 1000;
const PAGE_SIZE = 50;
const RUN_COUNT = 20;
// Default 300 ms targets the intended in-region production environment
// (Vercel sin1 ↔ Neon ap-southeast-1, ~ 1–3 ms RTT). Local dev runs
// from Bangkok against Neon Singapore — the ~25 ms RTT × multi-op
// query × 100 samples typically lands around 550-650 ms p95, which is
// not a regression but a network-distance artifact. Override via
// `PERF_TIMELINE_P95_MS` for cross-region runs.
const P95_TARGET_MS = Number(
  process.env.PERF_TIMELINE_P95_MS ?? '300',
);

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

describe.skipIf(!RUN_PERF)('timeline perf (E3, RUN_PERF=1)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    // Seed one plan + one member
    const planId = `perf-plan-${randomUUID().slice(0, 6)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 100000n,
        legalNameTh: 'Test TH',
        legalNameEn: 'Test EN',
        taxId: '0000000000000',
        registeredAddressTh: 'Test Address TH',
        registeredAddressEn: 'Test Address EN',
        invoiceNumberPrefix: 'INV',
        creditNoteNumberPrefix: 'CN',
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Perf Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 500_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
    });

    const deps = buildMembersDeps(tenant.ctx);
    const slug = `perf-${randomUUID().slice(0, 8)}`;
    const r = await createMember(
      {
        company_name: 'Perf Timeline Co',
        country: 'SE',
        plan_id: planId,
        plan_year: 2026,
        primary_contact: {
          first_name: 'Anna',
          last_name: 'Andersson',
          email: `${slug}@example.com`,
          preferred_language: 'sv' as const,
        },
      },
      { actorUserId: user.userId, requestId: `perf-seed-${slug}` },
      deps,
    );
    if (!r.ok) {
      throw new Error(`seed failed: ${JSON.stringify(r.error)}`);
    }
    memberId = r.value.memberId;

    // Bulk-insert SEED_EVENTS synthetic audit rows. Use BYPASSRLS owner
    // role via `db` (not tx) — the test helper is allowed to bypass
    // tenant scoping for seed setup. Rows still carry the tenant slug so
    // the runtime repo query (which DOES run under runInTenant) sees them.
    const rows = Array.from({ length: SEED_EVENTS }).map((_, i) => ({
      eventType: 'member_updated' as const,
      actorUserId: 'perf-seeder',
      summary: `synthetic perf ${i}`,
      requestId: `perf-${i}`,
      tenantId: tenant.ctx.slug,
      payload: { member_id: memberId, seq: i, fields_changed: ['notes'] },
      // Staggered timestamps so ORDER BY + cursor pagination are meaningful.
      timestamp: new Date(Date.now() - i * 1000),
    }));
    // Chunk inserts — postgres.js default param limit ~64k.
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db.insert(auditLog).values(rows.slice(i, i + CHUNK));
    }
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it(`p95 < ${P95_TARGET_MS}ms for first page (${PAGE_SIZE} of ${SEED_EVENTS} events)`, async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const samples: number[] = [];
    // Warm-up — let the planner cache the query + index pages.
    await timelineList(
      { memberId, limit: PAGE_SIZE },
      { actorUserId: user.userId, actorRole: 'admin', requestId: 'warmup' },
      tenant.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );

    for (let i = 0; i < RUN_COUNT; i++) {
      const t0 = performance.now();
      const r = await timelineList(
        { memberId, limit: PAGE_SIZE },
        {
          actorUserId: user.userId,
          actorRole: 'admin',
          requestId: `perf-${i}`,
        },
        tenant.ctx,
        { memberRepo: deps.memberRepo, timeline: deps.timeline },
      );
      const t1 = performance.now();
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.events.length).toBe(PAGE_SIZE);
        expect(r.value.total).toBeGreaterThanOrEqual(SEED_EVENTS);
      }
      samples.push(t1 - t0);
    }

    const p95 = percentile(samples, 95);
    const p50 = percentile(samples, 50);
    console.log(
      `  timeline perf @ ${SEED_EVENTS} events: p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms`,
    );
    expect(p95).toBeLessThan(P95_TARGET_MS);
  }, 60_000);
});
