# Renewals Pipeline Page — Targeted Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the `/admin/renewals` page so the treasurer's core loop (see who's due/overdue/suspended → chase → collect → recover) is the dominant, one-click surface — without rewriting the shipped foundations.

**Architecture:** A **targeted restructure in three independently-shippable waves**, not a ground-up rewrite. The audit (3 independent lenses: IA, enterprise-UX, admin-workflow) found the foundations excellent (a11y rigor, i18n 3-locale parity, Suspense streaming, per-section error isolation, clean read/write boundary, URL-as-SSOT) and the defects to be composition/surfacing problems over already-shipped use-cases. Each wave is one PR: **Wave 1** = pure JSX/i18n reordering + surfacing existing dialogs (no backend/URL/money change); **Wave 2** = surface COLLECT + at-risk into the pipeline + the single new THB money aggregation + sortable/dense table; **Wave 3** = cohort bulk actions, mobile card-stack, merged "Today" worklist, saved segments.

**Tech Stack:** Next.js 16 App Router (RSC + Suspense streaming) · React 19 · TypeScript strict · Drizzle ORM + Neon Postgres (RLS via `runInTenant`) · Vitest + @testing-library · Playwright (@a11y/@i18n, preview-gated) · next-intl (EN canonical + TH + SV) · Base UI / shadcn primitives · Tailwind v4 · sonner toasts.

## Global Constraints

- **Money path is sacred (Principle IV):** any Mark-paid surfacing (single OR bulk) MUST reuse the EXISTING state-guarded `POST /api/admin/renewals/{cycleId}/mark-paid-offline` route + the `PAYABLE_STATUSES` guard from `cycle-admin-actions.tsx` + its audit path. **Never** add a new settlement/mutation path. Bulk mark-paid needs a confirm dialog with a per-invoice THB total.
- **URL-param contract is load-bearing + tested** (`admin-pipeline-route.test.ts` contract · `renewal-pipeline-dashboard` + `renewal-i18n` e2e · `urgency-bucket-tabs`/`month-bar-chart`/`should-show-empty-state` unit): `?urgency` (default `t-30`), `?month`, `?tier`, `?view` + their mutual-exclusion deletion logic. **Reordering render output is safe.** Changing a param name/semantics/default is a behaviour change → update those tests deliberately (each task names the tests it touches).
- **Preserve (do not regress):** ARIA tablist/roving-tabindex + arrow/Home/End nav · focusable `role=region` scroll strips · the client-pinned `aria-live` `ResultCountAnnouncer` (keep it; Wave 1 adds a *sighted* mirror, not a replacement) · sr-only landmark headings · 44px row-action targets · AA-contrast urgency pills with text labels · i18n 3-locale parity with `t.has()` guards + BE-aware localised dates · Suspense streaming + CLS-0 skeletons · per-section best-effort `try/catch` isolation · URL-as-SSOT.
- **Repo conventions:** `pnpm` (not npm) · **NO prettier** (hand-format, match the nearest file) · Conventional Commits · TDD (failing test first, commit red, then green) · unit via `pnpm test <path>`, integration via `pnpm test:integration <path>` (live Neon, guarded off prod), e2e `pnpm test:e2e --grep "<name>" --workers=1` (preview-gated) · i18n keys in `src/i18n/messages/{en,th,sv}.json` MUST stay at parity (`pnpm check:i18n`) · run `pnpm typecheck` as the final gate before each commit.
- **Server components aren't unit-testable in Vitest** — `page.tsx` edits are verified by extracting logic into testable client components + preview-gated e2e + manual; each `page.tsx` task says so.

## Plan-wide decisions

- **4 section tabs (Pipeline · Pending review · Tasks · Tier upgrades) stay as the top navigation axis** — they are 4 distinct workflows with tested URL routes; do NOT dissolve them. Instead make the tab STRIP an at-a-glance dashboard: **Wave 1 Task 2 puts a count badge on the Pending-review tab; extend the same badge treatment to Tasks and Tier upgrades in the same task** (all counts sourced from the existing per-section use-cases via Suspense islands — zero new queries), and verify the priority order Pipeline → Pending review → Tasks → Tier upgrades. The eventual single-pane "Today" worklist (Wave 3) blends the 4 without replacing them.
- **Ship each wave as its own PR** (independently testable + reviewable). Wave 1 is the ~80%-value, ~lowest-risk wave — ship it first and alone.

## Decisions (finalized 2026-07-27, financial-integrity-reviewed — build to these)

Flagged during drafting, DECIDED so the plan is execution-ready, then run through
a **financial-integrity review (verdict: CONDITIONAL PASS)**. That review REFINED
the money decisions below — **build to the refined values, NOT the original
draft sketches** (the Wave 2 Task 6 formula sketch + the Wave 3 settlement-preview
fixture in the task bodies predate this review and are superseded here). #1 and
#3 remain money/tax-facing → still surface the chosen value to the tenant
accountant at Wave 2/3 review (and `thai-tax-compliance-auditor` for the §87/RC
period basis). Grounding fact the review pinned everything to: an unpaid `issued`
invoice **cannot be credited** (`issueCreditNote` gates `status ∈ {paid,
partially_credited}`, `issue-credit-note.ts:449`) and there is **no partial-
payment state** (no `amount_paid` column — payment is whole-invoice `issued→paid`).

