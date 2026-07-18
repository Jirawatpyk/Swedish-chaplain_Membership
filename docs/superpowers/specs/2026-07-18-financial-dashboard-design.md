# Financial Dashboard (`/admin/finance`) — Design

**Date:** 2026-07-18 · **Module:** `src/modules/insights` (extension, no new bounded context)
**Status:** Design — approved through § 3 in brainstorming. § 4 (testing/rollout) written with the doc, pending review.

## Goal

Give the **treasurer and the board** one surface that answers a single question —
*"are we financially healthy?"* — from the revenue side of the business, with
enough slicing to answer the follow-up questions that always come next.

Chamber-OS has no expense, bank-balance, or general-ledger data. This page is
therefore a **management view of receipts and receivables**, not a financial
statement. That limitation is stated on the page itself, not just in this doc.

## Users and access

| Role | Access |
|---|---|
| `admin` | read the dashboard; set the annual revenue target |
| `manager` | read the dashboard (existing `canAccess(role, …, 'read')` already allows this — no policy change) |
| `member` | no access |

No changes to `src/modules/auth/domain/policies.ts` are required. The page
guards on `finance:dashboard` + `read`; the target form guards on `write`.

## Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Revenue basis | **Cash** — money actually received | Matches the existing `ytdPaidRevenueSatang` KPI and the 088 tax-at-payment model (the §86/4 receipt is issued at payment), so the dashboard and the tax register can be reconciled. |
| 2 | Data scope | Revenue side **+ an annual revenue target** | No expense module exists. A single target is the cheapest addition that turns raw figures into a judgement the board can act on. |
| 3 | Surface | **New page `/admin/finance`** | `/admin` home stays an operational overview. Follows the `/admin/invoices/registers` precedent: a separate, purpose-built page carries zero regression risk to the hot-path surfaces. |
| 4 | Interaction model | **Narrative order (A) + filters and drill-through (B)** | The five sections read top-to-bottom as a board briefing, but a sticky filter bar and click-to-cross-filter let the treasurer answer follow-ups without leaving the page. |
| 5 | Filter state | **Encoded in the URL** | Makes any view reproducible — the URL can be pasted into a board agenda and everyone sees the same figures. Removes the main objection to a filtered dashboard. |
| 6 | Compute | **Live query per request**, no snapshot cache | Free filtering makes precomputation combinatorial. At TSCC scale (~110 members, ~200 invoices/year) the aggregates are single-digit milliseconds. |
| 7 | Target granularity | **One figure per fiscal year** | Per-month or per-tier targets multiply the data-entry burden ninefold for a board that sets one number. Monthly pacing is *derived*, not entered — see § Pacing. |
| 8 | Board pack export | **CSV + print stylesheet**, no new PDF renderer | The board pack is an internal document, not a tax document. `Ctrl+P` on a print-styled page produces the same artefact for a fraction of the code. A true PDF stays available as a later addition. |
| 9 | Concentration panel | **Show member names** | Staff-only surface that both roles can already read across the member directory. The board needs to know *who* the concentration is in for the figure to be actionable. |

### Rejected alternatives

