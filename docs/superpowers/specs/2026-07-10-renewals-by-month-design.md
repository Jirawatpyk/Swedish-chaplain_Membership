# Renewals-by-Month — Design (v2, post specialist review)

**Date:** 2026-07-10 · **Feature:** F8 admin renewal-planning widget · **Branch:** `renewals-by-month`

> **v2 changelog** — revised after `chamber-os-ux-architect` + `chamber-os-architect` reviews. Fixes: (F1) suppress the pipeline's 90-day ceiling under a month filter; (F2) one shared status+erasure predicate (the pipeline has NO reusable "non-lapsed, non-erased, unbounded" set); (F3) month filter scopes ROWS only, not the urgency badges; (U1) colours align to the shipped `UrgencyPill`, not a new blue palette; (U2/F2) add an **Overdue** bucket so `chart total == pipeline non-terminal total`; plus horizontal-bar form, error-propagation, VM-type placement, and a11y/i18n tightenings.

## Goal

Give staff a **renewal-workload overview** on `/admin/renewals`: a horizontal **bar list** — one row per bucket — showing how many members' renewals fall in **Overdue · this month · the next 11 months · "Jul 2027 or later"** (from `renewal_cycles.expires_at`, Asia/Bangkok). Clicking a bucket filters the pipeline table to it. This **complements** — does not replace — the relative-urgency buckets (T-90…Lapsed), which stay exactly as shipped.

**Why:** the urgency buckets only surface members within ~90 days of renewal (currently ~11 of 95); the other ~84 renewing in 2027 are invisible there. The month view is the planning lens that shows **all** non-terminal members across the year (the ~84 far-future + any already-overdue), mirroring the operator's spreadsheet "who renews which month" and replacing its manual `End of Membership` / `Renewal` columns. **Reconciliation invariant:** `sum(all buckets) === count(status ∈ OPEN_CYCLE_STATUSES AND not-erased)` — the chart and the month-filtered pipeline rows count the SAME `MONTH_PLANNING_MEMBER_SQL` set (§0), so every bucket equals the rows its click returns. This set is a **strict subset** of the pipeline's non-terminal base (`NOT IN (cancelled,completed)`): `lapsed` (terminal) and `pending_admin_reactivation` (a reopened money-hold, not an upcoming renewal) are **intentionally excluded** — the pipeline surfaces lapsed via its own Lapsed tab. (Confirm the operator's spreadsheet "~95" likewise counts only open/upcoming renewals — true at SweCham today.)

## Scope decisions (locked with the operator)

1. **Placement:** new card "Renewals by month" on `/admin/renewals`, **above** the pipeline card (overview → detail). Purely **additive** to the shipped urgency tabs + table.
2. **Rendering:** **true horizontal bar list** — each row = `label │ bar │ count`, the whole row is the link. (Not vertical columns: with 14 buckets and localised `month + BE-year` labels + Swedish compounds, columns force truncation/rotation or a mandatory horizontal-scroll region and blow the 320px reflow budget; horizontal rows never truncate, are a natural mobile list, and give a ≥44px target for free.)
3. **Interactive:** clicking a bucket filters the pipeline via `?month=<key>` where `<key> ∈ { 'overdue', 'YYYY-MM' (×12), 'later' }`. Mirrors the `urgency-bucket-tabs` `?urgency=` pattern.
4. **Buckets (14):** `overdue` (non-terminal, `expires_at < current-month-start`) · current month + next 11 (rolling 12) · `later` (`expires_at ≥ now + 12 months`).
5. **month vs urgency = mutually-exclusive lenses** (they are two views of the SAME dimension — urgency is derived from `expires_at` — so AND-combine is mostly empty/confusing). Precedence: a **present AND valid** `month` wins and `urgency` is ignored; an invalid `month` string is treated as absent so a valid `urgency` still applies.
6. **Urgency-tabs colour polish (bundled, styling-only) — aligned to the SHIPPED `UrgencyPill`, not a new palette.** The pill (`urgency-pill.tsx:16-33`, rendered in every pipeline row and staying on screen) already defines the colour language; the tabs must match it, and the chart must match the tabs:
   - **slate** → `t-90`, `t-60` (planning / far)
   - **amber** → `t-30`, `t-14` (approaching)
   - **orange** → `t-7`
   - **red** → `t-0`, `grace` (imminent/overdue)
   - **gray/neutral** → `lapsed` (deliberately NOT red — "gone, not an actionable urgency")
   Reuse the exact Tailwind class strings + `dark:` variants from `urgency-pill.tsx:16-33` (light **and** dark match by construction). The chart's bucket→band mapping (pin at build, mirrors the pill's T-offset gradient): `overdue` → **red** · current month (index 0) → **orange** · next 1–2 months → **amber** · months 3–11 + `later` → **slate**. **No blue** (it appears nowhere in shipped renewals).