1. **Collection-rate definition (Wave 2 Task 6) — REFINED (the original `collected / (collected+overdue)` was financially broken):** the draft mixed a month-FLOW numerator with an all-time-STOCK denominator, so the rate collapsed to ~0% every start-of-month (numerator resets while stock persists) — a pure artifact that would alarm the treasurer. **Correct formula — a same-basis point-in-time snapshot (due-cohort settlement rate), scoped fiscal-year-to-date**, over membership invoices only:
   - `overdue` (owed) = `SUM(total_satang) WHERE status='issued' AND due_date < today` — **no** credit-netting (unpaid can't be credited).
   - `settledDueToDate` = `SUM(total_satang - credited_total_satang - waivedRefundSatang) WHERE status IN ('paid','partially_credited','credited') AND due_date < today` — **MUST net BOTH `credited_total_satang` AND per-invoice Track-B §105/void waived refunds** (reuse `listWaivedRefundTotalsByInvoice` from `@/modules/payments`, exactly as the F9 dashboard revenue reads do). **Forward-check refinement (2026-07-28, DECIDED "ตามเอเจ้น"):** without waived-netting, a paid-then-§105-cash-refunded membership invoice (status stays `paid`, `credited=0`) counts as fully settled here but is netted out in F9 → the two surfaces disagree and the rate inflates.
   - `rate = settledDueToDate / (settledDueToDate + overdue)`; exclude `void` and `due_date >= today` (not-yet-due) from both legs; divide-by-zero → "—". Always ≤ 100%, no month-reset, no double-count.
   - **NEVER** ship the flow÷stock formula. If a 4th aggregate is unwanted, the only acceptable fallback is `overdue / (dueInWindow + overdue)` **relabelled "Overdue rate"** — do not call flow÷stock "Collection rate".
2. **"Collected this month" tile window (Wave 2 Task 6) — CONFIRM (operational, decoupled from #1):** **current Asia/Bangkok calendar month** (`date_trunc('month', now AT TIME ZONE 'Asia/Bangkok')`) for the *cash-collected-this-month* tile — matches monthly bank-statement reconciliation cadence. **Label it as an operational figure, not a tax/period-close total** (the RC receipt register buckets by §87 payment fiscal year separately). This tile stands ALONE — it does NOT feed the #1 rate denominator. **Netting fix (was understated in the draft; + forward-check waived alignment 2026-07-28):** the collected-this-month leg must be `SUM(total_satang - credited_total_satang - waivedRefundSatang) WHERE status IN ('paid','partially_credited','credited')` keyed by `paid_at` this month — net BOTH credits AND per-invoice Track-B waived refunds (same `listWaivedRefundTotalsByInvoice` alignment with F9's monthly revenue read); summing only `status='paid'` drops a paid-then-partially-refunded invoice out entirely.
3. **Bulk Mark-paid scope (Wave 3, Principle IV) — REFINE (restrict is correct; harden the gate):** **restrict bulk to rows with a live linked invoice**, and gate `previewable = true` ONLY when that linked invoice is actually `status='issued'` AND non-void — **not** merely `linkedInvoiceId != null`. A stale/orphan `linkedInvoiceId` pointing at an already-paid/void/credited invoice must NOT contribute its amount to the batch total (the guarded route would 409/skip it, but the *displayed* THB would be wrong → the operator enters the wrong batch bank-transfer amount). Show `total_satang - credited_total_satang` (defensively; for a genuine `issued` row `credited=0`, so it equals `total_satang`). Minting a §86/4 (`upcoming`/no-bill) stays **single-row**; such rows render "not bulk-payable". NOTE: the enum has **`issued`**, not `'sent'` — the real query filters `status='issued'` (a draft fixture used the non-existent `'sent'`).
4. **Bulk shared payment reference (Wave 3) — CONFIRM:** one operator-entered reference for the batch (models one real bank transfer allocated across N members), written verbatim to **both** `audit_log` **and** `invoices.payment_reference` (the §86/4 receipt field). Fine when it reflects one bank transaction; each mark-paid is its own advisory-locked atomic tx (no torn write). Operator-training point: if the payments are genuinely N separate transfers, use single-row, not bulk.
5. **Bulk partial-failure UX (Wave 3) — REFINE (continue-on-error is right; expose orphans):** continue-on-error (each row atomic; better than stop-on-first, which would settle rows 1–4 and abandon 6–20 after the money already moved). BUT the runner **must NOT auto-retry**, must **separate `f4_orphan_invoice` from transient failures** in the summary, and must **keep the failed/skipped rows' selection + company names visible after the run** — orphan means a §87 number is already burned and a bulk retry would mint a DUPLICATE §86/4. A bare count is not enough on a money screen: the treasurer needs to know *which* members didn't settle (to reconcile the bank amount) and fix orphans from each cycle's detail page.
6. **Bulk Mark-contacted (Wave 3):** **dropped** — no shipped batch outreach backend. Outreach stays single-row (the OutreachDialog surfaced in Wave 1). Do not add a new use-case for it in this wave.
7. **Wave 3 PR split:** the Wave 3 PR ships **Tasks 9–12 only** (settlement-preview + row-selection + bulk-action-bar + mobile card-stack). **Task 13 (Today worklist)** and **Task 14 (saved segments)** split to their own follow-up branches (`nnn-renewals-today-worklist`, `nnn-renewals-saved-views`).
8. **THB minor-unit (Wave 3, impl note):** amounts are satang (`amountThbMinor`, /100 for display); before the Drizzle join, verify the invoices grand-total column's exact unit/name and match what `mark-paid-offline` mints (apply migration + integration test before commit).

**Extra tests the review requires when building the above:**
- **fast-check property (rate):** `rate ∈ [0,1]` AND **invariant across a month boundary** (fixed seed, advance `nowIso` past the 1st → rate must NOT jump) — directly catches the flow/stock trap.
- **live-Neon (collected leg):** seed a `paid`→`partially_credited` invoice, assert the collected-this-month leg = `total − credited`, not 0.
- **live-Neon (settlement-preview):** a linked invoice in `paid`/`void`/`credited` → `previewable=false`, excluded from `total_thb_minor` (assert on real `status='issued'`, not the non-existent `'sent'`).
- **contract/unit (bulk runner):** `f4_orphan_invoice` reported separately from transient + no auto-retry.

> **No pre-existing SHIPPED-code money bug was found** — the review verified the live money model is sound (credit-note gate, no partial-payment state, atomic per-cycle mark-paid, void/credited filtering). Every refinement above is to the *plan's proposed* aggregates, caught before build. (Forward-check DONE 2026-07-28, 3-agent opus workflow — verdict `naming-collision`, NO definition-conflict: F9 admin home has NO collection-rate % / no "Collected" KPI, so the Wave 2 rate is genuinely new. It surfaced the waived-refund netting refinement now folded into #1/#2 above, plus a Wave 2 labeling mandate — see § Forward-check labeling below.)

**§ Forward-check labeling (Wave 2 Task 6 — MANDATORY, from the 2026-07-28 F9-KPI cross-check):** F9's admin home (`src/app/(staff)/admin/(home)/page.tsx` — there is NO `admin/insights/**` route) already shows revenue *amount* (ex-VAT, all invoice types, fiscal-YTD) + an invoice-status donut (paid/unpaid/overdue *amounts*, VAT-inclusive, all-time) + an overdue *count*. To avoid a cross-page naming-collision where the treasurer tries to reconcile numbers that intentionally differ:
> - Caption EVERY Wave 2 money figure with its basis: rate → "membership · FY-to-date · due-cohort · incl. VAT"; collected tile → "membership dues collected · this calendar month · incl. VAT · operational cash, not a period-close/tax total".
> - NEVER label a Wave 2 figure a bare "Overdue" — F9 already has overdue-COUNT (all types) + overdue-AMOUNT (donut, all-time). Wave 2's owed leg is "membership dues past due" with its scope/window stated; never imply it is the donut's overdue or a shown rate denominator.
> - Wave 2 figures are VAT-inclusive; F9's revenue KPI is ex-VAT — state "incl. VAT" so no one treats Wave 2 collected as a subset of F9 revenue.
> - Reconciliation anchor: the Wave 2 rate reconciles ONLY to the membership subset of the invoices register (status + due_date + total/credited/waived) — NOT ภ.พ.30 (VAT by payment_date) nor the paid-invoices CSV export (status='paid' only, a 3rd "paid" population).

---

## File Structure

Every file this plan creates or modifies (deduped across waves). "Waves" shows which wave(s) touch it — files touched by multiple waves (`page.tsx`, `pipeline-table.tsx`, the repo, i18n) must be edited in wave order to avoid conflicts.

| File | Action | Waves | Responsibility |
|---|---|---|---|
| `src/app/(staff)/admin/renewals/[cycleId]/_components/cycle-admin-actions.tsx` | modify | 2 | Consume the extracted dialog + gate; remove the inline mark-paid Dialog (behaviour-preserving refactor). |
| `src/app/(staff)/admin/renewals/_components/at-risk-widget.tsx` | modify | 2 | Route its error/empty states through the shared LoadErrorCard + EmptyState (mounted inside the consolidated work-queue). |
| `src/app/(staff)/admin/renewals/_components/load-error-card.tsx` | create | 2 | Shared LoadErrorCard extracted from page.tsx so at-risk + tray + money band route through one error skin. |
| `src/app/(staff)/admin/renewals/_components/mark-paid-offline-dialog.tsx` | create | 2 | Controlled dialog extracted verbatim from cycle-admin-actions.tsx; reuses the EXISTING /mark-paid-offline route, validation, and error-code handling — no new settlement path. |
| `src/app/(staff)/admin/renewals/_components/members-without-cycle-tray.tsx` | modify | 2 | Route its error/empty states through the shared LoadErrorCard + EmptyState. |
| `src/app/(staff)/admin/renewals/_components/pipeline-bulk-action-bar.tsx` | create | 3 | Sticky bulk bar: bulk send-reminder (per-cycle route fan-out) + bulk mark-paid (confirm dialog with per-invoice THB totals, per-row guarded route); finalFocus + progress + BULK_CAP; Mark-contacted omitted (US4) |
| `src/app/(staff)/admin/renewals/_components/pipeline-card-list.tsx` | create | 3 | Mobile card-stack presentation (one card per cycle) reusing UrgencyPill/cycle-cells/RowActionsMenu |
| `src/app/(staff)/admin/renewals/_components/pipeline-money-band.tsx` | create | 2 | Server presentational THB KPI band (ux-standards §1.3 hero numbers) with one-click filter shortcuts onto the existing URL contract. |
| `src/app/(staff)/admin/renewals/_components/pipeline-table.tsx` | modify | 1, 2, 3 | Item ②: add useState import + OutreachDialog import; lift outreachFor state; replace RowActionsMenu with RowActions (visible Send reminder button promoted out of the menu; Open kept; disabled Mark contacted stub replaced with a working item that opens OutreachDialog); render OutreachDialog at table level |
| `src/app/(staff)/admin/renewals/_components/pipeline-with-bulk.tsx` | create | 3 | Client wrapper lifting selection state + mounting the bulk bar (mirrors directory-with-bulk.tsx) |
| `src/app/(staff)/admin/renewals/_components/renewals-section-tabs.tsx` | modify | 1 | Item ④B: add optional pendingReviewCount prop; render count badge (aria-hidden number + sr-only tabCountSr) on the Pending-review tab when > 0 |
| `src/app/(staff)/admin/renewals/_components/saved-segments-bar.tsx` | create | 3 | Chip bar that router.push-es stored filter queries + a Save-current-view affordance (LARGE/deferrable) |
| `src/app/(staff)/admin/renewals/_components/today-worklist.tsx` | create | 3 | Suspense-wrapped server component rendering the merged Today worklist (LARGE — candidate follow-up branch) |
| `src/app/(staff)/admin/renewals/_components/urgency-bucket-tabs.tsx` | modify | 1 | Item ③: add monthLensActive prop → dim region (opacity-60) + aria-describedby hint span + title; handleChange (URL exit-lens logic) left unchanged |
| `src/app/(staff)/admin/renewals/_components/work-queue-tabs.tsx` | create | 2 | 2-lens client tablist (roving tabindex) folding the pipeline + at-risk into one work-queue; no URL param. |
| `src/app/(staff)/admin/renewals/_lib/mark-paid-gate.ts` | create | 2 | Single source of truth for PAYABLE_STATUSES + shouldOfferMarkPaid, shared by the pipeline row and cycle-detail control (mirrors the route state-machine guard). |
| `src/app/(staff)/admin/renewals/_lib/saved-segments.ts` | create | 3 | SSR-safe, tenant-slug-namespaced localStorage store for saved filter segments; zod-validated, capped at 12, filter-subset queries only (LARGE/deferrable) |
| `src/app/(staff)/admin/renewals/page.tsx` | modify | 1, 2, 3 | Items ①③④: reorder RenewalsByMonthSection below the pipeline Card (①); pass monthLensActive + render MonthFilterChip on the filter row (③); render ResultCountLabel beside the announcer + wrap pipeline RenewalsSectionTabs in a Suspense island (PipelineSectionTabsWithCount) that reuses existing loadPendingReactivationReview for the badge count + update the stale hot-path comment (④) |
| `src/app/api/admin/renewals/settlement-preview/route.ts` | create | 3 | GET route returning snake_case {items,total_thb_minor}; f8 kill-switch 404+audit; admin/manager read |
| `src/components/renewals/result-count-label.tsx` | create | 1 | Item ④A: visible aria-hidden sighted twin of ResultCountAnnouncer, reusing srResultCount* keys; returns null when no lens set |
| `src/i18n/messages/en.json` | modify | 1, 2, 3 | Add actions.sendReminderAriaLabel, urgencyBuckets.monthLensHint, pendingReview.tabCountSr (canonical EN) |
| `src/i18n/messages/sv.json` | modify | 1, 2, 3 | SV parity for the 3 new keys |
| `src/i18n/messages/th.json` | modify | 1, 2, 3 | TH parity for the 3 new keys |
| `src/modules/renewals/application/ports/renewal-cycle-repo.ts` | modify | 2, 3 | Add PipelineMoneySummary + loadPipelineMoneySummary; add PipelineSort + PipelineQueryOpts.sort (additive). |
| `src/modules/renewals/application/use-cases/load-pipeline-money.ts` | create | 2 | Thin zod-validate + Result wrapper over cyclesRepo.loadPipelineMoneySummary (mirrors load-pipeline.ts). |
| `src/modules/renewals/application/use-cases/load-pipeline.ts` | modify | 2 | Accept + forward the additive sort param, default-preserving expires_at_asc. |
| `src/modules/renewals/application/use-cases/load-settlement-preview.ts` | create | 3 | Read-only use-case summing per-cycle THB totals for the bulk mark-paid dialog; guards cycleIds 1..100; sums only previewable rows |
| `src/modules/renewals/application/use-cases/load-today-worklist.ts` | create | 3 | Pure composer merging four existing reads (overdue/at-risk/escalations/no-cycle), ranked + de-duped; per-source try/catch isolation |
| `src/modules/renewals/client.ts` | modify | 2, 3 | Client-barrel export PipelineSort (headers are client). |
| `src/modules/renewals/index.ts` | modify | 2, 3 | Barrel-export loadPipelineMoney + PipelineMoneySummary + PipelineSort. |
| `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts` | modify | 2, 3 | Implement the SUM-over-invoices money query (runInTenant + explicit tenant_id predicate, BKK boundaries from nowIso); add the sort-driven orderBy branch using tierBucketOrdinalCaseSql. |
| `tests/contract/renewals/settlement-preview-route.test.ts` | create | 3 | Contract: flag-off 404+audit, 401 passthrough, 400 invalid_query, 200 snake_case shape |
| `tests/e2e/renewal-pipeline-dashboard.spec.ts` | modify | 1 | Preview-gated e2e: item ① DOM-order (pipeline above month chart) + item ② ⋯menu→Mark contacted opens OutreachDialog + visible Send reminder button |
| `tests/integration/renewals/load-pipeline-money.test.ts` | create | 2 | Live-Neon money aggregation: due/overdue/collected sums, BKK-month scoping, cross-tenant isolation. |
| `tests/integration/renewals/load-pipeline-sort.test.ts` | create | 2 | Live-Neon ordering for expires_at_desc + tier_desc. |
| `tests/integration/renewals/settlement-preview.integration.test.ts` | create | 3 | Live-Neon: cycles→invoices join, previewable gate under RLS |
| `tests/integration/renewals/today-worklist.integration.test.ts` | create | 3 | Live-Neon: all four buckets surface once, ranked (LARGE) |
| `tests/unit/app/renewals/pipeline-table.test.tsx` | modify | 1 | Item ②: add non-empty-row tests — visible send-reminder button (aria-label) + fetch POST to /api/admin/renewals/{cycleId}/send-reminder-now |
| `tests/unit/app/renewals/renewals-section-tabs.test.tsx` | modify | 1 | Item ④B: badge tests (count>0 shows badge+sr text; 0/undefined shows none) |
| `tests/unit/app/renewals/urgency-bucket-tabs.test.tsx` | modify | 1 | Item ③: dim + hint tests + regression guard that a dimmed tab still exits the month lens |
| `tests/unit/components/renewals/result-count-label.test.tsx` | create | 1 | Item ④A: unit tests for ResultCountLabel (urgency + month branches, aria-hidden, null branch) |
| `tests/unit/renewals/load-settlement-preview.test.ts` | create | 3 | Unit: sum-of-previewable + invalid_input guards |
| `tests/unit/renewals/mark-paid-gate.test.ts` | create | 2 | Pure predicate test for shouldOfferMarkPaid / PAYABLE_STATUSES. |
| `tests/unit/renewals/pipeline-bulk-action-bar.test.tsx` | create | 3 | Component: send-reminder fan-out count + mark-paid THB total rendering |
| `tests/unit/renewals/pipeline-card-list.test.tsx` | create | 3 | Component: one card per row with urgency text label + actions |
| `tests/unit/renewals/pipeline-density-toggle.test.tsx` | create | 2 | Density toggle localStorage persistence + applied class. |
| `tests/unit/renewals/pipeline-money-band.test.tsx` | create | 2 | THB formatting + filter-shortcut hrefs on the KPI band. |
| `tests/unit/renewals/pipeline-row-mark-paid.test.tsx` | create | 2 | Menu-item visibility by cycle status (Base UI dialog mocked to avoid jsdom hang). |
| `tests/unit/renewals/pipeline-sort-param.test.ts` | create | 2 | loadPipeline schema accepts additive sort, default omission preserved, rejects unknown. |
| `tests/unit/renewals/pipeline-table-selection.test.tsx` | create | 3 | Component: checkbox visibility + cycleId emission |
| `tests/unit/renewals/work-queue-tabs.test.tsx` | create | 2 | Roving-tabindex + panel switching + nested at-risk tablist preserved. |

---

# Wave 1 — Quick-wins (Tasks 1–4)

## Wave 1 — Renewals pipeline UX quick-wins

Scope guardrails honored across all tasks: **no** change to any `?urgency`/`?month`/`?tier`/`?view` param name, default, or mutual-exclusion deletion logic (presentation only); **no** new settlement/mutation path (item ② surfaces the *existing* `send-reminder-now` + `outreach` routes only — no mark-paid); i18n added to en/th/sv at parity (`pnpm check:i18n`). All 4 tasks touch different primary files except `page.tsx` (Tasks 1, 3, 4) — execute in the listed order so the `page.tsx` edits compose without conflict. `page.tsx` is an async server component and is **not** unit-testable in vitest, so its edits are verified by preview-gated e2e + manual; the extracted client components ARE unit-tested (TDD below).

Run unit tests single-file: `pnpm test <path>`. Run e2e (preview-gated, workers=1 MANDATORY): `pnpm test:e2e --grep "<name>" --workers=1`.

---

### Task 1 — Item ②: promote "Send reminder" to a visible row button; replace the disabled "Mark contacted" stub with the wired `OutreachDialog`

**Files:**
- `src/app/(staff)/admin/renewals/_components/pipeline-table.tsx` (modify — restructure `RowActionsMenu` → `RowActions`; lift outreach state; render `OutreachDialog`)
- `tests/unit/app/renewals/pipeline-table.test.tsx` (modify — add non-empty-row action tests)
- `src/i18n/messages/en.json` · `th.json` · `sv.json` (modify — add `actions.sendReminderAriaLabel`)
- `tests/e2e/renewal-pipeline-dashboard.spec.ts` (modify — menu→OutreachDialog flow, preview-gated)

**Interfaces:** `PipelineTable` public props unchanged. New internal `RowActions({ cycleId, memberId, companyName, onRecordOutreach })`; `onRecordOutreach: (t: { memberId: string; companyName: string }) => void`. `OutreachDialog` reused as-is (`memberId` sourced from `PipelineRow.memberId`).

- [ ] **Step 1 (failing test):** Add a non-empty-row suite to `tests/unit/app/renewals/pipeline-table.test.tsx`. It renders one row and asserts (a) a visible button named "Send reminder to Acme Co" exists, and (b) clicking it POSTs to the existing send-reminder route. Append:

```tsx
import { fireEvent } from '@testing-library/react';

const ONE_ROW: ReadonlyArray<PipelineRow> = [
  {
    cycleId: 'cyc-1' as PipelineRow['cycleId'],
    memberId: 'mem-1',
    companyName: 'Acme Co',
    tierBucket: 'premium' as PipelineRow['tierBucket'],
    expiresAt: '2026-12-01T00:00:00.000Z',
    urgency: 't-30',
    status: 'upcoming' as PipelineRow['status'],
    lastReminderAt: null,
    lastReminderStepId: null,
    linkedInvoiceId: null,
    anchored: false,
    closedReason: null,
    emailUnverified: false,
  },
];

describe('<PipelineTable> row actions (item ②)', () => {
  it('renders a VISIBLE "Send reminder" button per row and POSTs to send-reminder-now on click', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ outcome: { kind: 'sent' } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} />
      </NextIntlClientProvider>,
    );

    const btn = screen.getByRole('button', { name: 'Send reminder to Acme Co' });
    fireEvent.click(btn);
    // startTransition schedules the async fetch on a microtask.
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/renewals/cyc-1/send-reminder-now',
        { method: 'POST' },
      ),
    );
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2 (run — fails):** `pnpm test tests/unit/app/renewals/pipeline-table.test.tsx` → the new case fails (no visible "Send reminder to …" button; today it is a menu item behind the closed Base UI dropdown). Existing empty-state cases stay green. Commit red: `git commit -am "test(renewals): pin visible send-reminder row button + outreach wiring (red)"`.

- [ ] **Step 3 (i18n key):** Add `actions.sendReminderAriaLabel` next to the existing `actions.*` keys in all three locales (canonical EN first). In `src/i18n/messages/en.json` under `admin.renewals.actions`:

```json
"sendReminderAriaLabel": "Send reminder to {company}",
```

`th.json`: `"sendReminderAriaLabel": "ส่งการแจ้งเตือนถึง {company}",` · `sv.json`: `"sendReminderAriaLabel": "Skicka påminnelse till {company}",`. Run `pnpm check:i18n` (must pass — EN canonical + TH/SV parity).

- [ ] **Step 4 (implement):** In `pipeline-table.tsx`: (a) change the React import to `import { useMemo, useState, useTransition } from 'react';` and add `import { OutreachDialog } from './outreach-dialog';`. (b) In `PipelineTable`, add lifted state and wrap the return in a fragment that also renders the dialog:

```tsx
export function PipelineTable({ rows, monthLabel, monthKind }: PipelineTableProps) {
  const t = useTranslations('admin.renewals.table');
  const [outreachFor, setOutreachFor] = useState<{
    memberId: string;
    companyName: string;
  } | null>(null);
```

Change the `actions` column cell to hand the row to the new component (setState setter is stable, so the `[t]` deps array stays valid):

```tsx
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('columns.actions')}</span>,
        cell: ({ row }) => (
          <RowActions
            cycleId={row.original.cycleId}
            memberId={row.original.memberId}
            companyName={row.original.companyName}
            onRecordOutreach={setOutreachFor}
          />
        ),
      },
```

Wrap the returned `<Table>…</Table>` in a fragment and append the dialog (same lifted-state pattern as `lapsed-tab.tsx:273` + `at-risk-widget.tsx:434`, so the dialog survives the menu closing):

```tsx
  return (
    <>
      <Table>
        {/* …unchanged header + body… */}
      </Table>
      {outreachFor ? (
        <OutreachDialog
          open
          onOpenChange={(open) => {
            if (!open) setOutreachFor(null);
          }}
          memberId={outreachFor.memberId}
          memberCompanyName={outreachFor.companyName}
        />
      ) : null}
    </>
  );
```

- [ ] **Step 5 (implement):** Replace `RowActionsMenu` with `RowActions`: keep the entire existing `handleSendReminder` body verbatim, render the visible primary button (promoted OUT of the menu), keep `Open` in the menu, and turn the previously-**disabled** "Mark contacted" stub into a working item that opens the dialog (delete the `disabled` item + its `sr-only` `markContactedComingSoon` hint span):

```tsx
function RowActions({
  cycleId,
  memberId,
  companyName,
  onRecordOutreach,
}: {
  readonly cycleId: string;
  readonly memberId: string;
  readonly companyName: string;
  readonly onRecordOutreach: (t: { memberId: string; companyName: string }) => void;
}): React.JSX.Element {
  const tActions = useTranslations('admin.renewals.actions');
  const tToast = useTranslations('admin.renewals.sendReminderNow.toast');
  const locale = useLocale();
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const handleSendReminder = (): void => {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/admin/renewals/${cycleId}/send-reminder-now`,
          { method: 'POST' },
        );
        if (res.status === 401 || res.status === 403) {
          toast.error(tToast('error.unauthorized'));
          return;
        }
        if (res.status === 429) {
          const retry = res.headers.get('Retry-After') ?? '60';
          toast.error(tToast('error.rateLimited', { seconds: retry }));
          return;
        }
        if (res.status === 409) {
          const body = (await res.json().catch(() => null)) as {
            error?: { existing_dispatched_at?: string };
          } | null;
          const dispatchedAt = body?.error?.existing_dispatched_at;
          const ago = dispatchedAt ? formatRelativeAgo(dispatchedAt, locale) : '';
          toast.warning(tToast('skipped.alreadySent', { ago }));
          return;
        }
        if (!res.ok) {
          toast.error(tToast('error.network'));
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          outcome?: { kind: string; reason?: string };
        } | null;
        const outcome = body?.outcome;
        if (!outcome) {
          toast.error(tToast('error.generic'));
          return;
        }
        switch (outcome.kind) {
          case 'sent':
          case 'task_created':
            toast.success(tToast('sent.title'), {
              description: tToast('sent.description', { company: companyName }),
            });
            break;
          case 'skipped':
            toast.info(toastLabelForSkipReason(outcome.reason ?? 'generic', tToast));
            break;
          case 'failed_transient':
            toast.warning(tToast('failedTransient'));
            break;
          case 'failed_permanent':
            toast.error(tToast('failedPermanent'));
            break;
          default:
            toast.error(tToast('error.generic'));
        }
      } catch (e) {
        console.error('[F8] send-reminder-now: client handler failed', e);
        toast.error(tToast('error.generic'));
      }
    });
  };

  return (
    <div className="flex items-center justify-end gap-1">
      {/* Item ② — primary outreach action promoted to a one-click visible
          button. Labelled text button → h-9 is an adequate target
          (WCAG 2.5.8 AA, ≥24px); the icon-only ⋯ trigger keeps its 44px. */}
      <Button
        variant="outline"
        size="sm"
        className="h-9"
        disabled={isPending}
        onClick={handleSendReminder}
        aria-label={tActions('sendReminderAriaLabel', { company: companyName })}
      >
        {tActions('sendReminder')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(props) => (
            <Button
              {...props}
              variant="ghost"
              size="icon"
              className="h-11 w-11"
              aria-label={tActions('rowMenu', { company: companyName })}
              title={tActions('rowMenu', { company: companyName })}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          )}
        />
        <DropdownMenuContent align="end" className="min-w-56 whitespace-nowrap">
          <DropdownMenuItem
            render={(props) => (
              <a
                {...props}
                href={`/admin/renewals/${cycleId}`}
                aria-label={tActions('openAriaLabel', { company: companyName })}
                onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
                  if (
                    event.defaultPrevented ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey ||
                    event.button !== 0
                  ) {
                    return;
                  }
                  event.preventDefault();
                  router.push(`/admin/renewals/${cycleId}`);
                }}
              >
                {tActions('open')}
              </a>
            )}
          />
          {/* Item ② — was a permanently-disabled US4 stub; now opens the
              already-shipped OutreachDialog (same "Mark contacted" label +
              wiring as lapsed-tab.tsx:254). State is lifted to PipelineTable
              so the dialog outlives this menu closing. */}
          <DropdownMenuItem
            onClick={() => onRecordOutreach({ memberId, companyName })}
          >
            {tActions('markContacted')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
```

Update the `RowActionsMenu` doc-comment header to describe `RowActions`.

- [ ] **Step 6 (run — passes):** `pnpm test tests/unit/app/renewals/pipeline-table.test.tsx` (all green) → `pnpm typecheck` → `pnpm lint` (verify no `react-hooks/exhaustive-deps` regression on the columns memo). Commit: `git commit -am "feat(renewals): visible send-reminder row button + working Mark contacted (outreach dialog)"`.

- [ ] **Step 7 (e2e — preview-gated, menu/dialog portal flow):** Add to `tests/e2e/renewal-pipeline-dashboard.spec.ts` a test that opens a row's ⋯ menu, clicks "Mark contacted", and asserts the OutreachDialog appears; and that the visible "Send reminder" button is present (this covers the Base UI menu+dialog portal path that jsdom cannot reliably exercise — see the reassign-task-dropdown note). Guard on `F8_RENEWALS_ENABLED` like the sibling tests:

```ts
test('item ②: row exposes a visible Send reminder button + Mark contacted opens the outreach dialog', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto('/admin/renewals');
  await expect(page.getByRole('heading', { name: /renewal pipeline/i })).toBeVisible({ timeout: 10_000 });
  // Visible primary action (not behind the ⋯ menu):
  const sendBtns = page.getByRole('button', { name: /^send reminder to /i });
  await expect(sendBtns.first()).toBeVisible();
  // Tertiary: open ⋯ → Mark contacted → dialog:
  await page.getByRole('button', { name: /^actions for /i }).first().click();
  await page.getByRole('menuitem', { name: /mark contacted/i }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
});
```

Run `pnpm test:e2e --grep "renewal-pipeline-dashboard" --workers=1` against preview. Commit: `git commit -am "test(renewals): e2e for surfaced row actions (preview-gated)"`.

---

### Task 2 — Item ④: sighted results-count next to the filter row + count badges on the section tabs

> **Plan-wide decision (all-4-tabs badges):** the steps below implement the badge for the **Pending-review** tab as the template. Per § Plan-wide decisions, replicate the identical `pendingReviewCount`→badge pattern for the **Tasks** and **Tier-upgrades** tabs in this same task — add `tasksCount?` and `tierUpgradeCount?` props to `RenewalsSectionTabsProps`, source each count from its existing per-section use-case in a Suspense island (zero new queries), and render the badge only when the count is `> 0`. Verify the tab order stays Pipeline → Pending review → Tasks → Tier upgrades. Do NOT badge the Pipeline tab (it is the default view, not a work queue). If a section's count use-case turns out to be expensive, ship its badge behind the same Suspense island so it never blocks the pipeline hot path.

**Files:**
- `src/components/renewals/result-count-label.tsx` (create — visible, `aria-hidden` sighted mirror of the sr-only announcer)
- `tests/unit/components/renewals/result-count-label.test.tsx` (create)
- `src/app/(staff)/admin/renewals/_components/renewals-section-tabs.tsx` (modify — optional `pendingReviewCount` → badge on Pending-review tab)
- `tests/unit/app/renewals/renewals-section-tabs.test.tsx` (modify — badge tests)
- `src/app/(staff)/admin/renewals/page.tsx` (modify — render `ResultCountLabel`; wrap pipeline `RenewalsSectionTabs` in a Suspense island that supplies the count from the EXISTING `loadPendingReactivationReview` use-case; update the stale "no badge on hot path" comment)
- `src/i18n/messages/{en,th,sv}.json` (modify — `pendingReview.tabCountSr`)

**Interfaces (later waves consume):**
- `ResultCountLabel(props: ResultCountLabelProps)` — same prop shape as `ResultCountAnnouncerProps` (`count`, `urgencyKey?`, `monthLabel?`, `monthKind?`); returns `null` when neither lens is set.
- `RenewalsSectionTabsProps.pendingReviewCount?: number` — badge shown only when `> 0`.

- [ ] **Step 1 (failing test — sighted label):** Create `tests/unit/components/renewals/result-count-label.test.tsx`, mirroring `result-count-announcer.test.tsx` but asserting a VISIBLE (`aria-hidden`) node reusing the same `srResultCount*` keys:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ResultCountLabel } from '@/components/renewals/result-count-label';
import en from '@/i18n/messages/en.json';

function renderLabel(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>{ui}</NextIntlClientProvider>,
  );
}

describe('<ResultCountLabel>', () => {
  it('shows the urgency-bucket count and is aria-hidden (announcer owns the SR channel)', () => {
    renderLabel(<ResultCountLabel count={5} urgencyKey="t-30" />);
    const el = screen.getByText('Showing 5 members in T-30');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the month-lens count when monthKind/monthLabel are set', () => {
    renderLabel(<ResultCountLabel count={3} monthKind="month" monthLabel="December 2026" />);
    expect(screen.getByText('Showing 3 members renewing in December 2026')).toBeDefined();
  });

  it('renders nothing when neither lens is set', () => {
    const { container } = renderLabel(<ResultCountLabel count={0} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2 (run — fails):** `pnpm test tests/unit/components/renewals/result-count-label.test.tsx` → fails (module missing). Commit red.

- [ ] **Step 3 (implement label):** Create `src/components/renewals/result-count-label.tsx`. It reuses the exact branch logic + keys of `ResultCountAnnouncer` (single source of copy) but renders a visible, `aria-hidden` node so it never double-announces alongside the preserved sr-only announcer:

```tsx
/**
 * Sighted results-count label (client) — the visible twin of
 * `ResultCountAnnouncer`. `aria-hidden` because the sr-only announcer
 * already owns the screen-reader channel (mirrors the urgency count-badge
 * pattern: visible badge aria-hidden + sr-only `countSr`). Reuses the same
 * `admin.renewals.table.srResultCount*` message keys so the two surfaces
 * can never drift.
 */
'use client';

import { useTranslations } from 'next-intl';

export interface ResultCountLabelProps {
  readonly count: number;
  readonly urgencyKey?:
    | 't-90' | 't-60' | 't-30' | 't-14' | 't-7' | 't-0' | 'suspended' | 'terminated';
  readonly monthLabel?: string;
  readonly monthKind?: 'overdue' | 'later' | 'month';
}

export function ResultCountLabel({
  count,
  urgencyKey,
  monthLabel,
  monthKind,
}: ResultCountLabelProps) {
  const tTable = useTranslations('admin.renewals.table');
  const tBuckets = useTranslations('admin.renewals.urgencyBuckets');
  const text =
    monthKind === 'overdue'
      ? tTable('srResultCountOverdue', { count })
      : monthKind === 'later' && monthLabel !== undefined
        ? tTable('srResultCountLater', { count, month: monthLabel })
        : (monthKind === 'month' || monthKind === undefined) && monthLabel !== undefined
          ? tTable('srResultCountMonth', { count, month: monthLabel })
          : urgencyKey !== undefined
            ? tTable('srResultCount', {
                count,
                urgency: tBuckets(urgencyKey.replace('-', '_')),
              })
            : '';
  if (text === '') return null;
  return (
    <p aria-hidden="true" className="text-sm text-muted-foreground tabular-nums">
      {text}
    </p>
  );
}
```

`pnpm test tests/unit/components/renewals/result-count-label.test.tsx` → green. Commit.

- [ ] **Step 4 (failing test — tab badge):** In `tests/unit/app/renewals/renewals-section-tabs.test.tsx`, extend `renderTabs` to accept a count and add a describe block:

```tsx
function renderTabsWithCount(pendingReviewCount?: number) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <RenewalsSectionTabs showPipelineHelp pendingReviewCount={pendingReviewCount} />
    </NextIntlClientProvider>,
  );
}

describe('<RenewalsSectionTabs> pending-review count badge (item ④)', () => {
  it('renders the count badge on the Pending review tab when count > 0', () => {
    renderTabsWithCount(4);
    const pendingTab = screen.getByRole('tab', { name: /pending review/i });
    expect(pendingTab.textContent).toContain('4');
    // sr text present for the count
    expect(screen.getByText(/4 cycles awaiting review/i)).toBeInTheDocument();
  });

  it('renders NO badge when count is 0 or undefined', () => {
    renderTabsWithCount(0);
    expect(screen.queryByText(/awaiting review/i)).not.toBeInTheDocument();
    renderTabsWithCount(undefined);
    expect(screen.queryByText(/awaiting review/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 5 (run — fails):** `pnpm test tests/unit/app/renewals/renewals-section-tabs.test.tsx` → new cases fail (prop + badge don't exist). Existing cases stay green. Commit red.

- [ ] **Step 6 (i18n key):** Add `pendingReview.tabCountSr` (plural ICU) to all three locales. EN: `"tabCountSr": "{count, plural, one {# cycle awaiting review} other {# cycles awaiting review}}"`. TH: `"tabCountSr": "{count, plural, other {# รายการรอตรวจสอบ}}"`. SV: `"tabCountSr": "{count, plural, one {# cykel väntar på granskning} other {# cykler väntar på granskning}}"`. `pnpm check:i18n`.

- [ ] **Step 7 (implement tabs):** In `renewals-section-tabs.tsx`, add the optional prop and render the badge on the Pending-review trigger (visible number `aria-hidden` + `sr-only` count text — mirrors the urgency-tab badge pattern):

```tsx
export interface RenewalsSectionTabsProps {
  readonly showPipelineHelp?: boolean;
  /** Item ④ — count of cycles in `pending_admin_reactivation`; badge shown only when > 0. */
  readonly pendingReviewCount?: number;
}

export function RenewalsSectionTabs({
  showPipelineHelp = false,
  pendingReviewCount,
}: RenewalsSectionTabsProps) {
```

Replace the Pending-review `TabsTrigger`:

```tsx
          <TabsTrigger value={PENDING_REVIEW_VALUE}>
            {t('pendingReview.tab')}
            {pendingReviewCount !== undefined && pendingReviewCount > 0 ? (
              <>
                <span
                  aria-hidden
                  className="ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary/10 px-1.5 text-xs font-medium tabular-nums text-primary ring-1 ring-inset ring-primary/20"
                >
                  {pendingReviewCount}
                </span>
                <span className="sr-only">
                  {' '}
                  {t('pendingReview.tabCountSr', { count: pendingReviewCount })}
                </span>
              </>
            ) : null}
          </TabsTrigger>
```

`pnpm test tests/unit/app/renewals/renewals-section-tabs.test.tsx` → green. Commit: `feat(renewals): pending-review count badge on section tabs`.

- [ ] **Step 8 (wire in page.tsx — reuses EXISTING use-case, Suspense-isolated):** In `page.tsx`, (a) import nothing new for the label except the component; render `<ResultCountLabel>` on the filter row beside the sr-only announcer (visible twin). Insert right after the existing `<ResultCountAnnouncer …/>`:

```tsx
              <ResultCountAnnouncer
                count={rows.length}
                {...(monthLensActive
                  ? {
                      monthKind: monthKind as 'overdue' | 'later' | 'month',
                      ...(monthLabel !== undefined ? { monthLabel } : {}),
                    }
                  : { urgencyKey: urgency })}
              />
              <ResultCountLabel
                count={rows.length}
                {...(monthLensActive
                  ? {
                      monthKind: monthKind as 'overdue' | 'later' | 'month',
                      ...(monthLabel !== undefined ? { monthLabel } : {}),
                    }
                  : { urgencyKey: urgency })}
              />
```

with `import { ResultCountLabel } from '@/components/renewals/result-count-label';`.

(b) Replace the pipeline-view `<RenewalsSectionTabs showPipelineHelp />` (currently at ~line 354) with a Suspense island that streams the count in from the **existing** `loadPendingReactivationReview` use-case (no new query authored; kept off the blocking hot path per the perf note). Update the now-stale comment block above it (lines ~348-353) to describe the streamed badge:

```tsx
          {/* 070 item #18 + item ④ — section nav. The Pending-review count
              is streamed in a Suspense island (reusing loadPendingReactivationReview)
              so the urgency-pipeline hot path stays query-free; the fallback
              renders the identical tab strip with NO badge (CLS-safe — only the
              badge appears). Best-effort: a load throw degrades to no badge. */}
          <Suspense fallback={<RenewalsSectionTabs showPipelineHelp />}>
            <PipelineSectionTabsWithCount tenantSlug={tenantCtx.slug} />
          </Suspense>
```

Add the async wrapper near `PendingReviewSection` (same best-effort try/catch + `makeRenewalsDeps` pattern):

```tsx
/**
 * Item ④ — streams the pending-review count badge onto the pipeline view's
 * section tabs WITHOUT adding a query to the pipeline hot path (rendered in a
 * Suspense island). Reuses the existing `loadPendingReactivationReview`
 * use-case (count = cycles.length). Best-effort: any load failure degrades to
 * the un-badged tab strip — never crashes the pipeline page.
 */
async function PipelineSectionTabsWithCount({
  tenantSlug,
}: {
  readonly tenantSlug: string;
}) {
  const deps = makeRenewalsDeps(tenantSlug);
  let count = 0;
  try {
    const result = await loadPendingReactivationReview(deps, {
      tenantId: tenantSlug,
    });
    if (result.ok) count = result.value.cycles.length;
  } catch (e) {
    logger.error(
      {
        errorId: 'F8.ADMIN.PENDING_REVIEW_COUNT',
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenantSlug,
      },
      '[admin/renewals] pending-review count load failed',
    );
  }
  return <RenewalsSectionTabs showPipelineHelp pendingReviewCount={count} />;
}
```

`loadPendingReactivationReview` is already imported in `page.tsx` (line 36). `pnpm typecheck` → `pnpm lint`. Commit: `feat(renewals): sighted results count + streamed pending-review badge`.

- [ ] **Step 9 (verify):** `pnpm check:i18n && pnpm check:layout && pnpm typecheck`. The page.tsx label placement + streamed badge are verified visually on preview (server component); the extracted components are unit-covered above.

---

### Task 3 — Item ③: make the month↔urgency mutual-exclusion visible (filter-row "Month: {label} ✕" pill + dimmed urgency strip)

**Files:**
- `src/app/(staff)/admin/renewals/_components/urgency-bucket-tabs.tsx` (modify — `monthLensActive` prop → dim + explanatory hint; click still exits the lens)
- `tests/unit/app/renewals/urgency-bucket-tabs.test.tsx` (modify — dim + preserved-exit tests)
- `src/app/(staff)/admin/renewals/page.tsx` (modify — pass `monthLensActive`; render `MonthFilterChip` on the filter row)
- `src/i18n/messages/{en,th,sv}.json` (modify — `urgencyBuckets.monthLensHint`)

**Interfaces:** `UrgencyBucketTabsProps.monthLensActive?: boolean`. `MonthFilterChip` reused as-is (existing `byMonth.filterChip*` + `clearFilter` keys; its ✕ already deletes only `month`/`cursor`/`nowIso` — **no** urgency/tier param touched, mutual-exclusion logic unchanged).

- [ ] **Step 1 (failing test):** In `tests/unit/app/renewals/urgency-bucket-tabs.test.tsx`, add a `monthLensActive` render path and assert (a) the region is visibly dimmed + carries an explanatory `aria-describedby` that resolves to hint text, and (b) clicking a tab STILL exits the month lens (regression guard on the preserved URL logic — the mock already has `month=2027-02`):

```tsx
function renderDimmed() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <UrgencyBucketTabs current={null} counts={COUNTS} lapsedCount={9} monthLensActive />
    </NextIntlClientProvider>,
  );
}

describe('UrgencyBucketTabs month-lens dimming (item ③)', () => {
  it('visibly dims the urgency region + exposes an explanatory hint while a month lens is active', () => {
    const { container } = renderDimmed();
    const region = container.querySelector('[role="region"]') as HTMLElement;
    expect(region.className).toMatch(/opacity-60/);
    const hintId = region.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId!)?.textContent).toMatch(/month filter/i);
  });

  it('a dimmed tab is still clickable and exits the month lens (URL logic preserved)', () => {
    push.mockClear();
    renderDimmed();
    fireEvent.click(screen.getByText('T-30'));
    const url = push.mock.calls[0]![0] as string;
    expect(url).not.toContain('month=');
    expect(url).toContain('urgency=t-30');
  });

  it('applies NO dimming when monthLensActive is absent', () => {
    const { container } = renderTabs('t-30');
    const region = container.querySelector('[role="region"]') as HTMLElement;
    expect(region.className).not.toMatch(/opacity-60/);
    expect(region.getAttribute('aria-describedby')).toBeNull();
  });
});
```

- [ ] **Step 2 (run — fails):** `pnpm test tests/unit/app/renewals/urgency-bucket-tabs.test.tsx` → new cases fail. Existing cases (incl. the existing "clicking an urgency tab exits the month lens") stay green. Commit red.

- [ ] **Step 3 (i18n key):** Add `urgencyBuckets.monthLensHint` to all three locales. EN: `"monthLensHint": "Urgency filters are paused while a month filter is active. Clear the month filter to use them.",`. TH: `"monthLensHint": "ตัวกรองความเร่งด่วนถูกพักไว้ขณะที่ใช้ตัวกรองเดือน ล้างตัวกรองเดือนเพื่อใช้งาน",`. SV: `"monthLensHint": "Prioritetsfilter är pausade när ett månadsfilter är aktivt. Rensa månadsfiltret för att använda dem.",`. `pnpm check:i18n`.

- [ ] **Step 4 (implement):** In `urgency-bucket-tabs.tsx`, add the prop, dim the region, and mount an sr-only hint span the region's `aria-describedby` points at. This is presentation only — the `handleChange` body (which deletes `month`/`cursor`/`nowIso` and sets `urgency`) is untouched, so a dimmed tab still exits the lens:

```tsx
export interface UrgencyBucketTabsProps {
  readonly current: UrgencyBucket | null;
  readonly counts: Readonly<Record<UrgencyBucket, number>>;
  readonly lapsedCount: number;
  /**
   * Item ③ — TRUE when a `?month` lens supersedes urgency (mutually
   * exclusive). Presentation only: dims the strip + explains why. Tabs stay
   * clickable/keyboard-navigable and STILL exit the lens on activation.
   */
  readonly monthLensActive?: boolean;
}

export function UrgencyBucketTabs({
  current,
  counts,
  lapsedCount,
  monthLensActive = false,
}: UrgencyBucketTabsProps) {
```

Wrap the return so the hint span sits alongside the region and dim the region className:

```tsx
  return (
    <>
      {monthLensActive ? (
        <span id="urgency-month-lens-hint" className="sr-only">
          {t('monthLensHint')}
        </span>
      ) : null}
      <div
        role="region"
        aria-label={t('aria_label_scroll')}
        tabIndex={0}
        className={cn(
          'w-full overflow-x-auto overflow-y-hidden py-0.5 focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring',
          monthLensActive && 'opacity-60',
        )}
        {...(monthLensActive
          ? { 'aria-describedby': 'urgency-month-lens-hint', title: t('monthLensHint') }
          : {})}
      >
        <Tabs value={current ?? ''} onValueChange={handleChange}>
          {/* …unchanged TabsList… */}
        </Tabs>
      </div>
    </>
  );
```

`pnpm test tests/unit/app/renewals/urgency-bucket-tabs.test.tsx` → green. Commit: `feat(renewals): dim urgency strip while a month lens is active`.

- [ ] **Step 5 (wire in page.tsx):** Pass the flag and render the filter-row chip. Update the `<UrgencyBucketTabs …/>` call to add `monthLensActive={monthLensActive}`, and render `<MonthFilterChip>` inside the filter-row flex container when the lens is active (reuse the already-computed `monthKind`/`monthLabel`):

```tsx
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <UrgencyBucketTabs
                  current={monthLensActive ? null : urgency}
                  counts={summary.byUrgency}
                  lapsedCount={summary.lapsedCount}
                  monthLensActive={monthLensActive}
                />
                <div className="flex items-center gap-2">
                  {monthLensActive && monthKind !== undefined ? (
                    <MonthFilterChip
                      monthKind={monthKind}
                      {...(monthLabel !== undefined ? { monthLabel } : {})}
                    />
                  ) : null}
                  <TierFilterSelect current={tier ?? 'all'} />
                </div>
              </div>
```

Add `import { MonthFilterChip } from '@/components/renewals/month-filter-chip';`. `pnpm typecheck && pnpm lint && pnpm check:layout`. Commit: `feat(renewals): filter-row month pill signals month↔urgency exclusion`.

- [ ] **Step 6 (e2e — preview-gated):** Optionally extend `tests/e2e/renewal-i18n.spec.ts` / dashboard spec: navigate to `?month=<key>`, assert the filter-row month chip is visible and the urgency region has reduced opacity, then click its ✕ and assert `?month` is gone and the strip un-dims. Run `--workers=1` on preview.

---

### Task 4 — Item ①: reorder so the pipeline table is the dominant first-after-header surface; move the 14-bar "Renewals by month" chart below it

**Files:**
- `src/app/(staff)/admin/renewals/page.tsx` (modify — move the `RenewalsByMonthSection` Suspense block from ABOVE the pipeline `<Card>` to BELOW it)
- `tests/e2e/renewal-pipeline-dashboard.spec.ts` (modify — DOM-order assertion, preview-gated)

**Interfaces:** none (pure render reorder — explicitly "safe" per the URL-param contract note; no param/props change).

- [ ] **Step 1 (failing e2e assertion):** Add a DOM-order test to `tests/e2e/renewal-pipeline-dashboard.spec.ts` asserting the pipeline table renders before the "Renewals by month" chart heading. This is red against the current order (chart is above the pipeline). Note: page.tsx is a server component with `requireSession`/`headers`/`loadPipeline` deps — there is no vitest surface, so this ordering guard is e2e-only:

```ts
test('item ①: pipeline table is the dominant first surface, month chart is below it', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto('/admin/renewals');
  await expect(page.getByRole('heading', { name: /renewal pipeline/i })).toBeVisible({ timeout: 10_000 });
  const urgencyTablist = page.getByRole('tablist', { name: /filter by renewal urgency/i });
  const monthHeading = page.getByRole('heading', { name: /renewals by month/i });
  await expect(urgencyTablist).toBeVisible();
  await expect(monthHeading).toBeVisible();
  const tablistY = (await urgencyTablist.boundingBox())!.y;
  const monthY = (await monthHeading.boundingBox())!.y;
  expect(tablistY).toBeLessThan(monthY); // pipeline sits above the month chart
});
```

- [ ] **Step 2 (run — fails on preview):** `pnpm test:e2e --grep "renewal-pipeline-dashboard" --workers=1` against preview → the ordering case fails (chart currently first). Commit red.

- [ ] **Step 3 (implement reorder):** In `page.tsx`, move the `<Suspense fallback={<RenewalsByMonthSectionSkeleton />}><RenewalsByMonthSection …/></Suspense>` block (currently lines ~339-345, immediately inside `RenewalsPageShell` before the pipeline `<Card>`) to sit AFTER the pipeline `<Card>…</Card>` (i.e., between `</Card>` at ~line 409 and `<AtRiskWidget …/>` at ~line 410). Update the block's leading comment from "Rendered ABOVE the urgency pipeline" to "Rendered BELOW the pipeline as a secondary lens" and keep the `nowIso`/`selectedMonth` props exactly as-is (the `nowIso` reconciliation with `loadPipeline` is unchanged — only render position moves). Resulting order inside the shell: pipeline `<Card>` → `RenewalsByMonthSection` (Suspense) → `AtRiskWidget` → `MembersWithoutCycleTray` (Suspense).

- [ ] **Step 4 (run — passes on preview):** `pnpm test:e2e --grep "renewal-pipeline-dashboard" --workers=1` → ordering case green; the existing AS1 (8 tabs), AS3 (terminated), and both axe scans stay green (they are position-independent). `pnpm typecheck && pnpm lint && pnpm check:layout`. Commit: `feat(renewals): lead with the pipeline table; demote month chart below it`.

- [ ] **Step 5 (verify — full gate subset):** `pnpm check:i18n && pnpm typecheck && pnpm lint`, then the renewals unit subset `pnpm test tests/unit/app/renewals tests/unit/components/renewals`. Manual preview walk of the 4 items (AS-per-scenario) before ship, since the page-level surfaces are server-rendered.

---

# Wave 2 — Medium (Tasks 5–8)

## Wave 2 — Pipeline as the operator's one screen (COLLECT + money KPIs + one work-queue + sortable/dense table)

**Grounding (verified against real code):**
- `PipelineRow` already carries `status: CycleStatus` (`renewal-cycle-repo.ts:1111`) — the pipeline row already knows enough to gate a Mark-paid affordance; no extra query needed for ⑤.
- The guarded settlement path is POST `/api/admin/renewals/{cycleId}/mark-paid-offline`; the client dialog + `PAYABLE_STATUSES` + validation live in `cycle-admin-actions.tsx` (`:76`, `:143`, `:228`). We **reuse** it, never fork it.
- `loadPipeline` / `loadPipelinePage` are count-only (`PipelineSummary = { totalInWindow, byUrgency, lapsedCount }`). ⑥ is the **only** new query: a SUM over F4 `invoices` (already deep-imported into `drizzle-renewal-cycle-repo.ts:35`).
- Money columns: `invoices.totalSatang` (bigint satang), `status` (`invoice_status` enum), `dueDate` (date), `paidAt` (timestamptz), `invoiceSubject='membership'`; format via `formatSatangAsBaht` (`src/lib/money.ts:204`).
- URL contract (`?urgency` default `t-30`, `?month`, `?tier`, `?view`) is load-bearing and tested (`tests/contract/renewals/admin-pipeline-route.test.ts`, `load-pipeline.test.ts`). ⑧ adds an **additive** `?sort` param that defaults to today's fixed `expires_at_asc` order (no existing param semantics change); ⑦ adds **no** URL param.

---

### Task 5 — Bring COLLECT onto the pipeline: a state-guarded "Mark paid" row action (modal, not a route jump)

**Files:**
- `src/app/(staff)/admin/renewals/_lib/mark-paid-gate.ts` (create) — `PAYABLE_STATUSES` + `shouldOfferMarkPaid` moved here (single source of truth).
- `src/app/(staff)/admin/renewals/_components/mark-paid-offline-dialog.tsx` (create) — the controlled dialog extracted verbatim from `cycle-admin-actions.tsx`.
- `src/app/(staff)/admin/renewals/[cycleId]/_components/cycle-admin-actions.tsx` (modify) — consume the extracted dialog + gate (no behaviour change on cycle-detail).
- `src/app/(staff)/admin/renewals/_components/pipeline-table.tsx` (modify) — add the row action + sibling dialog.
- `src/i18n/messages/{en,th,sv}.json` (modify) — one new key `admin.renewals.actions.markPaid`.
- `tests/unit/renewals/mark-paid-gate.test.ts` (create) — pure predicate test.
- `tests/unit/renewals/pipeline-row-mark-paid.test.tsx` (create) — menu-item visibility by status.

**Interfaces this task produces:**
- `export const PAYABLE_STATUSES: ReadonlySet<CycleStatus>`
- `export function shouldOfferMarkPaid(status: CycleStatus): boolean`
- `export function MarkPaidOfflineDialog(props: { cycleId: string; open: boolean; onOpenChange: (open: boolean) => void; onPaid?: () => void; finalFocus?: React.RefObject<HTMLElement | null> })`

- [ ] **Step 1: Failing test — pure gate predicate.** Write `tests/unit/renewals/mark-paid-gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  PAYABLE_STATUSES,
  shouldOfferMarkPaid,
} from '@/app/(staff)/admin/renewals/_lib/mark-paid-gate';

describe('mark-paid gate', () => {
  it('offers mark-paid only for payable statuses (mirrors the route guard)', () => {
    expect(shouldOfferMarkPaid('upcoming')).toBe(true);
    expect(shouldOfferMarkPaid('awaiting_payment')).toBe(true);
  });
  it('never offers mark-paid for terminal / reminded / pending statuses', () => {
    for (const s of [
      'reminded',
      'completed',
      'lapsed',
      'cancelled',
      'pending_admin_reactivation',
    ] as const) {
      expect(shouldOfferMarkPaid(s)).toBe(false);
    }
  });
  it('PAYABLE_STATUSES has exactly the two the cycle-detail control uses', () => {
    expect([...PAYABLE_STATUSES].sort()).toEqual(['awaiting_payment', 'upcoming']);
  });
});
```

- [ ] **Step 2: Run — fails (module missing).** `pnpm test tests/unit/renewals/mark-paid-gate.test.ts` → red (`Cannot find module .../mark-paid-gate`).

- [ ] **Step 3: Implement the gate.** Create `src/app/(staff)/admin/renewals/_lib/mark-paid-gate.ts`:

```ts
/**
 * DV-Wave2 ⑤ — single source of truth for "is this cycle mark-paid-able".
 *
 * Extracted from `cycle-admin-actions.tsx:76` (was module-private) so the
 * pipeline ROW action and the cycle-detail control share ONE predicate and can
 * never diverge from the route's state-machine guard. The route
 * (`/api/admin/renewals/[cycleId]/mark-paid-offline`) stays the authority — this
 * gate only decides whether to OFFER the affordance, matching the route so we
 * never present a control the API will 409 (`cycle_not_payable`).
 */
import type { CycleStatus } from '@/modules/renewals/client';

/** Statuses where Mark-paid-offline is offered — mirrors the route guard. */
export const PAYABLE_STATUSES: ReadonlySet<CycleStatus> = new Set<CycleStatus>([
  'upcoming',
  'awaiting_payment',
]);

export function shouldOfferMarkPaid(status: CycleStatus): boolean {
  return PAYABLE_STATUSES.has(status);
}
```

- [ ] **Step 4: Run — passes.** `pnpm test tests/unit/renewals/mark-paid-gate.test.ts` → green. Commit: `refactor(renewals): extract mark-paid PAYABLE_STATUSES gate to a shared _lib`.

- [ ] **Step 5: Extract the dialog verbatim (no behaviour change).** Create `src/app/(staff)/admin/renewals/_components/mark-paid-offline-dialog.tsx` by lifting the `showMarkPaid` `<Dialog>` block from `cycle-admin-actions.tsx:344-447` **unchanged** — same route (`/api/admin/renewals/${encodeURIComponent(cycleId)}/mark-paid-offline`), same `runAction` envelope, same `readError`, same `resolveOrphanInvoiceHref`/`resolveExistingBillHref` handling, same `isMarkPaidIncomplete`, same `t('admin.renewals.cycleDetail.markPaidOffline.*')` namespace. Make it controlled and add `onPaid` + `finalFocus`:

```tsx
'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, TranslatedSelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isMarkPaidIncomplete } from '../[cycleId]/_components/cycle-admin-validation';
import {
  resolveExistingBillHref, resolveOrphanInvoiceHref,
} from '../[cycleId]/_components/cycle-admin-error-codes';

const PAYMENT_METHODS = ['bank_transfer', 'cash', 'cheque'] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface MarkPaidOfflineDialogProps {
  readonly cycleId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Fired after a 2xx settlement (row action refreshes the pipeline). */
  readonly onPaid?: () => void;
  /** Where focus lands after close — the row unmounts on refresh, so callers
      pin `#main-content` (see the row-menu dialog-focus memory). */
  readonly finalFocus?: React.RefObject<HTMLElement | null>;
}

// `readError` + `runAction` bodies are COPIED VERBATIM from cycle-admin-actions.tsx
// (only namespace collapsed to markPaidOffline). See that file for the doc comments.
export function MarkPaidOfflineDialog({
  cycleId, open, onOpenChange, onPaid, finalFocus,
}: MarkPaidOfflineDialogProps) {
  const t = useTranslations('admin.renewals.cycleDetail');
  const format = useFormatter();
  const router = useRouter();
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('bank_transfer');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [pending, start] = useTransition();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const incomplete = isMarkPaidIncomplete(paymentReference, paymentDate);
  const reset = () => { setPaymentReference(''); setPaymentDate(''); setPaymentMethod('bank_transfer'); };
  const succeed = () => { onOpenChange(false); reset(); router.refresh(); onPaid?.(); };

  // onMarkPaid — LIFTED VERBATIM from cycle-admin-actions.tsx:228-339 (runAction +
  // onSuccess reanchored/no-email branches + onError orphan/existing-bill/not-payable).
  // Only setMarkPaidOpen(false)/resetMarkPaidFields()/router.refresh() are replaced
  // by succeed(). No new network path.
  const onMarkPaid = () => { /* verbatim body → succeed() on 2xx */ };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}
    >
      <DialogContent
        initialFocus={cancelRef}
        {...(finalFocus ? { finalFocus } : {})}
      >
        {/* header + method Select + reference Input + date Input + footer —
            COPIED VERBATIM from cycle-admin-actions.tsx:359-443, cancelRef on the
            Cancel button, confirm disabled={pending || incomplete}. */}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6: Re-wire cycle-detail to the extracted dialog.** In `cycle-admin-actions.tsx`, delete the inline mark-paid `<Dialog>` + its `markPaidOpen`/payment field state + `onMarkPaid`, import `PAYABLE_STATUSES` from `_lib/mark-paid-gate`, and render `<MarkPaidOfflineDialog cycleId={cycleId} open={markPaidOpen} onOpenChange={setMarkPaidOpen} />` triggered by the existing `markPaidOffline.button`. Keep Cancel untouched. Run the existing e2e sanity: `pnpm test:e2e --workers=1 --grep "renewal-admin-actions"` (preview-gated; local smoke acceptable). Commit: `refactor(renewals): extract MarkPaidOfflineDialog for reuse (no behaviour change)`.

- [ ] **Step 7: Failing test — row offers Mark-paid by status.** Write `tests/unit/renewals/pipeline-row-mark-paid.test.tsx`. Follow the component-test harness rules from memory (`vi.useRealTimers()`, never spread-stub `crypto`). Mock `MarkPaidOfflineDialog` to a marker so no Base UI Dialog opens in jsdom:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PipelineTable } from '@/app/(staff)/admin/renewals/_components/pipeline-table';

vi.mock('@/app/(staff)/admin/renewals/_components/mark-paid-offline-dialog', () => ({
  MarkPaidOfflineDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="mark-paid-dialog" /> : null,
}));

beforeEach(() => vi.useRealTimers());

function row(status: string) {
  return {
    cycleId: 'c1', memberId: 'm1', companyName: 'Acme', tierBucket: 'regular',
    expiresAt: '2026-09-01T00:00:00.000Z', urgency: 't-30', status,
    lastReminderAt: null, lastReminderStepId: null, linkedInvoiceId: null,
    anchored: false, closedReason: null, emailUnverified: false,
  };
}
function renderTable(status: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PipelineTable rows={[row(status) as never]} />
    </NextIntlClientProvider>,
  );
}

