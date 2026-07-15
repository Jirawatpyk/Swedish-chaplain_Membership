# Renewal ↔ SweCham Payment-Terms Alignment — Design (Round 1)

**Date:** 2026-07-15
**Status:** Approved-for-planning (brainstorm complete)
**Author:** brainstorm session (SweCham official "member fees payment terms" spec vs. shipped F8/F4 behaviour)
**Related prior work:** `docs/superpowers/specs/2026-07-13-membership-benefit-suspension-design.md` (059 membership-suspension, PR #193), PR #173 (renewal ↔ paid-invoice rolling anchor)

---

## 1. Goal

Bring the renewal lifecycle into line with SweCham's official **member-fees payment-terms** rules — **only where the current implementation is actually wrong or missing**. Where our behaviour already satisfies the spec, we keep it (the guiding principle for this round: *polish what's good, fix what's wrong, don't rebuild*).

This is a **compliance + correctness** pass on the renewal money-path, scoped so it touches F8 (renewals) primarily, with small reaches into F4 (invoicing), F3 (members), and F6 (events). It **does not** touch F5 (Stripe/PromptPay online payment).

## 2. The SweCham spec (source of truth)

SweCham has **two membership categories**:

**Calendar-year** (term 1/1–31/12):
- Invoices issued/sent **Dec 1** for the following calendar year.
- Payment terms **30 days**. No benefit access until paid.
- If unpaid after 30 days → 1st reminder early January stating SweCham is **regulatory-bound to terminate** unpaid members **within 60 days counted from the invoice due date**. 2nd reminder 30 days after the 1st.
- On payment → benefits throughout the calendar year.

**Rolling** (anniversary term):
- Starts at enrolment + first invoice. Payment terms 30 days. No benefit access until paid.
- Same reminder + 60-day-from-due-date termination rule.
- On payment → benefits **from the date of payment** through the enrolment anniversary the following year.
- Renewal invoices sent yearly **30 days prior** to the enrolment date.

**General:** members must be informed of the statutory/regulatory obligation to delete members with unpaid fees — *"could be done with a text on the invoice form."*

## 3. What we already do correctly (KEEP — no change)

Verified against the code during this brainstorm:

- **30-day payment terms** — `tenant_invoice_settings.default_net_days = 30`, due = issue + net days (F4 `issue-invoice.ts`). ✔
- **Suspended = benefits paused** — suspended keeps the entitlement visible but pauses use (portal banner + denylist). ✔ Matches spec.
- **Resume-on-payment** — invoice `issued→paid` flips the cycle `→completed → full`. ✔
- **Rolling first-payment anchor = payment date** — a never-anchored cycle re-anchors to the payment month on first payment (`paymentAnchorMonthStartUtc`). ✔
- **Renewal is gapless and preserves the period** — `createNextCycleOnPaidInTx` sets `periodFrom = prior.periodTo`. This **automatically preserves calendar alignment** (a member on 1/1–31/12 stays 1/1–31/12) **and** the anniversary for rolling members. Combined with suspension ("no benefit until paid" during the post-expiry gap), the *effective* benefit window already equals the spec's "benefits from date of payment through the following anniversary / calendar year". **This is why no renewal re-anchor change is needed.** ✔

## 4. Key modelling decision: mid-year joiners are Rolling

A member who enrols mid-year naturally has an anniversary-based period → they are **Rolling**. "Calendar-year" is **not** something a mid-year enrolment becomes automatically; it is the property of a member whose period genuinely runs 1/1–31/12 (imported that way, or an admin deliberately aligns them).

**Consequence:** the first-payment anchor does **not** need to branch on category — it stays Rolling (payment-month + 12) for everyone. The calendar/rolling distinction therefore drives **no lifecycle behaviour this round**; its only behavioural role is **invoice-issuance timing**, which lives in the deferred auto-invoice phase (§7).

We still record the category now as foundation data (§5.1).

## 5. In scope (Round 1)

### 5.1 `billing_cycle` category field (F3 Members)

