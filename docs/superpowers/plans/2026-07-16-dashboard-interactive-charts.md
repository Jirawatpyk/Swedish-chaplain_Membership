# Dashboard Interactive Charts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add interactive (hover-tooltip) charts to the admin dashboard — migrate the two SVG sparklines to Recharts, and add a Membership-by-Tier horizontal bar + an Invoice-Status donut — with data computed in the snapshot cron and no a11y/perf regression.

**Architecture:** The two new aggregates are folded into the existing cached `DashboardSnapshot` (computed by the ~5-min cron, read via `listDashboard`) — reusing the `activeMembers` array (tier) and the invoice adapter's existing pagination pass (status). The four charts are `'use client'` components fed by server props, each rendering an `aria-hidden` Recharts canvas lazily (`next/dynamic ssr:false`) over a **server-rendered hidden data table** that is the sole a11y path.

**Tech Stack:** Next.js 16 App Router · React 19 · Recharts (NEW dep, pinned major) via shadcn/ui `chart` · Drizzle/Neon · next-intl · Vitest + Playwright/axe.

**Design doc:** `docs/superpowers/specs/2026-07-16-dashboard-interactive-charts-design.md` (revised after 4-agent review).

## Global Constraints

- **Constitution X (new dep):** `recharts` is a new dependency → a `plan.md` § Complexity Tracking entry is required (below). Pin the recharts **major** version (a11y contract differs 2.x↔3.x).
- **Constitution I (tenant isolation):** every DB read threads `tx` from `runInTenant`; never the global `db`. New aggregates run inside the snapshot cron's tenant context.
- **Constitution III (Clean Arch):** insights reads go through source PORTS → module barrels; no deep/foreign-table imports. Domain has zero framework imports.
- **A11y:** every chart is `aria-hidden` + `accessibilityLayer={false}`; the server-rendered hidden `<table>` is the sole SR path. axe gate is a hard blocker.
- **Perf:** chart canvas via `next/dynamic(() => import(...), { ssr:false })`; NEVER import a chart / `ui/chart.tsx` from a shared layout/sidebar/palette. Add a measured `/admin` bundle-budget entry.
- **Money:** satang bigint carried as decimal STRING in JSON; net-of-credit.
- **Timestamps:** overdue via F4 `computeIsOverdue` (Asia/Bangkok, strict `>`); never SQL `due_date < CURRENT_DATE`.
- **i18n:** EN canonical + TH + SV; `check:i18n` passes.
- **No prettier** (repo has no prettier gate; hand-format to ~80 col).

## Complexity Tracking (Constitution X)

| Principle | Deviation | Simpler alternative rejected | Why rejected |
|-----------|-----------|------------------------------|--------------|
| X — Simplicity / zero-new-deps | Add `recharts` (+shadcn `chart`) | (a) hand-roll SVG tooltips on the existing charts; (b) add recharts only for the 2 new charts, keep SVG sparklines | (a) a donut (arc math + centre label + legend + hover slices) and a tooltip layer consistent across 4 charts is disproportionate custom work; (b) the user chose a single consistent charting layer with interactive tooltips on all four. The donut/bar is the load-bearing justification; sparkline migration is bundled per the user's decision, with all existing annotations preserved. |

---

## File Structure

**Domain / application (data):**
- Modify `src/modules/insights/domain/dashboard-snapshot.ts` — add `TierDistributionSlice`, `InvoiceStatusBucket`, the two snapshot fields + `emptySnapshot` defaults.
- Create `src/modules/insights/domain/tier-distribution.ts` — pure `groupActiveMembersByTier(...)`.
- Modify `src/modules/insights/application/ports/source-ports.ts` — extend `PlanSource` (label) + `InvoiceSource` (`getInvoiceStatusDistribution`).
- Modify `src/modules/insights/application/use-cases/compute-dashboard-snapshot.ts` — compute both aggregates into the snapshot.
- Modify `src/modules/insights/infrastructure/sources/invoice-source-adapter.ts` — status buckets in the existing pass (uses `computeIsOverdue`).
- Modify `src/modules/insights/infrastructure/sources/plan-source-adapter.ts` — return the plan/tier label.
- Modify the snapshot repo (`.../infrastructure/**/drizzle-snapshot-repo.ts`) read path — defensive default for the 2 new fields on old rows.

