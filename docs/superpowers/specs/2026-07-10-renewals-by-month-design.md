# Renewals-by-Month — Design

**Date:** 2026-07-10 · **Feature:** F8 admin renewal-planning widget · **Branch:** `renewals-by-month`

## Goal

Give staff a **calendar-month overview** of the renewal workload on `/admin/renewals`: a horizontal bar chart showing how many members' renewals (`renewal_cycles.expires_at`) fall in each of the next 12 months (+ a "12+ later" catch-all). Clicking a month filters the pipeline table to that month. This complements — does **not** replace — the existing relative-urgency buckets (T-90…Lapsed).

**Why:** the urgency buckets only surface members within ~90 days of renewal (currently ~11 of 95); the other ~84 members renewing in 2027 are invisible in that view. The month chart is the planning lens that shows all 95 across the year, mirroring the operator's spreadsheet "who renews which month". This replaces the manual spreadsheet's `End of Membership` + `Renewal` tracking columns (the system already automates reminder status; the missing piece was the by-month planning view).

## Scope decisions (locked with the operator)

1. **Placement:** a new card ("Renewals by month") on `/admin/renewals`, positioned **above** the existing pipeline card (overview → detail flow). Purely **additive** — the urgency-bucket-tabs, pipeline table, and everything shipped stay untouched in behaviour.
2. **Rendering:** **horizontal bar chart** (magnitude visible at a glance — the whole point is "which months are heavy"). Not a pill strip / plain table.
3. **Interactive:** clicking a month bar **filters the pipeline** below via `?month=YYYY-MM` (mirrors the urgency-bucket-tabs `?urgency=` pattern). The "12+ later" bar filters via `?month=later`.
4. **Time range:** current month + next 11 (rolling 12) + a **"12+ later"** catch-all bucket for anything ≥12 months out.
5. **month vs urgency = mutually-exclusive lenses.** They are two views of the SAME dimension (urgency is derived from `expires_at`), so an AND-combine yields mostly-empty/confusing results. Selecting a month clears `?urgency`; selecting an urgency tab clears `?month`. The pipeline query applies whichever one filter is present.
6. **Urgency-tabs colour polish (bundled):** give the existing T-90…Lapsed tabs an urgency colour language **consistent with the chart** so the two lenses read as one system:
   - 🔴 red band → `T-0`, `Grace`, `Lapsed` (due/overdue)
   - 🟠 amber band → `T-14`, `T-7` (near)
   - 🔵 blue/neutral band → `T-90`, `T-60`, `T-30` (planning)
   This is a **styling-only** change to `urgency-bucket-tabs.tsx` (no behaviour change).

### Out of scope (YAGNI — deferred)

- ❌ Rename `T-90`/`T-0` labels to human strings, hide zero-count buckets (separate UX pass; touches i18n × 3 locales).
- ❌ Per-tier breakdown within each month.
- ❌ A by-month CSV export (the members backup export already covers data export).
- ❌ Combined month **AND** urgency filter.
- ❌ Replacing the urgency tabs with a unified timeline (option B — rejected: loses the reminder-stage granularity + higher risk).

## Architecture

Mirrors the existing pipeline data path (`load-pipeline.ts` → cycle repo → `PipelineTable`) and the urgency-tabs filter pattern. Four units:

### 1. Data — repo aggregation (Infrastructure)

New method on the renewal-cycle repo (`drizzle-renewal-cycle-repo.ts`):

```ts
countCyclesByExpiryMonth(
  tenantId: string,
  opts: { nowIso: string; horizonMonths: 12; timezone: string },
): Promise<{ months: Array<{ month: string /* 'YYYY-MM' */; count: number }>; laterCount: number }>
```

