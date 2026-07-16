# Dashboard Interactive Charts — Design

**Date:** 2026-07-16 · **Branch:** `067-dashboard-interactive-charts` · **Feature:** F9 admin-dashboard (`src/modules/insights`)
**Status:** Design — revised after 4-agent spec review (architecture, a11y, perf/bundle, chart-UX). Ready for spec review → plan.

## Goal

Make the admin dashboard charts interactive (hover tooltips) and add two
composition views. Today the dashboard has only *time-trend* charts drawn as
static SVG; users want hover interactivity and a sense of *composition* (what
the membership and the receivables are made of).

## Scope

**In — four charts, all rendered with Recharts (via shadcn/ui `chart`):**
1. **Member growth** — migrate the existing SVG sparkline to a Recharts line + tooltip.
2. **Revenue trend** — migrate the existing SVG sparkline to a Recharts line + tooltip.
3. **Membership by Tier** — a **horizontal bar** (NOT a donut — see Decisions/§Charts).
4. **Invoice Status** — a **donut** of receivables by status, in THB.

> The user chose to migrate the two sparklines to Recharts as well (the review
> panel leaned toward keeping the SVG sparklines, since they already have
> `<title>` hover + rich annotations + CLS-0). We honour that, and this design
> mitigates the panel's concern by (a) preserving every existing sparkline
> annotation and (b) using one a11y model across all four charts.

**Out:**
- The renewals **`month-bar-chart`** stays as-is — it is a keyboard-interactive,
  click-to-filter, `aria-current`, axe-passing control (`<Link>` bars + focusable
  scroll region). Replacing it with Recharts would *regress* those semantics for
  no interactivity gain. Confirmed by the a11y reviewer.
- No new data capture; no zoom/brush this phase (tooltips + hover only).

## Decisions (approved + review-driven)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Invoice Status metric | **THB amount, net-of-credit / outstanding** per bucket (paid / unpaid / overdue); centre = total outstanding; tooltip also shows invoice **count** and **%**. Chart title makes "by value" explicit (guard the value-vs-count reading). |
| 2 | Sparklines | **Migrate to Recharts line + tooltip**, PRESERVING all existing annotations (see §Charts). |
| 3 | Tier chart type | **Horizontal bar**, single brand colour (`--chart-1` navy), sorted desc, count + % end-labels. (Donut rejected: only 5 theme chart-tokens across 2 lightness clusters can't distinguish 9 tiers → CVD fail; and tier is two-layer so a donut's part-to-whole is invalid.) |
| 4 | Tier grouping | **One active member → one tier**, `GROUP BY plan slug`; members whose plan can't resolve go to an **`unassigned`** bucket so the bars sum to the active-member KPI. |
| 5 | Where computed | **In the snapshot cron** (`computeDashboardSnapshot`), cached in the `DashboardSnapshot` row — NOT live at request time. |
| 6 | Overdue derivation | **Reuse F4 `computeIsOverdue`** (Asia/Bangkok, strict `>`), NOT SQL `due_date < CURRENT_DATE`. |
| 7 | Bundle | `next/dynamic(() => import(...), { ssr:false })` for the chart canvas + a **new `/admin` entry in `check-bundle-budgets`** (measured). |
| 8 | A11y model | Every Recharts chart is **`aria-hidden` + `accessibilityLayer={false}`**; a **server-rendered hidden `<table>`** is the sole a11y/SR path. Pin the recharts major version. |

## Tooling & dependency

Use the **shadcn/ui `chart`** wrapper (`src/components/ui/chart.tsx`) over
**`recharts`** — theme-aware via CSS vars, standard tooltip/legend. Both are
**absent today** (verified: recharts not installed, no `ui/chart.tsx`).

