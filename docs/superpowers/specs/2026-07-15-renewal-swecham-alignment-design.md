# Renewal ↔ SweCham Payment-Terms Alignment — Design (Round 1)

**Date:** 2026-07-15
**Status:** Approved-for-planning (brainstorm complete; revised after 3-agent review)
**Author:** brainstorm session (SweCham official "member fees payment terms" spec vs. shipped F8/F4 behaviour)
**Related prior work:** `docs/superpowers/specs/2026-07-13-membership-benefit-suspension-design.md` (059 membership-suspension, PR #193), PR #173 (renewal ↔ paid-invoice rolling anchor)
**Review:** revised to incorporate a chamber-os-architect + thai-tax-compliance-auditor + reliability-guardian review (see §11).

---

## 1. Goal

Bring the renewal lifecycle into line with SweCham's official **member-fees payment-terms** rules — **only where the current implementation is actually wrong or missing** (*polish what's good, fix what's wrong, don't rebuild*).

Compliance + correctness pass on the renewal money-path. Touches F8 (renewals) primarily, with small reaches into F4 (invoicing) and F3 (members). It **does not** touch F5 (Stripe/PromptPay online payment) or F6 (events — see §5.5).

## 2. The SweCham spec (source of truth)

Two membership categories:

**Calendar-year** (term 1/1–31/12): invoices issued **Dec 1** for the following year; 30-day terms; no benefit until paid; unpaid-after-30-days → 1st reminder early Jan stating SweCham is **regulatory-bound to terminate** unpaid members **within 60 days of the invoice due date**; 2nd reminder 30 days after; on payment → benefits through the calendar year.

**Rolling** (anniversary term): starts at enrolment + first invoice; 30-day terms; no benefit until paid; same 60-day-from-due termination; on payment → benefits **from payment date** through the following anniversary; renewal invoices sent **30 days prior** to the anniversary.

**General:** inform members of the statutory obligation to delete members with unpaid fees — *"could be done with a text on the invoice form."*

## 3. What we already do correctly (KEEP — no change)

Verified against the code:

- **30-day payment terms** — `default_net_days = 30`; due = issue + net days (`issue-invoice.ts:630`). ✔
- **Suspended = benefits paused** — suspended pauses use, keeps entitlement visible. ✔
- **Resume-on-payment** — invoice `issued→paid` → cycle → `full`. ✔
- **Rolling first-payment anchor = payment date** — never-anchored cycle re-anchors to the payment month on first payment (`paymentAnchorMonthStartUtc`). ✔
- **Renewal is gapless AND the renewer model is invoice-consistent** — this was challenged in review and **verified correct**:
  - `confirm-renewal.ts:498-517` issues the renewal invoice **linked to the CURRENT cycle** but covering the **NEXT** window `[periodTo, periodTo + term]`.
  - `createNextCycleOnPaidInTx` creates the next cycle **on payment**, at `prior.periodTo` — i.e. the next cycle covers **exactly the period just paid for**.
  - Therefore an `upcoming` cycle only ever exists **after** its own period was paid — **except** the initial new-member cycle (§5.3). A renewer who does **not** pay is `suspended` the instant their period ends (`deriveMembershipAccess` `awaiting_payment`/expired-`upcoming` → suspended, `renewal-cycle.ts:352-371`); there is **no free renewal period**.
  - Combined with suspension ("no benefit until paid" once the period ends), the effective benefit window already equals the spec's "benefits from payment through the following period". **No renewal re-anchor change is needed.** ✔

## 4. Key modelling decision: mid-year joiners are Rolling

A mid-year enrolment naturally has an anniversary period → **Rolling**. "Calendar-year" is the property of a member whose period genuinely runs 1/1–31/12 (imported that way or deliberately aligned by an admin); a mid-year join does **not** become calendar automatically.

**Consequence:** the first-payment anchor does **not** branch on category (stays Rolling: payment-month + 12). The category drives **no lifecycle behaviour this round**; its only behavioural role is **invoice-issuance timing** (deferred auto-invoice phase). We still record it now as foundation data (§5.1).

## 5. In scope (Round 1)

### 5.1 `billing_cycle` category field (F3 Members) — foundation only

