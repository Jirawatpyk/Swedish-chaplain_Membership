# Renewal SweCham Alignment — Round 2 (F-4 / F-5 / S3) — Design

**Date:** 2026-07-16
**Branch (proposed):** `066-renewal-swecham-round2` (off `origin/main` @ `c6d3453a5`, which carries #205 + #210)
**Predecessor:** Round 1 = `065-renewal-swecham-alignment` (PR #205, merged `8ae1a8242`) + statutory wording fix (PR #210, `c6d3453a5`). This design closes the three residuals that Round 1 explicitly deferred as tracked follow-ups (design §12 table F-4 / F-5 + sweep item S3).

---

## 1. Goal

Close the three real residuals from Round 1 **before invoices start existing in prod** — without introducing new cycle modelling:

- **F-4** — due-date-anchored warning emails + a permanent dormancy guard so the §5.2 `due+60` termination can never fire against a member the system never warned. *(go-live blocker for the termination path)*
- **F-5** — prevent a terminated (non-member) from being charged + issued a §86/4 tax receipt through Chamber-OS rails; make the residual out-of-band/race case admin-visible. *(compliance + records hygiene)*
- **S3** — surface the termination basis + close the `closed_reason` i18n gap. *(polish)*

**Guiding steer (user):** *"ถ้าอันไหนของเราดีอยู่แล้วไม่ต้องปรับตาม หรือ polish เอา"* — do not force-change what already works; the smallest correct change wins. F-5 depth decided by the user: post-termination pay-to-rejoin is **rare + relationship-driven** → prevent-at-source (Gate), not an accept-and-reconcile queue (Full).

**Non-goals (this round):** auto-invoice generation; full admin-reactivation queue (new cycle modelling — deferred to its own out-of-branch feature); F-8 void-on-reissue; F-6 undelete discriminator; F-1 keyset pagination. See §8.

---

## 2. Round-1 context (why these are residuals)

Round 1 shipped: `billing_cycle` field; §5.2 termination clock anchored on the linked membership bill's `due_date + 60`; §5.3 new-enrolment gating via born-`awaiting_payment` start-status; §5.4 `isBill`-gated statutory notice on the bill; §5.5 reminder statutory copy (now bylaw-based per #210).

Two structural gaps remained, both provably harmless **today** (prod = 110 `upcoming` members, **zero invoices** → no cycle can reach the termination or post-termination-payment states yet), but both must land before the first real invoice:

1. The reminder ladder anchors on `expires_at` (~12 months out) and V12 suppresses pre-expiry steps on `awaiting_payment` cycles → a born-`awaiting_payment` member receives **zero** warning before the `due+60` termination. **(F-4)**
2. The §5.2 clock deliberately leaves a terminated member's bill open, so a post-termination payment lands in the `terminal_only` heal branch (`resolve-unlinked-membership-payment.ts:239-264`) which today only logs a silent `warn` — and under `FEATURE_088_TAX_AT_PAYMENT` a §86/4 receipt is minted to a non-member. **(F-5)**

---

## 3. F-4 — Due-anchored warnings + dormancy guard *(go-live blocker)*

### 3.1 Problem

`lapse-cycles-on-grace-expiry.ts` terminates on `termination_basis = 'due_plus_60'` at the member's oldest-due unpaid membership bill `due_date + 60`. The warning ladder (`_lib/dispatch-one-cycle.ts`) anchors steps on `expires_at`; V12 filters `awaiting_payment` cycles to `offsetDays >= 0` steps — still anchored on the far-future `expires_at`. Net: the born-`awaiting_payment` cohort is terminated with no prior notice. Round-1 shipped the copy (bylaw-based, #210) but not a **channel** that reaches this cohort before `due+60`.

### 3.2 Mechanism (three parts)

**(1) Due-anchored warning track.** For a cycle in `awaiting_payment` that has an unpaid membership bill, emit warning reminders anchored on that bill's `due_date` (not `expires_at`):

| step_id | offset | content |
|---|---|---|
| `awaiting.due+7` | bill `due_date` + 7d | gentle overdue reminder (new copy) |
| `awaiting.due+30` | bill `due_date` + 30d | firm — carries the bylaw termination warning (reuse the existing `STATUTORY_TERMINATION_WARNING` const, already bylaw-based per #210) |

- Reuse the `renewal_reminder_events (tenant, cycle, step_id, year_in_cycle)` idempotency index — each step fires once (`dispatchOneCycle` returns `skipped: 'already_sent'` on the unique-violation, unchanged).
- The bill's `due_date` comes from the **member-scoped oldest-due lookup already added in §5.2** (the `invoice-due-bridge` port that returns a `due_date`). No new query shape.
- Applies uniformly to **both** the born-`awaiting_payment` cohort and a lapsed-renewer whose renewal bill is unpaid — any `awaiting_payment` cycle with an unpaid membership bill.
- Copy: `awaiting.due+7` is a new gentle EN/TH/SV string; `awaiting.due+30` reuses the confirmed bylaw warning. `pnpm check:i18n` green.

**(2) Dormancy guard at the terminate boundary.** In `lapse-cycles-on-grace-expiry.ts`, before terminating on `termination_basis = 'due_plus_60'`, require that the `awaiting.due+30` reminder_event **exists and was sent** for that cycle. If absent (email disabled, member opted out, warning track hadn't run) → **defer** (cycle stays suspended, not terminated), increment `deferred_no_prior_warning`, and emit the `lapseDeferred{reason:'no_prior_warning'}` metric.

- This makes "never terminate someone the system never warned" a **permanent correctness invariant**, not a temporary launch flag. Fail-safe direction (later/never termination, never earlier).
- Scoped to the `due_plus_60` basis only. The `no_invoice_backstop` basis has no `due_date` to anchor and is already covered by the `expires_at` ladder (those cycles are not born-`awaiting_payment`), so it is unchanged.
- Slots into the existing deferred-counter machinery (V8 cron-route + coordinator JSON counters, V10 `renewals_lapse_deferred_total{reason}`). No new audit event type required — the warnings emit the existing `renewal_reminder_sent`; the defer is a counter, not an audit event.

**(3) No new feature flag.** The dormancy guard *is* the gate (self-protecting). Adding a flag would be redundant config surface; the guard is superior because it is permanent and per-cycle rather than a global toggle someone must remember to flip.

### 3.3 Testing (TDD, Principle II)

- **Integration (live Neon):** born-`awaiting_payment` cycle past `due+7`/`due+30` gets the warning events; terminate **deferred** when the `due+30` warning is absent; terminate **fires** once the `due+30` warning exists and `due+60` is reached; lapsed-renewer with an unpaid bill also gets the due-anchored track.
- **Unit:** the due-anchored step computation (offset from bill `due_date`); the dormancy-guard predicate.
- **i18n:** new `awaiting.due+7` keys EN/TH/SV; parity test.

---

## 4. F-5 — Gate the Pay + audit net *(compliance hazard)*

### 4.1 Problem

A member terminated at `due+60` still holds an open, unpaid membership bill (§5.2 leaves it open by design). Paying it — online (Stripe Payment Intent via the portal / F5 `initiate-payment`) or offline (admin mark-paid, or a bank transfer an admin later records) — heals through `resolve-unlinked-membership-payment.ts`'s `terminal_only` branch, which today only logs a silent `warn`. Under `FEATURE_088_TAX_AT_PAYMENT`, a §86/4 tax receipt is minted to a non-member. Verified verbatim at `resolve-unlinked-membership-payment.ts:248`.

### 4.2 Decision: Gate (prevent-at-source), not Full (accept-and-reconcile)

Confirmed by an adversarial 3-lens panel (§9) + the user's "rare" call:

- **Gate = prevention, Full = mitigation.** Gate blocks the payment so no charge and no §86/4 receipt ever reaches a non-member. Full allows the payment (receipt already minted) then cleans up — it does not avoid the hazard, it routes it.
- **Full is an out-of-branch feature** (new classifier outcome + a cycle born into `pending_admin_reactivation` that `createCycleInTx` cannot mint today + successor-cycle-on-reactivate + a likely `renewal_cycles` CHECK-constraint migration). Violates "polish, don't force-change".
- **Gate is not a dead-end.** Every Gate primitive (the payments membership-access port/bridge, the terminated-detection, the instrumented heal-site) is the exact substrate a future Full would build on; nothing Gate writes must be un-written.

### 4.3 What already exists (verified — shrinks Gate's scope)

- **Portal Pay CTA already hidden for terminal cycles:** `is-renewal-payable.ts` returns `false` for any status outside `{awaiting_payment, upcoming, reminded}` (a terminated member's cycle is `lapsed`). Presentation-only.
- **Offline admin mark-paid already rejects terminal cycles:** `mark-paid-offline.ts` `PAYABLE_STATUSES = {awaiting_payment, upcoming}` → a `lapsed` cycle returns `cycle_not_payable`. No change needed here beyond confirming the error routing points the admin to the reactivate-first comeback.

### 4.4 Gate's real work (three parts)

**(1) Server-side guard on `initiate-payment`** (defense-in-depth beyond the UI hide). Add one step after Step 4 (`initiate-payment.ts:~383`): if the member's membership access is `terminated`, return a new `InitiatePaymentError` code `membership-terminated` → route maps to **409** with a member-facing notice: *"Your membership has been terminated. Please contact the chamber to reactivate before paying."*

**(2) Upgrade the `terminal_only` heal site** (`resolve-unlinked-membership-payment.ts:239-264`) from the silent `warn` to:
- a real **audit event** `payment_on_terminated_member` (payload: invoiceId, memberId, paymentRef, amount) — emitted in the existing F4 payment tx (Principle VIII; `evt`+`tx` already threaded),
- the existing `renewalsMetrics` upgraded to a dedicated metric,
- an **admin-visible signal** so it is not "a silent leak with a louder log" (§9 steelman). Preferred: an escalation-task/work-item; fallback if the escalation-task schema cannot attach to a `lapsed` cycle: an alertable metric + a documented runbook. Decide the vehicle at plan time after reading the escalation-task schema.

**(3) Payments → membership-access port/bridge** to power (1). This is the 4th copy of the established consumer-owns-port pattern (events / members / broadcasts each ship an identical ~55-line port + ~20-line bridge composing F8's pure `deriveMembershipAccess` + `findLatestCycleForMember`). Clean Architecture: payments reads membership state through this port, never reaching into the renewals domain.

### 4.5 Known limitation (documented, accepted)

Gate controls **Chamber-OS payment rails only** (Stripe + admin mark-paid). It cannot refuse a **bank transfer / PromptPay pushed directly to the chamber's account** — that cash lands out-of-band. This is not a regression Gate introduces: the offline mark-paid block already exists today, and the designed comeback for money-already-arrived is **reactivate-first** (`admin-renew-lapsed-member` re-invoices, then apply the payment) — **not** a refund. The audit-net + admin-visible signal make the residual online-race case (Payment Intent created pre-termination, confirmed post-termination — the one path the `initiate-payment` 409 cannot catch) visible for the admin to reactivate-or-refund. Given the user's "rare + relationship-driven" call, the human reactivate-first path is the correct comeback; a self-service accept-and-reconcile queue is Full (deferred).

### 4.6 Testing (TDD, Principle II)

- **Integration (live Neon):** `initiate-payment` returns 409 `membership-terminated` for a terminated member; the `terminal_only` heal path emits the `payment_on_terminated_member` audit event + metric (+ escalation task if adopted) instead of the silent warn. **Mandatory cross-tenant integration test** for the new payments→membership read (Principle I, Review-Gate blocker).
- **Contract:** the new `InitiatePaymentError` code + route mapping; the payments membership-access port.
- **Unit:** the terminated-detection predicate on the bridge.

---

## 5. S3 — closed_reason polish *(small)*

- Ensure `closed_reason` ↔ i18n **parity** for the lapse/termination reasons so no `(untranslated)` fallback leaks (`lapsed-tab.tsx:153` comment + the cycle-detail loud-fail path).
- Surface the `termination_basis` (`due_plus_60` / `no_invoice_backstop`, already in the `renewal_lapsed` payload since V9) in the admin **cycle-detail** view so an admin can see *why* a member was terminated.
- Exact enum ↔ key set verified at plan time (read the `closed_reason` values + the `renewals` i18n namespace). Likely i18n-only, no migration.

---

## 6. Data model & migrations

- **F-5:** one new `audit_event_type` enum value `payment_on_terminated_member` — the "four-places" pattern (domain const + `pgEnum` + 2 test counts) + a retention row (5y default). One migration.
- **F-4:** no schema change (new reminder `step_id`s are data on the existing `renewal_reminder_events`; the defer is a JSON counter + metric).
- **S3:** likely i18n-only; if the admin surface needs a persisted discriminator it is already the `termination_basis` payload — no migration.
- **Renumber** any new migration against `main` at plan time (parallel-branch collision gotcha). Apply migration + `pnpm test:integration` **before** committing schema (F4 R8 gotcha).

---

## 7. Architecture & boundaries (Principle III)

- **Payments → renewals** membership access flows through a new payments-owned port + bridge (composing renewals' public `deriveMembershipAccess` / `findLatestCycleForMember`). No cross-module domain reach. Mirrors events/members/broadcasts.
- **F-4** lives entirely inside renewals (dispatch use-case + lapse use-case + copy); the `invoice-due-bridge` port already abstracts the bill `due_date` (no Drizzle leak).
- **F-5** audit event emitted in the existing F4 payment tx via the already-threaded emitter (Principle VIII — write + audit atomic).

---

## 8. Out of scope / explicitly deferred

| Item | Disposition | Why |
|---|---|---|
| Full admin-reactivation queue (accept-and-reconcile) | Deferred — own out-of-branch feature | New cycle modelling: new classifier outcome + cycle born `pending_admin_reactivation` (createCycleInTx can't) + successor-cycle-on-reactivate + likely CHECK-constraint migration. Refund half already built (`admin-reject-reactivation`). Gate is its foundation. |
| F-8 void-on-reissue | Separate F4 branch | HARD-dep before any auto-invoice ship; not this round. |
| F-6 undelete→upcoming discriminator | Needs design (pre-archive status column + migration) | No safe DB discriminator today. |
| F-1 keyset pagination in the lapse cron | Deferred | Starvation only under a sustained >1000 awaiting backlog — immaterial at ~110. |
| Auto-invoice generation | Deferred (next phase) | `billing_cycle` (§5.1) is its foundation. |

---

## 9. Adversarial verification record (2026-07-16)

A 3-lens panel (chamber-os-architect + business-pm steelman + thai-tax-compliance-auditor) stress-tested Gate vs Full. Tax lens hit a StructuredOutput retry cap; its load-bearing claim was instead confirmed directly from source (`resolve-unlinked-membership-payment.ts:248` documents the §86/4-to-non-member mint under 088). Findings folded into this design:

- **Architecture (chamber-os-architect):** Gate ≈ near-zero new modelling (2 of 4 intended blocks already exist); Full = out-of-branch-feature; `gate_is_deadend: false`, `gate_reusable_by_full: true`. → **Ship Gate, defer Full.**
- **Steelman (business-pm), `does_it_overturn_gate: false`:** raised two valid hardening points now incorporated — (a) the out-of-band bank-transfer/PromptPay channel (§4.5 limitation, handled by reactivate-first), and (b) the audit-net must be admin-visible, not a louder log (§4.4 part 2, escalation task). The decisive business question (channel: refuse-before-landing vs pushed-unilaterally) is answered pragmatically: even for pushed cash, the existing reactivate-first flow + admin-visible signal is the correct rare-case comeback.
- **Tax (verified from source):** the §86/4 receipt is minted at payment even when membership is terminated → Gate (prevent payment) prevents the receipt; Full (allow payment) does not. Confirms Gate as the compliance-correct choice.

---

## 10. Operator gates (post-merge, human)

1. **F-5 touches the payments (money) surface** → Constitution requires **≥2 reviewers, one signing the security checklist** (PII/PCI + tenant-isolation cross-tenant test).
2. All `check:*` gates + preview E2E before merge.
3. No prod behaviour change is imminent (zero invoices), so no data backfill; the F-4 dormancy guard + F-5 gate become load-bearing only once real invoices exist — verify the warning cron cadence in prod once invoicing begins.
