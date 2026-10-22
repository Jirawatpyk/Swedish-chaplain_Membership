# 124 — Invoice dashboard (`/admin/finance`)

**Size**: L (insights + payments + invoicing list + renewals count; money figures; a migration; a new flag; an RBAC gate).
**Status**: spec agreed with the maintainer; plan approved 22 Oct 2026; slice 1 merged (#617, 22 Oct); slice 2 (loaders, migration 0318) built 23 Oct; slice 3 (the page) not built.
**Sources**: the maintainer's design spec "Invoice dashboard — design spec" (Claude Docs, rev 19, decisions 1–10 of 19 and 22 Oct 2026) and the 7 `Admin-finance*` boards on the "Chamber-OS Portal — Aura" canvas (page `finance`). Where this file and the design spec disagree, this file wins: its § Premises records each correction made against the code.

## Summary

A new staff page, **Invoice dashboard**, at `/admin/finance`, first item of the Finance nav section. It shows receivables and collections at a glance and leads to the invoices that need action. Admins and super admins get figures and actions; managers get figures only. Read-only: the one action is the existing Record payment dialog. No new money mutation. Every amount on the page includes VAT; ex-VAT revenue stays on the home dashboard.

## User stories

### US1 — Admin sees what needs action (P1)

An admin opens `/admin/finance` and sees, as of today: 4 key-figure tiles (Outstanding, Overdue, Collected this month, Collected this year), Unpaid invoices by age, Needs attention, Oldest overdue (6 rows), Invoiced vs collected by month, Collected by payment method.

Done when:
- Outstanding shows Σ `total_satang` and the count of invoices with `status = 'issued'`, whole baht, and the caption "{count} unpaid invoices · as of today"; the words "net of credit notes" do not appear.
- Overdue shows the subset whose `due_date` is before Bangkok today (an invoice due today is not overdue), matching `computeIsOverdue`.
- The aging card shows five rows (Not yet due, 1–30, 31–60, 61–90, Over 90 days) whose amounts add to Outstanding and whose shares add to 100% (a non-zero share under 1% reads `<1%`).
- Collected this month is the current Bangkok calendar month on the **document basis** (§ Figure definitions), from the 1st to today, whatever fiscal year is selected; its caption says "{Month} to date · not affected by the fiscal-year filter".
- Collected in {FY} is the same over the selected fiscal year ("to date" only for the current FY); By payment method splits it into bank transfer, PromptPay, card, cheque, cash, other, the rows add up to the tile, and a Stripe-paid invoice is counted as card or PromptPay, never other, and once only.
- Needs attention shows five counts: manual drafts not issued, auto-renewal drafts awaiting review, receipt PDF failed on a paid invoice (`paid`, `partially_credited`, `credited` — the only states the worker re-renders), refunds failed at Stripe (payments with a `failed` refund whose code is `stripe_refund_%` and no later `succeeded` or `pending` attempt, each payment counted once), and refunds pending at Stripe for more than 3 days (`status = 'pending'` older than the stale-refund sweep's escalation age, D-k).
- Oldest overdue lists the overdue set longest past due first (ties by amount, then document number), each row with a Record payment… button that opens the existing dialog; after success the figures refresh and focus moves to the next row's button (or the card title when the list empties).

### US2 — Every figure drills into the list it summarises (P1)

Done when:
- The Outstanding and Overdue tiles link to `/admin/invoices?status=issued` and `?status=overdue`, and the list's count equals the tile's count.
- Each aging row is one link named "{bucket}: {amount}, {count} invoices" to `status=overdue&dueAfter=…&dueBefore=…` ("Not yet due": `status=issued&dueAfter=<today>`), and the list shows the same count.
- `/admin/invoices?dueAfter=YYYY-MM-DD` keeps invoices with `due_date >= dueAfter`; with `dueBefore` it gives a range; an invalid value is ignored exactly as an invalid `dueBefore` is; the filter shows as a chip that clears it.
- `/admin/invoices?plan=<plan_id>` keeps membership invoices on that plan (`invoices.plan_id`, every plan year); any well-formed id (≤ 64 characters) filters, so an id this year's plans do not know matches its invoices or nothing, never the whole list (D-i); an empty or over-long value is ignored; the filter shows as a chip naming the plan (or the id, when unknown) that clears it.
- Every dashboard link carries the active `type`, `plan` and `origin` filters as the list's `subject`, `plan` and `origin`, so the list count equals the figure it came from under any filter.
- Export CSV opens the existing `GET /api/admin/invoices/export.csv` with `from` = the FY start and `to` = the earlier of FY end and today.

### US3 — Filters (P1)

Four filters in one FilterBar row: Invoice type (All · Membership · Events), Fiscal year (current FY and the two before), Plan (All · each active plan), Origin (All · Created by staff · Auto-renewal; shown only while `FEATURE_AUTO_INVOICE` is on).

Done when:
- Each filter applies on pick, writes the URL (`type`, `fy`, `plan`, `origin`), and shows a chip; Clear all resets them; the default FY shows no chip.
- Picking a Plan sets Invoice type to Membership and both chips show; with Invoice type = Events the Plan filter is hidden and any `plan` param is dropped.
- As-of-today figures (Outstanding, Overdue, Collected this month, aging, Oldest overdue, Needs attention) ignore `fy` but follow type, plan and origin (Needs attention's caption says "under these filters" when any is set); Collected this year, the trend chart and By payment method follow it, and their captions start with the FY label.
- An FY outside the list falls back to the current FY, and an unknown value of type or origin to All, without an error page; a well-formed but unknown plan id still filters (D-i), so the dashboard and the list it links to show the same nothing rather than different everythings.
- Filtered to nothing, each card shows its own zero with "No invoices match these filters"; the page-level empty state never shows.

### US4 — Manager reads, never acts (P1)

Done when:
- A manager (holds `invoicing.read` + `insights.finance`, not `invoicing.write`) sees every figure but no Record payment…, no New invoice, and no draft or auto-renewal rows in Needs attention; Export CSV stays.
- The cut is made on the server: the manager's HTML contains none of the hidden rows or buttons.
- Marketing and member roles get the shell's "Page not available"; with `FEATURE_INVOICE_DASHBOARD` off the route is `notFound()` and the nav item is absent.

### US5 — States (P2)

Done when:
- Loading: `loading.tsx` shows Stat loading tiles and each card's skeleton at its loaded height, filters disabled, and an sr-only "Loading the invoice dashboard" status.
- No invoices yet: header, disabled filters and one EmptyState ("No invoices yet", "Figures appear here as soon as the first invoice is issued. Drafts are not counted.", New invoice for admins only).
- One card failed: that card alone shows EmptyState `tone="danger" size="sm"` with the reference id and Try again; the other cards render.

### US6 — Accessible, localised, fast (P2)

Done when:
- The 7 boards match at 390 and 1280 px in light and dark.
- Each chart has an sr-only ChartDataTable and an `aria-hidden` drawing; card titles are h2 under the page h1; touch targets are 44 px below 640 px or on a coarse pointer; the `@a11y` axe scan passes in light and dark.
- EN, TH and SV render with no missing key; TH shows the Buddhist year for display only.
- Each dashboard query runs ≤ 150 ms p95 on the Neon dev branch (server time, D-j); recharts is out of first-load JS; `/admin/finance` has a bundle budget.
- Tenant B's invoices, payments and refunds never appear in tenant A's figures (cross-tenant integration test, Principle I).

## Figure definitions

As the design spec § Figure definitions, with the corrections in § Premises and these definitions, which replace the design spec's where they differ:

- **Tax point** = `COALESCE(payment_date, (paid_at AT TIME ZONE 'Asia/Bangkok')::date)`, the register's own expression, exported from the invoicing barrel and used by the dashboard and migration 0318 alike.
- **Collected (document basis, D-d)** for a period = Σ `total_satang` of invoices in `paid | partially_credited | credited` whose tax point falls in it, − Σ `credit_notes.total_satang` issued in it (by `issue_date`), − Σ waived refunds (`status = 'succeeded' AND credit_note_waived_at IS NOT NULL`) by `(completed_at AT TIME ZONE 'Asia/Bangkok')::date`. Every subtraction joins its invoice and is restricted to the same status set and the four filters, so a refund on a void invoice never subtracts. Per invoice there is either a credit note or a waiver, never both, so nothing is subtracted twice. A refund Stripe paid out whose credit note could not be booked stays `pending` (with a `refund_cn_deferred` audit event) and is not subtracted until the hourly sweep books it; Needs attention counts refunds pending for more than 3 days (D-k).
- **By payment method**: each invoice's method is its `payments` row in `succeeded | partially_refunded | refunded` (`DISTINCT ON (invoice_id)`, latest `completed_at`), else `invoices.payment_method`; amounts always from `invoices`, never `payments.amount_satang`; a credit note carries its invoice's method and a waived refund the method of the payment it returned money through (the channel the cash left by; with one method payment per invoice, as on SweCham today, the two agree), so the rows add up to the tile.
- **Invoiced (Billed)** for a month = Σ `total_satang` of invoices issued in it (`issue_date`) whose status is neither `draft` nor `void` (D-e: voided invoices are excluded outright, so a past month can change when one of its invoices is voided; the caption says so), − credit notes by `issue_date`.
- **Fiscal year** filters are date ranges from `fiscal_year_start_month` (Bangkok): `issue_date` for Billed, tax point for Collected and By method. Never `invoices.fiscal_year`, which is the issue-date FY.
- The words "revenue" and "net of credit notes" appear nowhere on the page; the series are Billed and Collected. Aging shares are shares of amount, not of count.

In short: amounts incl. VAT, summed in satang (bigint) before rounding; Bangkok calendar dates; all queries inside `runInTenant` and under the four filters. Tiles and card headlines show whole baht (compact below 640 px); rows show 2 decimals. Months still to come in the selected FY draw as labelled empty slots; the current month is lighter and captioned as in progress.

## Decisions

Decisions 1–10 of the design spec stand. Added in this session (22 Oct 2026):
- D-a: **No cache in v1.** Read per request; add a cache only if a query misses its budget.
- D-b: **Add the collected-date index now** (migration 0318, slice 2).
- D-c: **No spec-review-panel**; `chamber-os-architect`, `financial-integrity-reviewer` and `financial-reporting-analyst` read the plan instead.
- D-d: **Collected uses the document basis** (§ Figure definitions), not receipts less succeeded refunds.
- D-e: **Voided invoices are excluded** from Billed outright; past months may change, and the caption says so.
- D-f: **The invoice list gains `plan`** in slice 1, so drill-downs match under a Plan filter.
- D-g (OQ1 closed): the Billed bar stays on `issue_date`; it is a billing view, not the ภ.พ.30 basis, and its caption says to use the tax-document register for VAT.
- D-j: **The 150 ms p95 budget is per-query server execution time** (`EXPLAIN (ANALYZE)` planning + execution inside `runInTenant`, RLS on), measured at 2k invoices; this replaces D-h's client-side timing; the page's wall-clock TTFB is measured on the Vercel preview in slice 3 (22 Oct, after the slice 2 measurement: client time from Bangkok is ~185 ms of round trip to Singapore).
- D-k: **Needs attention row 5 = refunds `pending` longer than the stale-refund sweep's escalation age (3 days)**, the payments module's own constant. Since the money-remediation F-3 change, a refund Stripe paid out whose credit note was not booked stays `pending` (never `failed + f4_bridge_%`, which only legacy rows carry); the row covers it and the unknown-outcome case, and also counts legacy `failed` refunds with `failure_reason_code LIKE 'f4_bridge_%'` (Stripe paid out, never booked, never subtracted) so no such refund is invisible (22 Oct, slice 2 review).
- D-l: **The dashboard's Plan filter follows D-i too**: a well-formed but unknown plan id filters (the cards show zero) rather than falling back to All, so a figure and the list it links to agree. This closes the slice-3 question about US3.4 (23 Oct, after the slice 2 spec audit; reversible at slice 3).
- D-i: **An unknown `?plan=` id still filters** (chip shows the id), so a link from another plan year or a lookup failure never widens the list unmarked (22 Oct, after the slice 1 review).
- D-h (OQ3 closed; the timing method is superseded by D-j): p95 measured at 2k invoices on a disposable tenant, serially and warm (≥ 20 runs), with row counts stated; `EXPLAIN` under `SET enable_seqscan = off` proves the tax-point index matches the query.

## Premises checked against the code

| Design spec says | Code says | Taken here |
|---|---|---|
| refunds `status = 'completed'` | `pending \| succeeded \| failed` (`src/modules/payments/domain/refund.ts:35`) | D-d: only waived `succeeded` refunds are subtracted; credited ones are covered by their credit note |
| Collected = receipts less refunds | a refund with an `invoice_voided` waiver sits on a void invoice never counted in (`refund-credit-note-requirement.ts:38`); an offline refund leaves only a manual credit note (`refunds.payment_id` NOT NULL) | D-d document basis |
| refunds "failed at Stripe" | `failed` + `f4_bridge_%` means Stripe paid out but booking failed (`drizzle-refunds-repo.ts:546`); `failed` is terminal and a retry is a new row | attention counts payments with a Stripe-failed refund and no later succeeded or pending attempt; row 5 became D-k |
| one payment method per invoice | `payments_one_active_per_invoice` (0033:166) does not cover `refunded` | `DISTINCT ON (invoice_id)` + a two-row integration test |
| auto-refunded payments might double-subtract | `confirm-payment` auto-refunds create **no** `refunds` row (`process-charge-refunded.ts:297`) | nothing to exclude |
| home revenue chart still on paid date (design spec follow-up) | moved to payment date by #596 | follow-up dropped; the charts still differ: home is ex-VAT, nets credit notes into the paid month, and falls back to `issue_date` |
| a port onto renewals for the auto-renewal queue | `renewals → insights → renewals` barrel cycle (`renewals/index.ts:1016`, `benefit-consumption-reader-insights.ts:47`) | count `origin = 'auto_renewal' AND status = 'draft'` in SQL (`invoices_auto_renewal_draft_idx`) |
| the invoice list can take every dashboard filter | it has `subject` and `origin`, no `plan` (`invoice-repo.ts:255-290`) | D-f |
| unstable_cache invalidated by existing write paths | no invoicing write path calls `revalidateTag`; pages use `router.refresh()` | D-a |
| indexes `(tenant_id, status, due_date)`, `(tenant_id, payment_date)` | neither; partial `invoices_tenant_due_date_issued_idx (tenant_id, due_date) WHERE status = 'issued'` (0019) | due-date queries use the partial; D-b adds the collected-date expression index |
| "Invoiced bars agree with the tax-document register and ภ.พ.30" | the register buckets receipts by the §78/1 tax point `COALESCE(payment_date, paid_at)` (`drizzle-invoice-repo.ts:1784`), not by `issue_date` | claim withdrawn pending OQ1 |
| nav item "label" | `NavItem.titleKey`; hiding by flag needs a `NavVisibilityFlag` member + staff-layout wiring (`src/config/nav.ts:136-150`) | add `invoiceDashboard` |
| Export CSV "with the FY range" | route takes `from` / `to`, inclusive, ≤ 366 days | US2 |
| card/PromptPay via the payments port | `listSucceededPaymentMethods` reads `status = 'succeeded'` only, feeds the CSV export, and takes an unbounded `IN (...)` | one SQL per card in the insights adapter joining the barrel-exported `paymentsTable`; the existing use case is unchanged |
| drafts and auto-renewal counts "existing" | drafts only via a JS-paging adapter; auto-renewal queue only in a renewals cron | new SQL counts (row above) |
| largest-remainder allocation | `allocatePercentages` is private in `src/components/dashboard/invoice-status-chart.tsx:103` | extract to `src/lib/` and reuse |
| ChartFrame / ChartDataTable from AURA | app components in `src/components/dashboard/` | reuse those |

## Out of scope

- Any new money mutation, export, or schema change other than migration 0318's indexes.
- Median days to pay; collection rate; largest debtors; recognising membership revenue over the coverage period (design spec § Follow-ups).
- Making the home chart and this page's chart agree month by month (decision 5).
- The CSV export labelling a refunded Stripe invoice "other" (follow-up issue).

## Open questions

None open. OQ1–OQ3 were closed on 22 Oct 2026 (D-g, D-e, D-h). To check in slice 2 with a scratch probe on dev (not committed): void invoices carrying `paid_at` or a refund; manual credit notes (`source_refund_id IS NULL`) by `payment_method`; invoices with more than one payments row in the method set; paid-family invoices with neither `payment_date` nor `paid_at` (if any exist, the page footnotes "{n} paid invoices without a payment date are not shown").