- **Schema:** pg enum `billing_cycle = ('calendar','rolling')`; `members.billing_cycle` NOT NULL, DB default `'rolling'`.
- **Backfill (derive, best-effort):** read each member's latest/active cycle; `period_from` = **January 1** (Asia/Bangkok) → `'calendar'`, else `'rolling'`; no cycle → `'rolling'`.
  - **Known limitation (documented):** a Rolling member whose **first payment landed in January** gets `period_from = Jan 1` and is indistinguishable by dates from a Calendar member (their date signatures collide). The heuristic will over-mark such members `'calendar'`. Because the field drives **no behaviour this round**, this is tolerable, but it makes the admin-review pass (§9.2) mandatory before the auto-invoice phase consumes the field.
- **Create/edit form:** required `billing_cycle` picker (calendar / rolling), EN/TH/SV labels. No silent default — free per-member choice.
- **Behaviour this round:** none (foundation for the future auto-invoice phase + admin filtering). Documented so a reviewer does not expect it to gate anything.

### 5.2 Termination clock → `due_date + 60` (F8 Renewals)

- **Current:** `lapse-cycles-on-grace-expiry.ts` selects `awaiting_payment` cycles with `expires_at < now − grace_period_days` (prod grace TBD — see §9.3), with a 059 guard (`invoice-due-bridge`, currently a **boolean** filtered `due_date >= today`) that defers the lapse while an issued membership invoice is not yet past due.
- **Change — the clock must be driven by the member's unpaid invoice `due_date`, not `expires_at + grace`:**
  1. Extend `invoice-due-bridge` (already **member-scoped**) to **return the `due_date` of the member's oldest-due unpaid membership invoice** (not just a boolean). Do **NOT** anchor on the cycle's `linked_invoice_id`: a §5.3 new-member initial cycle has `linked_invoice_id = NULL` (`createCycleInTx` never sets it, and the first invoice is paid via the unlinked-payment hook and is never linked), so a linked-invoice anchor would miss **exactly the cohort this feature targets**. Member-scoped + oldest-due covers both renewers (invoice tied to the member) and new members.
  2. Lapse decision per `awaiting_payment` cycle: `due_date >= today` → **defer** (preserves the 059 not-yet-due guard); `today > due_date + 60` → **terminate**; otherwise (past due but < 60 days) → **stay suspended**.
  3. **Rewrite the candidate selection** (`listCyclesEligibleForLapse`, currently `WHERE status = 'awaiting_payment' AND expires_at < now − grace`). That `expires_at` gate **hides the §5.3 cohort**: a new member's initial cycle is born `awaiting_payment` with `expires_at ≈ now + 12 months`, so `expires_at < now − grace` stays false for ~12 months and the due+60 clock would **never fire for new members** (the exact people the feature targets). Change it to select **all `awaiting_payment` cycles**, then apply the per-cycle due-date decision; `expires_at + grace_period_days` remains **only** the no-invoice backstop (an `awaiting_payment` cycle with no membership invoice).
  - **§5.2 ⇄ §5.3 coupling (important):** §5.3 introduces `awaiting_payment` cycles with a far-future `expires_at`, which is precisely why §5.2's candidate selection must drop the `expires_at`-based pre-filter. Implement them together; a test must cover the born-`awaiting_payment` cohort (§8).
  - Constant `TERMINATION_DAYS_AFTER_DUE = 60` (domain constant; may become a `tenant_renewal_settings` column if a second tenant needs a different value).
  - Rationale: for an on-time invoice `due_date ≈ expires_at`, so this ≈ the current model with `grace = 60`; the due-date anchor additionally makes **late-issued** invoices correct (terminate 60 days after the member was actually asked to pay, not 60 days after the period end).