describe('pipeline row — Mark paid affordance', () => {
  it('shows "Mark paid" for a payable (awaiting_payment) row', async () => {
    renderTable('awaiting_payment');
    await userEvent.click(screen.getByRole('button', { name: /actions for/i }));
    expect(await screen.findByRole('menuitem', { name: /mark paid/i })).toBeInTheDocument();
  });
  it('hides "Mark paid" for a terminal (completed) row', async () => {
    renderTable('completed');
    await userEvent.click(screen.getByRole('button', { name: /actions for/i }));
    expect(screen.queryByRole('menuitem', { name: /mark paid/i })).toBeNull();
  });
});
```

- [ ] **Step 8: Run — fails (no menu item yet).** `pnpm test tests/unit/renewals/pipeline-row-mark-paid.test.tsx` → red.

- [ ] **Step 9: Add the i18n key (EN canonical first).** Add `"markPaid": "Mark paid"` under `admin.renewals.actions` in `en.json`, then TH `"บันทึกการชำระเงิน"` and SV `"Markera betald"`. Run `pnpm check:i18n` → green (all three locales present).

- [ ] **Step 10: Wire the row action into `RowActionsMenu`.** Thread `status` into `RowActionsMenu` (add to the `actions` column `cell` render + the function's props), keep the dialog as a **sibling** of the `DropdownMenu` (not a child — avoids the Base UI focus race, per the row-menu memory), and pin `finalFocus` to `#main-content` because the row unmounts on `router.refresh()`:

```tsx
// in the columns memo, actions cell:
cell: ({ row }) => (
  <RowActionsMenu
    cycleId={row.original.cycleId}
    companyName={row.original.companyName}
    status={row.original.status}
  />
),
// in RowActionsMenu(): add status prop + local open state
const [markPaidOpen, setMarkPaidOpen] = useState(false);
const mainContentRef = useRef<HTMLElement | null>(null);
useEffect(() => { mainContentRef.current = document.getElementById('main-content'); }, []);
// inside the returned fragment, AFTER </DropdownMenu>, as a sibling:
{shouldOfferMarkPaid(status) ? (
  <MarkPaidOfflineDialog
    cycleId={cycleId}
    open={markPaidOpen}
    onOpenChange={setMarkPaidOpen}
    finalFocus={mainContentRef}
  />
) : null}
// and a new DropdownMenuItem, rendered only when shouldOfferMarkPaid(status):
{shouldOfferMarkPaid(status) ? (
  <DropdownMenuItem onClick={() => setMarkPaidOpen(true)}>
    {tActions('markPaid')}
  </DropdownMenuItem>
) : null}
```

Import `shouldOfferMarkPaid` from `../_lib/mark-paid-gate`, `MarkPaidOfflineDialog` from `./mark-paid-offline-dialog`, and `useEffect`/`useRef` from React.

- [ ] **Step 11: Run — passes.** `pnpm test tests/unit/renewals/pipeline-row-mark-paid.test.tsx` → green. Then `pnpm lint && pnpm typecheck`. Commit: `feat(renewals): mark-paid row action opens the guarded offline-settlement dialog in a modal`.

---