- **Schema:** new pg enum `billing_cycle` = `('calendar','rolling')`; column `members.billing_cycle` NOT NULL, DB default `'rolling'` (matches today's de-facto behaviour).
- **Backfill migration (derive from dates):** for each existing member, read their latest/active renewal cycle; if the cycle's `period_from` is **January 1** (Asia/Bangkok) → `'calendar'`, else `'rolling'`. Members with no cycle → `'rolling'`. Admins can correct exceptions afterward.
- **Create/edit member form:** add a required `billing_cycle` picker (calendar / rolling) with EN/TH/SV labels. No silent default — it is a free per-member choice.
- **Behaviour this round:** none. The field is **foundation only** for the future auto-invoice phase and for admin filtering/reporting. This is documented so a reviewer does not expect it to gate anything yet.

### 5.2 Termination clock → `due_date + 60` (F8 Renewals)

- **Current:** `lapse-cycles-on-grace-expiry.ts` lapses an `awaiting_payment` cycle at `expires_at + grace_period_days` (prod = 90), with a 059 guard (`invoice-due-bridge.hasUnpaidNotYetDueMembershipInvoice`) that defers the lapse while an issued membership invoice is not yet past due.
- **Change:** terminate when `today (Asia/Bangkok) > relevant_unpaid_membership_invoice.due_date + 60 days`.
  - Extend the `invoice-due-bridge` port to return the unpaid membership invoice's **`due_date`** (it already queries that invoice), not just a boolean.
  - Compute the cutoff from that due date. Constant `TERMINATION_DAYS_AFTER_DUE = 60` (domain constant; may be promoted to a `tenant_renewal_settings` column if multi-tenant later needs per-tenant values).
  - **No-invoice backstop:** if there is no membership invoice to anchor on, fall back to the existing `expires_at + grace_period_days` behaviour (we must not terminate a member on a due date that never existed). `grace_period_days` is retained as this backstop only; prod's 90 stays as the backstop value.
- **Compliance effect:** members are terminated **within** 60 days of the invoice due date (the regulatory deadline), instead of the current `period_end + 90` which is ~30 days too slow when the invoice is on time.

### 5.3 New-enrolment benefit gating (F8 Renewals)

- **Current:** a new member's initial cycle starts `'upcoming'` and, being unexpired, `deriveMembershipAccess` returns `'full'` — so a member who has **never paid** gets full benefits. The "never paid" signal (`anchoredAt IS NULL`) exists on the row but is unused.
- **Requirement:** a member who has **never paid** (no completed cycle in their history) has **no benefits until the first invoice is paid**.
- **Preferred approach:** start the initial cycle in a status that resolves to non-`full` until first payment (reuse the `awaiting_payment → suspended` machinery so first payment → `completed → full` heals it). Exact mechanism pinned in the plan.
- **Invariant to protect (live-Neon test):** a member **with a prior completed cycle** who is inside a still-covered period must remain `'full'` even if a *later* renewal invoice is unpaid — the gate must fire **only** on never-paid initial enrolment, never on a within-coverage renewer. (This is the trap: "unpaid current cycle" ≠ "never paid".)

### 5.4 Statutory notice on the invoice (F4 Invoicing)

- **Schema:** add `tenant_invoice_settings.termination_notice_th` + `termination_notice_en` (mirrors the existing `wht_note_th/_en` pattern; nullable).
- **Render:** show the notice on **membership** invoices' PDF (near the WHT note / payment-instructions block in `invoice-template.tsx`). If the field is empty, nothing renders (ships dark until SweCham supplies text).
- **Wording:** a **placeholder** is seeded (EN/TH). **SweCham must approve the final legal wording** before it goes live — flagged as an operator gate, not a code blocker.

### 5.5 Reminder copy + statutory warning (F8 Renewals)

- Add the statutory-obligation warning text to the reminder step(s) that fire **after** the due date (the existing post-expiry `t+7 / t+14 / t+30` steps already exist in every tier ladder).
- **Keep the tier-aware ladder structure unchanged** — it is richer than the spec's minimal "two reminders" and already sends multiple touches; we only add the required warning language, we do not rebuild it into a rigid 30/30 cadence.
- Copy is a **placeholder** in EN/TH/SV, pending SweCham's approved wording (same gate as §5.4).

### 5.6 F6 event-quota parity (F6 Events)

- **Current:** the CSV-import path flags suspended/terminated attendance (`checkSuspendedMemberWarning`, audit + warn, fail-open); the **webhook ingest path has no membership check at all** — it is blind.
- **Change (bounded):** bring the **webhook ingest path to parity** with the CSV path — apply the same membership-access check (audit event + flag) so suspended/terminated event attendance is no longer invisible.
- **Deferred (business decision):** hard-blocking or billing the benefit-quota consumption for suspended/terminated attendees is **not** in this round; we only close the blind spot.

## 6. Out of scope / explicitly deferred

| Item | Disposition | Why |
|---|---|---|
| Auto-invoice generation (calendar Dec 1 batch / rolling T-30) | **Deferred to next phase** | Big F4 + cron build; `billing_cycle` (§5.1) is its foundation. Invoicing stays manual/self-service this round. |
| Reminder ladder restructure to rigid 30/30 | **Keep ours** | Tier-aware ladder is richer than the spec; only copy is added (§5.5). |
| Rolling renewal re-anchor to payment date | **Not a gap** | Gapless renewal + suspension already yields the spec's effective window (§3). |
| Proration for a mid-year *calendar* enrolment | **Out of scope** | Mid-year joiners are Rolling (§4); a deliberate calendar alignment is an admin action with an admin-set fee. |
| F6 hard-block / billing of suspended attendance | **Deferred** | Parity/visibility only this round (§5.6). |
| F5 (Stripe/PromptPay) | **Untouched** | It only emits the `invoice paid` event renewals already consume. |

## 7. Architecture & data flow (unchanged seams)

- **`deriveMembershipAccess`** (`renewal-cycle.ts`) stays the single access predicate; §5.3 extends its inputs to recognise never-paid enrolment.
- **Lapse cron** (`lapse-cycles-on-grace-expiry.ts`) stays the termination seam; §5.2 changes only the cutoff computation and the `invoice-due-bridge` port return shape.
- **F4 `invoice paid` → F8 callbacks** chain is unchanged (`markCycleComplete`, `createNextCycleOnPaid`).
- **Invoice PDF** (`invoice-template.tsx`) gains one conditional notice block (§5.4).
- **F6** webhook adapter gains the membership check the CSV path already has (§5.6).

## 8. Testing (TDD, Constitution Principle II)

- **Unit (Domain):** `deriveMembershipAccess` — never-paid → non-full; prior-paid-in-coverage → full even with an unpaid later invoice (the §5.3 invariant).
- **Integration (live Neon):** termination fires at `due_date + 60` and not before; no-invoice backstop; `billing_cycle` derive-migration correctness; F6 webhook now records the suspended-member audit event.
- **i18n:** new keys (form labels, statutory placeholder ×2 surfaces, reminder warning) present in EN/TH/SV; `pnpm check:i18n` green.
- **Contract:** `invoice-due-bridge` port change.
- Apply migrations + run `pnpm test:integration` **before** committing schema changes (F4 R8 gotcha). Migration numbers renumbered against `main` at plan time (parallel-branch collision gotcha).

## 9. Operator gates (post-merge, human)

1. **SweCham to supply/approve** the final statutory notice wording (invoice + reminder), EN/TH/SV — until then the fields ship empty (dark).
2. Review the `billing_cycle` derive result and correct any member whose category the date-heuristic guessed wrong.
3. Confirm prod behaviour change: termination now anchors on `due_date + 60` (the old `grace_period_days = 90` becomes a no-invoice backstop only).

## 10. Open questions (none blocking)

- Whether `TERMINATION_DAYS_AFTER_DUE` should become a tenant setting — deferred until a second tenant needs a different value.
- Exact new-enrolment gating mechanism (initial-cycle status vs. `deriveMembershipAccess` predicate) — pinned during planning with the §5.3 invariant test as the guard.
