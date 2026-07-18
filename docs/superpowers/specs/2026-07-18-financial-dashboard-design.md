# Financial Dashboard (`/admin/finance`) — Design

**Date:** 2026-07-18 · **Module:** `src/modules/insights` (extension, no new bounded context)
**Status:** Design — **revised after a 5-agent review** (financial-reporting-analyst, chamber-os-architect, enterprise-ux-designer, chamber-os-qa-engineer, pdpa-gdpr-compliance-officer). All five returned BLOCK/NEEDS-REVISION on the first draft; this revision folds in the findings that are settle-able on paper and records the two that require an accountant ruling as **§ Open questions — must resolve before `/speckit.plan`**.

## Goal

Give the **treasurer and the board** one surface that answers a single question —
*"are we financially healthy?"* — from the revenue side of the business, with
enough slicing to answer the follow-up questions that always come next.

Chamber-OS has no expense, bank-balance, or general-ledger data. This page is
therefore a **management view of receipts and receivables**, not a financial
statement, and it is explicitly **not reconcilable to ภ.พ.30 except via the VAT
panel**, which is drawn from the tax register itself. That limitation is stated
on the page, not just in this doc.

## Open questions — MUST resolve before `/speckit.plan`

Two metric definitions change the **formula**, not a label, and cannot be
settled without an accountant ruling. They are already blocked threads from the
088 review (ภ.พ.30 voided-VAT + §86/10 netting, HELD for the accountant). The
dashboard's go-live is therefore gated on the same thread — this is not a
start-coding-now feature.

| # | Question | Options | Leaning |
|---|---|---|---|
| Q1 | A credit note that moves no cash (a §86/10 price reduction carried forward) — should it reduce the "collected" figure the board sees, and in which period? | (a) never reduce cash, show as a separate "credit issued" line; (b) reduce in the **credit note's own period**; (c) reduce retroactively in the original invoice's period | **(b)** — history stays immutable; matches how ภ.พ.30 treats it. **(c) is a live defect today** (dev has 144 CNs issued 2026-03-15 that rewrite Nov-2025 bars to ฿0). |
| Q2 | Is the headline "cash collected" gross (VAT-inclusive) or ex-VAT? | (a) gross; (b) ex-VAT | **(a) gross** — it is money in the bank — with the VAT component shown as a sub-line. Note this **deliberately differs** from the home `ytdPaidRevenueSatang` KPI (ex-VAT, FY-windowed); the two are different metrics and the spec must publish the reconciliation delta, not claim equality. |
| Q3 | Do event fees belong in the same headline as membership dues? | (a) combined; (b) split | **(b) split** — event invoices carry `plan_id = NULL` by construction, so combining creates a large unexplained `unassigned` tier bucket. Chambers normally report dues and event income separately. |
| Q4 | Withholding tax: a juristic member deducts 3% WHT, the invoice is marked paid in full, but less cash arrives. Which figure does the hero show? | (a) gross per invoice; (b) net after WHT | **Needs field data first** — the system has **no WHT storage at all**. If TSCC does not hit this in practice, defer; if it does, it is its own feature. |

Q1 and Q2 change the core formula. **Do not begin implementing the metric table until they are answered.** Q3 and Q4 change scope but not the § ① health formula.

## Users and access

| Role | Access | Basis |
|---|---|---|
| `admin` | read the dashboard; set the revenue target; export CSV | full owner |
| `manager` | **read the dashboard; NO export** | the treasurer may hold `manager`; but CSV is bulk member-attributable PII egress — see below |
| `member` | no access | — |

**This is a deliberate widening, not precedent-following** — and the first draft
got it wrong. `/admin/invoices/registers`, cited in the first draft as
precedent, is in fact **admin-only** (`if (user.role !== 'admin') notFound()`).
`canAccess` grants `manager` `read` on any resource by a default-allow
fall-through, not by a decision anyone made. So:

- The page guards with `requireSession('staff')` in the RSC (`requireAdminContext` is a route-handler helper and is wrong for `page.tsx`), then checks the flag → `notFound()`.
- **CSV export is restricted to `admin`** with a defence-in-depth check inside the use-case, mirroring `exportMembersBackup` (`export-members-backup.ts:79`, *"managers are read-only … this artefact is the full PII dump — admin only"*). Manager keeps on-screen read.
- Manager read on a named-member concentration surface is flagged for the security + PDPA reviewers and recorded in `plan.md` § Complexity Tracking.
- `finance:dashboard` typechecks via the `Resource` `(string & {})` tail without being declared — which means a **misspelling also typechecks and behaves identically**. RBAC therefore needs explicit literal tests (see § Testing H3).

## Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Revenue basis | **Cash** — money actually received, dated by settlement | Right basis for "are we healthy". **Not** claimed to reconcile with the home KPI — see Q2 and the reconciliation delta test. |
| 2 | Data scope | Revenue side **+ an annual revenue target** | No expense module. A single target turns raw figures into a board judgement. |
| 3 | Surface | **New page `/admin/finance`** | Keeps `/admin` home operational; zero regression risk to hot-path surfaces. |
| 4 | Interaction model | **Narrative order + URL-bound filters + legend-button cross-filter** | Five sections read as a briefing; a sticky filter bar answers follow-ups. Cross-filter is applied by **real DOM controls (legend buttons), never by clicking an `aria-hidden` chart** — see § Accessibility. |
| 5 | Filter state | **Encoded in the URL** (`push`, not `replace`, so Back = undo) | Reproducible: paste the URL into a board agenda. No **member-identifying** parameter may appear in the URL (leaks into logs/Referer) — cross-filter is by tier and channel only; a concentration row drills *through* to `/admin/members/[id]`. |
| 6 | Compute | **Live query per request**, no snapshot cache, **perf budget SC-002 (p95 < 1.5 s @ 5 k members) stated and measured** | Free filtering makes precomputation combinatorial. F9 rejected "fully live per load" *at 5 k* — so this is a departure from the F9 snapshot precedent and needs a Complexity Tracking entry + a measured budget, not an argument from TSCC's current 110 rows. |
| 7 | Target granularity | **One figure per fiscal year** | Monthly pacing is derived, not entered. |
| 8 | Board pack export | **CSV (admin-only) + print stylesheet**, no new PDF renderer | Internal document, not a tax document. |
| 9 | Concentration panel | **Show member names, per-entity-type** | See § Concentration + the PDPA ruling below. |

### Rejected alternatives

- **Composite health score (0–100)** — indefensible to a board, undiagnosable.
- **Snapshot cron** — incompatible with free filtering (Decision 6).
- **Click-the-chart cross-filter** — an `aria-hidden` canvas cannot be a keyboard/SR control; axe cannot even detect the failure, giving false assurance. Replaced by legend buttons.
- **Port returns aggregates** — would put every metric in coverage-excluded infrastructure, testable only on live Neon. Replaced by facts-then-fold (§ Architecture).

## Architecture

### Module placement — `src/modules/insights`

Confirmed correct by review: the metrics span invoicing, payments, members,
renewals, plans, which is what `insights` and its `source-ports.ts` pattern
exist for. No twelfth bounded context.

### Port returns **facts, not aggregates** — fold in the domain

This is the load-bearing architectural decision, and it is what makes the money
logic testable.

- The port methods return **rows scoped by period + tenant** — per-invoice cash facts, per-payment channel facts, per-cycle pipeline facts — **never pre-aggregated sums**.
- All folding — aging buckets, tier grouping, ARPU, channel mix, concentration ranking, DSO mean, retention set-math, pacing — lives in **`src/modules/insights/domain/finance-metrics.ts`** as pure functions over `bigint` satang. Precedent: `foldRawMonths` in renewals.
- Consequence: every metric becomes a **Domain 100%-line unit test** with no live Postgres. `vitest.config.ts` excludes `infrastructure/**` and `ports/**` from coverage, so aggregation-in-SQL would be invisible to every threshold in the repo. Each new domain file is added to the per-file 100% threshold list.
- Integration tests then prove only what they should: SQL scoping, RLS, and the baht→satang conversion.
- The **as-of timestamp is returned by the port** (via the existing `ClockPort`), not `Date.now()` in the page — so a future rollup implementation reports its own freshness without touching the use-case or the caption, and aging is not flaky at midnight Bangkok.

```text
src/modules/insights/
├── domain/
│   ├── finance-metrics.ts        # ALL folding: pure fns over bigint satang
│   └── revenue-target.ts         # RevenueTarget VO + pacing (pure)
├── application/
│   ├── ports/finance-source.ts   # returns FACTS (rows), not sums
│   └── use-cases/{compute-finance-dashboard, get-revenue-target, set-revenue-target, export-finance-csv}.ts
└── infrastructure/
    ├── sources/drizzle-finance-source.ts   # raw SQL: scoping + WHERE only, NO money rules
    └── db/schema-tenant-revenue-targets.ts
```