### Task 6 — THB money KPI band above the pipeline (the ONE new money aggregation)

**Files:**
- `src/modules/renewals/application/ports/renewal-cycle-repo.ts` (modify) — add `PipelineMoneySummary` type + `loadPipelineMoneySummary` method.
- `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts` (modify) — SUM-over-`invoices` implementation via `runInTenant`.
- `src/modules/renewals/application/use-cases/load-pipeline-money.ts` (create) — thin Result wrapper.
- `src/modules/renewals/index.ts` (modify) — barrel export the use-case + type.
- `src/app/(staff)/admin/renewals/_components/pipeline-money-band.tsx` (create) — server presentational band (ux-standards §1.3 hero numbers, `text-3xl`).
- `src/app/(staff)/admin/renewals/page.tsx` (modify) — Suspense-wrapped, best-effort fetch + render.
- `src/i18n/messages/{en,th,sv}.json` (modify) — new `admin.renewals.money.*` block.
- `tests/integration/renewals/load-pipeline-money.test.ts` (create) — **live-Neon** money aggregation + cross-tenant isolation.
- `tests/unit/renewals/pipeline-money-band.test.tsx` (create) — formatting + filter-shortcut hrefs.

**Interfaces this task produces:**
- `export interface PipelineMoneySummary { readonly dueInWindowSatang: bigint; readonly overdueSatang: bigint; readonly collectedThisPeriodSatang: bigint }`
- `RenewalCycleRepo.loadPipelineMoneySummary(tenantId: string, opts: { readonly nowIso: string; readonly windowDays: number }): Promise<PipelineMoneySummary>`
- `export async function loadPipelineMoney(deps, input: { tenantId: string; nowIso: string; windowDays?: number }): Promise<Result<PipelineMoneySummary, { kind: 'invalid_input'; issues: {path:string;message:string}[] }>>`

- [ ] **Step 1: Failing integration test (live Neon).** Write `tests/integration/renewals/load-pipeline-money.test.ts`, mirroring `load-pipeline.test.ts` fixture wiring (`createTwoTestTenants`, `runInTenant`, `makeRenewalsDeps`). Seed membership invoices with an **existing F4 invoice seed helper** — first `grep -rl "invoice_subject" tests/integration/helpers` and reuse the membership-invoice seeder (do NOT hand-roll the `invoices_non_draft_has_snapshots` 15-column snapshot; if no membership helper exists, extend the F4 one). Pin `nowIso` for determinism:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runInTenant } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { loadPipelineMoney, makeRenewalsDeps } from '@/modules/renewals';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedMembershipInvoice } from '../helpers/seed-invoice'; // reuse/extend real helper

const NOW = '2026-07-15T03:00:00.000Z'; // 2026-07-15 10:00 BKK

describe('F8 loadPipelineMoney — integration (live Neon)', () => {
  let a: TestTenant; let b: TestTenant; let user: TestUser;
  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    ({ a, b } = await createTwoTestTenants());
    // tenant A: 300.00 THB due in window, 500.00 overdue, 700.00 collected this month
    await seedMembershipInvoice(a, { status: 'issued', totalSatang: 30000n, dueDate: '2026-08-01' });   // due-in-window
    await seedMembershipInvoice(a, { status: 'issued', totalSatang: 50000n, dueDate: '2026-06-10' });   // overdue
    await seedMembershipInvoice(a, { status: 'paid',   totalSatang: 70000n, paidAt: '2026-07-05T00:00:00Z' }); // collected
    await seedMembershipInvoice(a, { status: 'paid',   totalSatang: 90000n, paidAt: '2026-05-20T00:00:00Z' }); // prior month, excluded
    // tenant B: money that must NOT leak into A's sums
    await seedMembershipInvoice(b, { status: 'issued', totalSatang: 11n, dueDate: '2026-08-01' });
  }, 120_000);
  afterAll(async () => {
    for (const t of [a, b]) await db.delete(invoices).where(eq(invoices.tenantId, t.ctx.slug)).catch(() => {});
    await a.cleanup().catch(() => {}); await b.cleanup().catch(() => {});
  }, 120_000);

  it('sums membership money by state, BKK-month scoped, tenant-isolated', async () => {
    const res = await loadPipelineMoney(makeRenewalsDeps(a.ctx.slug), {
      tenantId: a.ctx.slug, nowIso: NOW, windowDays: 90,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.dueInWindowSatang).toBe(30000n);
    expect(res.value.overdueSatang).toBe(50000n);
    expect(res.value.collectedThisPeriodSatang).toBe(70000n); // May payment excluded
  });

  it('cross-tenant: B money never appears in A sums', async () => {
    const res = await loadPipelineMoney(makeRenewalsDeps(a.ctx.slug), {
      tenantId: a.ctx.slug, nowIso: NOW, windowDays: 90,
    });
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.dueInWindowSatang).toBe(30000n); // not 30000n+11n
  });
});
```

- [ ] **Step 2: Run — fails (no export).** `pnpm test:integration tests/integration/renewals/load-pipeline-money.test.ts` (pass the file PATH positionally — never `-- <pattern>`, per the integration-filter gotcha) → red.

- [ ] **Step 3: Add the port type + method.** In `renewal-cycle-repo.ts`, near the other pipeline shapes (after `PipelineQueryResult`), add:

```ts
/**
 * DV-Wave2 ⑥ — THB money roll-up for the pipeline KPI band. All satang. The
 * ONLY money aggregation the pipeline owns; a SUM over F4 `invoices`
 * (invoice_subject='membership') scoped by BKK calendar boundaries. "This
 * period" = current Asia/Bangkok calendar MONTH (see open question).
 */
export interface PipelineMoneySummary {
  /** SUM(total_satang) of issued (unpaid) membership invoices due within window. */
  readonly dueInWindowSatang: bigint;
  /** SUM(total_satang) of issued membership invoices past due (due_date < today BKK). */
  readonly overdueSatang: bigint;
  /** SUM(total_satang) of membership invoices paid this BKK month. */
  readonly collectedThisPeriodSatang: bigint;
}
```

And add to the `RenewalCycleRepo` interface:

```ts
  /**
   * DV-Wave2 ⑥ — money roll-up over `invoices`. Tenant-isolated via RLS on the
   * surrounding `runInTenant` PLUS an explicit `tenant_id` predicate on
   * `invoices` (Principle I two-layer isolation — matches every sibling F4
   * cross-module read). Date boundaries are computed IN SQL from `nowIso`
   * (`AT TIME ZONE 'Asia/Bangkok'`) so the result is deterministic per instant.
   */
  loadPipelineMoneySummary(
    tenantId: string,
    opts: { readonly nowIso: string; readonly windowDays: number },
  ): Promise<PipelineMoneySummary>;
```

- [ ] **Step 4: Implement the SUM query.** In `drizzle-renewal-cycle-repo.ts`, add the method inside the returned repo object (alongside `loadPipelinePage`). `invoices` is already imported at `:35`; `renewalCycles`' repo already closes over `tenant`. Use `FILTER (WHERE …)` aggregates in one round-trip; BKK boundaries from the `nowIso` param:

```ts
    async loadPipelineMoneySummary(
      _tenantId: string,
      opts: { nowIso: string; windowDays: number },
    ): Promise<PipelineMoneySummary> {
      return runInTenant(tenant, async (tx) => {
        // today / window-end / month-start all derived from nowIso in BKK, so the
        // result is deterministic for a pinned instant (integration test relies on it).
        const today = sql`((${opts.nowIso}::timestamptz AT TIME ZONE 'Asia/Bangkok')::date)`;
        const windowEnd = sql`(${today} + (${opts.windowDays} * INTERVAL '1 day'))::date`;
        const monthStart = sql`date_trunc('month', (${opts.nowIso}::timestamptz AT TIME ZONE 'Asia/Bangkok'))`;
        // Explicit tenant_id predicate = two-layer isolation on top of RLS.
        const membership = and(
          eq(invoices.tenantId, tenant.slug),
          eq(invoices.invoiceSubject, 'membership'),
        )!;
        const [r] = await tx
          .select({
            due: sql<string>`COALESCE(SUM(${invoices.totalSatang}) FILTER (
              WHERE ${invoices.status} = 'issued'
                AND ${invoices.dueDate} IS NOT NULL
                AND ${invoices.dueDate} >= ${today}
                AND ${invoices.dueDate} <= ${windowEnd}), 0)`,
            overdue: sql<string>`COALESCE(SUM(${invoices.totalSatang}) FILTER (
              WHERE ${invoices.status} = 'issued'
                AND ${invoices.dueDate} IS NOT NULL
                AND ${invoices.dueDate} < ${today}), 0)`,
            collected: sql<string>`COALESCE(SUM(${invoices.totalSatang}) FILTER (
              WHERE ${invoices.status} = 'paid'
                AND ${invoices.paidAt} IS NOT NULL
                AND (${invoices.paidAt} AT TIME ZONE 'Asia/Bangkok') >= ${monthStart}), 0)`,
          })
          .from(invoices)
          .where(membership);
        return {
          dueInWindowSatang: BigInt(r?.due ?? '0'),
          overdueSatang: BigInt(r?.overdue ?? '0'),
          collectedThisPeriodSatang: BigInt(r?.collected ?? '0'),
        };
      });
    },
```

- [ ] **Step 5: Thin use-case wrapper.** Create `src/modules/renewals/application/use-cases/load-pipeline-money.ts` mirroring `load-pipeline.ts`'s validate→Result shape:

```ts
import { z } from 'zod';
import { ok, type Result } from '@/lib/result';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type { PipelineMoneySummary } from '../ports/renewal-cycle-repo';

export const loadPipelineMoneyInputSchema = z.object({
  tenantId: z.string().min(1),
  nowIso: z.string().datetime(),
  windowDays: z.number().int().min(1).max(365).optional(),
});
export type LoadPipelineMoneyInput = z.infer<typeof loadPipelineMoneyInputSchema>;
export type LoadPipelineMoneyError = {
  readonly kind: 'invalid_input';
  readonly issues: ReadonlyArray<{ path: string; message: string }>;
};

export async function loadPipelineMoney(
  deps: Pick<RenewalsDeps, 'cyclesRepo'>,
  rawInput: LoadPipelineMoneyInput,
): Promise<Result<PipelineMoneySummary, LoadPipelineMoneyError>> {
  const parsed = loadPipelineMoneyInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: 'invalid_input',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    };
  }
  const summary = await deps.cyclesRepo.loadPipelineMoneySummary(parsed.data.tenantId, {
    nowIso: parsed.data.nowIso,
    windowDays: parsed.data.windowDays ?? 90,
  });
  return ok(summary);
}
```

- [ ] **Step 6: Barrel export.** In `src/modules/renewals/index.ts` add `PipelineMoneySummary` beside the `PipelineSummary` type export (`:303`) and export the use-case:

```ts
export {
  loadPipelineMoney,
  loadPipelineMoneyInputSchema,
  type LoadPipelineMoneyInput,
} from './application/use-cases/load-pipeline-money';
```

- [ ] **Step 7: Apply migration state + run integration.** No new migration (columns exist), but per the migration-before-commit gotcha run integration against live Neon now: `pnpm test:integration tests/integration/renewals/load-pipeline-money.test.ts` → green (sums + cross-tenant). Commit: `feat(renewals): loadPipelineMoney — tenant-scoped THB SUM over membership invoices`.

- [ ] **Step 8: Failing unit test — the band (formatting + filter hrefs).** Write `tests/unit/renewals/pipeline-money-band.test.tsx` (`vi.useRealTimers()`):

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PipelineMoneyBand } from '@/app/(staff)/admin/renewals/_components/pipeline-money-band';

beforeEach(() => vi.useRealTimers());

it('renders THB hero numbers + one-click filter shortcuts', () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PipelineMoneyBand
        money={{ dueInWindowSatang: 3050n, overdueSatang: 50000n, collectedThisPeriodSatang: 70000n }}
      />
    </NextIntlClientProvider>,
  );
  expect(screen.getByText('30.50')).toBeInTheDocument();      // dueInWindow baht
  expect(screen.getByText('500.00')).toBeInTheDocument();     // overdue
  // Overdue tile deep-links to the month-lens overdue bucket (existing URL contract)
  expect(screen.getByRole('link', { name: /overdue/i })).toHaveAttribute(
    'href', '/admin/renewals?month=overdue',
  );
  // Collected tile deep-links to the F4 paid-invoice list
  expect(screen.getByRole('link', { name: /collected/i })).toHaveAttribute(
    'href', '/admin/invoices?status=paid',
  );
});
```

- [ ] **Step 9: Run — fails.** `pnpm test tests/unit/renewals/pipeline-money-band.test.tsx` → red.

- [ ] **Step 10: Add i18n + build the band.** Add an `admin.renewals.money` block to all three locales (EN canonical: `{"title":"Money","dueInWindow":"Due in 90 days","overdue":"Overdue","collected":"Collected this month","collectionRate":"Collection rate","currency":"THB"}`; TH/SV parity). Create `pipeline-money-band.tsx` as a server presentational component using `formatSatangAsBaht` + `asSatang` and `text-3xl tabular-nums` per ux-standards §1.3. Filter shortcuts map onto the **existing** URL contract (Overdue → `?month=overdue`; Due-in-window → `?urgency=t-30`; Collected → F4 `/admin/invoices?status=paid`); collection-rate is display-only (see open question):

```tsx
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { asSatang, formatSatangAsBaht } from '@/lib/money';
import { Card, CardContent } from '@/components/ui/card';
import type { PipelineMoneySummary } from '@/modules/renewals';

function Tile({ label, baht, href, currency }:{ label:string; baht:string; href?:string; currency:string }) {
  const body = (
    <>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-3xl font-semibold tabular-nums">
        {baht} <span className="text-sm font-normal text-muted-foreground">{currency}</span>
      </p>
    </>
  );
  return (
    <Card>
      <CardContent className="py-4">
        {href ? (
          <Link href={href} className="block rounded-md focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2">
            {body}
          </Link>
        ) : body}
      </CardContent>
    </Card>
  );
}

export function PipelineMoneyBand({ money }: { money: PipelineMoneySummary }) {
  const t = useTranslations('admin.renewals.money');
  const cur = t('currency');
  const due = formatSatangAsBaht(asSatang(money.dueInWindowSatang));
  const overdue = formatSatangAsBaht(asSatang(money.overdueSatang));
  const collected = formatSatangAsBaht(asSatang(money.collectedThisPeriodSatang));
  const collectible = money.collectedThisPeriodSatang + money.overdueSatang;
  const rate = collectible > 0n
    ? `${Number((money.collectedThisPeriodSatang * 100n) / collectible)}%` : '—';
  return (
    <section aria-label={t('title')} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label={t('dueInWindow')} baht={due} currency={cur} href="/admin/renewals?urgency=t-30" />
      <Tile label={t('overdue')} baht={overdue} currency={cur} href="/admin/renewals?month=overdue" />
      <Tile label={t('collected')} baht={collected} currency={cur} href="/admin/invoices?status=paid" />
      <Tile label={t('collectionRate')} baht={rate} currency="" />
    </section>
  );
}
```

- [ ] **Step 11: Run — passes.** `pnpm test tests/unit/renewals/pipeline-money-band.test.tsx && pnpm check:i18n` → green.

- [ ] **Step 12: Wire into the page (best-effort, Suspense).** In `page.tsx`, add a `<Suspense>`-wrapped async sub-component that calls `loadPipelineMoney(deps, { tenantId: tenantCtx.slug, nowIso })` inside a `try/catch` (per-section isolation — a money-query throw must never crash the pipeline) and renders `<PipelineMoneyBand>` above the main `<Card>`. Reuse the already-computed `nowIso`. On error, render nothing (or the shared `LoadErrorCard` from Task 8). Commit: `feat(renewals): THB money KPI band above the pipeline with filter shortcuts`.

---

### Task 7 — Consolidate At-Risk into ONE work-queue (no URL-param change)

**Files:**
- `src/app/(staff)/admin/renewals/_components/work-queue-tabs.tsx` (create) — 2-lens client tablist (roving tabindex) wrapping the pipeline panel + the at-risk panel.
- `src/app/(staff)/admin/renewals/page.tsx` (modify) — mount the pipeline section + `AtRiskWidget` inside `<WorkQueueTabs>` instead of two stacked cards.
- `src/i18n/messages/{en,th,sv}.json` (modify) — `admin.renewals.workQueue.{pipeline,needsAction,label}`.
- `tests/unit/renewals/work-queue-tabs.test.tsx` (create) — roving-tabindex + panel switch + nested at-risk tablist survives.

**Interfaces this task produces:**
- `export function WorkQueueTabs(props: { readonly pipeline: React.ReactNode; readonly needsAction: React.ReactNode })`

- [ ] **Step 1: Failing test — roving tabindex + panel switching.** Write `tests/unit/renewals/work-queue-tabs.test.tsx` (`vi.useRealTimers()`):

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { WorkQueueTabs } from '@/app/(staff)/admin/renewals/_components/work-queue-tabs';

beforeEach(() => vi.useRealTimers());

function setup() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <WorkQueueTabs
        pipeline={<div data-testid="pipeline-panel">PIPELINE</div>}
        needsAction={<div data-testid="needs-action-panel">NEEDS ACTION</div>}
      />
    </NextIntlClientProvider>,
  );
}