`recharts` is a **new dependency** → conflicts with Constitution Principle X.
`plan.md` § Complexity Tracking records the justification with the **specific**
rejected alternative: *"add recharts only for the two new charts (tier bar +
invoice donut) and keep the SVG sparklines"* — rejected because the user wants a
single consistent charting layer and interactive tooltips across all four; the
donut/bar (arc math + legend + centre label + hover slices) is genuinely
impractical to hand-roll, which is the load-bearing part of the justification.
**Pin the recharts major version** (its a11y contract differs sharply 2.x vs 3.x).

## Architecture — compute in the snapshot cron, render on the client

The two existing trend charts are already served from a **cached
`DashboardSnapshot`** (a cron computes it ~every 5 min; the page reads it via
`listDashboard`, and the header `asOf` reflects `computedAt`). The two new
aggregates MUST join that snapshot — not run live at request time — to keep the
dashboard SLO (`< 1.5 s p95 @ 5k`, which is predicated on a cached read) and a
uniform `asOf`. This also removes a Clean-Architecture problem (the members
barrel exposes no table / GROUP BY).

**Two reuse wins (why this is nearly free):**
1. **Tier distribution = pure JS.** `computeDashboardSnapshot` already loads
   `activeMembers = listActiveWithPlan(ctx)` → `{memberId, planId, planYear}[]`.
   Tier bars are a `GROUP BY planId` (collapsing plan years) over that array —
   **no new query or repo method.**
2. **Invoice-status = same pass.** `invoice-source-adapter` already paginates the
   full invoice set (for YTD revenue / overdue count / monthly revenue).
   Compute the three status buckets in that **same pass**, not a 4th scan.

**Flow:**
```
cron → computeDashboardSnapshot (adds tierDistribution + invoiceStatus to the snapshot)
     → snapshot row (JSON)
page (server) → listDashboard (single cached read; uniform asOf) → props
     → chart components ('use client', dynamic ssr:false): Recharts + server-rendered hidden table
```

`DashboardSnapshot` domain type + snapshot repo JSON gain two fields. **Read path
must default them defensively** (old cached rows lack them until the next cron
run — accept an empty chart for < ~5 min post-deploy, or backfill on read).

The server→client split matches existing precedent (`InsightsPanel` /
`ActivityFeed` are `'use client'` fed by server props).

## The four charts

| Chart | Type | Data (from snapshot) | Interaction | A11y equivalent (server-rendered) |
|-------|------|----------------------|-------------|-----------------------------------|
| Member growth | Recharts Line | existing trend series | hover tooltip: month → cumulative **and net-new** | hidden table (month → value); **keep** summary stat, delta chip, sparse-history hint, first/last labels, max reference |
| Revenue trend | Recharts Line | existing trend series | hover tooltip: month → THB | hidden table; keep the same annotations as above |
| Membership by Tier | Recharts BarChart `layout="vertical"` | `tierDistribution: {tierKey, count}[]` + `unassigned` | hover bar → tier, count, % | hidden table: tier → count, % (+ total row) |
| Invoice Status | Recharts Pie (donut) | `invoiceStatus: {bucket, amountMinor, count}[]` + `draftCount` | hover slice → bucket, THB, count, % | hidden table: bucket → THB, count, %; centre-total + draftCount as **real DOM** |

**Sparkline migration is not "line + tooltip" only** — the current
`_mini-series-chart` carries a KPI-sized summary stat, a delta chip (AA-pinned
colours), a sparse-history hint, first/last month labels, and a max gridline.
The plan MUST preserve these (they live *outside* the SVG); only the SVG drawing
is replaced by a Recharts `<LineChart>`. The tooltip must not become the *only*
way to read a value — keep the summary + first/last labels + a y reference.
(Bonus: Recharts fixes the existing single-data-point rendering bug.)

## Data & correctness

- **Tier**: `GROUP BY` the plan **slug** (plan year is a separate dimension, collapsed).
  A member whose plan slug can't resolve → **`unassigned`** bucket (never silently
  dropped; the bars must sum to the active-member KPI). Tier **labels** come from
  the plan source — the plan port must expose a label (today it exposes only
  entitlements); resolve distinct plans as the snapshot already does. Note in the
  plan whether labels are i18n keys (translatable) or stored tenant names
  (shown verbatim — not translated).
