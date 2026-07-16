# Dashboard Interactive Charts — Design

**Date:** 2026-07-16
**Branch:** `067-dashboard-interactive-charts`
**Status:** Design (approved for spec review)

## Goal

Make the admin dashboard charts interactive (hover tooltips) and add two
composition views. Today the dashboard has only *time-trend* charts
(member-growth, revenue-trend) drawn as static, decorative SVG. Users want
hover/tooltip interactivity and a sense of *composition* (what the membership
and the receivables are made of).

## Scope

**In:**
1. Migrate the two existing sparklines — `member-growth-chart` and
   `revenue-trend-chart` — from hand-rolled SVG to Recharts line charts with
   hover tooltips.
2. Add **Membership by Tier** — a donut of active members per plan tier.
3. Add **Invoice Status** — a donut of receivables by status, measured in **THB
   amount** (cash-flow view), with the total in the centre.

**Out of scope:**
- The renewals **`month-bar-chart`** stays as-is. It is already a keyboard-
  interactive, click-to-filter, axe-passing control; replacing it with Recharts
  would regress that accessibility for no interactivity gain. A future phase may
  revisit it deliberately.
- No new data is captured; all four charts read data the platform already
  stores (members, plans, invoices).
- No zoom/brush in this phase (tooltips + hover only). Zoom can be a follow-up
  once Recharts is in.

## Decisions (approved)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Invoice Status metric | **THB amount** per status (paid / issued-unpaid / overdue), centre label = total; tooltip also shows invoice **count** |
| 2 | Sparkline chart type | **Line + tooltip** (direct upgrade of the current sparkline intent) |
| 3 | Tier donut population | **Active members only** (the meaningful membership mix) |
| 4 | Bundle strategy | **Lazy-load Recharts on the dashboard route only** (dynamic import) to protect `check:bundle-budgets` |

## Tooling & dependency

Use the **shadcn/ui `chart` component** (`src/components/ui/chart.tsx`) which
wraps **`recharts`** — not raw Recharts. Rationale: it is built for the
shadcn/Tailwind stack, is theme-aware through CSS variables (navy branding +
dark mode need no manual wiring), and standardises tooltip/legend styling.

`recharts` is a **new npm dependency**, which conflicts with Constitution
Principle X (Simplicity / zero-new-dependencies). The justification —
interactive tooltips + composition donuts are impractical to hand-roll, and a
charting primitive is a bounded, well-understood addition — will be recorded in
`plan.md` § Complexity Tracking with the rejected simpler alternative
(hand-rolled SVG tooltips, rejected because zoom/consistent tooltips across four
charts is disproportionate custom work).

## Architecture

**Server fetches, client renders.** Recharts is client-only, so:

- The dashboard **page (server component)** calls the insights use-cases to get
  already-aggregated, serialisable data and passes it as props.
- Each **chart component is `'use client'`** and only renders the visual. No
  data fetching or business logic in the client layer.

```
(staff)/admin/dashboard/page.tsx  (server: fetch aggregates)
        │  props: series[] / slices[]
        ▼
components/dashboard/*-chart.tsx   ('use client': Recharts + visually-hidden table)
        └─ components/ui/chart.tsx (ChartContainer / ChartTooltip / ChartConfig)
```

### Data sources (new, in `src/modules/insights`)

Two new read-only aggregation use-cases, tenant-scoped via `runInTenant` (threading
`tx`, per the RLS gotcha — never the global `db`):

- **`getMembershipTierDistribution`** → `{ tierKey: string; planLabel: string; count: number }[]`
  `GROUP BY` plan/tier over members with `status = 'active'`.
- **`getInvoiceStatusDistribution`** → `{ bucket: 'paid' | 'unpaid' | 'overdue'; amountMinor: bigint; count: number }[]` plus a `draftCount`.
  The DB enum is `draft | issued | paid | void | credited | partially_credited`
  — there is **no `overdue` status**; overdue is **derived** (`issued` AND
  `due_date < today`, in the tenant timezone). Cash-flow buckets:
  - **paid** = `status = 'paid'`
  - **unpaid** = `status = 'issued'` AND `due_date >= today`
  - **overdue** = `status = 'issued'` AND `due_date < today`
  Sum invoice totals (minor units / satang) per bucket; presentation formats
  THB. **Excluded from the receivables total:** `draft` (not yet a receivable —
  surfaced only as a `draftCount` caption) and `void` (cancelled).
  `credited` / `partially_credited` handling (net-of-credit balance) is a detail
  for the plan; MVP may fold `partially_credited` into `unpaid`/`overdue` by its
  due date and treat fully `credited` like `void`.