- **Unpaid-invoice disposition on termination (tax):** the lapse use-case **does not touch F4 invoices**; the unpaid invoice simply remains.
  - Under `FEATURE_088_TAX_AT_PAYMENT = ON` (the intended prod path — §9.1): the pre-payment document is a **non-tax `bill`** on the non-§87 numbering stream. An unpaid bill has **no tax point** (VAT is cash-basis at receipt) → it can sit unpaid with **no §87 gap and no output-VAT liability**. Records hygiene: leaving it `issued/unpaid` forever is acceptable; optionally an admin voids the bill. **No automatic void this round.**
  - Under legacy `FEATURE_088_TAX_AT_PAYMENT = OFF` (§86/4 issued at issue-time): a terminated member's unpaid §86/4 tax invoice **would** leave the tenant carrying output VAT on uncollected revenue → needs void (within the correction window) or a §86/10 credit note. This is **out of scope** and assumed **not the prod path**; flagged in §9.1.

### 5.3 New-enrolment benefit gating (F8 Renewals) — mechanism corrected

- **Requirement:** a member who has **never paid** has **no benefits until the first invoice is paid**.
- **Mechanism (start-status at the creation site ONLY):** in `f8OnCreateMemberCallbacks` → `createCycleInTx`, start the **new member's initial cycle** in a status that resolves to non-`full` (i.e. `awaiting_payment`) instead of `upcoming`. `deriveMembershipAccess(awaiting_payment)` → `suspended` (`renewal-cycle.ts:352-354`).
- **MUST NOT (prod-incident guards):**
  - Do **not** implement this as a `deriveMembershipAccess` read-predicate on `anchoredAt`/settled-count. `anchored_at IS NULL` is **not** a "never paid" signal — it is null on renewal cycles **and** on the imported 110-member prod cohort (`import-members.ts` created them `upcoming`, `anchored_at = null`). A read-predicate would flip all 110 to non-`full` = production incident.
  - Do **not** change `import-members.ts` (imported members stay `upcoming` = `full`, grandfathered).
  - Do **not** change `createNextCycleOnPaidInTx` (renewal cycles stay `upcoming` = `full`).