- **Overdue** uses `computeIsOverdue(invoice, nowUtcIso)` (Asia/Bangkok local
  date, strict `>`) — never SQL `due_date < CURRENT_DATE` (UTC session ⇒ a 7-hour
  off-by-one for 00:00–07:00 Thai). This also makes the donut's overdue count
  **equal** the needs-attention `countOverdue` KPI (same page, same rule).
- **Amounts** — a receivables donut is a part-to-whole chart, so **every bucket
  uses ONE basis: VAT-INCLUSIVE, net-of-credit** = `total − creditedTotal`
  (the amount actually owed / received per the §86/4 tax invoice, which always
  includes VAT — Thai AR is booked gross). This applies to `paid`, `unpaid`, and
  `overdue` alike; mixing ex-VAT for `paid` with gross for the others would
  distort the slice proportions (paid would read ~6.5% small) and make the centre
  total meaningless. The ex-VAT *recognised revenue* view already lives in the
  revenue-trend chart (`netPaidRevenueSatang`) — do not duplicate it here.
  `partially_credited` folds into unpaid/overdue at its net (`total −
  creditedTotal`) balance; fully `credited`, `void`, and `draft` are excluded
  from the outstanding total; `draft` count shown as a caption.

## Accessibility (must not regress; axe gate is a hard check)

- **One model, all four charts:** the Recharts chart is `aria-hidden="true"` +
  `accessibilityLayer={false}`; a **server-rendered hidden `<table>`** (or dl) is
  the sole SR/keyboard data path (WCAG 1.1.1 / 1.3.1 / 1.4.1). This avoids the
  Recharts-3.x `accessibilityLayer` conflict (`role="application"` + `tabIndex=0`
  on an `aria-hidden` node ⇒ axe `aria-hidden-focus`; and duplicate data for SR).
  It matches the repo's existing sparkline pattern → zero-regression by construction.
- **Real DOM, not SVG-only:** the invoice donut's **centre total** and the
  **`draftCount` caption** and every **empty-state** message must be real DOM text
  (inside the hidden table / a visible caption), or SR users lose them.
- **Palette:** tier bar is **single navy** (`--chart-1`) → the 9-colour / CVD
  problem disappears. Invoice donut uses semantic colours (success/warning/
  destructive) but they are near equal-luminance in this theme → **each slice
  carries a direct text label + %** (not swatch-only), slices get a ≥ 3:1 stroke
  vs the card and a 2px gap, amber (unpaid) sits between green/red, and
  `validate_palette` runs on the trio. Colour is never the sole signal.