**Do not re-derive money rules in SQL.** Import `computeIsOverdue`, the paid-status
set, and `cycleFrozenPriceSatang` from the owning barrels — re-implementing them
in a second place is the mechanism behind both prior defects (#179, #229). The
boundary contract test (`tests/contract/insights/source-adapters-boundary.contract.test.ts`)
is extended to the new adapter.

Constitution Principle III note: the ESLint barrel rule does **not** catch cross-module
schema reads (its `ignores` covers `src/modules/*/**` and a later block re-sets the
rule — flat config replaces, not merges). Real enforcement is the contract test.

### Tenant isolation (Principle I, NON-NEGOTIABLE)

- Every query inside `runInTenant(ctx, async (tx) => …)`, using **that `tx`** — never the global `db`.
- New table gets **RLS + FORCE + a `GRANT SELECT, INSERT, UPDATE, DELETE … TO chamber_app`** — omitting the GRANT yields runtime "permission denied" (F7.1a 0172 incident).
- `tenant_revenue_targets` is **registered in `scripts/check-multi-tenant-ready.ts` `SCOPED_TABLES`** — that gate is an allow-list, not introspection; unregistered = silently never checked.
- Cross-tenant integration test (read **and** write on the targets table specifically) is a Review-Gate blocker.
- Super-admin is a non-issue — `ROLES = ['admin','manager','member']`, no bypass path (deferred to F13). Stated rather than left implicit.

### Money handling

- Satang as `bigint` in the domain; serialised to a decimal **string** at the RSC→client boundary — the reason is that `bigint` is not serialisable across that boundary (not the `DashboardSnapshot` "JSONB has no bigint" reason, which does not apply — this page persists nothing).
- No float touches money, including ratios — computed from integer satang, rounded only for display.
- **Committed pipeline uses `cycleFrozenPriceSatang` from the renewals barrel** (wraps `parseThbDecimalToSatang`) — `frozen_plan_price_thb` is `decimal(12,2)` returned as a branded `ThbDecimal` string. The first draft's bespoke conversion is dropped; do not hand-roll it.

### New DDL

```sql
CREATE TABLE tenant_revenue_targets (
  tenant_id      TEXT     NOT NULL,
  fiscal_year    SMALLINT NOT NULL,           -- matches invoices.fiscal_year
  target_satang  BIGINT   NOT NULL CHECK (target_satang > 0),
  note           TEXT     CHECK (char_length(note) <= 500),  -- capped free-text
  updated_by     UUID     NOT NULL,           -- actor cols in this repo are uuid
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, fiscal_year)
);
-- + RLS + FORCE + GRANT to chamber_app
```

- `CHECK (target_satang > 0)` makes zero unreachable, so **"clear a target" needs an explicit unset/delete path** — specify it or "no target" and "target cleared" collapse into one state.
- Concurrent edits are last-write-wins on the PK upsert. Add an `updated_at` precondition or a typed conflict — two admins on the settings page must not silently overwrite each other.
- The target is edited on `/admin/settings/invoicing`; the empty-state deep-links to that section anchor and back.

### Pacing

Uses the **prior year's actual monthly distribution** of cash, not a straight
twelfth (TSCC dues cluster early; linear would read "behind" every January).
**Three states, not two:**

1. Full prior year → use its shape.
2. No prior year → linear fallback, **caption says so**.
3. **Partial prior year** (tenant went live mid-year) or prior year totalling zero → also linear fallback + caption; never normalise a partial distribution (silently wrong curve) and never divide by a zero prior-year total.

## Metric definitions

Highest-risk part of the feature (two prior defects: #179, #229). Every row is
pinned here, and every row has a test in § Testing. Rows depending on Q1/Q2 are
marked **⏸ pending accountant**.

| Metric | Definition | Notes from review |
|---|---|---|
| **Cash collected** ⏸ | Per **non-void** invoice, the settled amount counted **once**: from a **succeeded `payments` row** where one exists, **else** from `invoices.payment_date`/`total_satang`. The two sources are **mutually exclusive by anti-join on `payments.invoice_id`** — never unioned. Contributing `payments.status ∈ {succeeded, partially_refunded, refunded, auto_refunded}`; `pending/failed/canceled` never contribute. Refunds subtract in **their own settlement period**. | First draft's "payments **plus** payment_date" **double-counted every Stripe payment** (`markPaidFromProcessor` writes both). `succeeded`-only would **delete refunded cash from both periods**. Gross-vs-ex-VAT is Q2. |
| **Outstanding (AR)** | Issued/`partially_credited`, unpaid, not void: `total_satang − credited_total_satang`. | An `issued` invoice always has `credited_total_satang = 0` (state machine forbids `issued→credited`); the term is live only for `partially_credited`. |
| **AR aging** | Bucket by `due_date` in Asia/Bangkok: not-yet-due / 1–30 / 31–60 / 61–90 / 90+. `daysOverdue = bangkokLocalDate(now) − due_date`; boundaries inclusive as listed. | Reuse `computeIsOverdue`'s **boundary rule only** (`status==='issued' && strict >`); the day-count buckets are **new code** in `finance-metrics.ts`. **`partially_credited` invoices are collectable but `computeIsOverdue` returns false for them** — aging must handle them separately or it will not reconcile with AR outstanding (adjacent panels). Invariant: `Σ(buckets) === Outstanding(AR)`. |
| **Collection rate** | `cash_collected_in_period ÷ Σ invoices.total_satang WHERE issue_date ∈ period AND status <> 'void'`. Same basis both sides; denominator not netted of CN. | First draft was asymmetric (numerator not netted, denominator netted) → **>100% systematically**. Zero denominator renders `—` "no invoices issued", not `0%`. |
| **DSO** | Unweighted mean days `issue_date → COALESCE(payment_date, (paid_at AT TIME ZONE 'Asia/Bangkok')::date)` over invoices **paid in the period**; rounded 1 dp. | `COALESCE` matches the tax register's fallback so the two panels share a denominator. `recordPayment` rejects `paymentDate < issueDate`, so no negative DSO. Empty set → `—`. |
| **Revenue by tier + ARPU** ⏸ | Cash grouped by `invoices.plan_id → tier`; **event invoices (`plan_id = NULL`) are a separate "Event fees" block, not `unassigned`** (Q3). ARPU denominator = **members active at period end** (stated, was undefined). Unresolvable membership plans → `unassigned`. | Sums to headline including `unassigned`. |
| **Payment channel mix** | `COALESCE(succeeded_payment.method, invoices.payment_method)` where `succeeded_payment` is the payments row **aggregated to one per invoice, `status='succeeded'`**. | `payments.method ∈ {card, promptpay}`; `invoices.payment_method ∈ {bank_transfer, cheque, cash, other}` — **there is no `card` value on the invoice**; online invoices carry `'other'`. Without the `succeeded` filter + 1-per-invoice aggregation, a failed card attempt buckets a bank transfer as "card" and multi-attempt fans out the total. `'other'` appearing in the chart means the join missed — assert it is zero in an online-only fixture. |
| **Concentration risk** | Top-5 members by **membership** cash in period, with names, per entity type (below). Ties at rank 5 and fewer-than-5-payers handled. | Event invoices have `member_id = NULL` → excluded, so scope is membership cash; state it or concentration under-reports. |
| **Committed pipeline** | Renewal cycles with `period_from` in the next 12 months (Asia/Bangkok; `period_from` is `timestamptz`), `status ∈ OPEN_CYCLE_STATUSES`, **`linked_invoice_id IS NULL`** → `Σ cycleFrozenPriceSatang`. **`pending_admin_reactivation` is EXCLUDED** (matches `OPEN_CYCLE_STATUSES`). Ex-VAT — caption says so, or multiply by the tenant VAT rate to match a gross hero. | First draft named `closed`/`rejected` — **neither is a real status** (7 real states; reject → `cancelled`). `linked_invoice_id`, not `anchor_invoice_id`. |
| **Revenue retention** | Cash this period from members who also paid in the prior comparable period ÷ those members' prior-period cash; plus value lost from non-renewers (from `lapsed` cycles' `cycleFrozenPriceSatang`). Cohort keyed on `member_id` (event `NULL` excluded). "Prior comparable period" = the immediately preceding window of equal length. | Empty cohort → `—`, not `0%`. Draft left the value-lost formula and the comparable-period definition undefined. **Consider deferring NRR to a follow-up** — a board memorises this number, and an ambiguous one is worse than none. |
| **VAT output** | **Calls `listTaxDocumentRegister`** for the period. | Cannot be tier/channel-filtered — see § Filter applicability. `MAX_DAYS = 366`, so trailing-12-months-over-a-leap-day and custom ranges >1 yr **return a typed error**; the panel renders a "period too wide for the tax register" state, not a crash. Requires a `kind`; `periodOutputVat` is kind-independent so the figure is safe, but a `kind` must be chosen for `rows`. Reads on **its own MVCC snapshot** (its deps factory opens a second `runInTenant`) — caption notes it is as-of its own read; the integration test uses a quiesced fixture. |

### On-screen disclaimer

States: management view of receipts and receivables; excludes all expenses; only
the VAT panel is tax-register data; **annual dues are recorded in full in the
month cash is received, not accrued over the coverage period** (there is no
coverage-period column on `invoices` — a structural limit, not a choice).

## Page design

Five sections, single scroll, briefing order, with a **sticky in-page section
nav** (precedent: `/admin/settings/invoicing` `SectionNav`).

### Container

`DetailContainer` (72 rem) matches `/admin` home and satisfies `check:layout`;
eleven panels at 72 rem is tight, so if `TableContainer` (96 rem) is chosen it is
recorded as a `check:layout` exception. Decide and document — the CI gate fails otherwise.

### Sticky filter bar

- **Period** presets (this FY / last FY / trailing 12 months / custom) + custom range **applies on an explicit Apply button** (a half-typed date must not fire a query); presets apply on change.
- **Tier** and **Channel** multi-select, via `TranslatedSelectValue` (Base UI renders raw enum in a collapsed trigger otherwise — sibling surfaces already wrap it).
- **Per-chip ✕ AND a clear-all**, both rendered always (disabled when inactive) to avoid layout shift and lost focus targets. Clear does **not** reset period (period always has a value; default = current FY).
- **As-of** timestamp with **timezone (Asia/Bangkok)** shown.
- On mobile the bar is a Sheet, but the **active-filter chips render outside the Sheet** (or the trigger carries a count badge) so no filter state is hidden — mitigation for the misread risk.

### Filter-applicability matrix (11 panels × 3 dimensions)

Not every filter applies to every panel; silently ignoring a filter is the top
misread risk. Three visual states, **not two**:

| Panel | Tier | Channel | Period |
|---|---|---|---|
| Cash vs target / hero | ✅ | ✅ | ✅ |
| Monthly cash YoY | ✅ | ✅ | ✅ |
| AR aging | ✅ | ❌ (unpaid → no channel) | ⚠️ point-in-time — define "as of period end" |
| Collection rate | ✅ | ✅ | ✅ |
| DSO | ✅ | ✅ | ✅ |
| Revenue by tier / ARPU | ✅ (self) | ✅ | ✅ |
| Channel mix | ✅ | ✅ (self) | ✅ |
| Concentration | ⚠️ changes meaning ("top-5 within one tier") | ✅ | ✅ |
| Committed pipeline | ✅ | ❌ (not yet invoiced) | ⚠️ window = next 12 mo, not filter period |
| Revenue retention | ✅ | ✅ | ✅ |
| **VAT output** | ❌ whole-tenant statutory | ❌ | ✅ (≤366 d) |

- **`applies`** → the filter shows in the basis caption (below).
- **`not-applicable`** → a **visible badge** (*"whole-tenant figure — not affected by the tier/channel filter"*) and the unfiltered number. **Never silently ignore a filter.**
- AR-aging "as of" and pipeline "window" ambiguities are resolved in the captions.

### Filter provenance lives in the **basis caption text**, not colour

An accent border is colour-only (fails WCAG 1.4.1), vanishes in greyscale print
and screenshots, and is invisible to screen readers — yet print/screenshot is
the board-pack path. So the active filter is written **into the caption string**:

> *"Cash actually received, net of refunds · excludes voided invoices · Gold tier only · 1 Jan–30 Jun 2026"*

Text survives print, greyscale, screenshot, copy-paste, and SR. The `KpiCard`
`caption` slot (PR #231) is reused; an accent border may stay as redundant
reinforcement but is never the sole signal.

### Cross-filter via legend controls (a11y-safe)

Every cross-filterable dimension has **real DOM controls beside the chart** — a
legend row of `<button aria-pressed>` or a Radix `ToggleGroup` (roving tabindex).
Clicking the (still `aria-hidden`) chart is a **redundant mouse shortcut** to the
same handler. This keeps the 067 chart-is-decorative contract valid, and fixes
the chart's poor click discoverability at the same time. Precedent for
button/link filters: `admin/events/page.tsx` `FilterChips`.

On filter change:
- A `role="status"` (polite, **not** `alert`) live region announces *"Filtered to Gold tier · 11 panels updated"*, cleared after announcing so a repeat filter re-announces.
- **Focus moves to the newly-added chip** (mirror of the removal focus-restoration in `renewals/month-filter-chip.tsx`).

### Progressive disclosure

- **Channel mix** is an operations metric, not a board metric → collapsed accordion or moved to § ⑤.
- **DSO** (jargon-heavy, non-standard) → disclosed under collection rate, not a peer panel.
- § ④ (forward) and § ⑤ (tax) collapsed by default (remembered in `localStorage`); § ① with a one-line VAT pointer to § ⑤.

### Empty / zero / error states

- **Empty ≠ zero.** A filter set with no matching rows (Gold + PromptPay + Q1) must render an empty state (icon + title + body + "clear filter" CTA), **never ฿0** — "฿0" reads as "we collected nothing", the worst misread on this page.
- **Undefined ratios** (collection rate x/0, DSO on 0 invoices, retention on empty cohort) render `—` with *"not enough data for this period"*, never `0%`.
- **Per-section `ErrorBoundary` + `error.tsx`** at `/admin/finance` (reuse `dashboard-error-state.tsx`). Suspense catches *slow*, not *thrown* — one aggregate throwing must not blank all eleven panels. A **partial-error state** must be prominent, and if a failed panel feeds the hero, the hero says it is incomplete.
- **Skeleton geometry matches real panels** (chart area + caption line); `loading.tsx` renders the **filter bar shape too** (F9 R2 finding). Repeated skeleton-CLS history in this repo.
- **`READ_ONLY_MODE`** disables the "set target" CTA with an explanation rather than letting it 503.

### Charting stack + accessibility

067 (`dashboard-interactive-charts`) has shipped, so the stack exists and this
feature **adds no new dependency**: `recharts@^3` (major pinned), the shadcn
wrapper `src/components/ui/chart.tsx`, the generic `chart-data-table.tsx`
(server-rendered visually-hidden `<table>`, never `aria-hidden`), and
`chart-skeleton.tsx`.

**Two chart patterns, chosen by whether the chart is a control:**

- **Read-only charts** (monthly cash YoY, AR aging, channel mix, VAT): 067 contract — `aria-hidden` + `accessibilityLayer={false}`; the `ChartDataTable` is the sole accessible + no-JS path.
- **Cross-filter charts** (tier bars, channel slices): the chart stays `aria-hidden`; the **legend buttons** carry the interaction, `aria-pressed`/`aria-current` for state. An `aria-hidden` canvas as a control fails WCAG 2.1.1 + 4.1.2 — and **axe cannot detect a mouse-only control, so the axe gate would give false assurance**. The keyboard-operability E2E (below) is the test that actually catches it.

Hero figures: the abbreviated form must be produced by a **new exported
`formatCompactThb(satang, locale)`** in `src/lib/format-thb.ts` (the one compact
formatter today is unexported), unit-pinned across en/th/sv. The first draft's
`฿4.24M` **is not produced by any locale** — verified: `฿` prefix is th-TH only
(en gives `THB 4.2M`), `maximumFractionDigits:1` gives `4.2M` not `4.24M`, en-GB
lower-cases to `4.2m`, sv gives `4,2 mn THB`. Because the hero abbreviates, the
**exact figure also renders as visible text** in the caption (*"collected
4,241,338.00 THB"*) — a board member cannot quote `฿4.2M` from the screen.
**No `CountUp`** on financial figures (misreads mid-animation). Symbol
convention (`formatSatangThb` uses a `THB` suffix; the hero would use a `฿`
prefix) must be reconciled to one and documented.

### Dates / i18n

- EN (canonical) + TH + SV; `admin.finance.*` namespace, sectioned. The ~33 basis-caption strings (11 × 3) need a **finance-literate** translator — "DSO", "net revenue retention" have no clean TH/SV term; keep the acronym + a translated gloss rather than translating the acronym.
- BE dates via `getDateFormatLocale` (`format-date-localised.ts`, maps th → `th-TH-u-ca-buddhist`) — **not** `format-tax-doc-date.ts` (that adds 543 by hand for tax docs only). BE is display-only.
- **Fiscal-year label** is a trap: DDL stores `fiscal_year` as CE `SMALLINT`; the th surface shows พ.ศ. 2569; and when `fiscal_year_start_month ≠ Jan` it is a *range*, not a single year. Convert explicitly with a test — an off-by-543 here is a Constitution ship blocker.

### Print stylesheet

**No `@media print` exists anywhere in `src/` today** — this is built from zero.
Spec requires: sticky bar → `print:static`; `print:hidden` on sidebar, theme
toggle, drill links, Clear, chip ✕; a **print-only header block** carrying tenant
+ period + active filters + as-of + a classification line (*"Internal — contains
member financial data"*); **force light tokens** (dark mode prints white-on-white);
`break-inside: avoid` per Card, `break-before` per section. The header block is
also the safety net for the "paste into agenda" workflow — provenance travels
with the figure.

### CSV export

Per ux-patterns § 5.1: filename `swecham-finance-YYYYMMDD-HHmm.csv`, UTF-8 **with
BOM**, ISO dates (no BE), **streamed synchronously — never persisted to Vercel
Blob** (routing through the F9 export-job worker would create a PII-at-rest
artefact needing its own token + TTL + retention rule). Formula-injection defang
(`cell()` from `members-backup-csv.ts`) on every **text** column
(`company_name`, `note`); numeric columns stay bare. **Admin-only.** Emits an
audit event atomically in the gather tx (below).

## Testing

Per Principle II (TDD). Because folding lives in the domain (§ Architecture), the
metric table is **Domain-100%-line unit-testable without live Postgres**.

**Unit (Domain, 100% line) — one per metric, all in `finance-metrics.ts`/`revenue-target.ts`:**
- Cash collected: anti-join correctness — a Stripe-paid invoice (both a succeeded payment and a set `payment_date`) counts **once**; mutation-check that the test goes red if the anti-join becomes `UNION ALL`.
- Cash `status` set: succeeded in P1, refunded in P2 → cash(P1) gross, cash(P2) negative by the refund (spans two periods — the draft's single-period refund test missed this).
- AR aging boundaries (30/31, 60/61, 90/91) **and** a `partially_credited` past-due row lands in a bucket; invariant `Σ(buckets) === AR` over a mixed fixture.
- Collection rate: symmetric basis, >100% impossible, zero-denominator → `—`.
- DSO: unweighted mean, `COALESCE(payment_date, paid_at::bkk-date)`, empty set → `—`, rounding.
- Channel mix: promptpay invoice → `promptpay` never `other`; `other` bucket zero in an online-only fixture; multi-attempt does not fan out.
- Concentration: top-5 share, ties at rank 5, fewer-than-5 payers, zero period cash.
- Committed pipeline: `OPEN_CYCLE_STATUSES` only, `linked_invoice_id IS NULL`, `pending_admin_reactivation` excluded, ex-VAT.
- ARPU: denominator = members active at period end.
- Retention: cohort set-membership + value-lost formula (or **test-deferred with the metric** if NRR is cut).
- Pacing: full / none / **partial** prior year + zero-prior-total → linear fallback + caption flag.
- FY boundary: `deriveFiscalYear` at the 17:00-UTC crossover for `startMonth ∈ {1,4,10}`; FY-label CE→BE conversion.

**Integration (live Neon `dev`, real Postgres) — F4 R8 class (migration + code together):**
- **Cross-tenant isolation — Review-Gate blocker** — across invoices/payments/cycles under every filter, **plus a dedicated read+write probe on `tenant_revenue_targets`** (RLS+FORCE asserted for the new table specifically).
- Cash-collected value assertion driving real `markPaidFromProcessor` + `recordPayment` of different amounts → sum equals, not double.
- Credit-note (Q1-dependent): a no-refund CN reduces AR, leaves cash unchanged; a refund reduces cash in its period.
- **Void-on-reissue pair** (`FEATURE_VOID_ON_REISSUE` merged 2026-07-18): a voided original + its reissued replacement contribute **exactly once** — not zero, not twice.
- Tier sums to headline incl. `unassigned`; event fees in their own block.
- baht→satang: read a real `frozen_plan_price_thb` back through the adapter → satang `bigint` (driver returns a string; unit test alone can't prove the shape).
- VAT panel equals `listTaxDocumentRegister` for the period, quiesced fixture (own-snapshot immunity); 366-day boundary succeeds, 367 renders the too-wide state.
- FY with `fiscal_year_start_month = 4` (every non-January tenant is otherwise untested).

**Property-based (`fast-check`, existing dev dep):** the draft's untestable *"filter combinations return internally consistent totals"* becomes three invariants — (a) `Σ(tier slices under F) === headline(F)`; (b) filtering by all tier values === no tier filter; (c) `cash(F) − cash(F minus one tier) === cash(that tier)`.

**Contract:** the finance source port as a **parameterised shared suite invoked twice** — from `tests/contract` against an in-memory fake, and from `tests/integration` against the Drizzle adapter on live Neon (the event-attendees precedent runs the real adapter only in integration). Malformed-URL params (inverted range, >366 d, unknown tier, non-numeric period) at the loader's zod schema — PR #229 fixed a money-route mass-assignment, so this is a known class.

**RBAC (unit + contract) — H3, security-critical 100% branch:**
- `canAccess('finance:dashboard', …)` for the **exact literal** × {admin, manager, member} × {read, write} (a misspelling typechecks and behaves identically — only a literal test catches drift).
- Page returns 404/403 for `member`; the export path 403s for `manager`; the target form is absent for `manager`.

**Audit — H4, 4-places rule (domain const + pgEnum + 2 test counts; `check:audit-counts` fails if missed):**
- `finance_dashboard_viewed` (best-effort `record()`, payload `{actor_role}`).
- `finance_dashboard_exported` (**atomic in the gather tx**, payload `{applied_filters: names-not-values, row_count, member_rows_included}` — mirrors the members-backup atomic path, not the best-effort audit-log-export path).
- `revenue_target_set` (atomic with the write, prior value read `FOR UPDATE` in-tx, payload `{fiscal_year, has_note}`).
- All three land at 5-year retention (`F9_AUDIT_RETENTION_YEARS` exhaustive map).

**E2E (Playwright, `--workers=1`; `@a11y`/`@i18n` authoritative on the preview deploy, noisy locally):**
- `@a11y` **keyboard-only cross-filter**: tab to a legend button, activate, filter applies, chip announced — the test that catches an `aria-hidden`-canvas-as-control.
- `@a11y` each chart's hidden table exists, is not `aria-hidden`, ordered with its chart (exact-figure assertion moved to an RTL unit test — E2E can't cheaply control data).
- `@i18n` EN/TH/SV; `formatCompactThb` per locale; BE display on th; FY label.
- Filter state survives reload from URL alone; `push` gives Back-as-undo.
- Drill-through lands on the correct pre-filtered list / `/admin/members/[id]`.
- Feature-flag OFF: nav entry absent and `/admin/finance` 404s (the exact regression the dead-link-sweep PRs existed for).
- Both "no target" states (admin gets an action, manager a statement).
- Print: `emulateMedia('print')` → all five section landmarks present, sticky bar + nav `display:none`, `body.scrollWidth <= viewport`, print header block present.

**Review gates:** financial-reporting-analyst · financial-integrity-reviewer · enterprise-ux-designer · i18n-translation-reviewer · drizzle-migration-reviewer · security-engineer (manager-read widening) · pdpa-gdpr-compliance-officer (concentration + export).

## PDPA / GDPR (from the compliance review — two were BLOCK)

- **Erasure sourcing (was BLOCK).** Member display names come from **`members.company_name` only — never `invoices.member_identity_snapshot`** (which retains buyer PII for 10 years per RD §87/3). Post-erasure `company_name` is the `[erased]` tombstone, so erasure works automatically with no `WHERE` predicate; money stays in every aggregate (dropping it repeats #179). Written as a port-contract comment. Integration test: erase a member with paid invoices → cash unchanged, `[erased]` (not the pre-erasure name) in every panel and the CSV.
- **Export (was BLOCK).** Admin-only + atomic audit + synchronous/no-Blob — covered above.
- **Concentration entity-type (H-2).** `company_name` is a natural person for the sole-trader subset, so a top-5 ranking of their income is profiling. Use `members.legal_entity_type`: juristic members shown by name; natural-person members shown as a tier-anonymised label — **or** name all five and record an Art. 6(1)(f) balancing test (board governance, staff-only, no automated decision) in `plan.md`. Either is acceptable; asserting "members are organisations" as if it disposed of the question is not. An Art. 21 objection is honoured by tier-anonymising that member.
- **`note` free-text** capped 500 (DDL) + UI helper *"Do not enter information about individuals."*
- **RoPA** (`docs/compliance/processing-records.md`) gains an entry: purpose, Art. 6(1)(f) basis + the balancing test, categories, recipients (board), retention, no new cross-border transfer.
- **No DPIA trigger** (no special-category data, no automated decision with legal effect) — recorded as assessed, not skipped.

## Rollout

- Behind `FEATURE_FINANCE_DASHBOARD`, default **false**.
- Nav gating uses **`visibilityFlag`** (`src/config/nav.ts:62`) — **not** a `feature` tag (that was a first-draft error; `feature` tags belong to the command palette). The `NavVisibilityFlag` union is **closed by design**, so this requires extending the union **and** wiring the resolver + staff layout. A **Finance section already exists** (`nav.ts:216`, Invoices + Credit notes) — decide whether the entry joins it gated, or follows the F9 Directory precedent (nav entry always present, page `notFound()` server-side). Also register `/admin/finance` + `/admin/invoices/registers` in the command palette.
- **Indexes added by this migration** (verified absent today): `(tenant_id, payment_date)`, `(tenant_id, due_date)`, `(tenant_id, issue_date)`. If the cash predicate uses `COALESCE(payment_date, paid_at::bkk-date)` like the tax register, the payment-date index must be an **expression index on that COALESCE**, not the bare column. Migration-review checklist item with an `EXPLAIN` assertion.
- Migration applied to the `dev` Neon branch and integration tests run **before** the schema commit (F4 R8).
- Flag flipped to production only after **Q1 + Q2 are answered**, the migration is applied, and the treasurer has set a target and confirmed the headline against their own records **with the published reconciliation delta vs the home KPI** (not a bare "confirmed").
- Consider **splitting the PR**: PR-A = target table + § ① + filter bar; PR-B = § ②–⑤. Five sections + eleven metrics + a new table + seven review gates in one diff on a money surface is large.

## Out of scope

- Expense tracking, P&L, balance sheet.
- Bank / accounting-software import and reconciliation.
- Accrual or deferred-revenue recognition.
- Per-tier or per-month target entry.
- A generated PDF board pack (print stylesheet covers it).
- WHT capture (Q4 — no storage exists; its own feature if TSCC needs it).
- Forecasting beyond committed pipeline.
