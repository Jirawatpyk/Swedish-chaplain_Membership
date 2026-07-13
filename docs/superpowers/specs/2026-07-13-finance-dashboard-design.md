# Finance Dashboard (`/admin/finance`) — Design

**Date**: 2026-07-13
**Branch**: `058-finance-dashboard`
**Status**: Approved (brainstorming gate)
**Feature id**: F10 candidate — read-only financial overview for the treasurer/board persona

---

## 1. Problem

`manager` has been defined since F1 as "senior staff / treasurer / board — **read-only access to
financial reports & dashboards**". That surface was never built. Today the money in Chamber-OS is
spread across three unconnected list screens (`/admin/invoices`, `/admin/credit-notes`,
`/admin/renewals`) and one mixed-purpose home dashboard (`/admin`, F9) whose single money KPI is
year-to-date paid revenue.

Nobody can answer, in one screen: **how much did we bill, how much did we collect, how much is
stuck, who is it stuck with, and is it getting better?**

## 2. Scope

A new read-only page at `/admin/finance`, the first item of the existing **Finance** nav section
(above Invoices and Credit Notes). Period control: **fiscal year only** (`?fy=2026`, default =
current FY, derived from the tenant's `fiscalYearStartMonth` in Asia/Bangkok — SweCham's FY is the
calendar year).

**In scope (v1)**

1. Cash position KPI cards — Billed, Collected, Outstanding, Overdue, Collection rate
2. AR aging (0–30 / 31–60 / 61–90 / 90+) + top-debtors table
3. Billed vs Collected 12-month trend
4. Revenue mix (by plan tier, membership vs event) + leakage (credit notes, refunds) + payment-method mix

**Out of scope (explicitly v2+)**

- Actionable collections work-queue (chase / send reminder / mark paid from this page). The page is
  read-only in v1; the actions live on `/admin/invoices` where they already are.
- ภ.พ.30 VAT-filing export. The VAT *bridge stat* below is a display number, not a filing artefact.
  A filing surface needs accountant sign-off (see the open items in `project_088_whole_feature_review`).
- Quarter/month narrowing inside a FY, and free date-range pickers.
- Budget vs actual, forecasting from the renewal pipeline.

## 3. The money-basis decision (the load-bearing one)

VAT is not the chamber's money — it is collected on behalf of the Revenue Department and remitted.
But the amount you *chase* from a member is the VAT-inclusive total printed on the invoice. Those
are two different units, and every accounting system in the world reports them separately: **AR is
gross, P&L revenue is net**.

The page therefore uses **two bases, one per zone**, never mixed inside a zone:

| Zone | Basis | Blocks |
|------|-------|--------|
| **Cash & Receivables** | **Gross** (VAT-inclusive), net of credit notes | Billed · Collected · Outstanding · Overdue · Collection rate · Billed-vs-Collected trend · AR aging · Top debtors · Payment-method mix · Leakage (credit notes, refunds) |
| **Revenue** | **Ex-VAT**, net of credit notes | Revenue by plan tier · Membership vs Event |

Between the two zones sits a **VAT bridge stat** that makes the difference reconcile on screen
rather than look like a contradiction:

> **VAT collected ฿64,150** — held for the Revenue Department
> (Collected ฿0.98M = Revenue ฿0.92M + VAT ฿0.06M)

The bridge is also an invariant the tests enforce:

```
collectedGross === revenueExVat + vatCollected      (± rounding, per invoice)
```

Each zone header carries a unit badge ("รวม VAT" / "ไม่รวม VAT"). No individual card is ambiguous
about its unit.

**Consistency with F9**: the `/admin` home KPI (`ytdPaidRevenueSatang`) is ex-VAT, net of credit
notes, scaled by each invoice's own `subtotal / total` ratio
(`src/modules/insights/infrastructure/sources/invoice-source-adapter.ts`). The Revenue zone reuses
**exactly** that definition, so the two pages agree. The Cash zone deliberately differs, and the
bridge stat explains why.

**Why the per-invoice ratio, not a flat 7%**: `invoices.vatTreatment` is
`standard | zero-rated | exempt`, so the ex-VAT share is not uniform across invoices. Reusing the
existing per-invoice ratio keeps zero-rated and exempt invoices correct.

