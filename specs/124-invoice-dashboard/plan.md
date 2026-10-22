# Plan: Invoice dashboard (`/admin/finance`)

Spec: `specs/124-invoice-dashboard/spec.md` · Size: L · Agreed by the user on: 2026-10-22

## Approach

- **Queries are SQL aggregates in insights infrastructure**, behind one new insights port `InvoiceDashboardSource` (the shape of `WaivedRefundSource`, `src/modules/insights/application/ports/source-ports.ts:230`). Invoices are read through the barrel-exported `invoicesTable` (precedent: `src/modules/renewals/infrastructure/ports-adapters/invoice-due-bridge-drizzle.ts:22`); `creditNotesTable` gets the same barrel export. Payments-owned data (the `refunds` table is not exported) comes through new payments **use cases** on the payments barrel, as `listWaivedRefundTotalsByInvoice` does (Principle III). The auto-renewal queue count comes through an insights port onto the renewals barrel's `readAutoInvoiceGaugeRow`. Every query runs inside `runInTenant` with `tx` plus an explicit `tenant_id` predicate (second wall).
- **Use case `loadInvoiceDashboard`** (insights application) composes the figures for the four filters and **cuts per role on the server** (`canWrite`: actions, draft and auto-renewal rows), as `listDashboard` does with `canFinance`.
- **Page**: server-rendered; each card in its own `<Suspense>` and error boundary so one failing query never blanks the page; the trend chart via `next/dynamic({ ssr: false })` like `src/components/dashboard/_mini-series-chart.tsx`. No cache (spec D-a).
- Not taken: aggregates as invoicing read use cases (more ports for no gain, `invoicesTable` is already exported); paging `listInvoices` in JS (forbidden by the design spec, O(n)); widening `listSucceededPaymentMethods` (it also feeds the CSV export, whose meaning would change).

## Files and modules

- **Slice 1 (invoicing list)**: `src/app/(staff)/admin/invoices/page.tsx` (`parseDueAfterParam` beside `parseDueBeforeParam`), `_components/invoice-filters.tsx` (chip beside the `dueBefore` chip), `src/modules/invoicing/application/use-cases/list-invoices.ts` (zod), `src/modules/invoicing/application/ports/*` list filter type, `src/modules/invoicing/infrastructure/repos/drizzle-invoice-repo.ts` (predicate beside `dueBefore`), `src/i18n/messages/{en,th,sv}.json` (`filters.dueAfter.chip`). Rule: `invoicing.md`.
- **Slice 2 (queries)**: `drizzle/migrations/0318_*.sql` + `meta/_journal.json`; payments use cases `list-collected-payment-methods`, `sum-succeeded-refunds-by-month`, `count-failed-refunds` + repo methods + barrel exports; `src/modules/invoicing/index.ts` (+ `creditNotesTable`); `src/modules/insights/domain/invoice-dashboard.ts` (aging buckets, FY month slots); `src/lib/allocate-percentages.ts` (extracted from `invoice-status-chart.tsx`); insights ports, `application/use-cases/load-invoice-dashboard.ts`, `infrastructure/sources/invoice-dashboard-source-adapter.ts`, `insights-deps.ts` (`makeLoadInvoiceDashboardDeps`), insights barrel. Rules: `invoicing.md`, `payments.md` (add the money-aggregate trap: never sum `payments.amount_satang`; one method row per invoice). Cross-module ports touched: payments barrel, renewals barrel — grep `tests/` for each changed symbol.
- **Slice 3 (page)**: `src/lib/env.ts` (`FEATURE_INVOICE_DASHBOARD` → `features.invoiceDashboard`); `src/config/nav.ts` (first Finance item, `ChartColumnIcon`, `defineGuard('invoicing.read')`, `activePattern: '/admin/finance'`, new `visibilityFlag`) + staff-layout wiring; `src/app/(staff)/admin/finance/{page,loading,error}.tsx` + `_components/*`; messages `admin.invoiceDashboard.*`, `nav.staff.invoiceDashboard`; `scripts/check-bundle-budgets.ts`; e2e spec; `docs/changelog.md`, `docs/operational-state.md`. Rules: `ui-aura.md`, `auth-rbac.md`.