### Out of scope (YAGNI — deferred)

- ❌ Rename `T-90`/`T-0` labels to human strings; hide zero-count urgency buckets (separate UX pass, i18n × 3).
- ❌ Migrating `UrgencyPill`'s own palette (if the operator later wants a 3-band simplification, that's a conscious `UrgencyPill` migration, not this "styling-only" polish).
- ❌ Per-tier breakdown per month · by-month CSV export · combined month **AND** urgency filter · option-B unified timeline.

## Architecture

### 0. ONE shared status + erasure predicate (fixes F2 — the crux)

`load-pipeline` does **not** expose a reusable "upcoming, non-lapsed, non-erased, unbounded" set. Its base filter is (`drizzle-renewal-cycle-repo.ts:1071-1091`): `status NOT IN ('cancelled','completed')` (**keeps `lapsed`** — that's the Lapsed tab) **AND** `MEMBER_NOT_ERASED_SQL` (`:1079`, `:378-383` — COMP-1 H4 drops GDPR-erased members from operational admin enumerations) **AND** `expires_at <= NOW() + INTERVAL '90 days'`.

Define **one** SQL fragment reused by both new paths (aggregation + month-filtered page):

```
MONTH_PLANNING_MEMBER_SQL =
   status = ANY(OPEN_CYCLE_STATUSES)   -- {upcoming, reminded, awaiting_payment} (cycle-status.ts:67-71)
   AND <MEMBER_NOT_ERASED_SQL>          -- reuse the existing constant (drizzle-renewal-cycle-repo.ts:378-383)
```

Decision (F7): use `OPEN_CYCLE_STATUSES` — it is the module's canonical "an upcoming renewal" set and deliberately **excludes** `pending_admin_reactivation` (a reopened-lapsed money-hold, not a normal upcoming renewal). This is the "an upcoming renewal that will actually happen" set; it is a strict subset of the pipeline's `NOT IN (cancelled,completed)` (which additionally shows lapsed for the Lapsed tab). **`MEMBER_NOT_ERASED_SQL` is non-negotiable** — without it the chart counts erased members the month-filtered pipeline (which inherits it) omits, breaking reconciliation and re-entering a member COMP-1 removed.

### 1. Data — repo aggregation (Infrastructure)

New method on the renewal-cycle repo:

```ts
countCyclesByExpiryMonth(
  tenantId, opts: { nowIso: string; timezone: 'Asia/Bangkok' },
): Promise<{ overdueCount: number; months: Array<{ month: 'YYYY-MM'; count: number }>; laterCount: number }>
```

- `WHERE <MONTH_PLANNING_MEMBER_SQL>` (§0), grouped `to_char(expires_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM')`. `expires_at` is **`timestamptz`** (`schema-renewal-cycles.ts:52`, `withTimezone:true`) so `AT TIME ZONE 'Asia/Bangkok'` yields the correct BKK wall-clock month (call this dependency out — a future column-type change must trip review). BKK is fixed UTC+7, no DST.
- The aggregation returns raw month→count for **all** non-terminal-non-erased cycles; the use-case slots them into `overdue` / the 12-window / `later`. (Hygiene F9: the aggregation MAY floor scanning but the past-month rows collapse into the single `overdue` count anyway.)
- Runs inside `runInTenant` — **thread the `tx`, never global `db`** (F7.1a RLS gotcha). RLS auto-scopes; no explicit `tenant_id` WHERE.

### 2. Application — use-case + view-model type

- View-model type lives in the **pure `domain/renewal-month-bucket.ts`** (zero framework imports) and is re-exported via **both** the server barrel and `@/modules/renewals/client` — so the client chart imports it without dragging the server graph into the browser bundle (F5: `PipelineRow`/`UrgencyBucket` are re-exportable from `client.ts:43-46` *because* they live in a pure port file, NOT in a use-case file that imports `RenewalsDeps`/otel/metrics).
- `loadRenewalMonthSummary(deps, { tenantId, nowIso })` → `Result<RenewalMonthSummary, never>` (module convention: input server-sourced, no business error). **The infra throw PROPAGATES** — the use-case does NOT catch (F4: mirrors `loadMembersWithoutCycle` at `load-members-without-cycle.ts:29-59`; the *page wrapper* try/catches to render the couldn't-load card). Empty-state (all buckets 0) is a distinct non-error path.
- Output: `{ buckets: Array<{ key: 'overdue' | 'YYYY-MM' | 'later'; count: number }>; maxCount: number; totalCount: number }` — chronological, month buckets may be 0. **Labels are NOT in the view-model** (Constitution III — resolved in Presentation via next-intl). `totalCount` = sum of all buckets = `count(MONTH_PLANNING_MEMBER_SQL)` (OPEN_CYCLE_STATUSES ∩ not-erased) — NOT the pipeline's non-terminal count (which keeps lapsed). Displayed by the title as the planning total.

### 3. Pipeline filter extension (fixes F1 + F3)

Extend `load-pipeline.ts` + the repo's pipeline query with an optional validated `monthFilter`:

- **F1 — suppress the 90-day ceiling under a month filter.** When `monthFilter` is present the repo MUST NOT emit `expires_at <= NOW()+INTERVAL '90 days'` (`:1088-1090`) — the month bounds ARE the window. Replace it with:
  - `'overdue'` → `expires_at < <current-month-start, BKK>` (+ `MONTH_PLANNING_MEMBER_SQL`).
  - `'YYYY-MM'` → half-open `expires_at >= <month-start,BKK> AND expires_at < <next-month-start,BKK>` (indexed column, no `to_char` in WHERE).
  - `'later'` → `expires_at >= <now + 12 months, BKK month-start>`.
  - Use `MONTH_PLANNING_MEMBER_SQL` (§0) as the status/erasure base so the row set == the bucket's counted set. **The month path REBUILDS its filter set from `MONTH_PLANNING_MEMBER_SQL` — it must NOT `baseFilters.slice()`** (whose `NOT IN (cancelled,completed)` keeps `lapsed` → clicking `overdue` would surface lapsed cycles + inflate the row count above the bucket count).
  - **Tier interaction:** the urgency `byUrgency` summary is tier-scoped (`drizzle-renewal-cycle-repo.ts:1126-1128`) but the chart aggregation is whole-tenant. So a month filter **ignores the "All tiers" dropdown** (rows match the whole-tenant bar count) — surface this in the clear-chip / empty copy so the numbers never look mismatched.
- **F3 — month scopes ROWS only, NOT the urgency badges.** `loadPipelinePage` computes `summary.byUrgency` + `lapsedCount` from `baseFilters` (`:1104-1132`). The month filter must apply to the **paged rows** only; the urgency summary + lapsed count stay computed on the **unfiltered 90-day base** so the urgency tabs show the same picture regardless of which month is selected (the "two independent lenses" contract). i.e. thread `monthFilter` into the row query but NOT into the summary aggregation.
- **F6 — validate precedence in the use-case, not SQL.** Add `month` to `loadPipelineInputSchema` (`load-pipeline.ts:43`) as `/^\d{4}-(0[1-9]|1[0-2])$/ | 'overdue' | 'later'` (reject `2026-13`/`2026-00`); invalid → treated as absent → `urgency` still honored. The use-case forwards at most one of `{urgency, month}` to the repo.
- `page.tsx` reads `searchParams.month`; present-and-valid → month view (urgency ignored); else existing `urgency` behaviour unchanged.

### 4. Presentation

- `RenewalsByMonthSection` (async server component) — calls `loadRenewalMonthSummary`, resolves bucket labels (locale + **BE year via `formatLocalisedDate`**, `format-date-localised.ts:20-28` — never a literal year), passes a serialisable VM to the client chart. Own `<Suspense>` + skeleton. Uses the tray's structure: `<section aria-labelledby>` + a **real `<h2>`** (NOT shadcn `CardTitle`, which renders a `<div>` — `members-without-cycle-tray.tsx:91-105`); heading order page-`h1` → this `h2` → pipeline `h2`s. Displays `totalCount` near the title ("95 renewals over the next year" — the exact aggregate the spreadsheet gave them).
- `MonthBarChart` (client, `src/components/renewals/month-bar-chart.tsx`) — a `<ul>`/`role="list"` of rows; each **nonzero** bucket row is a full-width `<Link>` to `?month=<key>` (soft-nav `router.push`, **clears `?urgency`**, resets pagination cursor — mirrors `urgency-bucket-tabs.tsx:59-65`). Per row: localised `label` · bar (length ∝ `count/maxCount`, **min length ~8–12px so nonzero ≠ zero**, `ring-1 ring-inset` edge so magnitude survives low fill-contrast — 1.4.11) · numeric `count` as text (primary magnitude cue). Bands coloured per §6 tokens. **Zero-count buckets: non-interactive** (muted text, `aria-disabled`, out of tab order). **Selected bucket:** `aria-current="true"` + a non-colour affordance (ring + bolder count), not colour alone (1.4.1).
- **Urgency-tabs polish:** `urgency-bucket-tabs.tsx` `TabsTrigger` gets band colour classes per §6 (styling only). When `?month` is active the tabs render a **no-selection/"All"** state (nullable `current` or an "all" pseudo-value) so exactly one lens ever looks active.
- **Clear-filter affordance:** a dismissible chip beside the chart under a month filter — "Renewing in ธันวาคม 2569 [✕]". The ✕ is a real `<button>` with an accessible name ("Clear month filter"), keyboard-reachable; on dismiss, focus returns to the previously-selected bucket row (or the chart region). → back to default. The pipeline empty copy becomes month-aware: add `noRowsInMonth` ("No members renew in {month}") alongside the existing `noRowsInBucket` (`pipeline-table.tsx:219-220`). Wire the month filter into the existing result-count live region (`role="status" aria-live="polite"`) so SR users hear "showing N members renewing in ธันวาคม 2569".

## Best-UX / a11y / i18n requirements

- **WCAG 2.1 AA:** every interactive bucket = a keyboard-focusable link, full-row hit-area ≥44px; urgency by **colour + position + numeric count** (never colour alone, 1.4.1); `aria-current` on selected; visible focus ring (2.4.7); `<ul>/<li>` list semantics (SR "3 of 14"); bar edge for graphical-object contrast (1.4.11). Horizontal-row form means **no** focusable scroll-region is needed (deletes the tabs' `overflow-x` a11y burden).
- **i18n (en/th/sv):** title, bucket labels, `overdue`, `later`, "N members", all aria — via next-intl. **Every month label carries its year** (the window spans two Gregorian → BE years, e.g. 2026-07…2027-06; a bare "มิ.ย." is ambiguous 2569-vs-2570). **BE for th-TH via the helper, never a literal** (the v1 aria example "ธ.ค. 2026" was an off-by-543 bug — it is **2569**). `later` label is dated + localised — "ก.ค. 2570 เป็นต้นไป" / "Jul 2027 or later" / "från jul 2027" (not the vague "12+"). The `overdue` label reads unambiguously as **"past due — not yet renewed"** in all 3 locales (distinct from the tabs' `lapsed` = given up), so a staffer never conflates the red overdue bucket with the gray Lapsed tab.
- **States:** shimmer skeleton = **14 bar placeholders** matching final layout (CLS 0, motion-safe via `<Skeleton>`, mirrors `MembersWithoutCycleTraySkeleton:172-182`); empty = shared `EmptyState` primitive (`members-without-cycle-tray.tsx:107-113`), copy "No upcoming renewals", no CTA; error = "couldn't load" card (page wrapper catch), never a 500, never masking empty.
- **Consistency:** chart + polished tabs + pills share ONE colour language (§6); card chrome matches shipped cards.
- **Mobile:** 14 stacked rows (~600px) sit above the pipeline — acceptable per the shipped staff-lg+ posture (`pipeline-table.tsx` J8-M34 defers mobile). Keep zero-count rows rendered (the "0 renewals in July" signal aids planning); consider a denser row height or a collapse-to-summary on `<sm` so the chart doesn't bury the table on phones.

## Error handling

- Infra throw → propagates from the use-case → **page wrapper** try/catch renders "couldn't load" (F4). Empty (all buckets 0) is a separate render. Pipeline load is independent.
- Invalid/absent `?month` → treated as absent (F6), `urgency` honored; never a 500.
- Cross-tenant: both new paths inside `runInTenant` (RLS `SET LOCAL app.current_tenant`); foreign cycles invisible.

## Testing

- **Unit (pure):** the bucketing helper — group expiry ISO into `overdue` / rolling-12 / `later` across the **Asia/Bangkok** boundary (a `2026-12-01T00:00+07` cycle → `2026-12`, not `2026-11`; a past-expiry non-terminal → `overdue`; a `now+12mo` edge → `later`); bar-width scaling incl. the 17-vs-2 domination (min-length applied); `?month` param parse (`YYYY-MM` / `overdue` / `later` / garbage→null). Use explicit +7 / js-joda, never host-local `Date`.
- **Integration (live Neon):** `countCyclesByExpiryMonth` per-bucket counts incl. `overdueCount`/`laterCount`; **erased members excluded** (`MEMBER_NOT_ERASED_SQL`); terminal + `pending_admin_reactivation` excluded (`OPEN_CYCLE_STATUSES`); the month-filtered pipeline **suppresses the 90-day ceiling** and returns members >90 days out; the urgency `summary`/`lapsedCount` are **unchanged** by a month filter (F3); RLS isolation (second tenant never leaks).
- **Reconciliation invariant (integration, F2/U9):** for every bucket key, `bucket.count === rows returned by monthFilter=<key>` on the same seeded set — incl. `overdue`, `later`, and the current-month + `now+12mo` edges. And `sum(all buckets) === count(MONTH_PLANNING_MEMBER_SQL)` (the chart's OWN predicate — a `lapsed`-seeded row and a `pending_admin_reactivation`-seeded row must appear in NEITHER the sum nor any bucket, even though the pipeline shows lapsed).
- **Component:** `MonthBarChart` renders correct bars/counts, click → `?month=` (clears urgency), zero buckets non-interactive, selected `aria-current` + ring; `@axe-core` 0 violations; polished urgency-tabs still navigate + carry the pill-matched colours + go to "All" state under a month filter.

## File structure

```
src/modules/renewals/
  domain/renewal-month-bucket.ts                            (new: pure bucketing helper + RenewalMonthSummary VM type)
  application/use-cases/load-renewal-month-summary.ts       (new: use-case, propagates throw)
  application/use-cases/load-pipeline.ts                    (modify: validated month param, precedence, thread to rows-only)
  application/ports/renewal-cycle-repo.ts                   (modify: countCyclesByExpiryMonth + pipeline monthFilter opt)
  infrastructure/drizzle/drizzle-renewal-cycle-repo.ts      (modify: MONTH_PLANNING_MEMBER_SQL, aggregation, suppress 90d under monthFilter, summary stays on base)
  domain/value-objects/cycle-status.ts                      (reference: OPEN_CYCLE_STATUSES)
  index.ts / client.ts                                      (modify: export use-case + VM type via both barrels)
src/app/(staff)/admin/renewals/
  page.tsx                                                  (modify: read+validate ?month, render section, thread filter, clear-chip)
  _components/renewals-by-month-section.tsx                 (new: server section + 14-bar skeleton)
  _components/urgency-bucket-tabs.tsx                        (modify: pill-matched colours + "All" state under ?month)
  _components/pipeline-table.tsx                             (modify: noRowsInMonth empty copy + month-aware live region)
src/components/renewals/month-bar-chart.tsx                 (new: horizontal bar list)
src/i18n/messages/{en,th,sv}.json                           (modify: admin.renewals.byMonth.* incl. dated later label)
tests/unit/renewals/domain/renewal-month-bucket.test.ts    (new)
tests/integration/renewals/count-cycles-by-month.test.ts   (new: counts + reconciliation + erasure + 90d-suppression + summary-unchanged)
tests/unit/app/renewals/month-bar-chart.test.tsx           (new)
```