- **Heal path (corrected):** first payment classifies `first_payment` (`classify-membership-payment.ts`) → `reanchorFirstPaymentCycleInTx` sets the cycle to `upcoming` **+ `anchoredAt`** and returns `reanchored` (**NOT** `completed`) → `deriveMembershipAccess(upcoming, not-expired)` = `full`. (Corrects the earlier draft's "→ completed → full".)
- **Invariant tests (live-Neon), the crux:**
  - (a) an **imported-cohort** member stays `full`;
  - (b) a **renewer** with a prior completed/anchored cycle stays `full` even with an unpaid **later** renewal invoice (in-coverage);
  - (c) a **brand-new** member is non-`full` until first payment, then `full`.
- **Documented side-effects / operator notes:**
  - The initial cycle is *born* `awaiting_payment` (no `renewal_entered_awaiting_payment` transition event) — confirm no reminder/at-risk logic keys on that transition for initial cycles.
  - A never-invoiced new member stays `suspended` until the `expires_at + grace` backstop (auto-invoice is deferred) — acceptable this round.
  - An admin who creates a member that **already paid offline** sees them `suspended` until the payment is recorded — expected (record the payment), noted for operators.

### 5.4 Statutory notice on the invoice (F4 Invoicing) — bill-only, version-gated

- **Schema:** add `tenant_invoice_settings.termination_notice_th` + `termination_notice_en` (nullable).
- **Render — BILL ONLY:** gate on **`isBill === true`**, anchored at the payment-instructions / bank block (`invoice-template.tsx:925`) — **NOT** the WHT-note site (`:858`, which is `invoice_subject`-scoped and would leak the notice onto the paid **§86/4 tax invoice/receipt**). The notice must **never** print on a §86/4 document.
- **Byte-determinism (SC-003):** adding a render block requires bumping `CURRENT_TEMPLATE_VERSION` **and** a new min-version gate (like WHT v7 / zero-rate v8 …), plus adding the notice text to the `TenantIdentitySnapshot` value object (undefined-guarded), so re-rendering an older void/credit-noted document does not change its bytes.
- **Flag dependency:** assumes `FEATURE_088_TAX_AT_PAYMENT = ON` so the pre-payment document is a non-tax `bill` (`isBill === true`). Under flag OFF the notice does not render (ships dark) — acceptable, documented (§9.1).
- **Wording:** **placeholder** EN/TH seeded; pinned into the immutable snapshot at issue (so it appears only on invoices issued after the tenant sets it). **SweCham approves the final legal wording** before go-live (§9.4). TH/EN pair is sufficient (tax PDFs are TH/EN only; the SV member locale applies to reminder emails, §5.6, not the tax document).

### 5.5 Reminder copy + statutory warning (F8 Renewals)

- Add the statutory-obligation warning to the reminder step(s) that fire **after** the due date (existing post-expiry `t+7 / t+14 / t+30` steps in each tier ladder).
- **Keep the tier-aware ladder structure unchanged** — only add the warning language.
- Copy is a **placeholder** in EN/TH/SV, pending SweCham's approved wording (§9.4).

### 5.6 F6 event-quota — NO CHANGE this round (webhook dormant)

- F6 currently uses **only manual CSV import** (the EventCreate native webhook is behind an Enterprise paywall and is not in use). The CSV path already flags suspended/terminated attendance with an audit event (`event_attendance_by_suspended_member`, alert-only, fail-open).
- **No F6 code change this round.** The review's "webhook is blind" finding targets a dormant path.
- **Deferred:** webhook-path membership parity (when the webhook is activated) and any hard-block / do-not-count enforcement of suspended attendance in the CSV path. If SweCham later wants CSV attendance to actually **not consume** paused benefit quota (vs. today's alert-only), that is a separate, bounded follow-up.

## 6. Out of scope / explicitly deferred

| Item | Disposition | Why |
|---|---|---|
| Auto-invoice generation (calendar Dec 1 / rolling T-30) | Deferred (next phase) | Big F4 + cron; `billing_cycle` (§5.1) is its foundation. Invoicing stays manual/self-service. |
| Reminder ladder restructure to rigid 30/30 | Keep ours | Tier ladder is richer; only copy added (§5.5). |
| Rolling renewal re-anchor to payment date | Not a gap | Verified: renewer model already yields the spec window (§3). |
| Proration for mid-year *calendar* enrolment | Out of scope | Mid-year = Rolling (§4); calendar alignment is an admin action with an admin-set fee. |
| F6 webhook parity + suspended-quota hard-block | Deferred | Webhook dormant; CSV already flags (§5.6). |
| Unpaid §86/4 void/§86-10 on termination | Out of scope | Assumes 088 ON (non-tax bill); legacy path not prod (§5.2, §9.1). |
| F5 (Stripe/PromptPay) | Untouched | Only emits the `invoice paid` event renewals consume. |

## 7. Architecture & data flow

- `deriveMembershipAccess` (`renewal-cycle.ts`) stays the single access predicate — **unchanged**; §5.3 changes only the **start status** of the initial cycle at the creation site.
- Lapse cron (`lapse-cycles-on-grace-expiry.ts`) stays the termination seam; §5.2 changes the candidate/cutoff logic + the `invoice-due-bridge` port return shape (boolean → due_date). Both bridge callers (059 defer-guard + new due+60 clock) reconciled.
- F4 `invoice paid → F8 callbacks` chain unchanged.
- Invoice PDF (`invoice-template.tsx`) gains one `isBill`-gated notice block behind a new min-version gate; `TenantIdentitySnapshot` gains one field.
- **Clean Architecture (Principle III):** `invoice-due-bridge` returning a `due_date` string keeps the port abstraction (no Drizzle leak). `members.billing_cycle` is F3-internal this round (no cross-module read); when the future auto-invoice phase reads it from F4/F8 it MUST go through the members public barrel/port.

## 8. Testing (TDD, Constitution Principle II)

- **Unit (Domain):** `deriveMembershipAccess` — `awaiting_payment` → suspended; the §5.3 states.
- **Integration (live Neon):**
  - §5.3 invariants (a)/(b)/(c) above — **the imported-cohort-stays-`full` test is mandatory**.
  - §5.2: terminate at `due_date + 60` and not before; not-yet-due defer preserved; late-issued invoice; no-invoice backstop; **the §5.3 born-`awaiting_payment` cohort — a new member whose initial cycle has a far-future `expires_at` but an unpaid membership invoice past `due_date + 60` MUST be terminated** (proves `listCyclesEligibleForLapse` no longer hides it behind the `expires_at` gate).
  - §5.1 backfill correctness incl. the Jan-collision case (assert it is flagged/tolerated, not silently trusted).
  - §5.4: notice renders on the `bill` and **NOT** on the §86/4 tax receipt (mirror `wht-note-scope.integration.test.ts`); version-gate holds byte-determinism on re-render.
- **i18n:** new keys (form labels, statutory placeholder, reminder warning) in EN/TH/SV; `pnpm check:i18n` green.
- **Contract:** `invoice-due-bridge` port change (both callers).
- Apply migrations + `pnpm test:integration` **before** committing schema changes (F4 R8 gotcha). Renumber migrations against `main` at plan time (parallel-branch collision gotcha).

## 9. Operator gates (post-merge, human)

1. **Confirm `FEATURE_088_TAX_AT_PAYMENT = ON` in prod** — the tax-safety of §5.2 and §5.4 depends on the pre-payment document being a non-tax `bill`. If OFF, do not ship §5.4 (notice would land on §86/4) without revisiting.
2. **Review the `billing_cycle` derive** and correct mis-classified members — especially Rolling members whose first payment was in January (over-marked `calendar`; §5.1 limitation).
3. **Confirm the prod `grace_period_days` value** before it is demoted to no-invoice-backstop-only; the code default is 14 (CHECK ≤ 90) and prod may have been set higher — verify the live value.
4. **SweCham supplies/approves** the final statutory wording (invoice + reminder), EN/TH/SV; fields ship empty (dark) until then.

## 10. Open questions (none blocking)

- Whether `TERMINATION_DAYS_AFTER_DUE` should become a tenant setting — deferred until a second tenant needs a different value.
- Whether termination should auto-void the unpaid `bill` (records hygiene) — deferred; leave unpaid this round.

## 11. Review incorporations (3-agent, 2026-07-15)

This revision folds in a chamber-os-architect + thai-tax-compliance-auditor + reliability-guardian review. Key changes vs. the first draft:

- **Refuted:** the "passive renewer gets a free renewal period" finding. Traced `confirm-renewal.ts:498-517` + `createNextCycleOnPaidInTx`: the renewal invoice is linked to the current cycle and covers the next window, and the next cycle is created **on payment** covering the **paid** period — so an `upcoming` cycle implies a paid period (except the initial cycle). No invoice-driven rework needed; §3 stands.
- **Corrected §5.3 mechanism:** `anchored_at IS NULL` is not "never paid" (null on renewal cycles + imported cohort). Switched to a **start-status** change at the new-member creation site only, with explicit "do not touch import/renewal paths" guards and an imported-cohort-stays-`full` invariant test.
- **Corrected §5.4:** notice must be **`isBill`-gated** (bill only, never §86/4), needs a template-version bump + `TenantIdentitySnapshot` field (SC-003), and depends on `FEATURE_088_TAX_AT_PAYMENT`.
- **Sharpened §5.2:** the clock must be driven by the linked invoice's `due_date` (bridge returns due_date; selection/decision reconciled with the 059 defer-guard), not just a cutoff tweak; added the unpaid-invoice-on-termination tax disposition.
- **Re-scoped §5.6:** no F6 change (webhook dormant; CSV already flags).
- **Code cleanup (implementation):** fix the stale "F4's 90-day net terms" comment in `lapse-cycles-on-grace-expiry.ts` to reflect the actual 30-day terms.

**Second targeted re-review (2026-07-15):** §5.3 confirmed sound (start-status classifies + heals + isolates correctly); §5.4 confirmed tax-safe (`isBill` gate renders only on the bill across all 6 doc kinds; SC-003 requirements sufficient). §5.2 revised again — the reviewer found it interacts with §5.3: the new-member `awaiting_payment` cohort has a far-future `expires_at` (so `listCyclesEligibleForLapse`'s `expires_at` gate would hide them) and `linked_invoice_id = NULL` (so a linked-invoice anchor would miss them). §5.2 now specifies member-scoped oldest-due lookup + a candidate-selection rewrite, with a coupling note and a born-`awaiting_payment` test.