## Data model and migration

No new tables or columns. Migration **0318** (slice 2, `new-migration` skill; applied on dev and confirmed in `pg_indexes` before dependent code is committed; unflagged on deploy; rollback = `DROP INDEX`):
- invoices `(tenant_id, COALESCE(payment_date, (paid_at AT TIME ZONE 'Asia/Bangkok')::date)) WHERE status IN ('paid', 'partially_credited', 'credited')` — the expression copied character for character from `TAX_POINT` (`drizzle-invoice-repo.ts:1784`) and used identically in the query; immutability checked on dev first (fallback: partials on `(tenant_id, payment_date)` and `(tenant_id, paid_at)`).
- `credit_notes (tenant_id, issue_date)` and `refunds (tenant_id, completed_at) WHERE status = 'succeeded'`: checked in `pg_indexes`; added only if missing and EXPLAIN shows a seq scan at the measured volume.
- No `(tenant_id, status, due_date)` index: the existing partial `invoices_tenant_due_date_issued_idx` serves every `status = 'issued'` query (EXPLAIN in § Evidence).

## Slices (L only)

| # | Slice | Done-when lines it covers | Surface reviewers | Branch | PR · status |
|---|---|---|---|---|---|
| 1 | `dueAfter` on `/admin/invoices` (additive, unflagged) | US2 line 3 | financial-integrity-reviewer, enterprise-ux-designer, i18n-translation-reviewer | `124-invoice-dashboard-s1` | — · open |
| 2 | migration 0318, payments use cases, insights port / adapter / use case, domain helpers; the page reads nothing yet | US1 lines 1–6 (figures), US3 lines 2–4 (filter semantics), US4 line 1 (projection), US6 lines 4–5 | financial-integrity-reviewer, financial-reporting-analyst, security-engineer, drizzle-migration-reviewer, performance-slo-guardian | `124-invoice-dashboard-s2` | — · open |
| 3 | flag, nav, route, filters, six cards, states, i18n, bundle budget, e2e | US1 line 7, US2 lines 1–2 and 4, US3 lines 1 and 5, US4, US5, US6 lines 1–3 | enterprise-ux-designer, mobile-a11y-ux-reviewer, security-engineer, i18n-translation-reviewer | `124-invoice-dashboard-s3` | — · open |

Slice 2 does not start its queries until spec OQ1–OQ3 are answered. Each slice is cut from `origin/main` after the previous one merged, in a short `%TEMP%` worktree with a real `pnpm install`.

## Test plan

| Done-when line | Test that goes red first (file, name) | Level |
|---|---|---|
| US2.3 `dueAfter` parse/validate; invalid ignored like `dueBefore` | `tests/unit/invoicing/…` page param parser | unit |
| US2.3 `due_date >= dueAfter`; range with `dueBefore` | `tests/integration/invoicing/list-invoices-due-after.test.ts` | integration |
| US2.3 list accepts `dueAfter` | `tests/contract/` invoice-list params | contract |
| US2.3 chip shows and clears (UI: may share a commit, failing run recorded in § Evidence) | `invoice-filters` component test | unit |
| US1.3 aging edges: due today = not yet due; 30/31/60/61/90/91 | `tests/unit/insights/invoice-dashboard-domain.test.ts` | unit |
| US1.3 shares add to 100; non-zero under 1% → `<1%` | `tests/unit/lib/allocate-percentages.test.ts` (existing chart test still green) | unit |
| US3.3 FY range and month slots from `fiscal_year_start_month` | domain test | unit |
| US1.1 Outstanding = Σ issued, no netting | `load-invoice-dashboard` use-case test + integration | unit, integration |
| US1.4 Collected by tax point with `paid_at` fallback; refunds by `completed_at`, waived included; current month ignores `fy` | use-case test + integration | unit, integration |
| US1.5 Stripe invoice → card / PromptPay; a retried payment counted once | payments use-case integration + contract | integration, contract |
| US1.6 needs-attention counts | integration | integration |
| Trend: credit note in a later month lands in its own month; void per OQ2 | integration | integration |
| US3.2/3.4 filters narrow every query; plan ⇒ membership only; bad params fall back | use-case test + integration | unit, integration |
| US4.1 manager projection drops draft / auto-renewal rows | use-case test | unit |
| US6.5 tenant B never in tenant A figures | `tests/integration/insights/invoice-dashboard-cross-tenant.test.ts` | integration |
| US6.4 each query ≤ 150 ms p95 (volume per OQ3, disposable tenant) | measured, numbers in § Evidence | perf |
| US3.2 Plan rule switches type; Events drops `plan` | finance URL-state parser test (logic: separate RED / GREEN) | unit |
| US4.3 flag off → notFound; no `insights.finance` → Page not available | page-guard test (guard: separate RED / GREEN) | unit |
| US4.3 nav guard = page guard | `tests/unit/nav/nav-permission-parity.test.ts`, `nav-config.test.ts` | unit |
| US1, US4.1/4.2 tiles, rows, link names, manager hides actions | component tests | unit |
| US2.1/2.2 drill-down counts match; US3.1 filters change URL and cards; US4 manager | `tests/e2e/admin/invoice-dashboard.spec.ts` | e2e (chromium + mobile-chrome) |
| US6.2/6.3 axe light + dark; TH / SV | same spec, `@a11y`, `@i18n` | e2e |

