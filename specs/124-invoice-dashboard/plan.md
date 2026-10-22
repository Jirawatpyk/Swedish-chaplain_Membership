# Plan: Invoice dashboard (`/admin/finance`)

Spec: `specs/124-invoice-dashboard/spec.md` · Size: L · Agreed by the user on: 2026-10-22 (amended the same day after the architect, financial-integrity and financial-reporting reads: spec D-d to D-h)

## Approach

- **One SQL aggregate per card, in insights infrastructure** (`invoice-dashboard-source-adapter.ts`), behind one insights port `InvoiceDashboardSource` (the shape of `WaivedRefundSource`, `src/modules/insights/application/ports/source-ports.ts:230`). The adapter reads the barrel-exported `invoicesTable` and `paymentsTable`, plus `creditNotesTable` and `refundsTable` exported the same way. Infra-to-infra schema sharing through a barrel is the documented policy (`src/modules/payments/index.ts:199-206`; precedents `renewals/infrastructure/ports-adapters/invoice-due-bridge-drizzle.ts:22`, `insights/infrastructure/sources/benefit-consumption-aggregate-adapter.ts:44`). Each query runs inside `runInTenant` with `tx` and an explicit `tenant_id` predicate (second wall), so every card reads one snapshot.
- **The tax point is one exported expression**: `invoiceTaxPointSql` from the invoicing barrel (precedent `liveMembershipBillWhere`), replacing the private `TAX_POINT` in `drizzle-invoice-repo.ts:1784`; the register, the dashboard and migration 0318 share it.
- **Per-card loaders** in insights application (`loadInvoiceDashboardTiles`, `…Aging`, `…Attention`, `…OldestOverdue`, `…Trend`, `…Methods`) share one filter parser (`domain/invoice-dashboard-filters.ts`) and one role projection; each returns its own `Result`. A card's server component renders `EmptyState tone="danger"` with the logged reference id on `err`, so one failing query never blanks the page (a React error boundary would only get a digest in production).
- **One `today` per request (slice 2)**: the aging and overdue SQL takes Bangkok today as a parameter computed once in the app (`bangkokLocalDate`), the same value the drill-down links carry, never the database's `now()`, so a figure and its link cannot straddle midnight (financial-integrity review of slice 1, L-3).
- **Six round trips, one per card**: each loader opens its own `runInTenant`; slice 3 runs them with `Promise.all`, never in sequence. The cards are six snapshots taken within one request (the page's "As of {time}" covers it); only Outstanding and aging share one query, by design. The oldest-overdue loader takes a limit: the page asks for 6 (spec US1), the phone shows 3.
- **Role cut on the server**: the page guard is `requirePagePermission('invoicing.read')` (one literal key, as `check-staff-page-guard.ts` and the nav parity test require), then `canPerform(role, 'insights.finance')`; today every holder of `invoicing.read` (admin, manager) also holds `insights.finance` (`role-bundles.ts:30-47`). `canPerform(role, 'invoicing.write')` decides actions and the two draft rows.
- **No cache** (spec D-a). The trend chart loads via `next/dynamic({ ssr: false })` like `src/components/dashboard/_mini-series-chart.tsx`.
- Not taken: aggregates as invoicing read use cases (more ports for nothing); paging `listInvoices` in JS (O(n), forbidden by the design spec); payments use cases returning per-invoice maps (unbounded `IN (...)`, no invoice filters, a separate transaction each); a port onto renewals for the auto-renewal queue (barrel cycle `renewals → insights → renewals`, the 066 class).

## Files and modules

- **Slice 1 (invoice list)**: `src/app/(staff)/admin/invoices/page.tsx` (`parseDueAfterParam`, `plan` param + active plan names for the chip), `_components/invoice-filters.tsx` (`dueAfter` and `plan` chips beside `dueBefore`), `src/modules/invoicing/application/use-cases/list-invoices.ts` (zod), `application/ports/invoice-repo.ts` (filter type), `infrastructure/repos/drizzle-invoice-repo.ts` (predicates beside `dueBefore`), `src/i18n/messages/{en,th,sv}.json`. Rule: `invoicing.md`.
- **Slice 2 (queries)**: `drizzle/migrations/0318_*.sql` + `meta/_journal.json`; `src/modules/invoicing/index.ts` (+ `creditNotesTable`, `invoiceTaxPointSql`); `drizzle-invoice-repo.ts` (register uses the export); `src/modules/payments/index.ts` (+ `refundsTable`); `src/modules/insights/domain/invoice-dashboard*.ts` (filters, aging buckets, FY ranges and month slots); `src/lib/allocate-percentages.ts` (extracted from `invoice-status-chart.tsx`; no framework imports); insights port, adapter, per-card loaders, `insights-deps.ts`, barrel; `tests/contract/insights/source-adapters-boundary.contract.test.ts` (new adapter and barrel symbols). Rules: `invoicing.md`, `payments.md` (add the money-aggregate trap: amounts from `invoices`, never `payments.amount_satang`; one method row per invoice via `DISTINCT ON`).
- **Slice 3 (page)**: `src/lib/env.ts` (`FEATURE_INVOICE_DASHBOARD` → `features.invoiceDashboard`); `src/config/nav.ts` (first Finance item, `ChartColumnIcon`, `defineGuard('invoicing.read')`, `activePattern: '/admin/finance'`, new `visibilityFlag`) + staff-layout wiring; `src/app/(staff)/admin/finance/{page,loading,error}.tsx` + `_components/*`; messages `admin.invoiceDashboard.*`, `nav.staff.invoiceDashboard`; `scripts/check-bundle-budgets.ts`; e2e spec; `docs/changelog.md`, `docs/operational-state.md`. Rules: `ui-aura.md`, `auth-rbac.md`. Gates to run early: `route-loading-no-suspending-hooks`, `rbac-coverage-config`, `nav-config` ordering, `e2e-critical-set-list`.

## Data model and migration

No new tables or columns. Migration **0318** (slice 2, `new-migration` skill; applied on dev and confirmed in `pg_indexes` before dependent code is committed; unflagged on deploy; rollback = `DROP INDEX`):
- invoices `(tenant_id, <invoiceTaxPointSql>) WHERE status IN ('paid', 'partially_credited', 'credited')`; immutability checked on dev first (fallback: partials on `(tenant_id, payment_date)` and `(tenant_id, paid_at)`).
- `credit_notes (tenant_id, issue_date)` and `refunds (tenant_id, completed_at) WHERE status = 'succeeded'`: checked in `pg_indexes`, added only if missing.
- No `(tenant_id, status, due_date)` index: the existing partial `invoices_tenant_due_date_issued_idx` serves every `status = 'issued'` query; the auto-renewal count uses `invoices_auto_renewal_draft_idx`.
- **Facts read on the dev branch (22 Oct, read-only probe, slice 2 step 0)**: `timezone(text, timestamptz)` is IMMUTABLE and a trial index on the exact tax-point expression builds, so no fallback; `credit_notes` has no `(tenant_id, issue_date)` index and `refunds` no `(tenant_id, completed_at)` one, so 0318 adds both; no void invoice carries `paid_at` or a refund; no paid-family invoice lacks both `payment_date` and `paid_at` (no footnote needed); no invoice has two payments in the method set; 61 manual credit notes, all on bank-transfer invoices; refunds are 30 `pending` + 2 `succeeded`, none `failed`.

## Slices (L only)

| # | Slice | Done-when lines it covers | Surface reviewers | Branch | PR · status |
|---|---|---|---|---|---|
| 1 | `dueAfter` and `plan` on `/admin/invoices` (additive, unflagged) | US2 lines 3–4 | financial-integrity-reviewer, enterprise-ux-designer, i18n-translation-reviewer | `124-invoice-dashboard-s1` | #617 · done |
| 2 | migration 0318, barrel exports, insights port / adapter / per-card loaders, domain helpers; the page reads nothing yet. Carried from slice 1 (maintainer, 22 Oct): the invoice-list use case checks `dueBefore` with `parseIsoCalendarDate` as it does `dueAfter`; the popover's read-only rows tie their label to the value (`role="group"` + `aria-labelledby`) | US1 lines 1–6 (figures), US3 lines 2–4 (filter semantics), US4 line 1 (projection), US6 lines 4–5 | financial-integrity-reviewer, financial-reporting-analyst, security-engineer, drizzle-migration-reviewer, performance-slo-guardian | `124-invoice-dashboard-s2` | — · open |
| 3 | flag, nav, route, filters, six cards, states, i18n, bundle budget, e2e | US1 line 7, US2 lines 1–2 and 5–6, US3 lines 1 and 5, US4, US5, US6 lines 1–3 | enterprise-ux-designer, mobile-a11y-ux-reviewer, security-engineer, i18n-translation-reviewer, thai-tax-compliance-auditor (Billed caption wording) | `124-invoice-dashboard-s3` | — · open |

Each slice is cut from `origin/main` after the previous one merged, in a short `%TEMP%` worktree with a real `pnpm install`. Slice 1 merges `origin/main` and reinstalls before Verify if the AURA 5.54 bump lands first.

## Test plan

| Done-when line | Test that goes red first (file, name) | Level |
|---|---|---|
| US2.3 `due_date >= dueAfter`; range with `dueBefore`; drafts excluded | `tests/integration/invoicing/list-invoices-origin-filter.test.ts` § dueAfter | integration |
| US2.4 `plan` keeps that plan's membership invoices only | same file § plan | integration |
| US2.3/2.4 use case rejects a malformed `dueAfter` / `plan` | `tests/unit/invoicing/list-invoices-paged-088-filters.test.ts` | unit |
| US2.3/2.4 page and use case ignore an invalid `dueAfter`; any well-formed `plan` filters, named by the id when unknown | `tests/unit/lib/iso-calendar-date.test.ts`, `tests/unit/app/invoices/plan-filter.test.ts`, use-case test | unit |
| US2.3/2.4 chips show and clear (UI: may share a commit; failing run in § Evidence) | `tests/unit/app/invoices/invoice-filters-popover.test.tsx` | unit |
| US1.3 aging edges: due today = not yet due; 30/31/60/61/90/91 | `tests/unit/insights/invoice-dashboard-domain.test.ts` | unit |
| US1.3 shares add to 100; non-zero under 1% → `<1%` | `tests/unit/lib/allocate-percentages.test.ts` (existing chart test still green) | unit |
| US3.3 FY date ranges and month slots from `fiscal_year_start_month` | domain test | unit |
| US1.1/1.3 Outstanding = Σ issued, no netting; aging from the same query adds to it | loader test + integration | unit, integration |
| US1.4 Collected on the document basis: tax point with `paid_at` fallback; CN by `issue_date`; waived refund by Bangkok `completed_at` (23:30 UTC lands in the Bangkok month); current month ignores `fy` | loader test + integration | unit, integration |
| US1.4 refund with an `invoice_voided` waiver on a void invoice → 0, not negative; offline invoice with a manual CN is netted; a succeeded refund with its CN is netted once; `f4_bridge_%` is not subtracted | integration | integration |
| US1.5 Stripe invoice → card / PromptPay; two payment rows → one method; method rows add up to the tile | integration | integration |
| US1.6 five attention counts, latest-attempt refund rule | `tests/integration/insights/invoice-dashboard-figures.test.ts` § Needs attention | integration |
| US1.6 row 5 (D-k): `pending` refund with `initiated_at` strictly older than `now − STALE_REFUND_ESCALATION_AGE_MS` counts (4 d yes; 1 d, exactly 3 d, succeeded no); filters via the refund's invoice; tenant B stays out | `tests/integration/insights/invoice-dashboard-pending-refunds.test.ts` | integration |
| US1.5 no payments row: a stored `invoices.payment_method` of `card` / `promptpay` lands on card / PromptPay, not other (characterisation, green on arrival) | `tests/integration/insights/invoice-dashboard-method-fallback.test.ts` | integration |
| Billed: CN in a later month lands in its own month; void excluded | integration | integration |
| US3.2/3.4 filters narrow every query, subtractions included; plan ⇒ membership only; bad params fall back | domain + integration | unit, integration |
| US4.1 manager projection drops draft rows and actions | loader test | unit |
| US6.5 tenant B never in tenant A figures | `tests/integration/insights/invoice-dashboard-cross-tenant.test.ts` | integration |
| new adapter and barrel symbols | `tests/contract/insights/source-adapters-boundary.contract.test.ts` | contract |
| US6.4 each query ≤ 150 ms p95 (D-h) | measured, numbers in § Evidence | perf |
| US3.2 Plan rule switches type; Events drops `plan` | finance URL-state parser test (logic: separate RED / GREEN) | unit |
| US4.3 flag off → notFound; no `insights.finance` → Page not available | page-guard test (guard: separate RED / GREEN) | unit |
| US4.3 nav guard = page guard | `tests/unit/nav/nav-permission-parity.test.ts`, `nav-config.test.ts` | unit |
| US1, US4.1/4.2 tiles, rows, link names (carrying `subject`/`plan`/`origin`), manager hides actions | component tests | unit |
| US2.1/2.2/2.5 drill-down counts match under filters; US3.1 filters change URL and cards; US4 manager | `tests/e2e/admin/invoice-dashboard.spec.ts` | e2e (chromium + mobile-chrome) |
| US6.2/6.3 axe light + dark; TH / SV | same spec, `@a11y`, `@i18n` | e2e |

## Constitution Check

- **I Data Privacy & Security** — pass: `runInTenant` + `tx` + explicit tenant predicate; cross-tenant test (slice 2); role cut on the server; gate `invoicing.read` then `insights.finance` (`sensitive: 'money'`). No new PII: buyer names and plan names already shown on `/admin/invoices`.
- **II Test-First** — pass: test plan above; money, application logic, validation and guards never share a test-and-code commit.
- **III Clean Architecture** — pass: application reads through ports; infra-to-infra schema sharing via barrels is documented policy.
- **IV PCI DSS** — pass: method labels only, no card data.
- **i18n** — pass: EN / TH / SV; Buddhist year display-only via `formatLocalisedDate`.
- **Inclusive UX** — pass: WCAG 2.1 AA, 44 px targets, both themes.
- **Perf & Observability** — pass: per-query p95 measured (D-h); bundle budget; recharts out of first-load JS; per-card failures logged with a reference id.
- **Reliability** — pass: per-card `Result`; read-only.
- **Code Quality** — pass.
- **Simplicity** — pass: zero new npm dependencies; one extraction justified by its second caller.

## Complexity Tracking

- **Slice 1 is unflagged** on a live page (two additive, read-only URL parameters). Listed as unflagged behaviours in its PR.
- **Solo-maintainer review (money surface)** — the five checks, recorded per slice in its PR: financial-integrity-reviewer, financial-reporting-analyst (slice 2), security-engineer, the cross-tenant test (slice 2), `/code-review high <pr#>`.

## Evidence

### Slice 1 (2026-10-22, branch `124-invoice-dashboard-s1`, after merging `origin/main` with AURA 5.54)

- **US2.3 `dueAfter`** — RED `ddd6b1ebb`: 5 new integration cases failed (`expected [ …(3) ] to deeply equal [ …(2) ]` and similar), unit schema / helper / chip tests failed; GREEN `2995dce45`: `tests/integration/invoicing/list-invoices-origin-filter.test.ts` 12/12 on the Neon dev branch (inclusive edge 2026-01-01, half-open range `[2025-08-16, 2026-01-02)` → only the 2026-01-01 bill, drafts excluded). Browser on the branch server: `?status=overdue&dueAfter=2026-01-01&dueBefore=2026-03-01` → 200, chips "Due from 2026-01-01" + "Due before 2026-03-01" + Clear filters; `?dueAfter=2026-02-30` → 200, no chip, unfiltered (60 results).
- **US2.4 `plan`** — RED `ddd6b1ebb` / GREEN `2995dce45` for the filter itself; the every-plan-year and event-invoice cases were added with `8a52a01ec` and `cff02bdb5` (characterisation, the event case mutation-proved); integration `planId` cases pass: only that plan's invoices, in every plan year (a 2025-year row of the same id matches), never the plan-less event invoice (mutation `OR plan_id IS NULL` turns the case red), composes with `dueAfter` and derived overdue. D-i (unknown id still filters): RED `e593166c6` "an id this year's plans do not know still filters" → `expected undefined to deeply equal { id: 'gold-2025', … }`; GREEN `8a52a01ec`. Browser: `?plan=diamond` → chip "Plan: Diamond Partnership", TH "แพ็กเกจ: พาร์ทเนอร์ระดับเพชร", SV "Paket: Diamond partnerskap"; `?plan=gold-2019` → chip "Plan: gold-2019", 0 results. Manager sees the same chips.
- **Boundary** (financial-integrity review): a bill due on Bangkok today is in `status=issued&dueAfter=today` and not in `status=overdue` (integration, 13/13 in the file on the final HEAD).
- **D-023 UI commit** `b8268f791` (Clear filters counts `dueAfter` / `plan`, not an absent date): failing run first — "dueAfter alone, or a plan alone, still offers Clear filters" → `Unable to find role button "Clear filters"`; the regression it closes was caught by `tests/unit/app/portal/invoices/invoice-filters-props.test.tsx` (2 failures in the first coverage run, passing again after the fix; the same file passes 14/14 against `main`'s component).
- **Review fixes**: use case drops a non-calendar `dueAfter` (RED `cb2e7dd07` → `expected '2026-02-30' to be undefined`; GREEN `d28372949`). UI commit `6c367c706` (D-023): popover row's button named "Clear {label}" (failing run: `Unable to find role button "Clear Due before 2026-01-01"`), focus moves to the search box after it (browser: `INPUT[type=search]`), phone "Filters (n)" leaves out URL-only chips (browser: "Filters (1)" with Status + three chips; was 3). `listPlanNames` (RED `3c57e7dd3` → `listPlanNames is not a function`; GREEN `cff02bdb5`): no tax read, deleted plans included, lookup runs alongside the list read.
- **Gates on `cff02bdb5`**: `pnpm check` exit 0; `pnpm test:coverage` 1764/1764 files, exit 0; `pnpm vitest run tests/contract/` 254/254 files.
- **e2e on `cff02bdb5` (branch server on :3401, attach config, workers 1)**: `invoice-admin-a11y` chromium 2/2, mobile-chrome 2/2; `admin-payment-reconciliation-view` chromium 4/4, mobile-chrome 4/4.
- **UI probes**: 320 px phone with three chips → `innerWidth` 320, `scrollWidth` 305; 390 px with four chips → `scrollWidth` 375; EN, TH and SV render with no `MISSING_MESSAGE`.
- **Unflagged behaviours (slice 1)**: `?dueAfter=` and `?plan=` on `/admin/invoices` for admin and manager; both additive and read-only.

## Rollout

1. Slices merge in order, each on the user's word (D-006). Each is safe to deploy alone: slice 1 is additive, slice 2 is a migration plus unused code, slice 3 is behind `FEATURE_INVOICE_DASHBOARD` (default off).
2. Turning the flag on is a production deploy (D-007): only on the user's word, recorded in `docs/operational-state.md`.
3. Follow-up issue: the CSV export labels a refunded Stripe invoice "other". (The `dueBefore` use-case check moved into slice 2.)

## Risks

- The home chart and this page's chart disagree by design: home is ex-VAT, nets credit notes into the paid month, and falls back to `issue_date`; this page is incl. VAT and nets in the document's month. Captions say so; neither is "fixed".
- Billed for a past month changes when one of its invoices is voided (D-e); the caption says so.
- A refund Stripe paid out whose credit note was not booked overstates Collected until the hourly sweep books it; Needs attention counts refunds pending more than 3 days (D-k).
- Under RLS the tax-point date range runs as a Filter after `invoices_tenant_tax_point_paid_idx` narrows by tenant and status (`timezone()` is not leakproof, so it cannot be an index condition; the register's `TAX_POINT` has always behaved so). Accepted at SweCham's volume (Collected 13 ms server p95 at 2k invoices); the leakproof rewrite (separate `payment_date` / `paid_at` ranges + two partial indexes) is the fix if volume grows.
- The boards predate decisions 10 and D-d to D-h: read the 7 `.dc.html` files at slice 3 before claiming parity; captions and the attention rows will differ.
- Measuring at volume on the shared dev tenant would burn §87 numbers and leak rows: a disposable tenant created and deleted in the run (D-h).
- CI's live-Neon suites run about 7× slower than a workstation: no explicit per-test timeouts.
- A tenant's first queries before autovacuum has ANALYZEd its rows see `rows=1` estimates and nested loops over its whole paid set: measured at 2k invoices, Collected FY ~55–61 ms and By method / monthly ~115–125 ms (about 30× the analysed figures, still under D-j's 150 ms). It grows with volume until autoanalyze runs; a new tenant's import should be followed by `ANALYZE` on invoices, credit_notes, payments and refunds (slice 2 review fixes, 22 Oct).