- **Composite "financial health score" (0–100).** Rejected: a score with no
  accounting standard behind it cannot be defended to a board ("why 72 and not
  80?"), and movements in it are not diagnosable. Vanity metric.
- **Snapshot cron like `/admin` home.** Rejected under Decision 6. Retained as
  the documented escape hatch: if a tenant exceeds ~50k invoices, add a rollup
  table (month × tier × channel × status) and let filters aggregate from it.
  This changes only the infrastructure layer — use-cases are unaffected.
- **Extending `/admin` home instead of a new page.** Rejected: home would grow
  past a scannable length and would serve two audiences with different jobs.

## Architecture

### Module placement

The metrics span `invoicing`, `payments`, `members`, `renewals`, and `plans`.
Reading across bounded contexts for a derived read-model is exactly what
`src/modules/insights` exists for, and it already has the port pattern for it
(`application/ports/source-ports.ts`). A twelfth module would duplicate that
machinery and add a Principle III surface for no benefit.

```text
src/modules/insights/
├── domain/
│   ├── finance-metrics.ts        # value objects: AgingBucket, ChannelSlice, TierRevenue, …
│   └── revenue-target.ts         # RevenueTarget VO + pacing calculation (pure)
├── application/
│   ├── ports/finance-source.ts   # read ports over invoicing/payments/renewals
│   └── use-cases/
│       ├── compute-finance-dashboard.ts
│       ├── get-revenue-target.ts
│       └── set-revenue-target.ts
└── infrastructure/
    ├── repos/drizzle-finance-source.ts
    └── db/schema-tenant-revenue-targets.ts
```

Presentation lives in `src/app/(staff)/admin/finance/` with a `_components/`
directory for the panels.

### Tenant isolation (Principle I, NON-NEGOTIABLE)

Every query runs inside `runInTenant(ctx, async (tx) => …)` and uses **that
`tx`** — never the pool-global `db` singleton. A repo method on a `tenant_id`
table that reaches for `db` gets a connection without `SET LOCAL
app.current_tenant` and silently bypasses RLS. A cross-tenant integration test
is a Review-Gate blocker.

### Money handling

Satang as `bigint` inside the domain, serialised to a decimal **string** at the
boundary (matching `DashboardSnapshot`). No floating point touches money at any
point, including percentage and average calculations — ratios are computed from
integer satang and rounded only for display.

**Unit mismatch to handle explicitly.** `invoices` and `payments` store money as
`bigint` satang, but `renewal_cycles.frozen_plan_price_thb` is a Postgres
`decimal` in **baht**. The committed-pipeline metric is the only place the two
meet. The conversion happens **once, in the infrastructure adapter**, using
integer arithmetic on the decimal's string representation (never
`parseFloat`), and the domain only ever sees satang `bigint`. A unit test pins
the conversion against fractional-baht values, and the port contract documents
that its committed-pipeline figure is already satang.

### New DDL

```sql
CREATE TABLE tenant_revenue_targets (
  tenant_id      TEXT   NOT NULL,
  fiscal_year    INTEGER NOT NULL,
  target_satang  BIGINT NOT NULL CHECK (target_satang > 0),
  note           TEXT,
  updated_by     TEXT   NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, fiscal_year)
);
```

With RLS + FORCE policies matching every other tenant-scoped table. Fiscal year
is resolved through the existing `fiscal_year_start_month` configuration and the
`src/lib/fiscal-year.ts` helpers — never hardcoded to January.

The target is edited on `/admin/settings/invoicing`, which already groups
money-adjacent tenant configuration. No new settings page.

### Pacing

The "are we on pace?" comparison uses the **prior year's actual monthly
distribution** of cash collected, not a straight twelfth. TSCC's dues cluster
early in the year; a linear target would report "behind" every January and
February in a perfectly normal year.

When no prior-year data exists, fall back to a linear target and say so in the
panel caption. The fallback must be visible to the reader, not silent.

## Page design

Five sections in a single scroll, in briefing order.

### Sticky filter bar

- **Period** — presets (this fiscal year / last fiscal year / trailing 12 months / custom range)
- **Tier** — multi-select
- **Payment channel** — multi-select
- **As-of** timestamp (request time; live query means there is no cache staleness to explain)
- **Clear** action, shown only when a filter is active

Every filter is reflected in the URL query string.

### Sections

| # | Section | Panels |
|---|---|---|
| ① | Are we healthy? | cash collected vs target (hero, with pacing) · monthly cash-in with prior-year overlay |
| ② | Who owes us? | AR aging buckets · collection rate · DSO |
| ③ | Where does revenue come from? | revenue by tier + ARPU · payment channel mix · concentration risk |
| ④ | Looking ahead | committed pipeline · revenue retention and churned value |
| ⑤ | Tax & adjustments | VAT output for the period (link to `/registers`) · credit notes and refunds |

### Cross-filter rules

