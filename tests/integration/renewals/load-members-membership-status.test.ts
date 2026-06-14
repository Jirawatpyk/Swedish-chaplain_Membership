/**
 * F8 #4 lapsed-badge — `loadMembersMembershipStatus` live-Neon integration.
 *
 * Constitution v1.4.0 Principle I (Review-Gate blocker): proves the
 * members-directory batch read against REAL Postgres + RLS+FORCE:
 *
 *   (a) Positive control — returns exactly the lapsed members of the
 *       current tenant (terminal `lapsed`/`cancelled` past expiry per
 *       `isMembershipLapsed`); non-terminal + future-expiry rows are NOT
 *       flagged.
 *   (b) Cross-tenant negative control — tenant A's deps CANNOT see a
 *       tenant-B member id (the `findLatestCyclesForMembers` adapter
 *       wraps its DISTINCT-ON query in `runInTenant`, so RLS scopes the
 *       result to A). THIS is the Principle I cross-tenant probe.
 *   (c) Multi-cycle parity — for a member with ≥2 cycles whose
 *       `created_at` and `expires_at` deliberately disagree, the batch
 *       picks the SAME latest cycle as the single-member
 *       `loadMemberRenewalStatus` (proves the `created_at DESC` basis
 *       shared by both the DISTINCT-ON adapter and `list({ sort:
 *       'created_at_desc' })`).
 *   (d) Index usability — EXPLAIN proves the DISTINCT-ON query is
 *       SERVED by `renewal_cycles_member_recency_idx` (no full Seq
 *       Scan). The drop-guard (index exists + predicate) is asserted
 *       separately so a dropped/renamed index fails regardless of
 *       table-size planner cost.
 *
 * Harness mirrors `at-risk-bulk-write.test.ts` +
 * `cross-tenant-isolation.test.ts`: `createTwoTestTenants`,
 * `createActiveTestUser`, `seedF8MembershipPlan`, raw member + cycle
 * inserts via `runInTenant`, `makeRenewalsDeps(slug)`, owner-role
 * cleanup. All members are SIMULATED (fresh `randomUUID()` ids + dummy
 * company names) — no real PII is referenced.
 *
 * Seeding note: `renewal_cycles` carries the composite FK
 * `renewal_cycles_member_fk (tenant_id, member_id) → members ON DELETE
 * RESTRICT`, and `members` carries a composite FK to `membership_plans
 * (tenant_id, plan_id, plan_year)`. Cycles therefore CANNOT be inserted
 * against bare uuids — each fixture member needs a real `members` row
 * bound to a seeded plan first (cleanup is FK-ordered by the test-tenant
 * helper: scheduled_plan_changes → renewal_cycles → members → plans).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql as drizzleSql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import {
  loadMembersMembershipStatus,
  loadMemberRenewalStatus,
  makeRenewalsDeps,
} from '@/modules/renewals';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const INDEX_NAME = 'renewal_cycles_member_recency_idx';

/**
 * A single node in a Postgres `EXPLAIN (FORMAT JSON)` plan tree. Child nodes
 * live under `Plans` (absent on leaves). `Index Name` is present only on
 * index-driven scan nodes. Used by the EXPLAIN test (S6) to assert on the
 * EXACT index name driving the scan rather than a substring of the whole
 * stringified plan.
 */
interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Index Name'?: string;
  readonly Plans?: ReadonlyArray<PlanNode>;
}

/** Depth-first flatten of a plan tree into a flat node list (root included). */
function flattenPlan(root: PlanNode): PlanNode[] {
  const out: PlanNode[] = [root];
  for (const child of root.Plans ?? []) out.push(...flattenPlan(child));
  return out;
}

// Fixed instants. All "past" expiries sit before the wall clock the
// production `makeRenewalsDeps` binds (`clock: wallClock`), so a lapsed
// terminal cycle reads lapsed regardless of the run date. The lapse
// gate checks TERMINAL STATUS FIRST then expiry — so an `awaiting_payment`
// cycle (non-terminal) with a FUTURE expiry is never flagged, and a
// `lapsed`/`cancelled` cycle with a PAST expiry always is.
const NOW_PAST = '2026-01-01T00:00:00.000Z';
const NOW_FUTURE = '2027-01-01T00:00:00.000Z';
const PERIOD_FROM = '2025-01-01T00:00:00.000Z';