describe('WorkQueueTabs', () => {
  it('shows pipeline by default and hides needs-action', () => {
    setup();
    expect(screen.getByTestId('pipeline-panel')).toBeVisible();
    expect(screen.queryByTestId('needs-action-panel')).toBeNull();
  });
  it('ArrowRight moves roving focus + selection to needs-action', async () => {
    setup();
    const tabs = screen.getAllByRole('tab');
    tabs[0]!.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('tabindex', '0');
    expect(tabs[0]).toHaveAttribute('tabindex', '-1');
    expect(await screen.findByTestId('needs-action-panel')).toBeVisible();
  });
});
```

- [ ] **Step 2: Run — fails.** `pnpm test tests/unit/renewals/work-queue-tabs.test.tsx` → red.

- [ ] **Step 3: Add i18n keys** (`admin.renewals.workQueue`) to all three locales, EN canonical first (`{"label":"Work queue","pipeline":"Renewals pipeline","needsAction":"Needs action"}`). `pnpm check:i18n` → green.

- [ ] **Step 4: Build `WorkQueueTabs`.** Port the exact roving-tabindex pattern already proven in `at-risk-widget.tsx:224-279` (ArrowLeft/Right/Home/End, `tabIndex={active?0:-1}`, `aria-selected`, `role="tab"`/`role="tabpanel"` linked by id). Only the active lens's panel is mounted — the pipeline panel is server-streamed content passed as a prop, so mounting/unmounting it is cheap and keeps "one queue" honest. The at-risk lens mounts `AtRiskWidget` unchanged, so its internal 3-band tablist (with its own roving tabindex) is preserved intact — a valid nested-tablist per WAI-ARIA:

```tsx
'use client';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarClock, AlertTriangle } from 'lucide-react';

const LENSES = ['pipeline', 'needsAction'] as const;
type Lens = (typeof LENSES)[number];

export function WorkQueueTabs({
  pipeline, needsAction,
}: { readonly pipeline: React.ReactNode; readonly needsAction: React.ReactNode }) {
  const t = useTranslations('admin.renewals.workQueue');
  const [active, setActive] = useState<Lens>('pipeline');
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div>
      <div role="tablist" aria-label={t('label')} className="mb-3 flex flex-wrap gap-1 border-b">
        {LENSES.map((lens, idx) => {
          const isActive = active === lens;
          return (
            <button
              key={lens}
              id={`work-queue-tab-${lens}`}
              ref={(el) => { refs.current[idx] = el; }}
              type="button" role="tab" tabIndex={isActive ? 0 : -1}
              aria-selected={isActive} aria-controls="work-queue-panel"
              onClick={() => setActive(lens)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const dir = e.key === 'ArrowRight' ? 1 : -1;
                  const n = (idx + dir + LENSES.length) % LENSES.length;
                  setActive(LENSES[n]!); refs.current[n]?.focus();
                } else if (e.key === 'Home') { e.preventDefault(); setActive(LENSES[0]!); refs.current[0]?.focus(); }
                else if (e.key === 'End') { e.preventDefault(); const l = LENSES.length - 1; setActive(LENSES[l]!); refs.current[l]?.focus(); }
              }}
              className={
                'inline-flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-sm font-medium motion-safe:transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 ' +
                (isActive ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground')
              }
            >
              {lens === 'pipeline'
                ? <CalendarClock className="size-3.5" aria-hidden="true" />
                : <AlertTriangle className="size-3.5" aria-hidden="true" />}
              {t(lens)}
            </button>
          );
        })}
      </div>
      <div id="work-queue-panel" role="tabpanel" aria-labelledby={`work-queue-tab-${active}`}>
        {active === 'pipeline' ? pipeline : needsAction}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run — passes.** `pnpm test tests/unit/renewals/work-queue-tabs.test.tsx` → green.

- [ ] **Step 6: Restructure the page.** In `page.tsx`, replace the two stacked surfaces (the pipeline `<Card>` at `:346-409` and the standalone `<AtRiskWidget>` at `:410`) with a single `<Card>` whose `CardContent` mounts `<RenewalsSectionTabs showPipelineHelp />` then `<WorkQueueTabs pipeline={<>…existing pipeline block…</>} needsAction={<AtRiskWidget actorRole={widgetActorRole} />} />`. The `RenewalsSectionTabs` stays the **top axis** (4 section tabs); urgency tabs stay the sub-filter inside the pipeline lens. No URL param added → `admin-pipeline-route`/`renewal-pipeline-dashboard`/`renewal-i18n` contracts untouched. Run `pnpm test:e2e --workers=1 --grep "@a11y"` locally (preview-gated) to sanity-check the nested tablist. Commit: `feat(renewals): fold at-risk into a single work-queue control under the section tabs`.

---

### Task 8 — Sortable headers (server-side) + density toggle + shared empty/error chrome

**Files:**
- `src/modules/renewals/application/ports/renewal-cycle-repo.ts` (modify) — add `PipelineSort` + `PipelineQueryOpts.sort?`.
- `src/modules/renewals/application/use-cases/load-pipeline.ts` (modify) — accept + forward `sort` (additive; default preserves `expires_at_asc`).
- `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts` (modify) — `orderBy` branch (tier via `tierBucketOrdinalCaseSql`).
- `src/app/(staff)/admin/renewals/page.tsx` (modify) — read `?sort`, forward, build header sort hrefs (delete `cursor` on sort change), pass to `PipelineTable`.
- `src/app/(staff)/admin/renewals/_components/pipeline-table.tsx` (modify) — header anchors + `aria-sort` + a client density toggle (localStorage).
- `src/app/(staff)/admin/renewals/_components/load-error-card.tsx` (create) — extract the page's `LoadErrorCard` to shared, route at-risk + tray + money through it.
- `src/i18n/messages/{en,th,sv}.json` (modify) — `admin.renewals.table.sort.*` + `admin.renewals.table.density.*`.
- `tests/unit/renewals/pipeline-sort-param.test.ts` (create) — schema accepts `sort`, defaults preserved.
- `tests/integration/renewals/load-pipeline-sort.test.ts` (create) — live-Neon `expires_at_desc` + `tier_desc` ordering.
- `tests/unit/renewals/pipeline-density-toggle.test.tsx` (create) — localStorage persistence.

**Interfaces this task produces:**
- `export type PipelineSort = 'expires_at_asc' | 'expires_at_desc' | 'tier_asc' | 'tier_desc'`
- `PipelineQueryOpts.sort?: PipelineSort` (default `expires_at_asc`)
- `PipelineTableProps.sort?: PipelineSort` + `PipelineTableProps.sortHrefs?: Record<'expires' | 'tier', string>`

- [ ] **Step 1: Failing unit test — schema is additive.** Write `tests/unit/renewals/pipeline-sort-param.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadPipelineInputSchema } from '@/modules/renewals';

describe('loadPipeline input — additive sort param', () => {
  it('accepts a valid sort value', () => {
    expect(loadPipelineInputSchema.safeParse({ tenantId: 't', sort: 'expires_at_desc' }).success).toBe(true);
  });
  it('omitting sort still parses (default order preserved)', () => {
    const r = loadPipelineInputSchema.safeParse({ tenantId: 't' });
    expect(r.success).toBe(true);
  });
  it('rejects an unknown sort value', () => {
    expect(loadPipelineInputSchema.safeParse({ tenantId: 't', sort: 'bogus' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run — fails.** `pnpm test tests/unit/renewals/pipeline-sort-param.test.ts` → red.

- [ ] **Step 3: Add the sort type + plumb it (additive).** In `renewal-cycle-repo.ts` add `export type PipelineSort = 'expires_at_asc' | 'expires_at_desc' | 'tier_asc' | 'tier_desc';` and `readonly sort?: PipelineSort;` on `PipelineQueryOpts`. In `load-pipeline.ts` add `sort: z.enum(['expires_at_asc','expires_at_desc','tier_asc','tier_desc']).optional()` to the schema and forward `...(input.sort !== undefined ? { sort: input.sort } : {})` into the `loadPipelinePage` opts. Export `PipelineSort` from the barrel + client barrel (headers are client). Run Step-1 test → green.

- [ ] **Step 4: Failing integration test — real ordering.** Write `tests/integration/renewals/load-pipeline-sort.test.ts` mirroring `load-pipeline.test.ts` seeding (seed cycles across tiers + expiries), asserting `expires_at_desc` reverses the default and `tier_desc` orders by tier ordinal. Run `pnpm test:integration tests/integration/renewals/load-pipeline-sort.test.ts` → red.

- [ ] **Step 5: Implement the orderBy branch.** In `loadPipelinePage`, replace the hardcoded `.orderBy(sql\`${renewalCycles.expiresAt} ASC, ${renewalCycles.cycleId} ASC\`)` (`:2264`) with a `sort`-driven clause. Keyset pagination stays on `(expires_at, cycle_id)`; for a tier sort the tier is the primary key and `(expires_at, cycle_id)` is the stable tiebreak. Use the existing `tierBucketOrdinalCaseSql` (`tier-bucket-ordinal-sql.ts:93`) rather than sorting the enum text:

```ts
const tierOrd = sql.raw(tierBucketOrdinalCaseSql('renewal_cycles.tier_at_cycle_start'));
const orderBy =
  opts.sort === 'expires_at_desc'
    ? sql`${renewalCycles.expiresAt} DESC, ${renewalCycles.cycleId} DESC`
    : opts.sort === 'tier_asc'
      ? sql`${tierOrd} ASC, ${renewalCycles.expiresAt} ASC, ${renewalCycles.cycleId} ASC`
      : opts.sort === 'tier_desc'
        ? sql`${tierOrd} DESC, ${renewalCycles.expiresAt} ASC, ${renewalCycles.cycleId} ASC`
        : sql`${renewalCycles.expiresAt} ASC, ${renewalCycles.cycleId} ASC`;
// ... .orderBy(orderBy)
```

Note: the keyset cursor WHERE (`:2168-2178`) is `(expires_at, cycle_id)` ASC-shaped; when a `desc`/tier sort is active, guard by resetting the cursor on sort change at the page layer (Step 7) so a stale ASC cursor never mis-pages a DESC list. Run Step-4 test → green. Commit: `feat(renewals): server-side pipeline sort (expiry/tier, additive ?sort default asc)`.

- [ ] **Step 6: Failing test — density toggle persistence.** Write `tests/unit/renewals/pipeline-density-toggle.test.tsx` (`vi.useRealTimers()`): render `PipelineTable`, click the density toggle, assert `localStorage.getItem('renewals.pipeline.density') === 'compact'` and the table container carries a compact class; reload-render reads the stored value. Run → red.

- [ ] **Step 7: Headers as sort links + density toggle + page wiring.**
  - In `page.tsx`: read `const sort = SORTS.has(query.sort) ? query.sort : 'expires_at_asc'`, forward into `loadPipeline`, and build `sortHrefs` for `expires`/`tier` using the SAME param-preservation discipline as the existing `paginationParams` builder (`:262-273`) — preserve `tier`/`urgency`/`month`, **delete `cursor`** on sort change, toggle the direction, and pass `sort` + `sortHrefs` to `<PipelineTable>`.
  - In `pipeline-table.tsx`: render the `expires` and `tier` `<TableHead>` contents as `<a href={sortHrefs.expires}>` carrying a direction chevron (`ArrowUp`/`ArrowDown`/`ArrowUpDown`) and set `aria-sort` on the `<TableHead>` (`ascending`/`descending`/`none`) per WCAG 1.3.1. Add a client density toggle button (top-right of the table) writing `localStorage['renewals.pipeline.density']`, defaulting `comfortable`, applying `[&_td]:py-1.5` (compact) vs `[&_td]:py-3` (comfortable) on the `<Table>`. Add i18n keys `admin.renewals.table.sort.{ascending,descending,sortBy}` + `admin.renewals.table.density.{compact,comfortable,label}` in all three locales. Run the density test → green; `pnpm check:i18n` → green.

- [ ] **Step 8: Route empty/error through shared chrome.** Extract the page-local `LoadErrorCard` (`page.tsx:552-575`) into `_components/load-error-card.tsx` (export it), and re-point: the money band's catch (Task 6 Step 12), `AtRiskWidget`'s error branch (`at-risk-widget.tsx:299`), and `MembersWithoutCycleTray`'s error state all render `<LoadErrorCard>`; their empty states render the shared `<EmptyState>` (`@/components/shell/empty-state`). This makes every pipeline sub-card use one empty/error skin. Keep `role="alert"`/`aria-live="assertive"` on the error card and `role="status"` semantics on empties (existing). Run `pnpm test` for the renewals unit suite + `pnpm lint && pnpm typecheck`. Commit: `feat(renewals): sortable headers + density toggle + shared EmptyState/LoadErrorCard across pipeline cards`.

- [ ] **Step 9: Full local gate.** `pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm check:layout && pnpm test:coverage && pnpm test:integration tests/integration/renewals/load-pipeline-money.test.ts tests/integration/renewals/load-pipeline-sort.test.ts`. Run E2E with `--workers=1` (preview-gated `@a11y`/`@i18n` may noise locally). This is a UI-heavy money surface → route the PR through the **enterprise-ux-designer** additional review (per repo convention) and a normal reviewer; money-path change (mark-paid surfacing + THB aggregation) → flag for a second reviewer even though no new settlement route was added.

---

# Wave 3 — Large (Tasks 9–14)

## Wave 3 — Cohort + mobile + saved views (DRAFT, Large)

**Sequencing rationale.** Items ⑨⑩⑪ are all large. They are ordered so that money-touching + foundational work lands first behind independently shippable deliverables, and the genuinely deferrable pieces come last:

1. **Task 9** — read-only settlement-preview query (backs ⑨'s per-invoice THB total). Small, safe, TDD-tractable.
2. **Task 10** — row selection in the pipeline table + a `PipelineWithBulk` wrapper (mirrors `directory-with-bulk.tsx`). Foundational for ⑨.
3. **Task 11** — `PipelineBulkActionBar`: bulk **Send-reminder** (iterates the shipped `send-reminder-now` route) + bulk **Mark-paid** (confirm dialog with per-invoice THB totals, iterates the guarded `mark-paid-offline` route **per row**). Bulk **Mark-contacted is intentionally NOT built** — see the flag below.
4. **Task 12** — mobile card-stack (`≤md`) for the pipeline table.
5. **Task 13 (LARGE — flag)** — merged "Today" worklist server component.
6. **Task 14 (LARGE / most deferrable — flag)** — saved filter segments via `localStorage`.

**Deferral flags (surface at plan review, do not silently build):**
- **Bulk Mark-contacted is dropped from Wave 3.** There is no shipped `mark-contacted` use-case or route anywhere (`grep -rln "mark-contacted" src` returns nothing; the row-menu item is `disabled` + `markContactedComingSoon`, reserved for US4). Building it here would be new backend, which the wave's own guardrail forbids ("surface existing use-cases; only THB KPI + bulk needs new queries"). It is gated to the US4 at-risk follow-on. The `admin.renewals.bulk.actions.markContacted` i18n key is reserved (mirroring how `bulk.actions.change_plan` was kept in members) so the button lands in one diff when US4 ships.
- **Bulk Mark-paid THB total is truthful only for cycles that already carry a live linked invoice.** `mark-paid-offline` *mints* the bill for `upcoming` cycles with no invoice yet, so no real "per-invoice total" exists pre-confirm for those rows. On a live-money screen, showing a computed guess that may not equal what the mint produces is a hazard (Principle IV). Task 9 therefore returns `previewable: false` for such rows and the dialog shows "—" + a per-row note rather than a fabricated number. **Open question for the product owner in `openQuestions`.**
- **Task 13 and Task 14 are each a wave's worth of work on their own** and are drafted as skeleton-first so they can split to a follow-up branch (`nnn-renewals-today-worklist`, `nnn-renewals-saved-views`) if Wave 3 gets too wide for one PR.

---

### Task 9 — Read-only settlement-preview query (backs ⑨ bulk Mark-paid THB totals)

**Files:**
- `src/modules/renewals/application/ports/renewal-cycle-repo.ts` (add `SettlementPreviewRow` + repo method signature)
- `src/modules/renewals/application/use-cases/load-settlement-preview.ts` (new use-case)
- `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts` (implement query)
- `src/modules/renewals/index.ts` (barrel export the use-case + type)
- `src/modules/renewals/client.ts` (export the `SettlementPreviewRow` type for the client dialog)
- `src/app/api/admin/renewals/settlement-preview/route.ts` (new GET route)
- `tests/unit/renewals/load-settlement-preview.test.ts` (unit, mocked repo)
- `tests/integration/renewals/settlement-preview.integration.test.ts` (live-Neon)
- `tests/contract/renewals/settlement-preview-route.test.ts` (contract)

**Interfaces (produced this task):**
- `loadSettlementPreview(deps, input): Promise<Result<SettlementPreviewResult, LoadSettlementPreviewError>>`
- `interface SettlementPreviewRow { cycleId; companyName; invoiceId: string | null; amountThbMinor: number | null; currency: string | null; previewable: boolean }`
- GET `/api/admin/renewals/settlement-preview?cycle_ids=<comma-list>` → `{ items: SettlementPreviewRow[], total_thb_minor: number }`

- [ ] **Step 1: Failing unit test — preview returns real amounts only for cycles with a live linked invoice.**

```ts
// tests/unit/renewals/load-settlement-preview.test.ts
import { describe, expect, it, vi } from 'vitest';
import { loadSettlementPreview } from '@/modules/renewals';

function makeDeps(rows: unknown) {
  return {
    renewalCycleRepo: {
      loadSettlementPreview: vi.fn().mockResolvedValue(rows),
    },
  } as never;
}

describe('loadSettlementPreview', () => {
  it('sums only previewable (live-invoice) rows into total_thb_minor', async () => {
    const deps = makeDeps([
      { cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1', amountThbMinor: 1070_00, currency: 'THB', previewable: true },
      { cycleId: 'c2', companyName: 'Beta', invoiceId: null, amountThbMinor: null, currency: null, previewable: false },
    ]);
    const res = await loadSettlementPreview(deps, { tenantId: 't', cycleIds: ['c1', 'c2'] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.totalThbMinor).toBe(1070_00);
    expect(res.value.items).toHaveLength(2);
  });

  it('rejects empty / oversized cycleIds with invalid_input', async () => {
    const deps = makeDeps([]);
    const empty = await loadSettlementPreview(deps, { tenantId: 't', cycleIds: [] });
    expect(empty.ok).toBe(false);
    const over = await loadSettlementPreview(deps, { tenantId: 't', cycleIds: Array.from({ length: 101 }, (_, i) => `c${i}`) });
    expect(over.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — fails (`loadSettlementPreview` not exported).** `pnpm test tests/unit/renewals/load-settlement-preview.test.ts`

- [ ] **Step 3: Add port types.** In `renewal-cycle-repo.ts` after `PipelineRow`:

```ts
export interface SettlementPreviewRow {
  readonly cycleId: CycleId;
  readonly companyName: string;
  /** Live linked bill for this cycle, or null when none has been minted yet. */
  readonly invoiceId: string | null;
  /** Bill total in satang (THB minor units). null when not previewable. */
  readonly amountThbMinor: number | null;
  readonly currency: string | null;
  /**
   * TRUE only when a real, un-voided/un-credited invoice is linked and its
   * total can be shown truthfully on the money confirm dialog. FALSE for
   * `upcoming` cycles whose bill is minted on mark-paid (no total exists yet).
   */
  readonly previewable: boolean;
}

export interface RenewalCycleRepo {
  // …existing methods…
  loadSettlementPreview(input: {
    readonly tenantId: string;
    readonly cycleIds: ReadonlyArray<string>;
  }): Promise<ReadonlyArray<SettlementPreviewRow>>;
}
```

- [ ] **Step 4: Implement the use-case (guards ABOVE any read; no writes — pure query).**

```ts
// src/modules/renewals/application/use-cases/load-settlement-preview.ts
import { ok, err, type Result } from '@/lib/result';
import type { RenewalCycleRepo, SettlementPreviewRow } from '../ports/renewal-cycle-repo';

const MAX_CYCLES = 100; // matches BULK_CAP

export interface LoadSettlementPreviewInput {
  readonly tenantId: string;
  readonly cycleIds: ReadonlyArray<string>;
}
export interface SettlementPreviewResult {
  readonly items: ReadonlyArray<SettlementPreviewRow>;
  readonly totalThbMinor: number;
}
export type LoadSettlementPreviewError = { kind: 'invalid_input'; message: string };

export async function loadSettlementPreview(
  deps: { renewalCycleRepo: Pick<RenewalCycleRepo, 'loadSettlementPreview'> },
  input: LoadSettlementPreviewInput,
): Promise<Result<SettlementPreviewResult, LoadSettlementPreviewError>> {
  if (input.cycleIds.length === 0 || input.cycleIds.length > MAX_CYCLES) {
    return err({ kind: 'invalid_input', message: `cycleIds must be 1..${MAX_CYCLES}` });
  }
  const items = await deps.renewalCycleRepo.loadSettlementPreview({
    tenantId: input.tenantId,
    cycleIds: input.cycleIds,
  });
  const totalThbMinor = items.reduce(
    (sum, r) => (r.previewable && r.amountThbMinor !== null ? sum + r.amountThbMinor : sum),
    0,
  );
  return ok({ items, totalThbMinor });
}
```

- [ ] **Step 5: Barrel-export** from `src/modules/renewals/index.ts` (`loadSettlementPreview`, `type SettlementPreviewResult`) and re-export `type SettlementPreviewRow` from `src/modules/renewals/client.ts` (client dialog needs the shape). Run `pnpm test tests/unit/renewals/load-settlement-preview.test.ts` → GREEN. Commit `feat(renewals): settlement-preview read use-case (bulk mark-paid THB totals)`.

- [ ] **Step 6: Failing integration test (live-Neon) — join cycles→invoices under RLS, previewable gate.** Seed a tenant with (a) an `awaiting_payment` cycle linked to a `sent` invoice with a known total and (b) an `upcoming` cycle with no invoice. Assert row (a) `previewable:true` with the seeded total, row (b) `previewable:false, amountThbMinor:null`. Run with the file PATH positional: `pnpm test:integration tests/integration/renewals/settlement-preview.integration.test.ts`.

- [ ] **Step 7: Implement the Drizzle method** in `drizzle-renewal-cycle-repo.ts`, threading `tx` from `runInTenant` (NEVER the global `db` — RLS bypass). LEFT JOIN `invoices` on `renewal_cycles.linked_invoice_id`; `previewable = invoice IS NOT NULL AND invoice.status IN ('sent','partially_paid')` (exclude void/credited/paid). Amount from the invoice grand-total column. Run integration test → GREEN.

- [ ] **Step 8: Failing contract test + GET route.** Mirror `admin-pipeline-route.test.ts` mocking `requireRenewalAdminContext` + the use-case. Assert: 404 when `f8Renewals` flag off (+ `renewal_kill_switch_blocked` audit), 401 passthrough, 400 `invalid_query` on empty/`>100` `cycle_ids`, 200 snake_case `{ items, total_thb_minor }`. Implement `route.ts` (admin OR manager read allowed — this is read-only; no mutation). Run `pnpm test tests/contract/renewals/settlement-preview-route.test.ts` → GREEN. Commit `feat(renewals): GET settlement-preview route + live-Neon coverage`.

---

### Task 10 — Row selection in the pipeline table + `PipelineWithBulk` wrapper

**Files:**
- `src/app/(staff)/admin/renewals/_components/pipeline-table.tsx` (add optional selection column, mirror MembersTable)
- `src/app/(staff)/admin/renewals/_components/pipeline-with-bulk.tsx` (new wrapper, mirrors `directory-with-bulk.tsx`)
- `src/app/(staff)/admin/renewals/page.tsx` (render `PipelineWithBulk` instead of bare `PipelineTable` on the non-lapsed branch, admin-only)
- `tests/unit/renewals/pipeline-table-selection.test.tsx` (component test)

**Interfaces (produced this task):**
- `PipelineTable` gains `enableSelection?: boolean`, `onSelectionChange?: (cycleIds: string[]) => void`, `clearSelectionNonce?: number` (names + semantics copied verbatim from `MembersTable` so the pattern reads identically).
- `PipelineWithBulk({ rows, isAdmin, monthLabel?, monthKind? })`.

- [ ] **Step 1: Failing component test — checkboxes render only when `enableSelection`, and toggling emits cycleIds.** Component tests here MUST call `vi.useRealTimers()` (shared setup installs fake timers → `waitFor` hangs to the 30s test timeout).

```tsx
// tests/unit/renewals/pipeline-table-selection.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PipelineTable } from '@/app/(staff)/admin/renewals/_components/pipeline-table';

beforeEach(() => vi.useRealTimers());

const rows = [
  { cycleId: 'c1', memberId: 'm1', companyName: 'Acme', tierBucket: 'premium', expiresAt: '2026-08-15T17:00:00.000Z', urgency: 't-30', status: 'awaiting_payment', lastReminderAt: null, lastReminderStepId: null, linkedInvoiceId: 'inv1', anchored: false, closedReason: null, emailUnverified: false },
] as never;

function wrap(ui: React.ReactNode) {
  return <NextIntlClientProvider locale="en" messages={en}>{ui}</NextIntlClientProvider>;
}

describe('PipelineTable selection', () => {
  it('renders no checkbox when selection disabled', () => {
    render(wrap(<PipelineTable rows={rows} />));
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('emits selected cycleIds on toggle', () => {
    const onSel = vi.fn();
    render(wrap(<PipelineTable rows={rows} enableSelection onSelectionChange={onSel} />));
    fireEvent.click(screen.getAllByRole('checkbox')[1]!); // [0] is header select-all
    expect(onSel).toHaveBeenLastCalledWith(['c1']);
  });
});
```

- [ ] **Step 2: Run → fails** (`enableSelection` unknown prop). `pnpm test tests/unit/renewals/pipeline-table-selection.test.tsx`

- [ ] **Step 3: Add the selection column to `PipelineTable`** behind `enableSelection`, using TanStack `getRowId: (r) => r.cycleId`, an uncontrolled `RowSelectionState`, a `handleRowSelectionChange` that derives `cycleIds` and calls `onSelectionChange`, and a `clearSelectionNonce` effect — copy the exact shape from `members-table.tsx` (its `getRowId`/`rowSelection`/`clearSelectionNonce` block). Keep the `data`/`columns` `useMemo` keyed to include `enableSelection`. Header + row cells use `@/components/ui/checkbox` with `aria-label` from a new `admin.renewals.table.selectRow` / `selectAll` key. Run → GREEN.

- [ ] **Step 4: Write `PipelineWithBulk`** mirroring `directory-with-bulk.tsx`: `selectedIds` state, `clearNonce`, the "adjust state during render" reset when `rows !== rowsSnapshot`, `handleSelectionChange`, `handleClear`. Render `<PipelineTable enableSelection={isAdmin} …/>` + (Task 11) `<PipelineBulkActionBar/>` when `isAdmin`. For this task, stub the bar as `null` so the wrapper is independently testable.

- [ ] **Step 5: Wire `page.tsx`.** Replace the non-lapsed `<PipelineTable rows={rows} …/>` with `<PipelineWithBulk rows={rows} isAdmin={currentUser.role === 'admin'} …/>`, forwarding `monthKind`/`monthLabel`. **Render order only changes — no URL param name/semantics/default touched**, so the URL-param contract tests (`admin-pipeline-route.test.ts`, `renewal-pipeline-dashboard`/`renewal-i18n` e2e, `urgency-bucket-tabs`/`month-bar-chart`/`should-show-empty-state` unit) stay green untouched. Run `pnpm test tests/unit/renewals/ && pnpm typecheck`. Commit `feat(renewals): row selection + PipelineWithBulk wrapper (US3 scaffolding)`.

---

### Task 11 — `PipelineBulkActionBar`: bulk Send-reminder + bulk Mark-paid (per-row guarded route)

**Files:**
- `src/app/(staff)/admin/renewals/_components/pipeline-bulk-action-bar.tsx` (new, mirrors `members/_components/bulk-action-bar.tsx`)
- `src/app/(staff)/admin/renewals/_components/pipeline-with-bulk.tsx` (mount the real bar)
- `src/i18n/messages/{en,th,sv}.json` (add `admin.renewals.bulk.*`)
- `tests/unit/renewals/pipeline-bulk-action-bar.test.tsx` (component test, mocked fetch)

**Interfaces (produced this task):**
- `PipelineBulkActionBar({ selectedCycleIds, selectedCompanyNames, totalMatching, onClear })` — prop names mirror the members bar.

**Guardrails honored:** bulk Mark-paid iterates the **existing** `POST /api/admin/renewals/[cycleId]/mark-paid-offline` **per row** (no new settlement path); it opens a confirm dialog (ux-patterns §1) showing per-invoice THB totals from Task 9's read endpoint + a grand total; bulk Send-reminder iterates the **existing** `POST /api/admin/renewals/[cycleId]/send-reminder-now`. Sticky bar + `finalFocus` (reuse `useDialogFinalFocus` from `@/components/broadcast/reason-confirmation-dialog`, exactly as the members bar does) + `BulkProgressIndicator` + `BULK_CAP` cap. Mark-contacted button omitted (deferral flag above).

- [ ] **Step 1: Add i18n keys (EN canonical) under `admin.renewals.bulk`** mirroring `admin.members.bulk`: `toolbarLabel, selectedCount, overCap, overCapHelper, clear, cancel, actions.{sendReminder,markPaid,markContacted}` (markContacted reserved/unused), `confirmMarkPaidTitle, confirmMarkPaidDescription, confirmMarkPaidAction, paymentMethodLabel/paymentMethod.*/paymentReferenceLabel/paymentDateLabel` (reuse the cycleDetail wording), `previewTotal, previewRowUnpriced, reminderSent/reminderSkipped/reminderFailed, markPaidSucceeded/markPaidFailed, rateLimited, networkError, unknownError`. Add TH + SV so `pnpm check:i18n` passes (missing EN fails build; missing TH/SV fails release CI). Run `pnpm check:i18n`.

- [ ] **Step 2: Failing component test — bulk Send-reminder fans out one POST per selected cycle and aggregates buckets.**

```tsx
// tests/unit/renewals/pipeline-bulk-action-bar.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PipelineBulkActionBar } from '@/app/(staff)/admin/renewals/_components/pipeline-bulk-action-bar';

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outcome: { kind: 'sent' } }), { status: 200 })));
});

