# Renewal ↔ paid-invoice disconnect — QA finding triage (2026-07-08)

**Status**: TRIAGED — root cause confirmed on prod data; fix direction pending maintainer decision.
**Reporter**: QA team, 2026-07-06 — verbatim report: *"Renewal show count on lastest paided invoice"* + screenshot `docs/Bug/Screenshot 2026-07-06 170519.png` (a CREDITED membership invoice for SCCM-0004).
**Triage**: Claude session 2026-07-08. Prod evidence gathered via user-approved read-only DB check.

---

## F-1 (primary) — Paying a manually-created membership invoice does NOT complete the renewal cycle

### Decoded report

Member SCCM-0004 paid the 2026 membership invoice, yet every Renewal surface still
shows a renewal **countdown** ("count") as if the member never paid. QA's screenshot
shows one of their test invoices (the credited copy); the credited state is incidental
test noise — the real defect is the paid/renewal disconnect.

### Prod evidence (SCCM-0004, read 2026-07-08)

Invoices (all "Membership Regular Corporate 2026", 17,120 THB except where noted):

| Bill no. | Status | paid_at |
|---|---|---|
| SC-2026-000005 | paid | 2026-07-07 08:37 |
| SC-2026-000004 | **credited** | 2026-07-06 06:26 ← QA screenshot |
| SC-2026-000003 | paid | 2026-07-06 06:21 |
| SC-2026-000002 | paid | 2026-07-06 06:21 |
| SC-2026-000001 | partially_credited (18,120) | 2026-07-06 03:38 |
| (legacy doc SC-2026-000005) | void | — |

Renewal cycles for the same member — **exactly one**:

| Status | period_from → period_to | expires_at | linked_invoice_id |
|---|---|---|---|
| `upcoming` | 2025-12-11 → 2026-12-11 | 2026-12-11 | **null** |

Three paid membership invoices; the cycle never left `upcoming` and links to nothing.

### Root cause

F8 only completes a cycle for **its own dispatched invoice**:

- `markCycleCompleteInTx` (`src/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid.ts:123`)
  resolves the cycle via `findByInvoiceIdInTx` on `renewal_cycles.linked_invoice_id`.
  An admin-created (ad-hoc) invoice is never linked → callback logs
  `"no F8 cycle for invoice — non-renewal payment"` and returns `no_cycle_for_invoice`
  (deliberate no-op).
- Additionally the transition guard only accepts `awaiting_payment` cycles; an
  `upcoming` cycle could not auto-complete even if linked.
- `createNextCycleOnPaidInTx` no-ops the same way (resolves by linked invoice).

So the QA flow — create member → create membership invoice from the Invoicing module →
record payment — is invisible to F8 **by design**, and the design leaves no signal for
staff that the renewal cycle was not settled.

### Affected surfaces (all read the stale `upcoming` cycle)

- Admin member detail → "Renewal & Health" card (`member-renewal-health-section.tsx`):
  status `upcoming` + expiry 2026-12-11 + days-remaining countdown.
- Portal dashboard Membership stat (`dashboard-stats.ts` → `deriveMembershipStat`).
- `/admin/renewals` pipeline + urgency buckets.
- Portal renewal page `/portal/renewal/[memberId]` (active `upcoming` cycle → renders
  the confirm-renewal flow).

### Impact — launch-relevant, not just a test artifact

At **t-90 (~mid-September 2026)** the reminder dispatcher will start emailing renewal
reminders and drive members toward paying a SECOND invoice. Verified: the dispatcher's
13 `SKIP_REASONS` (`dispatch-one-cycle.ts:78`) contain **no "already paid this coverage
year" guard**. Every real member onboarded in year 1 with a manually-issued invoice
(the current SweCham workflow) is in this state.

### Existing workaround (available today)

`mark-paid-offline` (`src/modules/renewals/application/use-cases/mark-paid-offline.ts:107`)
accepts `PAYABLE_STATUSES = {awaiting_payment, upcoming}`. Staff process fix: after
recording payment on a manually-created membership invoice, ALSO "Mark paid offline"
on the member's renewal cycle. This is the missing step in the QA scenario.

### Fix directions (not yet decided)

1. **Reconciliation prompt** — when a paid invoice's `member_id` + plan/coverage year
   matches an open (`upcoming`/`awaiting_payment`) cycle, prompt admin to settle the
   cycle (or auto-settle with audit). Safest.
2. **Warning banner** — cycle detail + pipeline row shows "member has a paid membership
   invoice for this coverage year not linked to this cycle".
3. **Dispatcher guard** — add a skip reason `member_already_paid_coverage_year` so
   t-90 reminders never fire for these members even if the cycle is left stale.

Options compose; (3) is the cheapest safety net before September 2026.