The main failure mode of a filterable dashboard is a reader absorbing a filtered
figure without realising it, then quoting it to the board. Mitigations are
mandatory, not optional:

1. Clicking a chart segment (a tier bar, a channel slice) adds a **visible,
   dismissible chip** to the filter bar.
2. The URL updates on every filter change.
3. Panels affected by an active filter render with an accent border.
4. There is no filter state that is not visible in the filter bar.

### Basis captions

Every panel carries a one-line caption stating what the figure counts and what
it excludes — following the pattern established for the four home KPI cards in
PR #231. Example: *"Cash actually received, net of refunds · excludes voided
invoices"*. A board member must be able to answer "what is this number?" from
the screen.

### Drill-through

Every panel links to the existing filtered list (`/admin/invoices?status=overdue&…`,
`/admin/members?tier=…`). **No new list pages are created.**

### Loading, empty, and error states

- Each section is wrapped in Suspense with a shimmer skeleton per `docs/ux-standards.md` § 2.1, so one slow aggregate does not block the page.
- **No target set** — admin sees a card inviting them to set one, with a direct action; manager sees a statement that no target is set.
- **No prior-year data** — the year-over-year overlay is hidden rather than drawn as a zero line.
- **Zero-data tenant** — friendly empty state, consistent with the F9 dashboard's existing treatment.

### Accessibility

Follows the 067 precedent exactly, which is the established contract in this
codebase:

- Every chart is `aria-hidden` with `accessibilityLayer={false}`.
- A **server-rendered visually-hidden `<table>`** is the sole screen-reader path for each chart.
- Figures in those tables are unabbreviated integers (the hero may render `฿4.24M`; the table renders the exact satang-derived amount).
- WCAG 2.1 AA, verified by `@axe-core/playwright`.

### Internationalisation

EN (canonical) + TH + SV. THB formatted per locale. Buddhist Era is
display-only on `th-TH` surfaces and never stored.

### Responsive

On mobile the filter bar collapses into a Sheet, panels stack to a single
column, and any table scrolls inside its own container — the page body never
scrolls horizontally.

## Metric definitions

These definitions are the highest-risk part of the feature. This repository has
shipped two financial-semantics defects already (#179, where a credit note
dropped an entire invoice from the revenue KPI; #229, correcting dashboard
financial semantics), so each metric is pinned here before implementation.

| Metric | Definition | Deliberate choice |
|---|---|---|
| **Cash collected** | Money received within the period, from successful `payments` rows plus manually recorded `invoices.payment_date`, **less refunds issued in that period** | A credit note that moves no money **does not touch this line** — it reduces AR, not cash. Netting credit notes back into an earlier period would retroactively change figures already reported to the board. |
| **Outstanding (AR)** | Invoices issued, unpaid, not voided: `total_satang − credited_total_satang` | Here credit notes **do** reduce the figure, because it represents collectable money. |
| **AR aging** | Bucketed by `due_date` against today: not-yet-due / 1–30 / 31–60 / 61–90 / 90+ | Reuses F4's `computeIsOverdue` (Asia/Bangkok, strict `>`) rather than a fresh `due_date < CURRENT_DATE`, so the dashboard cannot disagree with the invoice list. |
| **Collection rate** | Cash collected in period ÷ amount billed in period (net of credit notes) | Not a cohort measure. The caption states this explicitly — it is a within-period ratio, not "what share of this batch of invoices got paid". |
| **DSO** | Mean days from `issue_date` to `payment_date` across invoices **paid in the period** | Deliberately not the balance-based textbook DSO. Chosen because it can be explained in one sentence; the caption states the formula. |
| **Revenue by tier** | Cash collected grouped by `invoices.plan_id` → tier, with ARPU per tier | Unresolvable plans fall into an `unassigned` bucket so tier figures always sum to the headline (067 precedent). |
| **Payment channel mix** | Cash collected grouped by `COALESCE(payments.method, invoices.payment_method)` | Unifies online methods (`card`, `promptpay`) with manually recorded ones (transfer, cash, cheque). |
| **Concentration risk** | Share of period cash collected held by the top five members, with names | Flags fragility: if five members are 40% of receipts, the board needs to know, and needs to know who. |
| **Committed pipeline** | Renewal cycles with `period_from` in the next 12 months, not closed or rejected, not yet invoiced → sum of `frozen_plan_price_thb` | Caption states this is a projection from renewal cycles, **not a contractual commitment**. Note the unit mismatch below. |
| **Revenue retention** | Cash this period from members who also paid in the prior comparable period ÷ those same members' prior-period cash; plus the value lost from members who did not renew | Net revenue retention on a member cohort. |
| **VAT output** | **Calls the existing `listTaxDocumentRegister` use-case** | Deliberately not reimplemented in SQL. Sharing the use-case makes it structurally impossible for this page to disagree with the figure filed on ภ.พ.30. |