function wrap(ui: React.ReactNode) {
  return <NextIntlClientProvider locale="en" messages={en}>{ui}</NextIntlClientProvider>;
}

describe('PipelineBulkActionBar — send reminder', () => {
  it('POSTs send-reminder-now once per cycle', async () => {
    render(wrap(
      <PipelineBulkActionBar
        selectedCycleIds={['c1', 'c2']}
        selectedCompanyNames={['Acme', 'Beta']}
        totalMatching={2}
        onClear={vi.fn()}
      />,
    ));
    fireEvent.click(screen.getByRole('button', { name: en.admin.renewals.bulk.actions.sendReminder }));
    // confirm dialog → confirm
    fireEvent.click(await screen.findByRole('button', { name: en.admin.renewals.bulk.confirmReminderAction }));
    await waitFor(() => {
      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([u]) => String(u).includes('send-reminder-now'),
      );
      expect(calls).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 3: Run → fails** (component missing). `pnpm test tests/unit/renewals/pipeline-bulk-action-bar.test.tsx`

- [ ] **Step 4: Build the bar** by adapting `members/_components/bulk-action-bar.tsx`. Reuse verbatim: the sticky `fixed bottom-0` container + measured-height spacer (`ResizeObserver`), `role="toolbar"`, `lastTriggerRef`/`closedViaSuccessRef`/`useDialogFinalFocus`, the `overCap = count > BULK_CAP` guard, `BulkProgressIndicator`. Replace the members endpoint with a **per-row fan-out** helper:

```tsx
// core of pipeline-bulk-action-bar.tsx — fan-out over the SHIPPED per-cycle routes
async function fanOut(
  cycleIds: string[],
  toRequest: (cycleId: string) => Promise<Response>,
): Promise<{ ok: number; skipped: number; failed: number }> {
  let okCount = 0, skipped = 0, failed = 0;
  // Sequential (not Promise.all): each mark-paid mints an invoice + receipt and
  // activates a cycle; serialising bounds DB/advisory-lock contention and keeps
  // the progress indicator monotonic. Cap is BULK_CAP (100).
  for (const cycleId of cycleIds) {
    try {
      const res = await toRequest(cycleId);
      if (res.ok) { okCount++; continue; }
      if (res.status === 409 || res.status === 422) { skipped++; continue; } // not-payable / already-sent / member state
      failed++;
    } catch { failed++; }
  }
  return { ok: okCount, skipped, failed };
}

const sendReminders = (ids: string[]) =>
  fanOut(ids, (id) => fetch(`/api/admin/renewals/${encodeURIComponent(id)}/send-reminder-now`, { method: 'POST' }));

const markPaidAll = (ids: string[], body: { payment_method: string; payment_reference: string; payment_date: string }) =>
  fanOut(ids, (id) => fetch(`/api/admin/renewals/${encodeURIComponent(id)}/mark-paid-offline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
```

Toast the aggregated buckets exactly like the members bar (`error` when `failed>0`, `success` when `ok>0`, neutral `info` on an all-skipped no-op). Raise `closedViaSuccessRef.current = true` **before** `onClear()`; call `router.refresh()` after. Run the Step-2 test → GREEN. Commit `feat(renewals): bulk send-reminder via per-cycle route fan-out`.

- [ ] **Step 5: Failing test — Mark-paid confirm dialog fetches the preview and shows a THB grand total; unpriced rows show a note, not a number.** Mock `fetch` for `settlement-preview` returning one previewable (`1070_00`) + one not-previewable row. Assert the dialog renders the formatted grand total (`฿1,070.00`) and the `previewRowUnpriced` note for the second cycle. (THB minor→major = `/100`, `Intl.NumberFormat(locale,{style:'currency',currency:'THB'})`.)

- [ ] **Step 6: Build the Mark-paid confirm dialog.** On open, `fetch('/api/admin/renewals/settlement-preview?cycle_ids=' + ids.join(','))`, render the per-cycle list (company + THB total or the unpriced note) + grand total, plus the three shared inputs (`payment_method` Select, `payment_reference` Input, `payment_date` date) reusing `isMarkPaidIncomplete` from `[cycleId]/_components/cycle-admin-validation.ts` to gate the confirm button. On confirm call `markPaidAll(ids, body)`. **Note in the dialog copy** that one reference applies to all rows (batch transfer) — see the open question. Run Step-5 test → GREEN. Commit `feat(renewals): bulk mark-paid confirm dialog with per-invoice THB totals`.

- [ ] **Step 7: Mount the real bar** in `PipelineWithBulk` (`{isAdmin && <PipelineBulkActionBar …/>}`), passing `selectedCompanyNames` resolved from the current page rows by `cycleId` (same `Map` lookup the members wrapper uses). Run `pnpm test tests/unit/renewals/ && pnpm typecheck`. Add a Playwright `@a11y` assertion (preview-gated) that the toolbar has an accessible name + the 44px targets survive. Commit `feat(renewals): wire PipelineBulkActionBar into the dashboard (US3)`.

---

### Task 12 — Mobile card-stack for the pipeline table (`≤md` collapse)

**Files:**
- `src/app/(staff)/admin/renewals/_components/pipeline-card-list.tsx` (new — card-per-cycle presentation)
- `src/app/(staff)/admin/renewals/_components/pipeline-table.tsx` (render `<table>` at `md+`, `PipelineCardList` below `md`)
- `tests/unit/renewals/pipeline-card-list.test.tsx`

- [ ] **Step 1: Failing test — card list renders one card per row with company, tier, urgency pill, expires, and the same RowActionsMenu.** Assert an urgency pill *text label* (AA-contrast + text, not colour alone) is present per card.

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Build `PipelineCardList`** reusing `UrgencyPill`, `CycleTierCell`, `CycleCompanyCell`, `CycleExpiresCell`, and the existing `RowActionsMenu` (export it from `pipeline-table.tsx`). Each card is a `<div role="group" aria-label={companyName}>`; the list is `<ul>`/`<li>`. Selection checkbox (when `enableSelection`) sits top-left of each card.

- [ ] **Step 4: Swap presentation by breakpoint** in `PipelineTable`: wrap the `<Table>` in `hidden md:block` and render `<PipelineCardList className="md:hidden" …/>`. This replaces the deferred `J8-M34` note (`ux-standards.md §9.4`) — delete that comment block. Keep `overflow-x-auto` only on the `md+` table. Run the test + `pnpm check:layout` (the pipeline lives in a `TableContainer`, so the container gate still passes). Commit `feat(renewals): mobile card-stack for the pipeline table (≤md)`.

- [ ] **Step 5: Preview-gated Playwright** — add a `layout-responsive` assertion at a 375px viewport that the cards render and no horizontal body scroll appears. (Do not add `/admin/renewals` to a sweep that selects rows — the members note warns that bar never rendered there; here it will, so assert the bar's measured spacer keeps the last card reachable.)

---

### Task 13 (LARGE — flag: candidate follow-up branch) — merged "Today" worklist

**Files:**
- `src/app/(staff)/admin/renewals/_components/today-worklist.tsx` (new server component, Suspense-wrapped)
- `src/modules/renewals/application/use-cases/load-today-worklist.ts` (new — composes EXISTING reads)
- `src/app/(staff)/admin/renewals/page.tsx` (mount above the pipeline card)
- tests: unit (composition/ordering) + integration (live-Neon)

**Design (surface existing use-cases; no new backend beyond a thin composer):** blend four already-shipped reads into one ranked list — overdue cycles (`loadPipeline` with `urgency:'t-0'`), critical at-risk (the at-risk widget's data source), open escalation tasks (the renewals `tasks` view source), and members-without-cycle (`loadMembersWithoutCycle`). `load-today-worklist.ts` calls those and merges/ranks; it introduces **no new query** except an optional bounded `LIMIT`.

- [ ] **Step 1: Failing unit test** — given stub outputs from the four sources, the composer returns a single list ranked overdue → at-risk → escalation → no-cycle, de-duplicated by `memberId`, capped at N.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement `load-today-worklist.ts`** as a pure composer over injected use-case ports (Clean Architecture: Application composes Application; zero new infra). Each source wrapped in its own try/catch so one failing source degrades to a section-empty, never crashes the worklist (mirror the page's per-section best-effort isolation).
- [ ] **Step 4: Failing integration test (live-Neon)** — seed one member per bucket, assert all four surface once, ranked. `pnpm test:integration tests/integration/renewals/today-worklist.integration.test.ts`.
- [ ] **Step 5: Implement + GREEN.**
- [ ] **Step 6: Server component + Suspense mount** with a CLS-0 skeleton (mirror `MembersWithoutCycleTraySkeleton`). Commit `feat(renewals): merged Today worklist (overdue + at-risk + escalations + no-cycle)`. **If the PR is already wide from Tasks 1–4, split Task 13 to `nnn-renewals-today-worklist`.**

---

### Task 14 (LARGE / most deferrable — flag: recommend last, likely own branch) — saved filter segments

**Recommendation: ship the lighter `localStorage` option first**, tenant-scoped table only if cross-device sync is later demanded. Filters are already push-to-URL (`tier-filter-select.tsx`, `urgency-bucket-tabs.tsx`), so a saved segment is just a stored URL query-string + a label — no new server state, no migration, no RLS surface. This keeps Wave 3 free of a money-adjacent schema change.

**Files:**
- `src/app/(staff)/admin/renewals/_lib/saved-segments.ts` (new — `localStorage` read/write, zod-validated shape, tenant-slug-namespaced key)
- `src/app/(staff)/admin/renewals/_components/saved-segments-bar.tsx` (new — chips that `router.push` the stored query; a "Save current view" affordance)
- `src/app/(staff)/admin/renewals/page.tsx` (render above the filter row)
- tests: unit for the store (serialize/deserialize/validate/cap) + component for the chip bar

- [ ] **Step 1: Failing unit test for the store** — round-trips `{ id, label, query }[]`, rejects malformed JSON, caps at 12 segments, namespaces the key by tenant slug so two tenants on one browser don't cross-read. (Guard against a corrupt/oversized `localStorage` blob — parse behind `zod.safeParse`.)
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement `saved-segments.ts`** (SSR-safe: guard `typeof window === 'undefined'`; the query stored is the *filter subset* — `urgency`/`tier`/`month`/`view` — never `cursor`/`nowIso`, so a replayed segment always lands on page 1, consistent with every existing nav builder's `delete('cursor')`).
- [ ] **Step 4: Failing component test** — chips render stored segments; clicking one calls `router.push` with the stored query; "Save current view" captures `useSearchParams()` (filter subset only) + prompts for a label.
- [ ] **Step 5: Implement `SavedSegmentsBar` + GREEN.** Two example seeded segments ("Overdue Premium" = `?urgency=t-0&tier=premium`, "Suspended this month" = `?urgency=suspended`) are just default `localStorage` entries, not code paths. Chips are a `role="list"` of buttons with visible text labels (AA). Commit `feat(renewals): saved filter segments (localStorage, smart-feature #12)`. **Recommend shipping this on its own branch `nnn-renewals-saved-views` after Wave 3's core lands.**

---

**Wave close (before declaring done):** run the full local chain — `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm test:integration && pnpm test:e2e --workers=1` (never omit `--workers=1`). Confirm the URL-param contract suite (`admin-pipeline-route.test.ts` + the two named e2e + the three named unit suites) is untouched-green, since Wave 3 reorders render but changes **no** param name/semantics/default.

---

## Appendix A — Interfaces produced (per wave)

### Wave 1

1) src/components/renewals/result-count-label.tsx — `export interface ResultCountLabelProps { readonly count: number; readonly urgencyKey?: 't-90'|'t-60'|'t-30'|'t-14'|'t-7'|'t-0'|'suspended'|'terminated'; readonly monthLabel?: string; readonly monthKind?: 'overdue'|'later'|'month'; }` and `export function ResultCountLabel(props: ResultCountLabelProps): React.JSX.Element | null` (aria-hidden visible mirror of ResultCountAnnouncer; returns null when neither lens set).
2) renewals-section-tabs.tsx — `RenewalsSectionTabsProps` gains `readonly pendingReviewCount?: number;` (badge rendered only when > 0).
3) urgency-bucket-tabs.tsx — `UrgencyBucketTabsProps` gains `readonly monthLensActive?: boolean;` (default false; presentation dim only, URL logic unchanged).
4) pipeline-table.tsx — internal only (not exported): `RowActions({ cycleId, memberId, companyName, onRecordOutreach }: { readonly cycleId: string; readonly memberId: string; readonly companyName: string; readonly onRecordOutreach: (t: { memberId: string; companyName: string }) => void })` replacing RowActionsMenu; PipelineTable public props unchanged.
5) page.tsx — internal `async function PipelineSectionTabsWithCount({ tenantSlug }: { readonly tenantSlug: string })` (Suspense island reusing existing loadPendingReactivationReview; count = cycles.length).
6) i18n keys added: `admin.renewals.actions.sendReminderAriaLabel` ("Send reminder to {company}"), `admin.renewals.urgencyBuckets.monthLensHint`, `admin.renewals.pendingReview.tabCountSr` (plural ICU {count}).