---

## F-2 (found during triage) — No credit-note → renewal hook exists anywhere

The only F4→F8 integration event is `F4InvoicePaidEvent` (one-way, paid only). Grep
confirms zero `onCredited`/`CreditedEvent`/void callbacks in `src/`. If a LINKED
renewal invoice completes a cycle and is later credited (refund), the cycle stays
`completed` and membership never reverts. The only refund-aware path is
`admin-reject-reactivation` (reactivation flow), not generic credit notes.

- F8 spec (`specs/011-renewal-reminders`) never specified this case → spec gap, not a
  regression.
- Business decision required: a credit note may mean "refund" (revert membership) or
  "re-issue paperwork" (keep membership) — status alone cannot distinguish. A warning
  chip on the Renewal card when `linkedInvoice.status` is no longer `paid`
  (`load-cycle-detail.ts:61` already exposes it) is the safe first step.

## F-3 (found during triage) — At-risk scoring counts credited invoices as "last payment"

`drizzle-member-renewal-flags-repo.ts:574` (batch scorer) computes
`MAX(paid_at) AS last_paid_at` over ALL of a member's invoices with **no status
filter** — credited/void invoices retain `paid_at`, so a fully-refunded payment still
suppresses the `daysSinceLastPayment > 180 → +10` risk factor
(`at-risk-score.ts:315`). Check the single-member scorer
(`drizzle-at-risk-scorer.ts:19`) for the same pattern when fixing. Severity: low
(internal scoring only), but it silently understates risk for refunded members.

---

## Q-1 (QA follow-up, answered 2026-07-08) — "What does the renewal period count from? Registration date?"

**Yes — the renewal cycle is anniversary-based on `members.registration_date`, NOT on
the latest paid invoice and NOT on the plan's calendar year.**

Anchor rules (single home: `createCycleInTx`, `create-cycle-in-tx.ts:99-137`):

1. **First cycle** (create-member listener / member import): `periodFrom =
   registration_date`, advanced by whole `termMonths` multiples until the period
   covers "now" (`anchorToCurrentPeriod`, 068 cluster F).
   Verified on prod: SCCM-0004 `registration_date = 2025-12-11` → cycle
   2025-12-11 → 2026-12-11. Exact match.
2. **Steady-state renewal** (paying the F8-dispatched invoice): next cycle anchors at
   `prior.periodTo` — gapless anniversary continuation (`create-next-cycle-on-paid.ts:73`).
   The payment date does NOT move the anchor; paying early/late keeps the same
   anniversary.
3. **Admin lapsed-comeback**: anchors at the comeback instant (the only path that
   re-bases the anniversary).
4. **Paying a manually-created invoice**: no effect at all (that is finding F-1).

### Model mismatch surfaced by this question

The F2 plan (and therefore the invoice line) is a **calendar-year product**:
"Membership Regular Corporate 2026 (coverage 2026-01-01 to 2026-12-31)". The F8 cycle
is **registration-anniversary** based. For SCCM-0004 the invoice says coverage ends
**2026-12-31** while the renewal cycle expires **2026-12-11** — a 20-day disagreement
shown to staff and member on different screens. For a mid-year registrant the gap can
be months.

Open business decision: should cycles align to the plan's calendar year (Jan 1 –
Dec 31 of `plan_year`, matching the 2026 Membership Package and what the invoice
prints), or stay anniversary-based (current F8 behaviour)? If calendar-year is chosen,
the anchor rule in `createCycleInTx` + the reminder schedule derivation are the
touch-points.

---

## Q-2 (QA follow-up, answered 2026-07-08) — "Should the period count from the latest payment date?"

**No.** Payment date should *trigger* the status change (cycle → completed) but never
*define* the membership period. Counting from payment date would:

1. **Contradict the tax invoice** — the invoice states what was sold ("coverage
   2026-01-01 to 2026-12-31"). Delivering July-to-July coverage against a document
   that says Jan–Dec is an accounting/legal inconsistency, not just UX.
2. **Punish early payers, reward late payers** — and each member's period drifts later
   every year they pay a few days late (rolling-anchor creep).
3. **Break plan pricing and quotas** — plans are per-year products (2026/2027 priced
   separately) and benefit quotas are per calendar year; a period straddling two years
   has no well-defined plan price or quota year.

The "count from last payment" instinct is the consumer-subscription (rolling) mental
model; chamber membership is a fixed-period product — pay any time, receive *that
year*.

Legitimate roles of the payment date (all already correct in principle):
- Trigger for cycle completion (modulo bug F-1 for manually-created invoices).
- Tax point for the §86/4 receipt (088 behaviour).
- Re-basing a long-lapsed member's fresh cycle at the reactivation instant
  (admin-comeback path — the ONE place a payment-time anchor is right).

Recommended QA-facing answer: "Pay any time — status flips to renewed immediately on
payment, but the membership period is the plan year printed on the invoice; it does
not restart from the payment date."

---

## Q-3 (QA follow-up, answered 2026-07-08) — "What about mid-year joiners?" (under calendar-year membership)

**Coverage** (system decision): first period = registration date → **Dec 31 of the plan
year**, then Jan 1 – Dec 31 thereafter. Matches what the tax invoice already prints
today for mid-year joiners.

**Price** (commercial decision — the chamber's, not the system's):

| Option | Rule | Trade-off |
|---|---|---|
| A. Full price | Same fee regardless of join month | Simplest (current de-facto — July joiner SCCM-0004 was invoiced the full 16,000); Q4 joiners feel short-changed and may defer to January |
| B. Pro-rata | Discount by remaining quarters/months | Fairest; fractional amounts on tax invoices; needs fee-config feature or manual line edits every time |
| C. Q4 rule | Join Oct 1+ → invoice for the NEXT plan year; remainder of the current year free (coverage to Dec 31 next year) | Most common chamber/association practice; round plan amounts; fixes A's Q4 dead zone |

**Recommendation: C + A hybrid** — Jan–Sep joiners pay the current plan year in full
(coverage join-date → Dec 31); Oct–Dec joiners are invoiced the NEXT plan year
(coverage join-date → Dec 31 next year). Implementation is a single decision point at
member creation (pick `plan_year` = current vs next); invoice + cycle follow the chosen
plan with no proration math and no VAT/number-sequence complications. At ~131 members,
one-off exceptions are handled by staff editing the invoice amount manually.

**Confirm with the chamber board/manager** what their actual practice is (Oct cut-off
is a placeholder) before spec'ing. Minor spec point: mid-year joiners' benefit quotas
(e-blast/event) — recommend full-year quota (simple + new-member incentive) rather than
prorated.

---

## TSCC ANSWER (received 2026-07-08) — SUPERSEDES the Q-1/Q-3 recommendations above

TSCC's actual policy (verbatim intent, translated):

> Membership runs **12 months on a rolling basis, starting from the date the member is
> approved AND the fee payment is completed** — NOT calendar year (Jan–Dec).
> For renewing members the cycle references the member's 2025 payment date. Example:
> paid June 2025 → membership June 2025 – May 2026; on renewal the next period is
> June 2026 – May 2027 (gapless anniversary continuation, NOT re-anchored on the
> renewal payment date). **No pro-rating is used.**

Consequences for the recommendations above:

- **Q-1**: the calendar-year recommendation is REJECTED — TSCC is anniversary/rolling.
  F8's existing rolling architecture is the correct model; the CALENDAR-YEAR side
  (invoice coverage text) is what must change.
- **Q-2**: still correct — renewal payments do NOT move the anchor (TSCC's own example
  confirms gapless continuation). Only the FIRST payment sets the anchor.
- **Q-3**: dissolves — no proration; every joiner gets a full 12 months from their
  approval+payment date. `tenant_invoice_settings.pro_rate_policy` stays `none`; the
  F4 pro-rate machinery remains unused.

### Revised refactor scope (assessed 2026-07-08)

Smaller than feared — F8 was already built rolling. Work items:

| # | Item | Where | Size |
|---|---|---|---|
| R1 | First-cycle anchor: `registration_date` → **first-payment-completed date**. Keep creating the cycle at member creation (pipeline visibility) but RE-ANCHOR `periodFrom/periodTo` when the first membership payment completes. | F8 `f8-on-create-member-callbacks.ts`, `createCycleInTx` input, new re-anchor step in the on-paid chain | S–M |
| R2 | Invoice membership-line coverage text: currently the FY boundary of `planYear` (`create-invoice-draft.ts:263-281`, 088 FR-011) → must print the member's OWN rolling window (cycle `periodFrom → periodTo`). Draft creation needs the cycle window threaded in. Stored-text model means old documents are untouched (forward-only, same as 088 T036). | F4 `create-invoice-draft.ts` + callers + tests | M |
| R3 | F-1 fix is now CORE, not an edge case: the first payment SETS the anchor, so ad-hoc membership invoices MUST reach F8 (link invoice↔cycle at creation, or match by member+plan-year on payment). Dispatcher skip-guard still wanted as safety net. | F4→F8 integration | M |
| R4 | Backfill existing prod members: cycles are anchored at `registration_date`; TSCC says real members' periods reference their **2025 payment dates**. Need TSCC's payment-date list per member → migration script re-anchors each cycle. **DECIDED 2026-07-08: run AFTER testing completes; anchor = payment date; awaiting TSCC data.** | ops + script | S + data dependency |
| R5 | Plan-year pricing mapping: price = catalogue year of `periodFrom` (already how the F8 freeze resolves via `deriveFiscalYear(periodFrom)`). A June-2026→May-2027 period bills the 2026 catalogue. Confirm TSCC accepts this. | none (confirm only) | — |
| R6 | Benefit-quota year (e-blast / event seats). **DECIDED 2026-07-08: keep CALENDAR-YEAR quotas** (current F7/F9 behaviour, per recommendation — maintainer confirmed). Zero work. | — | 0 |
| R7 | Late-payment / lapse rule. **Working assumption (2026-07-08, UNCONFIRMED)**: maintainer found on TSCC's public site: *"membership lapses if the fee is overdue more than 30 days after the invoice or reminder"*. Maps to existing config: `tenant_renewal_settings.gracePeriodDays` 14 → **30** (config-only; range 0–90; `lapse-cycles-on-grace-expiry` already lapses past `expires_at + grace`). Paying WITHIN grace already yields gapless backdated continuation (`create-next-cycle-on-paid` anchors at `prior.periodTo`); beyond grace → lapsed → admin-comeback re-anchors (existing paths). Wording nuance to confirm with TSCC: their text counts 30 days from *invoice/reminder receipt*, F8 counts from *period end* — near-equivalent since the final notices land at expiry, but get official confirmation. | config | XS (pending official confirm) |

Remaining open items:
1. **Official TSCC confirmation of the 30-day lapse rule (R7)** — current source is the
   public website (maintainer: "ไม่ชัวร์").
2. ~~R4 data~~ **RECEIVED 2026-07-08**: `docs/Membership Database_Since 2025.xlsx`
   (PII — git-ignored, never commit). Analysis: 112 current members (Total Update
   sheet); **103/112 have a payment date** (master sheet `Payment Date` col +
   Renewal Form sheet); the 9 missing = 2 unpaid (Toyota MH, Scania — must NOT be
   anchored) + ~7 paid-but-undated early-2025 rows (ask TSCC or INV-date fallback).
   The workbook's own formulas CONFIRM rolling: `End of Membership =
   EDATE(Payment Date, 11)` (month-granular). Anomalies: 1 future-dated payment
   (2026-12-18, duplicated row); records key on company NAME (no member numbers).
3. **NEW Q for TSCC (from the workbook)**: the master sheet has a "Rolling Starts"
   section marker + 6 members explicitly labelled "full year" (+ "yellow highlight
   = full year" note on the Unpaid sheet) — do legacy full-year members convert to
   rolling at their next renewal, or stay on fixed-year terms? And is expiry
   month-end (sheet shows "Jun-26" for a 4-Jul-2025 payment) or exact date
   (payment + 12 months, our current design)?

---

## Questions for TSCC (drafted 2026-07-08 — answers unblock the fix spec)

1. **Membership period model** *(unblocks Q-1)* — Is TSCC membership valid per
   calendar year (Jan 1 – Dec 31, as printed on the tax invoice), or 12 months from
   each member's join date? (Today the tax invoice says calendar year while the
   renewal system tracks join-date anniversary — one must win.)
2. **Mid-year joiner pricing** *(unblocks Q-3)* — Full annual fee, pro-rated, or a
   special rule? Do Q4 joiners (Oct–Dec) pay next year's fee with the rest of the
   current year free? If so, from which month?
3. **Renewal season timings** *(configures the F8 reminder schedule + grace rules)* —
   When are next-year renewal invoices issued (e.g., Oct–Nov)? Payment deadline? How
   long after non-payment is a membership considered lapsed?
4. **Credit-note intent** *(unblocks F-2)* — When a paid membership invoice is
   credited, does that usually mean refund/cancellation (membership should revert) or
   a paperwork correction (membership stays)? Auto-revert or staff decision per case?
5. **Mid-year benefit quotas** *(minor spec point)* — Do mid-year joiners get the full
   annual benefit quota (e-blasts, free event seats) or a pro-rated share?

---

## Follow-ups

- [ ] Answer QA: explain F-1 + the "Mark paid offline" step; confirm which screen they saw the count on.
- [ ] Decide Q-1 business rule: calendar-year cycles (align with plan/invoice coverage) vs registration-anniversary (current).
- [ ] Confirm Q-3 mid-year-joiner pricing with chamber board/manager (recommended: C+A hybrid, Oct cut-off placeholder).
- [ ] Decide fix direction for F-1 (options 1–3 above) — recommend at least (3) before Sep 2026.
- [ ] Decide business rule for F-2 (credit note vs membership state).
- [ ] Fix F-3 status filter (both scorers) when touching at-risk code.