### On-screen disclaimer

The page states that it is a management view of receipts and receivables, that
it excludes all expenses, and that only the VAT panel is drawn from tax-register
data. This appears on the page, not merely in this document.

## Testing

Per Principle II (TDD, NON-NEGOTIABLE) — failing test, commit red, implement,
commit green.

**Unit (Domain, 100% line)**
- Pacing calculation, including the no-prior-year linear fallback.
- Aging bucket boundaries: exactly-due, one day overdue, 30/31, 60/61, 90/91.
- Ratio arithmetic on integer satang, including division by zero (no target set, no billing in period, no prior-period cohort).

**Integration (live Neon `dev` branch, real Postgres)**
- **Cross-tenant isolation test — Review-Gate blocker.** Tenant B's invoices, payments, and renewal cycles must be invisible in tenant A's figures under every filter combination.
- Credit-note treatment: a credit note with no refund reduces AR and leaves cash collected unchanged; a refund reduces cash in the refund's period.
- A voided invoice is absent from every metric.
- Tier figures sum to the headline, including the `unassigned` bucket.
- The VAT panel figure equals `listTaxDocumentRegister` output for the same period.
- Filter combinations return internally consistent totals.

**Contract**
- The finance source port, so a future rollup-table implementation is a drop-in replacement.

**E2E (Playwright)**
- `@a11y` — axe-core scan; every chart's hidden table is reachable and carries exact figures.
- `@i18n` — EN/TH/SV coverage; THB formatting; Buddhist Era display on `th-TH`.
- Filter state survives a reload from the URL alone.
- Cross-filter by clicking a tier bar produces a visible, dismissible chip.
- Drill-through lands on the correct pre-filtered list.
- Print stylesheet renders all five sections without clipping.

**Review gates**
- `financial-reporting-analyst` — metric semantics and query correctness.
- `financial-integrity-reviewer` — money arithmetic and cross-module reconciliation.
- `enterprise-ux-designer` — required for any UI-touching change in this repo.
- `i18n-translation-reviewer` — locale parity.
- `drizzle-migration-reviewer` — the new table, its RLS policies, and indexes.

## Rollout

- Ships behind `FEATURE_FINANCE_DASHBOARD`, default **false**.
- Navigation entry carries the existing `feature` tag so the link does not appear while the flag is off (dead-link sweep precedent, PRs #190/#191/#195/#199).
- Migration applied to the `dev` Neon branch and integration tests run **before** the schema commit — unit-test mocks hide schema gaps that only surface against live Postgres (F4 R8 incident).
- Indexes on `invoices (tenant_id, payment_date)`, `invoices (tenant_id, due_date)`, and `invoices (tenant_id, issue_date)` are verified present or added with the migration.
- Flag flipped to production only after the treasurer has set a target for the current fiscal year and confirmed the headline figure against their own records.

## Out of scope

- Expense tracking, P&L, and balance sheet.
- Bank or accounting-software import and reconciliation.
- Accrual or deferred-revenue recognition.
- Per-tier or per-month target entry.
- A generated PDF board pack (the print stylesheet covers the need; revisit if it does not).
- Forecasting beyond the committed pipeline figure.