**Charting infra:**
- `package.json` — add `recharts` (pinned major).
- Create `src/components/ui/chart.tsx` — shadcn chart wrapper.
- Modify `scripts/check-bundle-budgets.ts` — add measured `/admin` entry.

**Chart components (presentation):**
- Create `src/components/dashboard/chart-data-table.tsx` — shared visually-hidden data table.
- Modify/replace `src/components/dashboard/_mini-series-chart.tsx` + `member-growth-chart.tsx` + `revenue-trend-chart.tsx` — Recharts line, annotations preserved.
- Create `src/components/dashboard/membership-tier-chart.tsx` — horizontal bar.
- Create `src/components/dashboard/invoice-status-chart.tsx` — donut.
- Modify `src/app/(staff)/admin/(home)/page.tsx` — Trends + Breakdown sections, dynamic import, empty states.
- Modify `src/app/(staff)/admin/(home)/loading.tsx` — skeletons for the new charts.

**i18n / tests:** `src/i18n/messages/{en,th,sv}.json`; unit/integration/component/e2e as per each task.

---

## Task 1: Extend the `DashboardSnapshot` domain type

**Files:**
- Modify: `src/modules/insights/domain/dashboard-snapshot.ts`
- Test: `tests/unit/insights/domain/dashboard-snapshot-empty.test.ts` (extend if exists)

**Interfaces — Produces:**
```ts
export interface TierDistributionSlice {
  readonly tierKey: string;   // plan slug, or 'unassigned'
  readonly label: string;     // display label ('unassigned' → a translatable sentinel key handled in presentation)
  readonly count: number;
}
export interface InvoiceStatusBucket {
  readonly bucket: 'paid' | 'unpaid' | 'overdue';
  readonly satang: string;    // net/outstanding amount, decimal string
  readonly count: number;
}
export interface InvoiceStatusDistribution {
  readonly buckets: readonly InvoiceStatusBucket[];
  readonly draftCount: number;
}
// added to DashboardSnapshot:
readonly tierDistribution: readonly TierDistributionSlice[];
readonly invoiceStatus: InvoiceStatusDistribution;
```