## 4. Metric definitions

All figures are scoped to one tenant (RLS) and one fiscal year. Money is `bigint` satang end to end;
formatting to a locale string happens only in the presentation layer.

Invoice statuses: `draft | issued | paid | void | credited | partially_credited`.
Drafts and voids are excluded from every figure — a draft is not a receivable and a void never was.

| Metric | Definition |
|--------|-----------|
| **Billed** (gross) | `Σ (total − creditedTotal)` over invoices with `fiscalYear = FY` and status ∈ {issued, paid, credited, partially_credited} |
| **Collected** (gross) | The same sum restricted to the settled set — F9's `PAID_REVENUE_STATUSES` = {paid, partially_credited, credited} (see the invariant below) |
| **Outstanding** (gross) | `Billed − Collected` — equivalently `Σ total` over status `issued`, since an `issued` invoice can carry no credit |
| **Overdue** (gross) | Outstanding where `dueDate < today` (tenant tz). Due **today** is NOT overdue. |
| **Collection rate** | `Collected / Billed`. Guard: Billed = 0 → render "—", never `NaN`/`0%`. |
| **AR aging buckets** | Outstanding split by `today − dueDate` in days: 0–30, 31–60, 61–90, 90+. Bucket edges are inclusive-low/inclusive-high; a 30-day-old invoice is in 0–30, a 31-day-old one is in 31–60. Invoices not yet due sit outside the buckets (they are Outstanding but not aged). |
| **Top debtors** | Members ranked by outstanding gross desc, then oldest `dueDate` asc. Returns member id, member number (`SCCM-NNNN`), display name, outstanding gross, oldest due date, unpaid invoice count. Limit 10. |
| **Billed vs Collected trend** | 12 months back from the FY end (or today if the FY is current), keyed `YYYY-MM` in tenant tz. Billed bucketed by `issueDate`, Collected by `paidAt`. Months with no rows render 0, not a gap. |
| **Payment-method mix** | Gross collected split by `payments.method` (`card`, `promptpay`) plus **offline** — invoices settled without a `payments` row (`invoices.paymentMethod`, i.e. bank transfer / cash recorded by an admin). The three must sum to Collected. |
| **Revenue by tier** (ex-VAT) | Ex-VAT, credit-netted revenue grouped by `planId` (label from the F2 plan catalogue). |
| **Membership vs Event** (ex-VAT) | Same measure grouped by `invoices.invoiceSubject` (`membership` \| `event`). |
| **Leakage** | Credit notes issued in the FY (count + gross total) and refunds (`refunds` where `status = succeeded`, count + gross) plus the count of refunds currently `pending` or `failed` — the latter is an operational signal from the F5 refund lifecycle. |
| **VAT collected** | `Σ vat` over settled invoices, net of credit-note VAT. This is the bridge stat. |