interface CycleSpec {
  readonly status: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly closedReason?: string;
}

/**
 * Insert a SIMULATED member (fresh uuid + dummy company) bound to the
 * seeded plan, then its renewal cycle(s). Runs inside the tenant's RLS
 * context so the FK lookups + inserts resolve under the right scope.
 */
async function seedMemberWithCycles(
  tenant: TestTenant,
  planId: string,
  memberId: string,
  cycles: ReadonlyArray<CycleSpec>,
): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Lapsed Badge Co ${memberId.slice(0, 6)}`,
      country: 'TH',
      planId,
      planYear: 2026,
    });
    for (const c of cycles) {
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: c.status,
        periodFrom: new Date(PERIOD_FROM),
        periodTo: new Date(c.expiresAt),
        // expires_at trigger denormalises from period_to; set explicitly
        // so the owner-role raw insert (no app trigger guarantee) matches.
        expiresAt: new Date(c.expiresAt),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        createdAt: new Date(c.createdAt),
        // Terminal cycles REQUIRE closed_at (DB CHECK: closed_at IS NULL
        // ↔ status non-terminal). Anchor it to created_at for the fixture.
        ...(c.closedReason
          ? { closedAt: new Date(c.createdAt), closedReason: c.closedReason }
          : {}),
      });
    }
  });
}

describe('loadMembersMembershipStatus (integration, live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;

  // SIMULATED member ids — never a real member row (memory constraint).
  const mLapsed = randomUUID(); // single lapsed terminal cycle, past expiry
  const mActive = randomUUID(); // awaiting_payment, future expiry → not lapsed
  const mNone = randomUUID(); // member with NO cycle → absent from result
  const mMulti = randomUUID(); // 2 cycles; latest (created_at) = lapsed
  const mTie = randomUUID(); // 2 cycles, EQUAL created_at → cycle_id DESC decides
  const bMember = randomUUID(); // tenant B lapsed member — A must NOT see it

  // mTie's two cycle ids, ordered so `cycleHi > cycleLo` lexicographically.
  // The cycle_id DESC tiebreak (S1 fix) must pick `cycleHi`; we assign the
  // LAPSED (terminal) cycle to `cycleHi` and the NON-terminal awaiting_payment
  // cycle to `cycleLo`, so the tiebreak choice flips the lapsed verdict. See
  // the `equal-created_at tiebreak` test below for the regression rationale.
  const [tieCycleLo, tieCycleHi] = [randomUUID(), randomUUID()].sort() as [
    string,
    string,
  ];

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    const planIdA = `f8-lapsed-${randomUUID().slice(0, 8)}`;
    const planIdB = `f8-lapsed-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId: planIdA,
        planName: { en: 'Lapsed Badge Plan A' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await runInTenant(tenantB.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantB.ctx.slug,
        planId: planIdB,
        planName: { en: 'Lapsed Badge Plan B' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    // mNone seeded as a member with ZERO cycles (FK-clean; no cycle row).
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: mNone,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Lapsed Badge No-Cycle Co',
        country: 'TH',
        planId: planIdA,
        planYear: 2026,
      });
    });

    await seedMemberWithCycles(tenantA, planIdA, mLapsed, [
      { status: 'lapsed', expiresAt: NOW_PAST, createdAt: NOW_PAST, closedReason: 'lapsed' },
    ]);
    await seedMemberWithCycles(tenantA, planIdA, mActive, [
      { status: 'awaiting_payment', expiresAt: NOW_FUTURE, createdAt: NOW_PAST },
    ]);
    // Multi-cycle: OLDER awaiting_payment (NON-terminal, future expiry,
    // NOT lapsed) + NEWER lapsed (terminal, past expiry). Exactly one
    // non-terminal cycle, so the `renewal_cycles_active_member_uniq`
    // partial unique (excludes terminal) is satisfied. `awaiting_payment`
    // (rather than `completed`) avoids the `completed → linked_invoice_id
    // NOT NULL` CHECK without seeding a full F4 invoice fixture.
    //
    // `created_at` and `expires_at` deliberately DISAGREE on which cycle
    // is "latest": the lapsed cycle has the LATER created_at (2026-02) but
    // the EARLIER expiry (2026-01); the awaiting_payment cycle has the
    // EARLIER created_at (2025-01) but the LATER expiry (2027). The
    // DISTINCT-ON / single-read both pick by created_at DESC → the lapsed
    // cycle wins. If either read keyed on expires_at instead, it would
    // pick the awaiting_payment cycle and mMulti would NOT be flagged —
    // so the parity assertion is load-bearing for the created_at basis.
    await seedMemberWithCycles(tenantA, planIdA, mMulti, [
      { status: 'awaiting_payment', expiresAt: NOW_FUTURE, createdAt: '2025-01-01T00:00:00.000Z' },
      { status: 'lapsed', expiresAt: NOW_PAST, createdAt: '2026-02-01T00:00:00.000Z', closedReason: 'lapsed' },
    ]);
    // Equal-created_at tie: BOTH cycles share the IDENTICAL created_at, so
    // `created_at DESC` alone cannot resolve the order — only the
    // `cycle_id DESC` tiebreak (the S1 fix) decides which cycle is "latest".
    // The LAPSED (terminal, past expiry) cycle is pinned to the LARGER
    // cycle_id (`tieCycleHi`); the NON-terminal awaiting_payment (future
    // expiry → never lapsed) cycle is pinned to the SMALLER (`tieCycleLo`).
    // With the tiebreak, both reads pick tieCycleHi → mTie reads lapsed.
    // Pinned cycle_ids (not random) so the assertion can name the EXACT
    // expected row, making the test fail deterministically if the tiebreak
    // were removed (see the dedicated test below). Inlined (not via
    // seedMemberWithCycles) because that helper mints random cycle_ids.
    const TIE_CREATED_AT = '2026-03-01T00:00:00.000Z';
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: mTie,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Lapsed Badge Tie Co',
        country: 'TH',
        planId: planIdA,
        planYear: 2026,
      });
      // Non-terminal cycle → smaller cycle_id, future expiry (never lapsed).
      await tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId: tieCycleLo,
        memberId: mTie,
        status: 'awaiting_payment',
        periodFrom: new Date(PERIOD_FROM),
        periodTo: new Date(NOW_FUTURE),
        expiresAt: new Date(NOW_FUTURE),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planIdA,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        createdAt: new Date(TIE_CREATED_AT),
      });
      // Terminal lapsed cycle → larger cycle_id, past expiry (IS lapsed).
      await tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId: tieCycleHi,
        memberId: mTie,
        status: 'lapsed',
        periodFrom: new Date(PERIOD_FROM),
        periodTo: new Date(NOW_PAST),
        expiresAt: new Date(NOW_PAST),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planIdA,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        createdAt: new Date(TIE_CREATED_AT),
        // Terminal cycles REQUIRE closed_at (DB CHECK). Anchor to created_at.
        closedAt: new Date(TIE_CREATED_AT),
        closedReason: 'lapsed',
      });
    });

    // Tenant B: a lapsed member that tenant A MUST NOT see.
    await seedMemberWithCycles(tenantB, planIdB, bMember, [
      { status: 'lapsed', expiresAt: NOW_PAST, createdAt: NOW_PAST, closedReason: 'lapsed' },
    ]);
  }, 120_000);

  afterAll(async () => {
    // Owner-role, FK-ordered cleanup (handled inside the helper). Guard
    // each so a single failure never leaves the OTHER tenant's fixtures
    // orphaned on live Neon.
    await tenantA?.cleanup().catch(() => {});
    await tenantB?.cleanup().catch(() => {});
  }, 120_000);

  it('positive control: returns exactly the lapsed members of tenant A', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const res = await loadMembersMembershipStatus(deps, {
      tenantId: tenantA.ctx.slug,
      memberIds: [mLapsed, mActive, mNone, mMulti],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // mLapsed (terminal lapsed, past expiry) + mMulti (latest cycle is
      // the lapsed one) are flagged. mActive (non-terminal) and mNone
      // (no cycle) are NOT.
      expect([...res.value].sort()).toEqual([mLapsed, mMulti].sort());
    }
  });

  it('cross-tenant negative control: tenant A cannot see tenant B lapsed members (Principle I)', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const res = await loadMembersMembershipStatus(deps, {
      tenantId: tenantA.ctx.slug,
      memberIds: [bMember],
    });
    expect(res.ok).toBe(true);
    // RLS hides B's cycle from A's `runInTenant` binding → empty Set
    // (NOT a leaked "lapsed" flag for a foreign member).
    if (res.ok) expect(res.value.size).toBe(0);

    // Defence in depth: tenant B's OWN binding still sees its lapsed
    // member — proves the empty result above is RLS isolation, not a
    // broken/empty seed.
    const depsB = makeRenewalsDeps(tenantB.ctx.slug);
    const resB = await loadMembersMembershipStatus(depsB, {
      tenantId: tenantB.ctx.slug,
      memberIds: [bMember],
    });
    expect(resB.ok).toBe(true);
    if (resB.ok) expect(resB.value.has(bMember)).toBe(true);
  });

  it('multi-cycle parity: batch picks the SAME latest cycle as loadMemberRenewalStatus (created_at DESC)', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const single = await loadMemberRenewalStatus(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: mMulti,
    });
    const batch = await loadMembersMembershipStatus(deps, {
      tenantId: tenantA.ctx.slug,
      memberIds: [mMulti],
    });
    expect(single.ok).toBe(true);
    expect(batch.ok).toBe(true);
    // Single-member read's latest cycle (sort: created_at_desc) is the
    // lapsed one → so the batch DISTINCT-ON must also resolve mMulti as
    // lapsed. Both agreeing proves they share the created_at DESC basis.
    if (single.ok) expect(single.value.cycle?.status).toBe('lapsed');
    if (batch.ok) expect(batch.value.has(mMulti)).toBe(true);
  });

  it('equal-created_at tiebreak: both reads pick the SAME cycle via cycle_id DESC (S1 regression guard)', async () => {
    // REGRESSION GUARD the `multi-cycle parity` test above LACKS: that test
    // gives its two cycles DISTINCT created_at (2025-01 vs 2026-02), so
    // `created_at DESC` alone resolves the order and removing the
    // `, cycle_id DESC` tiebreak from list() / findLatestCyclesForMembers
    // would NOT fail it. THIS test pins BOTH of mTie's cycles to an IDENTICAL
    // created_at, so `created_at DESC` is a tie and ONLY the `cycle_id DESC`
    // tiebreak decides the winner. The lapsed (terminal) cycle is the LARGER
    // cycle_id (tieCycleHi); the non-terminal awaiting_payment cycle is the
    // smaller. With the tiebreak both paths deterministically pick tieCycleHi
    // (lapsed). If the `, cycle_id DESC` tiebreak were removed from EITHER
    // path, Postgres would return the equal-created_at rows in an arbitrary,
    // index-/heap-order-dependent order — the single read could surface the
    // awaiting_payment cycle (status !== 'lapsed', cycleId !== tieCycleHi) and
    // the batch could omit mTie — so the strict assertions below fail. This is
    // the load-bearing, non-vacuous proof that both paths share the
    // `created_at DESC, cycle_id DESC` ordering.
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const single = await loadMemberRenewalStatus(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: mTie,
    });
    const batch = await loadMembersMembershipStatus(deps, {
      tenantId: tenantA.ctx.slug,
      memberIds: [mTie],
    });
    expect(single.ok).toBe(true);
    expect(batch.ok).toBe(true);
    // Single-read path (list → ORDER BY created_at DESC, cycle_id DESC LIMIT 1)
    // MUST resolve the EXACT larger-cycle_id lapsed row — naming the cycleId
    // makes the assertion fail (not silently pass) if the tiebreak is dropped.
    if (single.ok) {
      expect(single.value.cycle?.cycleId).toBe(tieCycleHi);
      expect(single.value.cycle?.status).toBe('lapsed');
    }
    // Batch DISTINCT-ON path MUST agree → mTie flagged lapsed. (If it picked
    // the awaiting_payment cycle instead, mTie would be absent from the Set.)
    if (batch.ok) expect(batch.value.has(mTie)).toBe(true);
  });

  it('index drop-guard: renewal_cycles_member_recency_idx exists with the expected predicate', async () => {
    const rows = await db.execute<{ indexname: string; indexdef: string }>(
      drizzleSql`
        SELECT indexname, indexdef
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'renewal_cycles'
           AND indexname = ${INDEX_NAME}
      `,
    );
    expect(rows.length).toBe(1);
    const def = rows[0]!.indexdef;
    // (tenant_id, member_id, created_at DESC) btree on renewal_cycles —
    // case-insensitive substring checks (Postgres normalises whitespace).
    expect(def).toMatch(/renewal_cycles/i);
    expect(def).toMatch(/tenant_id/i);
    expect(def).toMatch(/member_id/i);
    expect(def).toMatch(/created_at/i);
    // S4 — the recency SORT DIRECTION is load-bearing: `loadMemberRenewalStatus`
    // and the batch DISTINCT-ON both pick "latest" by created_at DESC, so an
    // index re-emitted ASC (or with the direction dropped) would no longer serve
    // the production ORDER BY and silently degrade to a Sort. Assert DESC is
    // pinned on created_at (Postgres prints `created_at DESC` in indexdef).
    expect(def).toMatch(/created_at\s+DESC/i);
  });

  it('EXPLAIN: the batch DISTINCT-ON query is served by the recency index — no full Seq Scan', async () => {
    // The production query (`findLatestCyclesForMembers`) is:
    //   SELECT DISTINCT ON (member_id) * FROM renewal_cycles
    //    WHERE member_id = ANY($1::uuid[])
    //    ORDER BY member_id, created_at DESC, cycle_id DESC
    // NOTE: the real adapter omits an explicit `tenant_id = $1` predicate —
    // tenant scope is enforced by the RLS+FORCE policy (SET LOCAL
    // app.current_tenant) inside runInTenant, not a WHERE clause. The raw
    // EXPLAIN probe below adds tenant_id to its own predicate only so it can
    // run OUTSIDE a runInTenant scope against the live table; the planner
    // shape it exercises (recency index, no full Seq Scan) is the one the
    // RLS-scoped production query gets.
    // At seed scale the table is tiny, so the COST-based planner may
    // legitimately prefer a Seq Scan + Sort (cheaper for a handful of
    // rows) — asserting planner *preference* would flake. Instead we
    // prove the index can SERVE the query (right columns + ordering) by
    // forcing index preference with `SET LOCAL enable_seqscan = off`
    // inside one transaction, then asserting the plan cites the recency
    // index as an Index Scan and is not a full Seq Scan. This is the
    // honest acceptance evidence for the recency index regardless of
    // table-size cost flukes; the drop-guard test above covers the
    // "index removed" regression.
    const ids = [mLapsed, mActive, mMulti];
    const idsArray = drizzleSql.raw(
      `ARRAY[${ids.map((id) => `'${id}'`).join(',')}]::uuid[]`,
    );
    const slug = tenantA.ctx.slug;

    const planRoot = await db.transaction(async (tx) => {
      await tx.execute(drizzleSql`SET LOCAL enable_seqscan = off`);
      const planRows = await tx.execute<{
        'QUERY PLAN': Array<{ Plan: PlanNode }>;
      }>(drizzleSql`
        EXPLAIN (FORMAT JSON)
        SELECT DISTINCT ON (member_id) *
          FROM renewal_cycles
         WHERE tenant_id = ${slug}
           AND member_id = ANY(${idsArray})
         ORDER BY member_id, created_at DESC, cycle_id DESC
      `);
      return planRows[0]!['QUERY PLAN'][0]!.Plan;
    });

    // S6 — walk the plan tree (the DISTINCT-ON / forced-index plan nests the
    // scan under a Unique node) and collect every node so we can assert on the
    // EXACT Index Name, not a substring of the whole stringified plan. The
    // old substring check would also pass if the index name merely appeared in
    // a Filter expression or some other field — the parsed-node check pins that
    // the recency index is the one DRIVING an Index Scan.
    const nodes = flattenPlan(planRoot);

    // The recency index is named by an Index-Scan node — i.e. it SERVES the
    // query (exact-equality match on the node's `Index Name`, not a substring).
    const indexScanNames = nodes
      .filter((n) => /Index Scan/i.test(n['Node Type']))
      .map((n) => n['Index Name']);
    expect(indexScanNames).toContain(INDEX_NAME);

    // No full sequential scan of renewal_cycles when the index is available
    // (forced-index plan above is an Index Scan, not Seq Scan).
    expect(nodes.some((n) => n['Node Type'] === 'Seq Scan')).toBe(false);
  });
});
