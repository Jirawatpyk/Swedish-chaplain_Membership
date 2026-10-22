# 124 — Invoice dashboard (`/admin/finance`)

**Size**: L (insights + payments + invoicing list + renewals count; money figures; a migration; a new flag; an RBAC gate).
**Status**: spec agreed with the maintainer; plan approved 22 Oct 2026; slices 1–3 not built.
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
- Collected this month is the current Bangkok calendar month's payments by `COALESCE(payment_date, Bangkok date of paid_at)`, less refunds with `status = 'succeeded'` by `completed_at` in that month, whatever fiscal year is selected.
- Collected this year is the same over the selected fiscal year to date; By payment method splits it into bank transfer, PromptPay, card, cheque, cash, other, and a Stripe-paid invoice is counted as card or PromptPay, never other, and once only.
- Needs attention shows four counts: drafts not issued, auto-renewal drafts awaiting review, receipt PDF failed, refunds failed at Stripe.
- Oldest overdue lists the overdue set longest past due first (ties by amount, then document number), each row with a Record payment… button that opens the existing dialog; after success the figures refresh and focus moves to the next row's button (or the card title when the list empties).

### US2 — Every figure drills into the list it summarises (P1)

Done when:
- The Outstanding and Overdue tiles link to `/admin/invoices?status=issued` and `?status=overdue`, and the list's count equals the tile's count.
- Each aging row is one link named "{bucket}: {amount}, {count} invoices" to `status=overdue&dueAfter=…&dueBefore=…` ("Not yet due": `status=issued&dueAfter=<today>`), and the list shows the same count.
- `/admin/invoices?dueAfter=YYYY-MM-DD` keeps invoices with `due_date >= dueAfter`; with `dueBefore` it gives a range; an invalid value is ignored exactly as an invalid `dueBefore` is; the filter shows as a chip that clears it.
- Export CSV opens the existing `GET /api/admin/invoices/export.csv` with `from` = the FY start and `to` = the earlier of FY end and today.

### US3 — Filters (P1)

Four filters in one FilterBar row: Invoice type (All · Membership · Events), Fiscal year (current FY and the two before), Plan (All · each active plan), Origin (All · Created by staff · Auto-renewal; shown only while `FEATURE_AUTO_INVOICE` is on).

Done when:
- Each filter applies on pick, writes the URL (`type`, `fy`, `plan`, `origin`), and shows a chip; Clear all resets them; the default FY shows no chip.
- Picking a Plan sets Invoice type to Membership and both chips show; with Invoice type = Events the Plan filter is hidden and any `plan` param is dropped.
- As-of-today figures (Outstanding, Overdue, Collected this month, aging, Oldest overdue) ignore `fy`; Collected this year, the trend chart and By payment method follow it, and their captions start with the FY label.
- An unknown plan or an FY outside the list falls back to the default without an error page.
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
- Each dashboard query runs ≤ 150 ms p95 on the Neon dev branch (volume per § Open questions OQ3); recharts is out of first-load JS; `/admin/finance` has a bundle budget.
- Tenant B's invoices, payments and refunds never appear in tenant A's figures (cross-tenant integration test, Principle I).

## Figure definitions

As the design spec § Figure definitions, with the corrections in § Premises. In short: amounts incl. VAT, summed in satang (bigint) before rounding; Bangkok calendar dates; all queries inside `runInTenant` and under the four filters. Tiles and card headlines show whole baht (compact below 640 px); rows show 2 decimals. Credit notes and refunds count in the month their document is issued (decision 5). Months still to come in the selected FY draw as labelled empty slots; the current month is lighter and captioned as in progress.

## Decisions

Decisions 1–10 of the design spec stand. Added in this session (22 Oct 2026):
- D-a: **No cache in v1.** Read per request; add a cache only if a query misses its budget.
- D-b: **Add the collected-date index now** (migration 0318, slice 2).
- D-c: **No spec-review-panel**; `chamber-os-architect`, `financial-integrity-reviewer` and `financial-reporting-analyst` read the plan instead.

## Premises checked against the code

| Design spec says | Code says | Taken here |
|---|---|---|
| refunds `status = 'completed'` | `pending \| succeeded \| failed` (`src/modules/payments/domain/refund.ts:35`) | `succeeded` + `completed_at`; waived §105 refunds are `succeeded` rows and are subtracted (cash left) |
| auto-refunded payments might double-subtract | `confirm-payment` auto-refunds create **no** `refunds` row (`process-charge-refunded.ts:297`) | no exclusion needed; Collected counts the invoice once |
| unstable_cache invalidated by existing write paths | no invoicing write path calls `revalidateTag`; pages use `router.refresh()` | D-a |
| indexes `(tenant_id, status, due_date)`, `(tenant_id, payment_date)` | neither; partial `invoices_tenant_due_date_issued_idx (tenant_id, due_date) WHERE status = 'issued'` (0019) | due-date queries use the partial; D-b adds the collected-date expression index |
| "Invoiced bars agree with the tax-document register and ภ.พ.30" | the register buckets receipts by the §78/1 tax point `COALESCE(payment_date, paid_at)` (`drizzle-invoice-repo.ts:1784`), not by `issue_date` | claim withdrawn pending OQ1 |
| nav item "label" | `NavItem.titleKey`; hiding by flag needs a `NavVisibilityFlag` member + staff-layout wiring (`src/config/nav.ts:136-150`) | add `invoiceDashboard` |
| Export CSV "with the FY range" | route takes `from` / `to`, inclusive, ≤ 366 days | US2 |
| card/PromptPay via the payments port | `listSucceededPaymentMethods` reads `status = 'succeeded'` only and also feeds the CSV export | new use case over `succeeded \| partially_refunded \| refunded`; the existing one is unchanged |
| drafts and auto-renewal counts "existing" | drafts only via a JS-paging adapter; auto-renewal queue via `readAutoInvoiceGaugeRow` (renewals barrel), cron-only | new SQL count; a port onto the renewals barrel |
| largest-remainder allocation | `allocatePercentages` is private in `src/components/dashboard/invoice-status-chart.tsx:103` | extract to `src/lib/` and reuse |
| ChartFrame / ChartDataTable from AURA | app components in `src/components/dashboard/` | reuse those |

## Out of scope

- Any new money mutation, export, or schema change other than migration 0318's indexes.
- Moving the home dashboard's revenue chart to `payment_date`; median days to pay; collection rate; largest debtors; recognising membership revenue over the coverage period (design spec § Follow-ups).
- Making the two revenue charts (home vs this page) agree month by month (decision 5).
- The CSV export labelling a refunded Stripe invoice "other" (follow-up issue).

## Open questions (block slice 2's queries; slice 1 is unaffected)

- **OQ1 — Invoiced basis.** The tax register is by payment tax point, the Invoiced bar is by `issue_date`. Keep `issue_date` (an accrual view that will not match ภ.พ.30), and reword `trend.description` accordingly? Owner: maintainer, advised by `financial-reporting-analyst`.
- **OQ2 — Voided invoices in closed months.** "Status not draft/void" makes a March invoice voided in May leave March's bar in May, so closed months move. Count it in its issue month and subtract it in its void month, or exclude void outright? Owner: maintainer, advised by `financial-reporting-analyst`.
- **OQ3 — Measurement volume.** The 150 ms p95 is to be measured on a disposable tenant created and deleted inside the run (never the dev SweCham tenant, whose §87 numbering is gap-free). 20k invoices as the design spec says, or 2k with EXPLAIN showing index scans? Owner: maintainer.