### Wave 2

Task 5 (mark-paid row action):
- `export const PAYABLE_STATUSES: ReadonlySet<CycleStatus>` (src/app/(staff)/admin/renewals/_lib/mark-paid-gate.ts)
- `export function shouldOfferMarkPaid(status: CycleStatus): boolean`
- `export function MarkPaidOfflineDialog(props: { cycleId: string; open: boolean; onOpenChange: (open: boolean) => void; onPaid?: () => void; finalFocus?: React.RefObject<HTMLElement | null> }): JSX.Element` — reuses POST /api/admin/renewals/{cycleId}/mark-paid-offline (no new route)

Task 6 (money aggregation — the ONE new query):
- `export interface PipelineMoneySummary { readonly dueInWindowSatang: bigint; readonly overdueSatang: bigint; readonly collectedThisPeriodSatang: bigint }`
- `RenewalCycleRepo.loadPipelineMoneySummary(tenantId: string, opts: { readonly nowIso: string; readonly windowDays: number }): Promise<PipelineMoneySummary>`
- `export async function loadPipelineMoney(deps: Pick<RenewalsDeps,'cyclesRepo'>, input: { tenantId: string; nowIso: string; windowDays?: number }): Promise<Result<PipelineMoneySummary, { kind: 'invalid_input'; issues: {path:string;message:string}[] }>>`
- `export const loadPipelineMoneyInputSchema` (zod)
- `export function PipelineMoneyBand(props: { money: PipelineMoneySummary }): JSX.Element` (server component)

Task 7 (work-queue consolidation):
- `export function WorkQueueTabs(props: { pipeline: React.ReactNode; needsAction: React.ReactNode }): JSX.Element` — no URL param

Task 8 (sort + density + shared chrome):
- `export type PipelineSort = 'expires_at_asc' | 'expires_at_desc' | 'tier_asc' | 'tier_desc'`
- `PipelineQueryOpts.sort?: PipelineSort` (default 'expires_at_asc')
- `PipelineTableProps.sort?: PipelineSort` + `PipelineTableProps.sortHrefs?: Record<'expires'|'tier', string>`
- `export function LoadErrorCard(props: { message: string; children?: React.ReactNode }): JSX.Element` (shared)

### Wave 3

Task 1: loadSettlementPreview(deps: { renewalCycleRepo: Pick<RenewalCycleRepo,'loadSettlementPreview'> }, input: { tenantId: string; cycleIds: ReadonlyArray<string> }): Promise<Result<SettlementPreviewResult, { kind:'invalid_input'; message:string }>>. interface SettlementPreviewRow { cycleId: CycleId; companyName: string; invoiceId: string | null; amountThbMinor: number | null; currency: string | null; previewable: boolean }. interface SettlementPreviewResult { items: ReadonlyArray<SettlementPreviewRow>; totalThbMinor: number }. RenewalCycleRepo gains loadSettlementPreview(input:{ tenantId:string; cycleIds:ReadonlyArray<string> }): Promise<ReadonlyArray<SettlementPreviewRow>>. HTTP: GET /api/admin/renewals/settlement-preview?cycle_ids=<comma-list> → { items: SettlementPreviewRow[] (snake_case: cycle_id, company_name, invoice_id, amount_thb_minor, previewable), total_thb_minor: number }. Task 2: PipelineTable gains props enableSelection?: boolean; onSelectionChange?: (cycleIds: string[]) => void; clearSelectionNonce?: number (names/semantics copied from MembersTable). PipelineWithBulk({ rows: ReadonlyArray<PipelineRow>; isAdmin: boolean; monthLabel?: string; monthKind?: 'overdue'|'later'|'month' }). RowActionsMenu is exported from pipeline-table.tsx. Task 3: PipelineBulkActionBar({ selectedCycleIds: string[]; selectedCompanyNames: string[]; totalMatching: number; onClear: () => void }). Task 5: loadTodayWorklist(deps, input:{ tenantId:string; limit?:number }): Promise<Result<{ items: TodayWorklistItem[] }, never>> where TodayWorklistItem discriminates source ('overdue'|'at_risk'|'escalation'|'no_cycle') + memberId + cycleId? + label fields. Task 6: readSavedSegments(tenantSlug:string): SavedSegment[]; writeSavedSegments(tenantSlug:string, segs:SavedSegment[]): void; interface SavedSegment { id:string; label:string; query:string } (query = filter subset only: urgency/tier/month/view, never cursor/nowIso).

## Appendix B — Open questions surfaced during drafting

> **RESOLVED (2026-07-27):** every open question below has been decided — see **§ Decisions (agent-finalized)** near the top, which governs. This appendix is kept as the original framing/rationale for each.


### Wave 1

1) Item ④B ("no backend" tension): the pending-review badge needs a count. The plan supplies it by reusing the EXISTING loadPendingReactivationReview use-case inside a Suspense island (zero new queries, off the blocking hot path) and updates the stale page.tsx:349-353 "no badge on hot path" comment. Confirm this fits the Wave-1 "JSX/i18n only" boundary, or should the streamed count defer to a later wave (leaving RenewalsSectionTabs badge-capable but unfed on the pipeline view)?
2) Item ③ chip placement/duplication: MonthFilterChip is already rendered inside the chart section (renewals-by-month-section.tsx:153). Adding it to the filter row means two chips exist (now far apart after item ① moves the chart below). Keep both (each in local context) or move the single chip up to the filter row and remove it from the chart section? Also note MonthFilterChip's ✕ restores focus to `#renewals-by-month` (the chart region, now below the pipeline) — acceptable downward focus jump, or should the filter-row instance restore focus nearer the un-dimmed urgency strip?
3) Item ① verification is e2e-only + preview-gated (page.tsx is a server component with auth/headers/db deps — no vitest surface). Is a preview e2e ordering assertion + manual screenshot sufficient for the wave gate, or do you want a lighter local guard?
4) Dead-key cleanup: removing the disabled "Mark contacted" stub leaves `admin.renewals.actions.markContactedComingSoon` unused in all 3 locales (harmless for check:i18n). Remove it in this wave, or leave it?
5) Send-reminder visible button sizing: plan uses h-9 labelled outline button (≥24px AA target) and keeps the ⋯ trigger at 44px. Confirm this matches the "44px row-action targets" PRESERVE intent (which was written for the icon-only trigger, not a labelled button).

### Wave 2

1. Collection-rate definition (⑥): the band computes rate = collected / (collected + overdue) with divide-by-zero → "—". Confirm with the PO/accountant whether it should instead be collected / billed-this-period, or paid-count / issued-count. Load-bearing for the KPI's meaning; flagged display-only (no filter shortcut) until confirmed.

2. "Collected THIS PERIOD" window (⑥): implemented as the current Asia/Bangkok CALENDAR MONTH (date_trunc('month', nowIso AT TIME ZONE 'Asia/Bangkok')). Alternatives = tenant FISCAL year-to-date (tenant_invoice_settings fiscal-year start month) or a trailing 30/90d. Fiscal-YTD would need the F4 fiscal-year-settings port threaded in; confirm the intended period before we harden the SQL boundary.

3. "Due in window" span (⑥): fixed at windowDays=90 to match the pipeline's own 90-day ceiling. Confirm 90d is the intended KPI window (vs 30d to match the default ?urgency=t-30 tab).

4. Overdue tile filter target (⑥): mapped to ?month=overdue (the existing month-lens overdue bucket) because there is no dedicated "overdue" urgency. That bucket is cycle-expiry-overdue, not invoice-due-date-overdue — they usually agree but can diverge for a member with a not-yet-due fresh invoice. Confirm this is acceptable, or whether Overdue should deep-link to the F4 invoice list filtered to past-due issued invoices instead.

5. Bulk mark-paid (global constraint mentions it; NOT in the ⑤–⑧ item list): out of scope for this wave. There is NO bulk settlement route and the constraint forbids adding one, so a bulk affordance would be a CLIENT-SIDE sequential loop over the single guarded /mark-paid-offline route, gated by a confirm dialog showing the per-invoice THB total (which needs ⑥'s money query to enrich each selected row). That is a distinct, larger task — recommend a Wave 3 follow-up rather than bloating this PR. Flagging so it is a deliberate deferral, not an omission.

6. ?sort keyset-pagination interaction (⑧): the opaque cursor is encoded from (expires_at, cycle_id) ASC. Under a desc/tier sort the page layer deletes cursor on any sort change (so a stale ASC cursor never mis-pages), meaning a sort change resets to page 1. Confirm that reset-to-page-1-on-sort is acceptable UX (the alternative — a sort-aware cursor encoding — is a larger repo change).

7. ⑦ consolidation depth: this wave folds the at-risk widget and the urgency pipeline into ONE work-queue with two lenses under the 4 section tabs, WITHOUT adding a URL param (client state only), to keep the tested URL contract intact. If product wants the work-queue lens to be deep-linkable/bookmarkable (e.g. ?queue=needs-action), that is an additive URL-param change that must deliberately update the renewal-pipeline-dashboard + admin-pipeline-route tests — deferred pending confirmation.

### Wave 3

1. BULK MARK-PAID THB TOTAL TRUTHFULNESS (money, Principle IV — needs product-owner decision): mark-paid-offline MINTS the bill for `upcoming` cycles that have no invoice yet, so no real per-invoice total exists pre-confirm for those rows. Task 1 returns previewable:false + amount null for them and the dialog shows "—" + a note rather than a computed guess. DECISION NEEDED: (a) accept the mixed dialog (real totals for awaiting_payment/linked-invoice rows, "computed on confirm" for upcoming rows), or (b) SCOPE bulk mark-paid to only cycles that already carry a live linked invoice (linkedInvoiceId != null) so every displayed THB total is a real issued-invoice amount. Recommend (b) for a first cut — safest on a live-money screen. 2. BULK MARK-PAID SHARED REFERENCE: the guarded route requires payment_reference per call and stores it verbatim in audit_log (PAN-guarded). Bulk applies ONE operator-entered reference to all N cycles (a batch bank transfer). Confirm this matches SweCham's reconciliation workflow, or whether per-row references are required (which would make bulk mark-paid impractical and argue for keeping it single-cycle only). 3. THB MINOR-UNIT ASSUMPTION: Task 1 expresses amounts as amountThbMinor (satang, /100 for display). Verify the invoicing grand-total column's unit/name before implementing the Drizzle join (Gotcha: apply migration + integration test before commit; the amount source must match exactly what mark-paid mints). 4. PARTIAL-FAILURE UX on bulk mark-paid: N sequential mints; if row k fails mid-run (e.g. membership_bill_already_exists / f4_orphan_invoice), the run continues and the aggregate toast reports ok/skipped/failed counts — but individual orphan-invoice deep-links (surfaced per-row in cycle-admin-actions) are lost in aggregate. Confirm an aggregate summary is acceptable, or whether bulk mark-paid should stop-on-first-error. 5. BULK MARK-CONTACTED is dropped from Wave 3 (no shipped backend); confirm it stays gated to US4 rather than expecting a new use-case in this wave. 6. TASK 5 + TASK 6 SPLIT: confirm whether Today worklist and saved segments should ride in the Wave 3 PR or split to follow-up branches (nnn-renewals-today-worklist / nnn-renewals-saved-views) to keep the PR reviewable — recommend splitting if Tasks 1–4 already make the diff large.