**Fiscal-year windowing**: use the `invoices.fiscalYear` column that the §87 allocator already
stamps at issue time — never `EXTRACT(YEAR FROM issue_date)`. A non-January-FY tenant would be
silently mis-windowed otherwise (the bug F9 #4 already fixed once).

**The settled-set invariant** (load-bearing — it is why "Collected" may be decided by status alone):
`issue-credit-note` gates on invoice status ∈ {`paid`, `partially_credited`}
(`src/modules/invoicing/application/use-cases/issue-credit-note.ts`), so an **unpaid** invoice can
never reach `credited` / `partially_credited`. Every invoice in `PAID_REVENUE_STATUSES` therefore has
money against it, and status-based Collected ≡ `paidAt IS NOT NULL`.

If that gate is ever relaxed (e.g. to allow a §86/10 price-reduction credit note against an unpaid
bill), an unpaid-but-partially-credited invoice would start counting as **collected cash that was
never received**. An integration test asserts the gate, so the assumption fails loudly instead of
silently inflating the dashboard.

## 5. Architecture

Approach chosen: **live aggregate queries**, no cache table, no cron.

Rejected — **snapshot cache table** (mirroring F9's `dashboard_metrics_cache` + a cron refresh):
staleness on a money surface is a real credibility risk (the board asks why the dashboard disagrees
with the invoice list), and it costs a migration plus another cron-job.org endpoint for a dataset of
~131 members and a few hundred invoices a year. Rejected — **Next 16 `use cache` + `cacheTag`**:
correctness then depends on tagging *every* path that moves money (issue, void, mark-paid, Stripe
webhook, refund, credit note); the Stripe webhook runs outside the request scope, so one missed tag
leaves stale money on screen. If the dataset ever outgrows live aggregation, `use cache` can be
layered on later **without a schema change** — that upgrade path is why the cache table is not worth
paying for now.

The feature extends the existing **`insights`** bounded context (the reporting context — it already
owns an `InvoiceSource` port and RLS-safe tenant adapters). A new `src/modules/finance/` module
would duplicate that port surface for no gain (Constitution X, Simplicity).

```
src/modules/insights/
├── domain/finance-overview.ts                       # VOs + pure policy
├── application/ports/finance-source.ts              # new port (7 methods)
├── application/use-cases/compute-finance-overview.ts # orchestration (Promise.all)
└── infrastructure/sources/finance-source-adapter.ts  # Drizzle SQL aggregates
```

**Domain** (`finance-overview.ts`) — pure, zero framework imports:
`CashPosition`, `AgingBuckets`, `Debtor`, `TrendPoint`, `PaymentMethodMix`, `RevenueMix`,
`Leakage`, `VatBridge`, `FinanceOverview`; plus the policy functions
`bucketForDaysPastDue()`, `collectionRate()` (zero-guard), `netOfCredit()`, `exVatOf()`,
`reconcile()` (the bridge invariant).

**Port** (`finance-source.ts`) — 7 methods, each taking `(ctx: TenantContext, fiscalYear: number)`:
`getCashPosition`, `getAgingBuckets`, `getTopDebtors`, `getMonthlyBilledVsCollected`,
`getPaymentMethodMix`, `getRevenueMix`, `getLeakage`. VAT-collected rides on `getCashPosition` (it
comes from the same scan).

**Adapter** — Drizzle SQL aggregates against `invoices`, `credit_notes`, `payments`, `refunds`.
Existing indexes cover it: `invoices_tenant_status_issued_idx`, `invoices_tenant_due_date_issued_idx`,
`invoices_tenant_member_status_idx`, `payments_tenant_invoice_status_idx`.

> **RLS gotcha (mandatory)**: every query must run on the `tx` threaded from `runInTenant(ctx, …)`.
> A repo method that reaches for the pool-global `db` singleton gets a connection without
> `SET LOCAL app.current_tenant` and silently bypasses RLS. This is the F7.1a US2 incident.

**Use case** — fans the port calls out with `Promise.all`, applies domain policy, returns
`FinanceOverview`. No ORM, no framework imports.

## 6. Presentation

```
src/app/(staff)/admin/finance/
├── page.tsx        # RSC — parses ?fy + ?bucket, calls the use case
└── loading.tsx     # shimmer skeleton (ux-standards § 2.1)

src/components/finance/
├── cash-position-cards.tsx     # reuses <KpiCard/> from src/components/dashboard/
├── billed-vs-collected-chart.tsx
├── ar-aging-chart.tsx          # follows the F8 month-bar-chart pattern
├── top-debtors-table.tsx
├── payment-method-mix.tsx
├── leakage-summary.tsx
├── vat-bridge-card.tsx
├── revenue-mix.tsx
└── fy-selector.tsx
```

**URL state**: `?fy=2026` (fiscal year) and `?bucket=31-60` (narrows the top-debtors table). Both are
server-parsed; unknown values fall back to the default rather than erroring.

**Drill-down** — every number is a door:

| Element | Target |
|---------|--------|
| Overdue KPI card | `/admin/invoices?status=overdue` (already exists) |
| AR aging bar | `?bucket=<edge>` on the same page — narrows the top-debtors table |
| Top-debtor row | `/admin/invoices?memberId=<id>` |

`listPaged` in `drizzle-invoice-repo.ts` **already supports** a `memberId` filter; only the
`/admin/invoices` page needs to parse the param (~5 lines on a shipped surface). No repo change.

**Nav**: a new first entry in the existing Finance section of `src/config/nav.ts`
(`nav.staff.financeOverview` → `/admin/finance`, `activePattern: 'exact:/admin/finance'`).

**Layout**: standard `PageHeader` + page container, so `pnpm check:layout` passes.

## 7. Access control + kill switch

- New `Resource` id **`'finance'`** in `src/modules/auth/domain/policies.ts`. The baseline rules
  already give the right answer with no special-casing: admin → all actions; manager → `read` only;
  member → denied. The page is read-only, so `manager` and `admin` see the identical screen.
- Feature flag **`FEATURE_FINANCE_DASHBOARD`** (zod-validated in `src/lib/env.ts`, default `false`).
  When off: the page returns `notFound()` **and** the nav entry is hidden. Rationale: this screen
  publishes money figures to the board — if a number is wrong it must be pullable in ~30 seconds
  without a deploy.

## 8. Empty, error, and edge states

- **Zero-data tenant is the realistic first render** — production was wiped clean (2026-06-24,
  re-wiped 2026-07-12) and member import is incomplete. Each zone gets a purposeful empty state, not
  a wall of `฿0`.
- **No invoices in the selected FY** but data in others → empty state that names the FY and offers
  the nearest FY that has data.
- **Billed = 0** → collection rate renders "—".
- Errors bubble to the existing `(staff)/admin/error.tsx` boundary.

## 9. Accessibility + i18n

- Every chart ships a **visually-hidden data table** so a screen reader gets the numbers, not the
  SVG. (Lesson from PR #181: `/code-review` caught an a11y scroll-region issue the design pass
  missed.)
- Chart bars are focusable links where they are drill-downs; ≥24×24px targets (WCAG 2.2 SC 2.5.8).
- WCAG 2.1 AA — axe scan in E2E.
- **EN + TH + SV from the first commit** (`pnpm check:i18n` gate). Money formats per locale, THB
  primary. Buddhist Era is display-only on `th-TH`; never stored.

## 10. Testing (TDD — red first)

| Layer | Coverage |
|-------|----------|
| **Domain unit** (100% line) | Bucket edges (due today ⇒ not overdue; day 30 vs day 31), `collectionRate` zero-division, credit-note netting, ex-VAT ratio on zero-rated/exempt invoices, `reconcile()` bridge |
| **Application unit** (80%+ line/branch) | `compute-finance-overview` against a fake `FinanceSource`, including the throw path of a failing source (a rejected `Promise.all` member must not blank the whole page silently) |
| **Contract** | One file per port method — shape + tenant-scoping |
| **Integration (live Neon `dev` branch)** | Seed invoices across every status, two fiscal years, credit notes, refunds, offline + online payments → assert each aggregate. **Plus the mandatory cross-tenant probe** (Principle I — a Review-Gate blocker without it). **Plus a guard test on the settled-set invariant** (§4): a credit note against an unpaid `issued` invoice must be rejected — if that ever starts passing, Collected is silently wrong. |
| **Invariant** | `collectedGross === revenueExVat + vatCollected` and `sum(aging buckets) + notYetDue === outstanding` — the same reconciliation discipline that PR #181 used |
| **E2E** | admin sees the page · manager sees it read-only · member is denied · flag off ⇒ 404 · axe scan · TH/SV locale render |

## 11. Risks

| Risk | Mitigation |
|------|-----------|
| Two money bases confuse the reader | Zone-level unit badges + the VAT bridge stat that reconciles them on screen |
| Numbers disagree with `/admin` home | Revenue zone reuses F9's exact ex-VAT definition; the Cash zone's difference is explained by the bridge |
| Live aggregation gets slow at scale | Indexes already exist; `use cache` is a drop-in upgrade with no schema change |
| RLS bypass via the global `db` singleton | Adapter threads `tx` from `runInTenant`; cross-tenant probe test in CI |
| Touching the shipped `/admin/invoices` page | Change is limited to parsing one already-supported repo filter (`memberId`); covered by an E2E drill-down assertion |