- SQL: `GROUP BY to_char(expires_at AT TIME ZONE $tz, 'YYYY-MM')`, `$tz = 'Asia/Bangkok'` (tenant TZ) so month boundaries match how staff read dates. Counts **non-terminal** cycles only (NOT `completed`/`cancelled`/`lapsed` — the exact same set the pipeline's upcoming urgency buckets show; a terminal cycle is not an upcoming renewal). The precise status predicate reuses whatever the pipeline query already uses for its "upcoming" set (single source of truth — confirm against `load-pipeline.ts` at build time).
- The use-case buckets the raw month→count map into the fixed 12-month window + `laterCount`. Runs inside `runInTenant` (RLS-safe, never the raw `db`).
- Composite-index note: relies on the existing `(tenant_id, status, expires_at)` access path; no new index required for a ~131-member tenant (add later only if a large tenant regresses).

### 2. Application — use-case

`loadRenewalMonthSummary(deps, { tenantId, nowIso })` (new file `application/use-cases/load-renewal-month-summary.ts`):

- Read-only, returns `Result<RenewalMonthSummary, never>` (error channel `never`; a repo throw degrades to an empty summary at the presentation boundary, never a 500 — matches `MembersWithoutCycleTray`'s posture).
- Output: `{ buckets: Array<{ key: 'YYYY-MM' | 'later'; count: number }>; maxCount: number; totalCount: number }` — 12 month buckets (each may be count 0) + the `later` bucket, in chronological order. Month **labels are NOT in the view-model** — they're resolved in Presentation via next-intl (Constitution III: no i18n in Application). `maxCount` drives bar-width scaling in presentation.
- Exported via the renewals barrel (`@/modules/renewals`); the client bar-chart imports **types** from the client-safe sub-barrel `@/modules/renewals/client` (same rationale as `PipelineRow` / `UrgencyBucket` — Turbopack + server-only deps).

### 3. Pipeline filter extension

Extend `load-pipeline.ts` + the repo's pipeline query to accept an optional `monthFilter: string`:

- `'YYYY-MM'` → `WHERE expires_at >= <month-start, BKK> AND expires_at < <next-month-start, BKK>` (half-open range on the indexed column — index-friendly, no `to_char` in the WHERE).
- `'later'` → `WHERE expires_at >= <now + 12 months, BKK month-start>`.
- The renewals `page.tsx` reads `searchParams.month`; when present it takes precedence and `urgency` is ignored (mutually-exclusive lenses). When absent, existing `urgency` behaviour is unchanged.

### 4. Presentation

- `RenewalsByMonthSection` (async server component, new `_components/renewals-by-month-section.tsx`) — calls `loadRenewalMonthSummary`, resolves month labels (locale + BE via next-intl `useFormatter`/`format-date-localised`), passes a serialisable view-model to the client chart. Own `<Suspense>` boundary + skeleton (never blocks the pipeline paint — same pattern as `MembersWithoutCycleTray`).
- `MonthBarChart` (client component, new `src/components/renewals/month-bar-chart.tsx`) — renders a row of month columns: count (top) · vertical bar (height ∝ `count / maxCount`) · month label (bottom). Each column is a **link** to `?month=<key>` (soft-nav via `router.push`, clears `?urgency`, resets pagination cursor — mirrors `urgency-bucket-tabs.handleChange`). Selected month highlighted. Bars coloured by band (🔴 current-month/overdue, 🟠 next 1–2 months, 🔵 later) — the same palette as the polished tabs. A legend row explains the colours.
- **Urgency-tabs colour polish:** edit `urgency-bucket-tabs.tsx` `TabsTrigger` to apply band-based colour classes (Tailwind tokens, both light+dark). Behaviour unchanged.

## Best-UX requirements (the operator asked for "best UX")

- **WCAG 2.1 AA:** each bar is a keyboard-focusable link with a descriptive `aria-label` ("ธ.ค. 2026 — 17 members — filter pipeline"); urgency conveyed by **colour + position + the numeric count** (never colour alone, WCAG 1.4.1); visible focus ring (2.4.7); the chart row is a `role="group"`/`region` with an `aria-label`; horizontal `overflow-x-auto` for narrow viewports (1.4.10 Reflow) with a keyboard-pannable focusable region (mirror `urgency-bucket-tabs`' scroll-region pattern).
- **i18n (en/th/sv):** widget title, month labels (localised, **BE year for th-TH**), "12+ later", "N members" count, all aria strings. Missing EN key fails build; TH/SV fall back + CI-warn (existing `check:i18n`).
- **States:** shimmer skeleton while streaming; empty state ("No upcoming renewals") when every bucket is 0; graceful "couldn't load" card on read failure — none crash the pipeline page.
- **Consistency:** the chart + polished tabs share ONE colour language; the card matches the shipped card chrome (border, radius, `CardHeader` real `<h2>` for SR heading-nav, per `docs/ux-standards.md`).
- **Zero layout shift** (skeleton reserves the chart height); soft-nav preserves scroll/state.

## Error handling

- Repo throw → use-case returns empty summary → widget shows "couldn't load" card (best-effort). Pipeline load is independent and unaffected.
- Malformed/absent `?month` param → ignored (falls back to default urgency view), never a 500.
- Cross-tenant: the aggregation runs inside `runInTenant` (RLS `SET LOCAL app.current_tenant`) — a foreign tenant's cycles are invisible; no explicit `tenant_id` WHERE needed.

## Testing

- **Unit** (pure, mock-free): the month-bucketing helper — grouping expiry ISO dates into the rolling-12 + `later` buckets across the **Asia/Bangkok** boundary (a renewal at 2026-12-01T00:00+07 counts in `2026-12`, not `2026-11`); bar-width scaling; empty/all-later edge cases; `?month` param parsing (`YYYY-MM`, `later`, garbage → null).
- **Integration** (live Neon): `countCyclesByExpiryMonth` returns correct per-month counts + `laterCount` on seeded cycles; the pipeline `monthFilter` returns exactly the members whose `expires_at` falls in that month (BKK); RLS isolation (a second tenant's cycles never leak); terminal cycles excluded from the counts.
- **Component:** `MonthBarChart` renders the right bars/counts, a click navigates to `?month=`, selected-month highlight; `@axe-core` a11y scan (0 violations); polished urgency-tabs still navigate + carry the new colour classes.
- **E2E (optional):** click a month bar → pipeline filters to that month; switch to an urgency tab → `?month` cleared.

## File structure

```
src/modules/renewals/
  application/use-cases/load-renewal-month-summary.ts        (new)
  application/use-cases/load-pipeline.ts                     (modify: monthFilter)
  application/ports/renewal-cycle-repo.ts                    (modify: countCyclesByExpiryMonth + pipeline monthFilter)
  infrastructure/drizzle/drizzle-renewal-cycle-repo.ts       (modify: impl)
  domain/renewal-month-bucket.ts                             (new: pure bucketing helper)
  index.ts / client sub-barrel                               (modify: exports + client types)
src/app/(staff)/admin/renewals/
  page.tsx                                                   (modify: read ?month, render widget, thread filter)
  _components/renewals-by-month-section.tsx                  (new: server section + skeleton)
  _components/urgency-bucket-tabs.tsx                        (modify: colour polish + clear ?month on select)
src/components/renewals/month-bar-chart.tsx                  (new: client bar chart)
src/i18n/messages/{en,th,sv}.json                            (modify: admin.renewals.byMonth.*)
tests/unit/renewals/domain/renewal-month-bucket.test.ts     (new)
tests/integration/renewals/count-cycles-by-month.test.ts    (new)
tests/unit/app/renewals/month-bar-chart.test.tsx            (new)
```
