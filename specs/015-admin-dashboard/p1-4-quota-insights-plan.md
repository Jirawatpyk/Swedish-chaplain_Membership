# P1-4 — FR-004 Quota Insights (cross-member aggregate) — Implementation Plan

**Status:** in progress · **Branch:** `018-f9-quota-insights` (from `main` / F9) · **Spec Kit:** not required (focused task on the existing F9 `015-admin-dashboard` spec, FR-004).

## Problem

The F9 admin dashboard is meant to surface THREE `topInsights` but only one is computed:

- `at_risk_followup` ✅ (reference implementation)
- `unused_eblast_quota` ❌ never built
- `underused_event_tickets` ❌ never built

The two missing cards need a **cross-member aggregate** (every active member's entitlement vs consumption, rolled up). The source ports today are per-member; `compute-dashboard-snapshot.ts` defers this ("US4 benefit-usage aggregate" markers ~lines 14-15, 104-105, 125) and hardcodes `underDeliveredBenefitCount = 0`.

## Chosen approach — **C-hybrid** (3 fixed queries regardless of member count)

Rejected alternatives:
- **A (N+1 loop):** ~270-400 round-trips at 131 members (OK now) but ~10k+ at a 5k-member tenant → blows the 60s cron `COMPUTE_TARGET_MS`; needs a size-guard = tech debt.
- **B (barrel aggregate exports):** requires new public exports on the shipped broadcasts (F7) + events (F6) barrels → widens blast radius (ESLint guards, contract tests, F6/F7 review).

**C keeps all new SQL inside `src/modules/insights/infrastructure/`:**
1. ONE paginated member-enumeration scan (active-only) → `MemberPlanRef[]` (memberId, planId, planYear), reusing the members barrel `directorySearchWithCount` pagination pattern.
2. ONE batched broadcasts `GROUP BY requestedByMemberId` (filter must match `drizzle-broadcasts-repo.ts` quota counter: `status='sent' AND quotaYearConsumed=$year AND tenantId=$tid`) → `Map<memberId, sentCount>`.
3. ONE batched events `GROUP BY matchedMemberId` (filter must match `drizzle-event-attendees-by-member.ts`: `isCulturalEvent=true AND startDate ∈ [yearStart, min(yearEnd, now)) AND piiPseudonymisedAt IS NULL AND archivedAt IS NULL`) → `Map<memberId, attendedCount>`.
4. ≤9 memoized plan-entitlement reads via the existing `planSourceAdapter.getEntitlements` escape-hatch.
5. A pure-domain roll-up join in `quota-underuse.ts`.

No migration. No new npm deps. No F6/F7 barrel changes. Both GROUP BY queries run inside `runInTenant(ctx, tx)` → RLS+FORCE (Principle I) applies automatically.

## Decisions (locked by product owner, 2026-06-01)

- **Threshold rule = "any shortfall":** a member counts for a benefit when `entitlement > 0 AND used < entitlement` (ratio < 1). Distinct from US4 (FR-021) which uses the 25pt-gap mean-of-ratios — intentionally different (card = "has unused quota"; member view = "statistically behind pace"). Documented in `quota-underuse.ts`.
- **`underDeliveredBenefitCount` = UNION:** count of members under-using EITHER benefit (de-duped Set).
- **Timing = pre-launch:** ship on this branch so F9 is complete before go-live.

## TDD phases

1. **Domain** (red→green, zero framework): `quota-underuse.ts` + unit test (entitlement=0 excluded; used<ent counted; used==ent / used>ent not; absent→0; union de-dup; empty→zeros). 100% line.
2. **Application ports** (pure interfaces): `MemberPlanRef`, `MemberEnumerationSource.listActiveWithPlan(ctx)`, `BenefitConsumptionAggregateSource.{eblastUsedByMember,culturalUsedByMember}(ctx, year)`, `planKey(planId, planYear)`. Absent map key = 0; fail-loud on query error.
3. **Infrastructure adapters** (new SQL in F9 infra, red→green unit): `member-enumeration-adapter.ts` (active-only, pageSize=100 clamp, members barrel only) + `benefit-consumption-aggregate-adapter.ts` (2 GROUP BY inside `runInTenant`, schema imports only — no broadcasts/events application/domain imports).
4. **Use-case wiring:** widen `ComputeDashboardSnapshotDeps`; replace the 3 deferral markers; enumerate → parallel aggregate fetch → memoized entitlements → `countUnderUsedQuota` → push `unused_eblast_quota` / `underused_event_tickets` to candidates when count>0 (mirror at_risk ternary) → set `underDeliveredBenefitCount`. Wire deps in `insights-deps.ts`. `typecheck`.
5. **Integration (live Neon):** `quota-insights-snapshot.test.ts` (seed 2 plans incl entitlement=0; 5 members across counted/not/prior-year) + **equivalence assertion** (batched GROUP BY == per-member `computeQuotaCounter` for one member) + extend `cross-tenant-isolation.test.ts` (Principle I blocker: tenant B rows contribute 0 to tenant A) + update `dashboard-snapshot.test.ts` 0-stub comment + `dashboard-perf.test.ts` 5k stays <60s.
6. **Contract + gates:** boundary contract test (adapters import only allowed paths) + `lint` + `check:i18n` + `check:multi-tenant` + `test:coverage` + `test:integration` → commit `[Spec Kit] feat(F9): FR-004 quota insights`.

## Acceptance (FR-004)

AC1 `unused_eblast_quota` count = active members with eblast used < entitlement (ent>0), current membership year (tenant TZ). AC2 same for `underused_event_tickets`. AC3 `underDeliveredBenefitCount` = union, not hardcoded 0. AC4 count=0 key not emitted. AC5 per-key dismissal per membership_year cycle. AC6 entitlement=0 excluded. AC7 prior-year excluded (SQL year scoping). AC8 archived/inactive excluded. AC9 any DB error → `err('compute_failed')`, never false-zero. + Principle I cross-tenant test. + perf 5k < 60s.

## Key risks

- **SQL filter drift** between batched GROUP BY and per-member adapters → mitigated by the equivalence integration assertion.
- **`isCulturalEvent` semantics:** the per-member adapter treats both `cultural` + `partnership_and_cultural` as cultural (both have `isCulturalEvent=true`); the GROUP BY filters `isCulturalEvent=true` alone — pinned by the equivalence test.
- **Threshold divergence** FR-004 (any shortfall) vs FR-021 US4 (25pt-gap) is intentional — comment the spec refs.

## Source

Plan produced by the `plan-p1-4-quota-insights` Understand→Design workflow (2026-06-01): 5 readers + 3 approach designers + architect synthesis, grounded in the actual insights/broadcasts/events code.
