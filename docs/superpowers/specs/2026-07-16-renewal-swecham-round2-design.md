# Renewal SweCham Alignment — Round 2 (F-4 / F-5 / S3) — Design

**Date:** 2026-07-16 (rev 2 — post 4-lens formal review, see §9)
**Branch:** `066-renewal-swecham-round2` (off `origin/main` @ `c6d3453a5`, which carries #205 + #210)
**Predecessor:** Round 1 = `065-renewal-swecham-alignment` (PR #205, merged `8ae1a8242`) + statutory wording fix (PR #210, `c6d3453a5`). This design closes the three residuals that Round 1 explicitly deferred as tracked follow-ups (design §12 table F-4 / F-5 + sweep item S3).

---

## 1. Goal

Close the three real residuals from Round 1 **before invoices start existing in prod** — without introducing new cycle modelling:

- **F-4** — due-date-anchored warning emails + a permanent dormancy guard so the §5.2 `due+60` termination can never fire against a member the system never warned. *(go-live blocker for the termination path)*
- **F-5** — prevent a terminated (non-member) from being charged + issued a §86/4 tax receipt through Chamber-OS rails; make every residual leak (webhook race, linked-path skip) admin-visible. *(compliance + records hygiene)*
- **S3** — surface the termination basis on the admin cycle detail. *(polish; the closed_reason i18n set is verified complete — see §5)*

**Guiding steer (user):** *"ถ้าอันไหนของเราดีอยู่แล้วไม่ต้องปรับตาม หรือ polish เอา"* — do not force-change what already works; the smallest correct change wins. F-5 depth decided by the user: post-termination pay-to-rejoin is **rare + relationship-driven** → prevent-at-source (Gate), not an accept-and-reconcile queue (Full).

**Non-goals (this round):** auto-invoice generation; full admin-reactivation queue (new cycle modelling — deferred to its own out-of-branch feature); F-8 void-on-reissue; F-6 undelete discriminator; F-1 keyset pagination. See §8.

---

## 2. Round-1 context (why these are residuals)

Round 1 shipped: `billing_cycle` field; §5.2 termination clock anchored on the member-scoped oldest-due unpaid membership bill's `due_date + 60`; §5.3 new-enrolment gating via born-`awaiting_payment` start-status; §5.4 `isBill`-gated statutory notice on the bill; §5.5 reminder statutory copy (now bylaw-based per #210).

Two structural gaps remained, both provably harmless **today** (prod = 110 `upcoming` members, **zero invoices** → no cycle can reach the termination or post-termination-payment states yet), but both must land before the first real invoice:

1. The reminder ladder anchors on `expires_at` (~12 months out for the born-awaiting cohort) and V12 suppresses pre-expiry steps on `awaiting_payment` cycles → a born-`awaiting_payment` member receives **zero** warning before the `due+60` termination. **(F-4)**
2. The §5.2 clock deliberately leaves a terminated member's bill open, so a post-termination payment can be charged — and under `FEATURE_088_TAX_AT_PAYMENT` a §86/4 receipt minted — to a non-member, with only a silent `warn` as the trail. **(F-5)**

---

## 3. F-4 — Due-anchored warnings + dormancy guard *(go-live blocker)*

### 3.1 Problem

`lapse-cycles-on-grace-expiry.ts` terminates on `termination_basis = 'due_plus_60'` at the member's oldest-due unpaid membership bill `due_date + 60`. The warning ladder (`_lib/dispatch-one-cycle.ts`) anchors every step on `cycle.expiresAt` via `findDueStepsForDate`; V12 filters `awaiting_payment` cycles to `offsetDays >= 0` steps — still `expires_at`-anchored. Net: the born-`awaiting_payment` cohort is terminated with no prior notice. Round-1 shipped the copy (bylaw-based, #210) but not a **channel** that reaches this cohort before `due+60`.

### 3.2 Mechanism

**(1) Candidate selection — a second arm (fixes the ±120d window hole).** The dispatch candidate query (`drizzle-dispatch-candidate-repo.ts:279-280`) only selects cycles with `expires_at` within ±`maxOffsetDays` (120d) of now; a born-awaiting cycle's `expires_at` is ~12 months out, so it would **never** enter the dispatcher and the warnings would never send (re-deadening §5.2 through the guard). The candidate selection therefore gains a **second arm**: `awaiting_payment` cycles joined (batched, in the query — no per-candidate N+1, honouring the FIX-6 precedent) to their member's **oldest-due unpaid membership bill**, with **no `expires_at` pre-filter** — mirroring `listCyclesEligibleForLapse`'s documented no-pre-filter precedent (`lapse-cycles-on-grace-expiry.ts:279-283`). The bill's `due_date` is threaded onto the candidate row. The lookup uses the **same floor** as the termination clock (`sinceDueDate = period_from − MAX_INVOICE_ISSUANCE_LEAD_DAYS(60)`), so the warning track and the `due+60` clock can never anchor on different invoices.

**(2) Due-anchored warning track — code-defined, tier-less.** For an `awaiting_payment` cycle **with** an unpaid membership bill, two warning steps anchored on that bill's `due_date`:

| step_id | offset | content |
|---|---|---|
| `due+7.email` | bill `due_date` + 7d | gentle overdue reminder — **new full EN/TH/SV template** |
| `due+30.email` | bill `due_date` + 30d | firm overdue-invoice warning — **new full EN/TH/SV template** that embeds the existing `STATUTORY_TERMINATION_WARNING` const (bylaw-based, #210). Do **not** reuse the post-expiry reactivation bodies — their "expired on {expiresAt}" framing is wrong for a member whose expiry is ~12 months out. |

Mechanism decisions (each reviewed against the machinery):
- **Steps are code constants** (a domain const pair), NOT rows in the per-tier `tenant_renewal_schedule_policies.steps_jsonb` — policy steps are `expires_at`-anchored by construction and admin-editable; a tenant deleting a policy row must never be able to freeze terminations. Tenant schedule policies stay `expires_at`-only.
- **Tier-less**: the dunning content is a statutory-style notice, not tier marketing. Copy lives in a dedicated `DUE_TRACK_COPY` per-locale const in `copy.ts` (NOT the `tier × offset` `RENEWAL_COPY` matrix), with parity pinned by `copy.test.ts` — **not** `pnpm check:i18n` (email copy is explicitly outside check:i18n scope).
- **Email gateway branch**: `deriveOffsetFromStepId` rejects unknown first segments (permanent `template_variables_missing` failure), so the gateway gets an explicit due-track branch keyed on the `due+N` step prefix rendering from `DUE_TRACK_COPY`.
- **Idempotency**: reuse the `renewal_reminder_events (tenant, cycle, step_id, year_in_cycle)` unique index via the existing `insertIfAbsent`; `year_in_cycle` for a due step is computed from the **step's own due-day** (`computeYearInCycle(periodFrom, dueDate + offset)`), never the run date (the 063 #1 duplicate-send lesson) — stable for a cycle stuck `awaiting_payment` across a year boundary.
- **No staleness skip**: due-track steps are **exempt from the 7-day `REMINDER_CATCH_UP_LOOKBACK_DAYS` cutoff** while the cycle is unterminated and the step unsent — they stay fireable until sent. Safe: the guard (3) blocks termination until then, so a late warning is still a pre-termination warning; the idempotency row prevents re-sends.
- **Track precedence (no double-dunning)**: on an `awaiting_payment` cycle **with** an unpaid membership bill, the due-anchored track runs and the `expires_at`-anchored `t+N` email steps are **suppressed**; **without** a bill (the never-invoiced/backstop cohort), the existing `t+N` ladder runs unchanged. A lapsed renewer (bill due ≈ `expires_at`) therefore gets exactly one dunning track, not two overlapping ones.
- **Opt-out policy**: the due-track warnings are **contractual/bylaw dunning notices, not marketing** — they bypass the `renewalRemindersOptedOut` gate (FR-016 is scoped to marketing-style renewal reminders). `email_unverified`, `no_primary_contact`, archived, and erased gates still apply (those members fall to the escalation net below).

**(3) Dormancy guard at the terminate boundary.** In `lapse-cycles-on-grace-expiry.ts`, before terminating on `termination_basis = 'due_plus_60'`, require a **sent statutory-warning-bearing email event** for that cycle: the `due+30.email` event, **or** any post-expiry `t+N` (≥ t+7) email event — all of which carry the bylaw warning per §5.5 (accepting `t+N` prevents forever-deferral for cohorts warned by the pre-existing ladder). Additionally require **minimum notice**: terminate only when the warning's `dispatched_at` is ≥ `MIN_WARNING_NOTICE_DAYS (14)` days ago — in the normal path (warning at due+30, termination after due+60) this changes nothing; it only extends runway when a warning fired late.

If the guard fails → **defer** (cycle stays suspended), increment `deferred_no_prior_warning`, emit `lapseDeferred{reason:'no_prior_warning'}`, **and create an idempotent escalation task** (the open-status partial unique index absorbs daily re-runs) so the structurally-unwarnable cohort (unverified email, no primary contact, persistent send failures) is **admin-visible with a comeback** (fix the contact data, or use the manual cancel/renew flows) — a counter alone is SRE-visible, not admin-visible.

- This makes "never terminate someone the system never warned" a **permanent correctness invariant**, not a launch flag. Fail-safe direction (later/never termination, never earlier). No new feature flag — the guard is the gate.
- Scoped to the `due_plus_60` basis only. The `no_invoice_backstop` basis is unchanged: those cycles have **no bill** (the never-invoiced cohort — which *includes* born-awaiting members who were never invoiced), so the `expires_at`-anchored `t+N` ladder (V12 permits it on awaiting cycles, and near expiry they ARE inside the candidate window) fires during the `expires_at → expires_at+grace(60d)` runway before the backstop terminates — that path is already warned.
- Slots into the existing deferred-counter machinery (V8 cron-route + coordinator JSON counters, V10 `renewals_lapse_deferred_total{reason}`). Deps: widen the `LapseCyclesOnGraceExpiryDeps` Pick with `reminderEventRepo` (+ `escalationTaskRepo`) — the full deps object is already passed at runtime.

### 3.3 Testing (TDD, Principle II)

- **Integration (live Neon):**
  - Born-awaiting geometry **must use `expires_at` > 120d out** (so the C1 window hole can never silently pass): cycle past `due+7`/`due+30` gets the warning events via the second candidate arm.
  - Terminate **deferred** (+ escalation task created, idempotent across two runs) when no statutory warning was sent; terminate **fires** once `due+30.email` is sent ≥14d ago and today > `due+60`.
  - Guard accepts a sent `t+N` (≥ t+7) email in lieu of `due+30.email` (pre-existing-ladder cohort).
  - Track precedence: renewer with unpaid bill gets due-track only (no `t+N` email duplicates); never-invoiced cycle keeps the `t+N` ladder.
  - Opt-out member still receives due-track warnings (contractual-notice bypass); unverified-email member gets no email but ends admin-visible via the escalation task.
  - Corrected/reissued invoice (new `due_date`): the 059 not-yet-due shield defers while the new bill is not due; once past due, termination proceeds on the earlier cycle warning + min-notice — pinned as accepted behaviour (one warning per cycle-year).
  - Year-boundary: cycle stuck `awaiting_payment` >365d mints no duplicate warnings (due-day-anchored `year_in_cycle`).
- **Unit:** due-step date computation (offset from bill `due_date`, floor); the guard predicate (statutory-step set + min-notice); the gateway due-track branch; `DUE_TRACK_COPY` parity in `copy.test.ts`.
- **E2E:** cron-route JSON gains `deferred_no_prior_warning` — extend the existing sum-invariant assertion.

---

## 4. F-5 — Gate the Pay + audit net *(compliance hazard)*

### 4.1 Problem

A member terminated at `due+60` still holds an open, unpaid membership bill (§5.2 leaves it open by design). Chamber-OS has **three first-party rails** that could take that money — online Stripe (portal pay-sheet → `initiate-payment`), the renewals cycle-scoped admin `mark-paid-offline`, and the **F4 invoice-scoped admin record-payment** (`POST /api/invoices/[invoiceId]/pay` → `recordPayment`, the single §86/4 mint site under 088). A charge on any of them mints a §86/4 receipt to a non-member.

### 4.2 Decision: Gate (prevent-at-source), not Full (accept-and-reconcile)

Confirmed by an adversarial panel + the user's "rare" call (§9):

- **Gate = prevention, Full = mitigation.** Gate blocks the payment on every Chamber-OS rail so no charge and no §86/4 receipt reaches a non-member. Full allows the payment (receipt already minted) then cleans up.
- **Full is an out-of-branch feature** (new classifier outcome + a cycle born into `pending_admin_reactivation` that `createCycleInTx` cannot mint today + successor-cycle-on-reactivate + a likely CHECK-constraint migration). Violates "polish, don't force-change".
- **Gate is not a dead-end.** Every Gate primitive (the membership-access port copy, the terminated-detection, the instrumented heal-sites) is the exact substrate a future Full would build on.

### 4.3 What already exists (verified)

- **Online rail is already server-blocked at the chokepoint:** `requireMemberContext` runs the 059 terminated portal-scope allowlist on **every** portal API request; `/api/payments/initiate` is deliberately NOT on the terminated allowlist → a terminated member's Pay-now click already **403s** (`membership_access_restricted`) before the use-case runs (`lapsed-portal-scope.ts:107-111`). What's missing is only the **member-facing message** (the pay-sheet client maps errors by HTTP status → a terminated member today sees a generic auth-retry message) — fixed in §4.4(3). A separate use-case-level guard inside `initiate-payment` would be dead code behind this chokepoint and is **not** built.
- **Renewals cycle-scoped mark-paid already rejects terminal cycles:** `mark-paid-offline.ts` `PAYABLE_STATUSES = {awaiting_payment, upcoming}` → `cycle_not_payable`; the admin UI hides the Mark-Paid button entirely on lapsed cycles (`cycle-admin-actions.tsx` renders null). The dead-end here is a **missing visible affordance**, not missing copy — fixed in §4.4(4).
- **The renewal-page Pay CTA** is hidden for terminal cycles (`is-renewal-payable.ts`) — but note the **portal invoice-detail pay-sheet** is a separate surface gated by invoice status, so a terminated member still *sees* Pay Now there; clicking it hits the 403 above. Accepted UX: click-then-403 **with the proper notice** (§4.4(3)) rather than threading a membership read into the invoice page.

### 4.4 Gate's real work (four parts)

**(1) Gate the F4 record-payment rail** — the one truly ungated first-party rail (review C3/C4). In the `recordPayment` use-case, **scoped to `invoiceSubject = 'membership'` AND the admin-manual trigger** (`triggeredBy = 'admin_manual' | 'admin_offline_mark'` — **never the webhook/processor path**, where Stripe has already captured the money and rejecting would wedge the payment tx and lose the record): consult a new invoicing-owned membership-access port; if the member's access is `terminated`, return a new typed error `membership_terminated` → route 409 → `record-payment-error-routing.ts` gains a `DEDICATED_MESSAGE_CODES` entry with the §4.4(4) comeback copy. Fail-open on port lookup error (payment availability; the §4.4(2) net is the backstop) with the existing `membership_access_fail_open`-style audit trail. Normal flows are unaffected: an awaiting/suspended member's payment passes (access ≠ terminated), the post-reactivation new invoice passes, the imported no-cycle cohort passes (null cycle → `full`), event invoices are out of scope by subject.

**(2) Audit net at BOTH terminal exits** (review C2). A post-termination payment reaches one of two sites, both already inside F4's payment tx with the audit emitter threaded:
- the **unlinked** `terminal_only` branch (`resolve-unlinked-membership-payment.ts:239-264`, today a silent warn), and
- the **linked-path skip** (`mark-cycle-complete-from-invoice-paid.ts:396-409` — a lapsed cycle's `linked_invoice_id` payment exits `cycle_not_payable` with only a warn; this is exactly where the §4.5 webhook race lands for a lapsed renewer).

Both sites gain, atomically in the payment tx: the **audit event `payment_on_terminated_member`** (payload from the real `F4InvoicePaidEvent` fields: `invoice_id`, `member_id`, `amount_satang`, `payment_method`, `triggered_by`, `paid_at` — the event carries **no** processor payment reference by design, and `paymentMethod`+`triggeredBy` distinguish the rails), a dedicated metric, and an **idempotent in-tx escalation task** via `escalationTaskRepo.insertIfAbsent` (the open-status partial unique index absorbs at-least-once webhook retries; `cycle_id` is nullable so the terminal cohort attaches fine). Ordering contract: the audit emit is mandatory-in-tx (audit-before-success); the task insert is idempotent-in-tx; **no swallow** that would commit the payment without the signal, and no non-idempotent write that could wedge the retrying webhook.

**(3) Member-facing notice on the online rail** (presentation-only). The pay-sheet client (`use-initiate-payment.ts`) currently maps errors by HTTP status; add a body-code branch: `403` + `membership_access_restricted` → a dedicated `portal.payment` i18n message: *"Your membership has been terminated. Please contact the chamber to reactivate before paying."* (EN/TH/SV).

**(4) Admin comeback guidance — visible, not toast-only** (review: the blocked path renders nothing on a lapsed cycle). A static callout on the **lapsed cycle-detail page** (and the record-payment error copy from (1)): *"This member's membership has been terminated — use Renew Lapsed Member to reactivate and re-invoice, then record the payment against the new invoice. Void the old open bill."* (EN/TH/SV). The **void-the-old-bill** step matters for tax hygiene: `admin-renew-lapsed-member` issues a fresh invoice without touching the old bill; after reactivation the member is no longer terminated, so the old bill becomes payable again — two open bills for one period risks a duplicate §86/4. Voiding the unpaid bill is tax-clean under 088 (no §86/4 exists pre-payment, so no §86/10 credit note needed). The existing void surface (`/admin/invoices/[invoiceId]` → void) is the tool; this is a runbook/copy step, not new machinery.

### 4.5 Known limitation (documented, accepted)

Gate controls **Chamber-OS rails only**. It cannot refuse a **bank transfer / PromptPay pushed directly to the chamber's account** — that cash lands out-of-band. The comeback for money-already-arrived is **reactivate-first** (`admin-renew-lapsed-member` → new invoice → record payment there → void the old bill), **not** a refund; the §4.4(1) gate + §4.4(4) guidance route the admin there. The residual **online race** (Payment Intent created pre-termination, confirmed post-termination — uncatchable by any pre-charge check) is covered by the §4.4(2) net at **both** exits, so it can no longer pass silently. Given the user's "rare + relationship-driven" call, the human reactivate-first path is the correct comeback; a self-service accept-and-reconcile queue is Full (deferred).

### 4.6 Testing (TDD, Principle II)

- **Integration (live Neon):**
  - `recordPayment` (admin-manual, membership subject) rejects `membership_terminated` for a terminated member; the webhook-triggered path is **not** gated (a lapsed-cycle linked-invoice webhook payment records + §86/4 mints + the net fires — pinning the C2 scenario end-to-end).
  - Both §4.4(2) sites emit `payment_on_terminated_member` + metric + exactly-one open escalation task across two deliveries (idempotency).
  - Normal-flow non-regression: suspended member's payment passes the gate; post-reactivation new-invoice payment passes; no-cycle (imported) member passes.
  - **Mandatory cross-tenant integration test** for the new invoicing→renewals membership read (Principle I, Review-Gate blocker).
- **Contract:** the new `recordPayment` error code + route mapping; the invoicing membership-access port; the client 403 body-code mapping.
- **Unit:** the gate predicate (subject × trigger × access matrix); fail-open on lookup error.
- **i18n:** new keys — portal notice, record-payment error copy, cycle-detail callout — EN/TH/SV; parity via `check:i18n` (these ARE messages-file keys, unlike the email copy).

---

## 5. S3 — termination-basis surfacing *(small)*

Verified at review: all 9 `CLOSED_REASONS` already have EN/TH/SV keys under `admin.renewals.lapsedReason` — **there is no missing-key gap**. The real residuals:

- A `due_plus_60` termination renders as **"Grace expired"** (both `lapsed` and `grace_expired` map to that label) — misstating the basis to the admin.
- `termination_basis` + `due_date` live **only** in the `renewal_lapsed` audit payload (V9); `loadCycleDetail` does not carry them.

Work: a small audit-log read for the cycle's `renewal_lapsed` event (mirroring the existing `ReminderAuditQueryPort` pattern), threaded through `loadCycleDetail` → cycle-detail page shows the basis (+ the anchoring `due_date`) with two new labels (`terminationBasis.due_plus_60` e.g. "Terminated — unpaid more than 60 days past due", `terminationBasis.no_invoice_backstop`) in EN/TH/SV. Query + presentation only; no migration.

---

## 6. Data model & migrations

- **F-5 audit event `payment_on_terminated_member`** — owned by the **F8 (renewals) audit taxonomy** (the emit sites live in renewals' heal path). Full lockstep set (verified against the label-coverage guard, which parses migrations SQL):
  1. One migration: `ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS ...` (copy 0247's shape; next free number **0249** — re-verify against `main` at plan time).
  2. `F8_AUDIT_EVENT_TYPES` tuple + count assertion 69 → 70 (`renewal-audit-emitter.ts`), + typed payload shape.
  3. `F8_ENUM_SHIPPED_TUPLE` (drizzle emitter) + `DB_ONLY_AUDIT_EVENT_TYPES` (auth schema) sync.
  4. Both count tests: `tests/unit/renewals/application/ports.test.ts` + `tests/contract/renewals-audit-port.contract.test.ts` (69 → 70) + the per-event canonical-payload case.
  5. `audit.eventType` label in **en/th/sv** (the label-coverage guard fails the build otherwise).
  6. **Retention: 10 years** — this event is the explanatory trail for an anomalous §86/4 receipt (tax-evidence class, same rationale as the 0039 F4 backfill per Thai RD §87/3); implemented as a small per-event override in the F8 emitter (default stays 5y).
- **F-4:** no schema change (steps are code constants; reminder rows reuse the existing table/index). The candidate-selection second arm and the batched due-date threading are **new query shapes** in the candidate repo (query-only, no DDL). The escalation-task use may add one `task_type`/`trigger_reason` literal (zod/domain const — no DDL).
- **S3:** query + i18n only; no migration.
- **Process:** renumber any migration against `main` at plan time (parallel-branch collision gotcha); apply migration + run the touched integration suites **before** committing schema (F4 R8 gotcha).

---

## 7. Architecture & boundaries (Principle III)

- **Invoicing → renewals membership access** flows through a new **invoicing-owned** port + bridge — the 4th copy of the consumer-owns-port pattern (F3 members / F6 events / F7 broadcasts). The bridge composes renewals' **public** `deriveMembershipAccess` (barrel-exported) with the **documented leaf-factory escape hatch** (`makeDrizzleRenewalCycleRepo` deep-import + `findLatestCycleForMember`, exactly as the three existing ~68-line bridge precedents do, each carrying the justification header). The plan's Constitution Check pre-declares this deviation; no payments-module port is needed (the online rail is gated at the portal chokepoint).
- **F-4** lives inside renewals (candidate repo + dispatch use-case + lapse use-case + copy + gateway branch); the invoice due_date read stays behind the `invoice-due-bridge` port shape (no Drizzle leak into Application).
- **F-5** audit event emitted in the existing F4 payment tx via the already-threaded F8 emitter (Principle VIII — write + audit atomic); escalation task via the renewals repo in the same tx.

---

## 8. Out of scope / explicitly deferred

| Item | Disposition | Why |
|---|---|---|
| Full admin-reactivation queue (accept-and-reconcile) | Deferred — own out-of-branch feature | New cycle modelling: new classifier outcome + cycle born `pending_admin_reactivation` (createCycleInTx can't) + successor-cycle-on-reactivate + likely CHECK-constraint migration. Refund half already built (`admin-reject-reactivation`). Gate is its foundation. |
| Auto-void of the old bill on reactivate | Deferred (runbook step this round) | Belongs with F-8 void-on-reissue (F4 branch); §4.4(4) documents the manual void step meanwhile. |
| F-8 void-on-reissue | Separate F4 branch | HARD-dep before any auto-invoice ship; not this round. |
| F-6 undelete→upcoming discriminator | Needs design (pre-archive status column + migration) | No safe DB discriminator today. |
| F-1 keyset pagination in the lapse cron | Deferred | Starvation only under a sustained >1000 awaiting backlog — immaterial at ~110. |
| Hiding the portal invoice pay-sheet for terminated members | Deferred (accepted click-then-403 + notice) | Presentation nicety; the server chokepoint blocks the charge and §4.4(3) gives the honest message. |
| Auto-invoice generation | Deferred (next phase) | `billing_cycle` (§5.1) is its foundation. |

---

## 9. Adversarial verification record (2026-07-16)

**Round A — Gate vs Full decision panel** (chamber-os-architect + business-pm steelman + thai-tax lens; tax lens re-verified from source after a tooling failure): architecture found Gate ≈ near-zero new modelling vs Full = out-of-branch feature (`gate_is_deadend: false`); steelman returned `does_it_overturn_gate: false` while contributing the out-of-band-cash limitation and the "audit-net must be admin-visible" hardening; source verification confirmed the §86/4 mint happens at payment (so only prevention avoids it). User decision: rare + relationship-driven → **Gate**.

**Round B — formal 4-lens spec review** (chamber-os-architect, reliability-guardian, chamber-os-qa-engineer, thai-tax-compliance-auditor — all four returned NEEDS_WORK on rev 1; every finding adjudicated and folded into this rev 2):
- **C1 (arch):** dispatch candidate ±120d window structurally hides the born-awaiting cohort → warnings never fire → guard re-deadens termination. Fixed: §3.2(1) second candidate arm, no `expires_at` pre-filter, + the >120d test-geometry requirement.
- **C2 (rel):** a linked-invoice post-termination payment exits at `mark-cycle-complete`'s skip, never reaching `terminal_only` — the rev-1 audit net missed the exact race it claimed to catch. Fixed: §4.4(2) instruments both exits.
- **C3 (qa) + C4 (tax), converged:** the F4 record-payment rail was completely ungated — one admin click mints §86/4 to a non-member; rev 1's "prevention" claim was false. Fixed: §4.4(1) gates the admin-manual membership-bill path (never the webhook path).
- **Importants folded:** code-const tier-less step model + gateway branch (the `awaiting.*` naming would have been rejected by `deriveOffsetFromStepId` as a permanent send-failure); batched due-date threading + shared floor + due-day-anchored `year_in_cycle`; track-precedence rule (double-dunning); guard accepts `t+N` warnings + 14-day min-notice + staleness exemption; contractual-notice opt-out bypass + escalation net for the structurally-unwarnable cohort; the initiate-payment 409 guard dropped as dead code behind the 059 chokepoint (replaced by the client-side 403 mapping); visible admin callout instead of unreachable toast copy; old-bill void step (duplicate-§86/4 risk); real `F4InvoicePaidEvent` payload fields (no `paymentRef` exists); full audit-enum lockstep checklist + 10y retention; S3 re-scoped (no i18n gap exists; the work is the audit-payload read + basis labels); factual fixes (backstop-cohort parenthetical, barrel-export wording).

---

## 10. Operator gates (post-merge, human)

1. **F-5 touches the invoicing/payments (money) surface** → Constitution requires **≥2 reviewers, one signing the security checklist** (PII/PCI + the cross-tenant integration test).
2. All `check:*` gates + preview E2E before merge.
3. No prod behaviour change is imminent (zero invoices); the F-4 guard + F-5 gate become load-bearing once real invoices exist — verify the dispatch + lapse cron cadence in prod when invoicing begins, and watch `renewals_lapse_deferred_total{reason='no_prior_warning'}` for a stuck cohort.
4. Runbook: the reactivate-first comeback (**Renew Lapsed Member → record payment on the new invoice → void the old bill**) documented for admins handling out-of-band transfers.