- **Reduced-motion:** `isAnimationActive` is gated on `prefers-reduced-motion`
  with an **SSR-safe default of off** (Recharts animates via JS; a global CSS
  media query can't reach it; default-off also avoids hydration mismatch + cuts TBT).
- **Focus:** since charts are `aria-hidden`/non-focusable, no focus ring needed on
  the canvas; the hidden table is reachable in normal reading order.

## Performance / bundle / CLS

- **Bundle gate is currently VOID for this route:** `check-bundle-budgets` has no
  `/admin` entry, so anything shipped there passes unchecked. The plan **adds**
  `{ route: '/admin', maxKb: <measured> }`, re-baselined per the file's rule
  (`ceil(measuredKb/10)*10 + 100`) from a real `pnpm build`. Capture
  `firstLoadUncompressedJsBytes` for `/admin` **before and after** from
  `route-bundle-stats.json`; recharts weight (~100–120 KB gzip) is UNVERIFIED
  until measured.
- **Lazy chunk, not first-load:** import the chart canvas via
  `next/dynamic(() => import(...), { ssr:false })` so recharts is a separate
  lazy chunk, NOT part of `/admin` first-load JS. (A plain client-component
  boundary is route-scoped but still counts as first-load JS.) **Never** import a
  chart component or `ui/chart.tsx` from a shared layout / sidebar / command
  palette — that leaks recharts into every route's global first-load.
- **CLS = 0 requires three things**, not just "fixed height": (1) the
  fixed-height card + placeholder is **server-rendered** (only the canvas is
  dynamic); (2) the container has a **definite** height (px / known-width aspect,
  not `height:auto`); (3) the `dynamic` placeholder matches the real height AND
  the donut legend's height is reserved so it doesn't reflow on hydrate.
- **INP < 200 ms** is the riskiest budget (4 charts hydrate together): `ssr:false`
  keeps them off the critical path; animations default off; consider
  IntersectionObserver-mount if INP regresses.
- **Queries** are SQL `GROUP BY` (tier via reused `activeMembers` array; invoice
  via the existing pagination pass) — the required indexes already exist
  (`members_tenant_status_plan_idx`; partial `invoices_tenant_due_date_issued_idx
  WHERE status='issued'` covers the derived-overdue split). No new index; no
  paginate-in-JS on the request path (that adapter is cron-only).
- **Tenant isolation:** all reads thread `tx` from `runInTenant` (never the global
  `db`); the aggregates run inside the snapshot cron's tenant context.

## Layout & states

- Place the two new charts in their own **`<section aria-label>`** landmarks.
  Group the dashboard as **"Trends"** (the two lines) and **"Breakdown /
  Composition"** (tier bar + invoice donut) rather than more repeating 2-col card
  rows. (A chart row previously shipped as a plain div with no landmark.)
- **`loading.tsx` skeletons**: add shimmer skeletons matching the new bar + donut
  layout (this route's `loading.tsx` has repeatedly missed chart rows → CLS spikes
  in F5/F8/F9; ux-standards requires a matching skeleton).
- **Empty states** per chart: 0 active members → tier empty text; all-draft / no
  invoices → invoice empty text ("no outstanding receivables"); parity with the
  existing sparkline `emptyLabel`.

## i18n (EN canonical / TH / SV)

New next-intl keys: chart titles (incl. "Receivables by value"), tooltip/axis
labels, status labels (paid/unpaid/overdue), "members"/"invoices". Tier labels
reuse plan labels — state whether they are i18n keys or stored names. `check:i18n`
must pass for all new keys.

## Testing

- **Integration (live Neon):** cross-tenant isolation (no bleed); **equivalence**
  test — donut overdue count `==` `countOverdue`; **tz-boundary** test — an
  invoice due at 00:30 Thai is NOT overdue while UTC is still the prior day; tier
  GROUP BY including the `unassigned` bucket summing to the active KPI.
- **Component (jsdom):** the hidden `<table>` renders from props independent of
  the SVG (mock `ResponsiveContainer` size); sparkline annotations still render.
- **E2E:** `pnpm test:e2e --workers=1 --grep "@a11y"` on `/admin/dashboard`, **plus
  Playwright steps that hover/focus each chart before scanning** (static axe misses
  tooltip popovers); tooltip surface contrast checked; reduced-motion spec.
- **Manual SR:** VoiceOver + NVDA read every chart's hidden table (incl. donut
  centre total, draftCount, empty states).
- **Gates:** `check:i18n`, `check:bundle-budgets` (with the new `/admin` entry),
  `check:layout`.

## Risks

- *recharts bundle* → measured `/admin` budget + `dynamic ssr:false` + no shared-layout import.
- *a11y regression* → single aria-hidden+hidden-table model + interaction-level axe + manual SR.
- *SLO/CLS* → snapshot-cron compute + 3 CLS conditions + INP mitigations.
- *overdue mismatch* → reuse `computeIsOverdue`; equivalence test.
- *charting inconsistency* (hand-rolled month-bar + Recharts elsewhere) → intentional, recorded debt.

## Deferred to the plan

- Exact `DashboardSnapshot` JSON shape + defensive read defaulting for old rows.
- Extending the plan port to expose tier labels.
- Whether tier labels are translatable (i18n keys) or stored names.