## Constitution Check

- **I Data Privacy & Security** — pass: `runInTenant` + `tx` + explicit tenant predicate; cross-tenant test (slice 2); role cut on the server; gate `invoicing.read` + `insights.finance` (`sensitive: 'money'`). No new PII: buyer names already shown on `/admin/invoices`.
- **II Test-First** — pass: test plan above; money, application logic and guards never share a test-and-code commit.
- **III Clean Architecture** — pass with one tracked deviation (below).
- **IV PCI DSS** — pass: method labels only, no card data.
- **i18n** — pass: EN / TH / SV; Buddhist year display-only via `formatLocalisedDate`.
- **Inclusive UX** — pass: WCAG 2.1 AA, 44 px targets, both themes.
- **Perf & Observability** — pass: per-query p95 measured; bundle budget; recharts out of first-load JS.
- **Reliability** — pass: per-card error boundary with reference id; read-only.
- **Code Quality** — pass.
- **Simplicity** — pass: zero new npm dependencies; one extraction justified by its second caller.

## Complexity Tracking

- **Insights infrastructure reads `invoicesTable` / `creditNotesTable`** instead of going through invoicing use cases. Simpler alternative rejected: paging `listInvoices` in JS (forbidden by the design spec; O(n)). Precedent: the renewals bridge.
- **Slice 1 is unflagged** on a live page (an additive, read-only URL parameter). Listed as an unflagged behaviour in its PR.
- **Solo-maintainer review (money surface)** — the five checks, recorded per slice in its PR: financial-integrity-reviewer, financial-reporting-analyst (slice 2), security-engineer, the cross-tenant test (slice 2), `/code-review high <pr#>`.

## Evidence

(one line per Done-when line, added per slice)

## Rollout

1. Slices merge in order, each on the user's word (D-006). Each is safe to deploy alone: slice 1 is additive, slice 2 is a migration plus unused code, slice 3 is behind `FEATURE_INVOICE_DASHBOARD` (default off).
2. Turning the flag on is a production deploy (D-007): only on the user's word, recorded in `docs/operational-state.md`.
3. Follow-up issues: home revenue chart onto the tax point; CSV export labels refunded Stripe invoices "other"; the design spec's tile candidates.

## Risks

- The home and this page's monthly charts disagree by design (decision 5); captions say so; neither is "fixed".
- The expression index is unused if the query's expression drifts: EXPLAIN in the integration evidence.
- The boards predate decision 10 (22 Oct): read the 7 `.dc.html` files at slice 3 before claiming parity.
- Measuring at volume on the shared dev tenant would burn §87 numbers and leak rows: measure on a disposable tenant created and deleted in the run (spec OQ3).
- CI's live-Neon suites run about 7× slower than a workstation: no explicit per-test timeouts.