- [ ] **Step 1:** Write a failing test asserting `emptySnapshot('t')` has `tierDistribution: []` and `invoiceStatus: { buckets: [], draftCount: 0 }`.
- [ ] **Step 2:** Run it → FAIL (fields don't exist).
- [ ] **Step 3:** Add the three interfaces + the two `DashboardSnapshot` fields + the `emptySnapshot` defaults shown above.
- [ ] **Step 4:** Run → PASS; `pnpm typecheck` (this will surface every construction site of `DashboardSnapshot` — Task 5 + the repo read path + any fixture — that now needs the fields; note them).
- [ ] **Step 5:** Commit `feat(insights): add tierDistribution + invoiceStatus to DashboardSnapshot`.

## Task 2: `PlanSource` label + `InvoiceSource.getInvoiceStatusDistribution` port

**Files:**
- Modify: `src/modules/insights/application/ports/source-ports.ts`
- Test: none (type-only contract; exercised by Tasks 3–5 tests).

**Interfaces — Produces:**
```ts
// PlanSource — add:
getPlanLabel(ctx: TenantContext, planId: string, planYear: number): Promise<string | null>;

// InvoiceSource — add (return shape mirrors the domain type, bigint here):
getInvoiceStatusDistribution(
  ctx: TenantContext,
  nowIso: string,
): Promise<{
  readonly buckets: ReadonlyArray<{ bucket: 'paid'|'unpaid'|'overdue'; satang: bigint; count: number }>;
  readonly draftCount: number;
}>;
```

- [ ] **Step 1:** Add the two methods to the port interfaces with the doc-comments above (label: null when plan/year unresolved; status: net-of-credit, overdue via `computeIsOverdue`).
- [ ] **Step 2:** `pnpm typecheck` → the two adapters + any test doubles now fail to satisfy the port (expected; Tasks 4/adapter fix them).
- [ ] **Step 3:** Commit `feat(insights): port methods for tier label + invoice-status distribution`.

## Task 3: Pure tier grouping (`groupActiveMembersByTier`)

**Files:**
- Create: `src/modules/insights/domain/tier-distribution.ts`
- Test: `tests/unit/insights/domain/tier-distribution.test.ts`

**Interfaces:**
- Consumes: `MemberPlanRef[]` (`{ planId, planYear }`), a `(planId) => label|null` resolver.
- Produces: `groupActiveMembersByTier(members, labelOf): TierDistributionSlice[]`.

```ts
import type { MemberPlanRef } from './quota-underuse';
import type { TierDistributionSlice } from './dashboard-snapshot';

export const UNASSIGNED_TIER_KEY = 'unassigned';

/** GROUP active members by plan slug (plan year collapsed). A member whose plan
 * label can't resolve goes to `unassigned`, so the slices SUM to the active
 * count (the bars must never silently drop a member). Sorted count desc, then
 * label asc; `unassigned` is forced last. */
export function groupActiveMembersByTier(
  members: readonly MemberPlanRef[],
  labelOf: (planId: string) => string | null,
): TierDistributionSlice[] {
  const byKey = new Map<string, { label: string; count: number }>();
  for (const m of members) {
    const label = labelOf(m.planId);
    const key = label === null ? UNASSIGNED_TIER_KEY : m.planId;
    const entry = byKey.get(key) ?? { label: label ?? UNASSIGNED_TIER_KEY, count: 0 };
    entry.count += 1;
    byKey.set(key, entry);
  }
  return [...byKey.entries()]
    .map(([tierKey, v]) => ({ tierKey, label: v.label, count: v.count }))
    .sort((a, b) => {
      if (a.tierKey === UNASSIGNED_TIER_KEY) return 1;
      if (b.tierKey === UNASSIGNED_TIER_KEY) return -1;
      return b.count - a.count || a.label.localeCompare(b.label);
    });
}
```

- [ ] **Step 1:** Write failing tests: (a) two members same plan → one slice count 2; (b) unresolved plan → `unassigned` bucket, sum == member count; (c) sort desc + `unassigned` last; (d) empty input → `[]`.
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3:** Implement the module above.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(insights): pure groupActiveMembersByTier (unassigned bucket, sorted)`.

## Task 4: Invoice-status distribution in the adapter (net-of-credit, Bangkok overdue)

**Files:**
- Modify: `src/modules/insights/infrastructure/sources/invoice-source-adapter.ts`
- Test: `tests/integration/insights/invoice-status-distribution.integration.test.ts` (live Neon)

**Interfaces:**
- Consumes: the invoicing barrel's invoice list (the same the adapter already paginates for `countOverdue`/revenue) + F4 `computeIsOverdue`.
- Produces: `getInvoiceStatusDistribution(ctx, nowIso)` (Task 2 shape).

**Rules (from design):**
- `paid` = `status === 'paid'` → **net paid** amount (mirror `netPaidRevenueSatang`).
- `unpaid` = `status === 'issued'` AND NOT `computeIsOverdue` → **outstanding** amount.
- `overdue` = `status === 'issued'` AND `computeIsOverdue(inv, nowIso)` → outstanding amount.
- `partially_credited` → fold into unpaid/overdue by its due date at its **net** balance.
- Excluded from totals: `draft` (counted into `draftCount`), `void`, fully `credited`.

- [ ] **Step 1:** Write a failing live-Neon test that seeds (in one tenant): a paid invoice, an issued invoice due in the future, an issued invoice past due, a draft, a void → assert the three bucket amounts + counts + `draftCount`. **Add a tz-boundary case**: an invoice `due_date = today` with `now` at 00:30 Asia/Bangkok while UTC is still the prior day → asserts it is NOT overdue (uses `computeIsOverdue`, not SQL date). **Add an equivalence assertion**: the `overdue` bucket count `===` `countOverdue(ctx)`.
- [ ] **Step 2:** Run → FAIL (method missing).
- [ ] **Step 3:** Implement `getInvoiceStatusDistribution`: reuse the adapter's existing pagination over the tenant's invoices (thread `tx`/ctx exactly as `countOverdue` does — see the adapter's cron-only paginate note), bucket each row per the rules, sum net amounts. Reuse `computeIsOverdue` from the invoicing barrel (do NOT re-implement the date rule).
- [ ] **Step 4:** Run the integration test → PASS. `pnpm typecheck`.
- [ ] **Step 5:** Commit `feat(insights): invoice-status distribution (net-of-credit, Bangkok overdue)`.

## Task 5: `plan-source-adapter` label + wire both aggregates into the snapshot

**Files:**
- Modify: `src/modules/insights/infrastructure/sources/plan-source-adapter.ts` (implement `getPlanLabel` via the F2 plan barrel — the plan entity's display name/tier)
- Modify: `src/modules/insights/application/use-cases/compute-dashboard-snapshot.ts`
- Test: `tests/unit/insights/compute-dashboard-snapshot-charts.test.ts` (mock deps) + extend the existing snapshot integration test.

**Interfaces:**
- Consumes: `activeMembers` (already loaded at `:119`), `planSource.getPlanLabel`, `invoiceSource.getInvoiceStatusDistribution`, `groupActiveMembersByTier`.
- Produces: `DashboardSnapshot.tierDistribution` + `.invoiceStatus`.

- [ ] **Step 1:** Write a failing unit test (mock deps like the existing snapshot test): active members across 2 plans + 1 unresolved → assert `snap.tierDistribution` matches `groupActiveMembersByTier`; and `snap.invoiceStatus` equals the mocked `getInvoiceStatusDistribution` mapped to string satang.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** In `computeDashboardSnapshot`: (a) resolve a `labelByPlanId` map inside the existing distinct-plan loop (add a `getPlanLabel` call alongside `getEntitlements`, memoized per planId); (b) `const tierDistribution = groupActiveMembersByTier(activeMembers, (id) => labelByPlanId.get(id) ?? null)`; (c) add `invoiceStatus` to the `Promise.all` batch: `deps.invoiceSource.getInvoiceStatusDistribution(ctx, now.toISOString())`, then map its bigint `satang` → string; (d) add both to the `snap` object literal.
- [ ] **Step 4:** Implement `getPlanLabel` in `plan-source-adapter` (return the plan's display name; null when not found — same null semantics as `getEntitlements`).
- [ ] **Step 5:** Run unit + the snapshot integration test → PASS. `pnpm typecheck`.
- [ ] **Step 6:** Commit `feat(insights): compute tier + invoice-status into the dashboard snapshot`.

## Task 6: Snapshot read-path defensive default

**Files:**
- Modify: the drizzle snapshot repo read/parse (`src/modules/insights/infrastructure/**/drizzle-snapshot-repo.ts`)
- Test: `tests/unit/insights/snapshot-repo-legacy-row.test.ts`

- [ ] **Step 1:** Write a failing test: parse a stored snapshot JSON **missing** `tierDistribution`/`invoiceStatus` (a pre-deploy row) → the read returns `tierDistribution: []` + `invoiceStatus: { buckets: [], draftCount: 0 }`, not `undefined`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** In the repo read path, default the two fields when absent (`?? []` / `?? { buckets: [], draftCount: 0 }`). Keep it a pure mapping (no zod change unless the repo already validates — then extend the schema with `.default(...)`).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `fix(insights): default new snapshot chart fields for legacy cached rows`.

## Task 7: Install recharts + shadcn `chart` + `/admin` bundle budget

**Files:**
- Modify: `package.json` / `pnpm-lock.yaml`
- Create: `src/components/ui/chart.tsx`
- Modify: `scripts/check-bundle-budgets.ts`

- [ ] **Step 1:** `pnpm add recharts@<pin major, e.g. ^2 or ^3 — pick and pin>` (decide the major; document the a11y contract it implies). Add the shadcn `chart` component (`ui/chart.tsx`) — the standard `ChartContainer` / `ChartTooltip` / `ChartTooltipContent` / `ChartConfig`.
- [ ] **Step 2:** `pnpm build`; read `firstLoadUncompressedJsBytes` for `/admin` from `.next/diagnostics/route-bundle-stats.json` (BEFORE any chart is added — baseline) and again after Task 12; record both in this plan.
- [ ] **Step 3:** Add `{ route: '/admin', maxKb: <ceil(measured/10)*10 + 100> }` to `BUDGETS[]` in `check-bundle-budgets.ts` (re-baseline rule per the file). Run `pnpm check:bundle-budgets` → PASS.
- [ ] **Step 4:** Commit `chore(deps): add recharts + shadcn chart + /admin bundle budget`.

## Task 8: Shared hidden data-table component

**Files:**
- Create: `src/components/dashboard/chart-data-table.tsx`
- Test: `tests/unit/dashboard/chart-data-table.test.tsx`

- [ ] **Step 1:** Failing test: given columns + rows, renders a `<table>` with a `sr-only`/visually-hidden wrapper, a `<caption>`, headers, and a row per datum; verify it is present in the DOM (this is the a11y contract, SSR-safe — no `useEffect` gate).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement a small server-safe `<ChartDataTable caption columns rows />` (visually-hidden, `aria-hidden` NOT set — it IS the a11y content). No `'use client'`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(dashboard): shared visually-hidden chart data table`.

## Task 9: Migrate the two sparklines to Recharts (preserve annotations)

**Files:**
- Modify: `src/components/dashboard/_mini-series-chart.tsx` (swap the inner `<svg>` for a Recharts `<LineChart>`; **keep** the summary stat, delta chip, sparse hint, first/last labels, max reference, empty state) — mark it `'use client'` and `aria-hidden` the Recharts canvas, render `<ChartDataTable>` alongside.
- Modify: `member-growth-chart.tsx` / `revenue-trend-chart.tsx` if their prop plumbing changes.
- Test: `tests/unit/dashboard/mini-series-chart.test.tsx` (extend)

- [ ] **Step 1:** Failing test: renders with a series → the hidden table has a row per month; the summary stat + delta chip + first/last labels still render (assert by text, not SVG); empty series → empty-state text; single-point series → no crash (Recharts fixes the old polyline bug).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Replace the SVG internals with `<ChartContainer><LineChart accessibilityLayer={false} …><Line isAnimationActive={reduceMotion ? false : …} /><ChartTooltip …/></LineChart></ChartContainer>` wrapped in an `aria-hidden` element; keep all surrounding annotation JSX; render `<ChartDataTable>` for the a11y path. Gate `isAnimationActive` off by default (SSR-safe reduced-motion).
- [ ] **Step 4:** Run → PASS. `pnpm typecheck`.
- [ ] **Step 5:** Commit `feat(dashboard): Recharts line sparklines (annotations + a11y table preserved)`.

## Task 10: Membership-by-Tier horizontal bar

**Files:**
- Create: `src/components/dashboard/membership-tier-chart.tsx` (`'use client'`)
- Test: `tests/unit/dashboard/membership-tier-chart.test.tsx`

- [ ] **Step 1:** Failing test: given `tierDistribution` slices → hidden table has tier→count,% rows + a total; `unassigned` label maps to a translated sentinel; empty → empty-state text.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `<BarChart layout="vertical" accessibilityLayer={false}>` single-colour (`--chart-1`), sorted (already sorted by Task 3), count+% end-labels, `aria-hidden` canvas + `<ChartDataTable>`; empty state.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(dashboard): membership-by-tier horizontal bar`.

## Task 11: Invoice-Status donut

**Files:**
- Create: `src/components/dashboard/invoice-status-chart.tsx` (`'use client'`)
- Test: `tests/unit/dashboard/invoice-status-chart.test.tsx`

- [ ] **Step 1:** Failing test: given buckets + draftCount → hidden table bucket→THB,count,% + total; **centre total + draft caption render as real DOM text**; semantic colours applied but each slice has a text label; empty (all-draft/none) → empty-state text.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `<PieChart><Pie innerRadius=… (donut) accessibilityLayer={false}>` with per-bucket semantic fills (success/warning/destructive) + a 2px slice gap + stroke ≥3:1; centre total + draftCount as DOM (not SVG `<Label>`); `aria-hidden` canvas + `<ChartDataTable>` (with %); title "Receivables by value". Run `validate_palette` on the trio (a check step, not code).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(dashboard): invoice-status donut (net receivables, real-DOM total)`.

## Task 12: Wire charts into the page + sections + dynamic + loading + empty

**Files:**
- Modify: `src/app/(staff)/admin/(home)/page.tsx`
- Modify: `src/app/(staff)/admin/(home)/loading.tsx`
- Test: covered by E2E (Task 14) + the component tests; add a render test for the page's chart section if feasible.

- [ ] **Step 1:** In `page.tsx`, read `tierDistribution` + `invoiceStatus` from the snapshot (already fetched via `listDashboard`). Import the 4 chart components via `next/dynamic(() => import('...'), { ssr:false, loading: () => <ChartSkeleton/> })`. Group into `<section aria-label={t('trendsSection')}>` (2 lines) and `<section aria-label={t('breakdownSection')}>` (bar + donut). Ensure each `dynamic` placeholder + card has a server-rendered **definite height** matching the chart (CLS).
- [ ] **Step 2:** In `loading.tsx`, add shimmer skeletons matching the bar + donut card shapes (definite height).
- [ ] **Step 3:** Verify empty states render when the snapshot fields are empty (fresh tenant / all-draft).
- [ ] **Step 4:** `pnpm typecheck` + `pnpm check:layout`.
- [ ] **Step 5:** Commit `feat(dashboard): mount charts (dynamic ssr:false) in Trends + Breakdown sections`.

## Task 13: i18n keys (EN/TH/SV)

**Files:**
- Modify: `src/i18n/messages/{en,th,sv}.json`
- Test: `pnpm check:i18n`

- [ ] **Step 1:** Add keys: chart titles (incl. "Receivables by value"), tooltip/axis labels, status labels (paid/unpaid/overdue), `unassigned` tier sentinel, "members"/"invoices", section labels, empty-state text — EN canonical.
- [ ] **Step 2:** Add TH + SV translations.
- [ ] **Step 3:** `pnpm check:i18n` → PASS.
- [ ] **Step 4:** Commit `i18n(dashboard): chart labels for EN/TH/SV`.

## Task 14: E2E axe (interaction-level) + reduced-motion + bundle re-measure

**Files:**
- Create/modify: `tests/e2e/*dashboard*charts*.spec.ts`
- Verify: `pnpm build` + re-measure `/admin` first-load; `pnpm check:bundle-budgets`.

- [ ] **Step 1:** Playwright a11y spec on `/admin/dashboard`: scan static, THEN **hover/focus each chart** and re-scan (tooltip popover), assert no new axe violations; assert the hidden tables are present; a `prefers-reduced-motion` run asserts no animation.
- [ ] **Step 2:** Run `pnpm test:e2e --workers=1 --grep "@a11y"` → PASS. (Manual SR pass — VoiceOver/NVDA — is a checklist item in the PR, not automatable.)
- [ ] **Step 3:** `pnpm build`; confirm the measured `/admin` first-load fits the Task 7 budget; adjust the budget number to the real post-implementation measurement; `pnpm check:bundle-budgets` → PASS.
- [ ] **Step 4:** Commit `test(dashboard): interaction-level axe + reduced-motion + bundle re-baseline`.

---

## Self-Review

- **Spec coverage:** tier→bar (T3,T10), invoice donut net/overdue (T4,T11), snapshot-cron compute (T5), computeIsOverdue reuse (T4), a11y model (T8–T11), bundle budget + dynamic (T7,T12,T14), CLS/loading (T12), i18n (T13), empty states (T10–T12), month-bar untouched (not in scope). Covered.
- **Type consistency:** `TierDistributionSlice`/`InvoiceStatusBucket`/`InvoiceStatusDistribution` defined in T1, produced by T3/T4/T5, consumed by T10/T11. `getPlanLabel`/`getInvoiceStatusDistribution` defined T2, implemented T4/T5. Consistent.
- **Deferred/measured:** recharts major pin (T7 — implementer picks + documents), the exact `/admin` budget number (measured T7/T14), plan-label i18n-vs-stored (resolve in T5/T13). These are measure-then-fill, not vague placeholders.
- **Risks:** the sparkline migration is the highest-regression task (T9) — its test pins the preserved annotations. The bundle budget is currently unenforced (T7 makes it real before any chart ships).

## Execution Handoff

Plan complete. Two execution options:
1. **Subagent-Driven (recommended)** — fresh subagent per task + two-stage review.
2. **Inline Execution** — batch with checkpoints.

---

## Task 15: KPI card count-up animation (added mid-execution, user request)

**Files:**
- Create: `src/components/dashboard/count-up.tsx` (`'use client'`)
- Modify: the dashboard headline KPI cards (find where `MembershipCounts` — total/active/atRisk/overdue — and the YTD-revenue number render; likely a `KpiCard`/stat component used by `src/app/(staff)/admin/(home)/page.tsx`). Wrap each headline NUMBER in `<CountUp>`.
- Test: `tests/unit/dashboard/count-up.test.tsx`

**Interfaces — Produces:**
```ts
// value = the numeric target; format = formats a number to the display string
// (the SAME formatter the card already uses — money THB / thousands-separator);
// durationMs default ~800.
function CountUp(props: {
  readonly value: number;
  readonly format: (n: number) => string;
  readonly durationMs?: number;
  readonly className?: string;
}): JSX.Element;
```

**Behavior (constraints — all required):**
- **SSR-safe / no hydration mismatch:** the server render AND the first client render output `format(value)` (the final number) — so no-JS, SR, SEO, and CLS all see the final value. The animation starts only in a client effect after hydration.
- **Count-up:** on mount (client), if motion is allowed, animate a displayed number from `0` → `value` over `durationMs` via `requestAnimationFrame` (ease-out), reformatting each frame with `format`. Avoid a visible final→0 flash (set the from-0 start before paint, e.g. `useLayoutEffect`/first rAF, guarded to run client-only).
- **Reduced motion (WCAG):** if `matchMedia('(prefers-reduced-motion: reduce)').matches`, DO NOT animate — render `format(value)` immediately. Default to no-animation on the server / before the media query is known (SSR-safe).
- **A11y:** no `aria-live` on the animating element (a per-frame live region would spam screen readers). The element's accessible text is the number; SR reads the current DOM value (final at rest). Do not add role/aria that announces intermediate frames.
- **Zero-dep:** hand-rolled rAF; no new npm dependency (Constitution X).
- **Re-animate on value change** is NOT required (dashboard reads a cached snapshot; a static mount animation is enough) — keep it simple (animate once on mount).

**TDD:**
- [ ] Write failing tests (jsdom, @testing-library/react): (1) renders `format(value)` synchronously on first render (SSR-parity — assert the final string is in the DOM immediately, before timers); (2) with `prefers-reduced-motion: reduce` mocked (`matchMedia`), the value is the final formatted string and no animation frames run; (3) no `aria-live` attribute on the output. (Animating intermediate frames is timing/rAF — you may fake timers/rAF to assert it eventually reaches `format(value)`, but the load-bearing assertions are SSR-parity + reduced-motion + no-aria-live.)
- [ ] Run → FAIL, implement, run → PASS.
- [ ] Wire `<CountUp>` into each headline KPI number (money card passes its THB formatter; count cards pass the integer/thousands formatter). Verify the cards still render the final numbers server-side (`pnpm typecheck` + the KPI card test if one exists).
- [ ] Commit `feat(dashboard): count-up animation on KPI cards (reduced-motion + SSR-safe)`.

**Note:** this is dashboard UX polish, independent of the chart data pipeline; it touches no snapshot/insights code.