The two existing sparklines already have data sources
(`member-source-adapter` / revenue trend); reuse them unchanged — only the
render layer changes.

## The four charts

| Chart | Type | Data | Interaction | a11y text equivalent |
|-------|------|------|-------------|----------------------|
| Member growth | Line | existing trend series | hover tooltip (date → count) | visually-hidden table of the series (kept) |
| Revenue trend | Line | existing trend series | hover tooltip (date → THB) | visually-hidden table (kept) |
| Membership by Tier | Donut (Pie) | tier distribution | hover slice → tier, count, % ; legend | visually-hidden table: tier → count, % |
| Invoice Status | Donut (Pie) | status distribution | hover slice → status, THB, count ; centre = total THB | visually-hidden table: status → THB, count |

## Accessibility (must not regress)

- Every chart keeps a **visually-hidden `<table>`** (or description list)
  conveying the full data, so information is never colour- or hover-only
  (WCAG 1.4.1, 1.1.1). The current sparklines already do this — preserve it and
  add the same for the two donuts.
- Enable Recharts **`accessibilityLayer`** on the cartesian charts for keyboard
  focus + arrow traversal of points.
- Donut slice colours come from theme CSS vars (`--chart-1..5`); Invoice-Status
  uses **semantic** colours (paid = success/green, overdue = destructive/red,
  unpaid = warning) but every slice is also labelled with text + %, so colour is
  never the sole signal.
- Respect `prefers-reduced-motion`: disable Recharts entry animations when set.
- Tooltips are supplementary only; the SR path is the hidden table.

## Performance / CLS / bundle

- **Route-scoped, lazy-loaded**: import the chart client components via
  `next/dynamic` (or rely on the client-component boundary) so Recharts ships
  only in the dashboard route bundle, not globally. Verify against
  `check:bundle-budgets`.
- **Fixed-height containers** (`ChartContainer` with a set aspect/height) so
  hydration of the client chart causes **no layout shift** (CLS budget).
- Server still renders the page + the hidden data tables immediately; the
  interactive canvas hydrates after.

## i18n (EN / TH / SV)

- New next-intl keys under the dashboard namespace: chart titles, axis/tooltip
  labels, status labels (paid/unpaid/overdue), "members", "invoices", tier
  labels (reuse existing plan/tier labels where present).
- EN canonical; TH + SV required (dashboard is a staff surface — TH mandatory).

## Testing

- **Integration (live Neon)** for each new aggregation use-case: seed members
  across tiers / invoices across statuses, assert counts + summed amounts, and
  tenant isolation (no cross-tenant bleed).
- **Component render tests (jsdom)**: Recharts needs a measured container —
  mock `ResponsiveContainer` / provide a fixed size — assert the visually-hidden
  table renders the passed data (the a11y contract), independent of the SVG.
- **E2E axe scan** on `/admin/dashboard` — no new violations; reduced-motion
  spec.
- i18n key-parity check for the new keys.

## Risks & mitigations

- *Recharts bundle weight* → route-scoped lazy load + bundle-budget gate.
- *a11y regression* → hidden data tables + axe scan as a hard check.
- *CLS on hydration* → fixed-height containers.
- *SSR* → charts are client components fed by server props; no Recharts on the
  server.

## Resolved during self-review

1. **Draft invoices** — **excluded** from the Invoice-Status receivables total
   (not yet a receivable); surfaced as a `draftCount` caption under the donut.
   `void` is likewise excluded.
2. **Tier donut** — **show all nine tiers** (6 corporate + 3 partnership); no
   "Other" bucket. Revisit only if it reads as cramped at build time.
3. **`ui/chart.tsx` / recharts** — confirmed **absent** (`recharts` not
   installed, no `src/components/ui/chart.tsx`). The plan adds the `recharts`
   dependency + the shadcn `chart` wrapper.

## Deferred to the plan (implementation detail, not blocking)

- `credited` / `partially_credited` invoice handling in the status donut
  (net-of-credit balance) — MVP folds `partially_credited` into `unpaid` /
  `overdue` by due date and treats fully `credited` like `void`.
