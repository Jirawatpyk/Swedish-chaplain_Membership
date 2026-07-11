# F5 Online Payment — Bug-fix Design (Refund lifecycle + webhook/route hardening)

**Date:** 2026-07-11
**Author:** Claude (adversarial bug-hunt → design)
**Status:** Approved (design v1) + 5 specialist reviews folded in as **v2 consolidation** (see end section — it SUPERSEDES v1 detail where they conflict), pending implementation plan
**Base branch:** `origin/main` (2be6a0fe) — F5 is shipped to production
**Worktree:** `.claude/worktrees/f5-refund-lifecycle`

## Context

An 8-dimension adversarial bug hunt of the F5 Online Payment module (Stripe card +
PromptPay, refunds, webhooks) surfaced **7 confirmed bugs + 1 contested** on shipped
production code. Tenant-isolation/RLS, RBAC, and gateway/Connect scoping came back
clean. The confirmed bugs cluster around one systemic gap: **F5's refund model assumes
"Stripe refund created == refund succeeded" and only subscribes to `charge.refunded`,
never to the refund-status-bearing `charge.refund.updated`.** As a result it cannot
represent an async refund lifecycle (PromptPay refunds are asynchronous; card refunds
can also settle to `failed`).

Delivery is split into **3 PRs** off `origin/main` in one worktree:

| PR | Scope | Bugs |
|----|-------|------|
| **PR-A** | Refund lifecycle + state hardening (+ migration) | #1 #2 #3 #8 (HIGH/MED) |
| **PR-B** | Refund pre-flight vs F4 credit-total | #4 (MED) |
| **PR-C** | Webhook route re-projection + status map | #5 #6 #7 (LOW) |

Constitution constraints that apply throughout: TDD (red→green), 100% branch on
security-critical use-cases, apply-migration-then-integration-test before committing
schema changes, add-audit-event-type touches 4 places (domain const + pgEnum migration
+ 2 audit-parity test counts), tenant-scoped repos must thread `tx` from `runInTenant`.

---

## Key schema facts discovered (constrain the design)

1. **`refunds_succeeded_iff_complete` is a biconditional** (migration 0034):
   `(status='succeeded') = (processor_refund_id IS NOT NULL AND credit_note_id IS NOT NULL)`.
   A **`pending` row with `processor_refund_id` set but `credit_note_id` NULL satisfies it**
   (both sides `false`). → We can persist `processor_refund_id` onto a still-`pending`
   refund row **without any CHECK migration**. This is the enabler for fix #2.
   The partial unique index `refunds_processor_refund_id_uniq` is per-refund-id, no conflict.

2. **`payments_status_enum`** (0033) currently allows 6 states; adding `auto_refunded`
   requires an `ALTER … CHECK`.

3. **`payments_card_metadata_iff_card`** (0044) permits card-rows with all-NULL card
   metadata ONLY for `status IN ('pending','failed','canceled')`. `auto_refunded` rows
   (captured-then-refunded; we never retrieved card metadata on the stale path) must be
   added to that all-NULL-allowed set.

4. **Refund status enum is `pending|succeeded|failed`** (no `canceled`). Stripe refund
   status `canceled` maps to our `failed`.

5. `refunds` require a credit note to be `succeeded` (biconditional above). A **stale-invoice
   auto-refund has no credit note** (the invoice was settled another way; issuing a CN
   would double-count). → the stale auto-refund path **does not create a `refunds` row**
   (see PR-A #3).

---

## PR-A — Refund lifecycle (fixes #1, #2, #3, #8)

### Core model: `refund.status` is the source of truth, delivered by `charge.refund.updated`

Stripe emits `charge.refund.updated` (and `refund.updated`) when a Refund object's status
changes (`pending → succeeded | failed | canceled`). F5 will subscribe to
**`charge.refund.updated`** and finalize pending refunds from it.

### A1 — `issueRefund` finalizes only on `succeeded` (fixes #1)

`src/modules/payments/application/use-cases/issue-refund.ts`

```
Phase A (tx):  insert refund row (pending, processor_refund_id=NULL) + audit refund_initiated   [unchanged]
Stripe:        createRefund → { id, status, amountSatang }
Phase A.5 (tx): persist refund.processor_refund_id = id  (status stays pending)
               *** enables webhook match — CHECK-compatible per Key-fact #1 ***
Branch on status:
  'succeeded'              → issue F4 CN + Phase B finalize (refund→succeeded, payment→refunded/partially)   [card happy path, ~unchanged]
  'pending'|'requires_action' → return { kind:'pending', refund:{...status:'pending'} }  (NO CN, NO payment flip)
  'failed'|'canceled'     → finaliseFailedRefund (mark failed + set processor_refund_id + audit refund_failed); return typed err
```

- The `succeeded` path is behaviour-preserving vs today (now with processor_refund_id
  already persisted in A.5, which Phase B re-affirms atomically with the CN).
- `finaliseFailedRefund` gains a `processorRefundId` param so a Stripe-created-then-failed
  refund is forensically complete + matchable. CHECK-compatible (failed side of biconditional).
- New success variant `{ kind: 'pending' }` returned to the route → 202-style response.

### A2 — New webhook `charge.refund.updated` → `processRefundUpdated` (fixes #1 reconcile)

New use-case `src/modules/payments/application/use-cases/process-refund-updated.ts`:

```
input: { refundId (re_...), stripeStatus, chargeId, ... }
lock/find refund by processor_refund_id:
  not found              → out_of_band branch (unless it matches a stale-invoice auto-refund — see #3b)
  row.status != 'pending' → idempotent no-op (already finalized by A1 succeeded path or a prior webhook)
  row.status == 'pending':
    incoming 'succeeded'          → issue F4 CN + flip refund→succeeded + flip payment (partially_refunded|refunded)
    incoming 'failed'|'canceled'  → mark refund failed (no CN)
    incoming 'pending'            → no-op
```

- The CN-issuance + payment-flip logic is **shared with A1's succeeded path** (extract a
  `finalizeSucceededRefund` helper used by both) to avoid drift.
- Idempotent via `expectedCurrentStatus='pending'` on the refund `updateStatus` — if A1's
  succeeded path already finalized, the webhook is a no-op.
- Wired into `process-webhook-event.ts` dispatcher + `F5_HANDLED_EVENT_TYPES` +
  webhook verifier projection (project refund id + refund status from
  `event.data.object` for `charge.refund.updated`).

### A3 — `charge.refunded` cleanup (fixes #2)

`src/modules/payments/application/use-cases/process-charge-refunded.ts`

- **Remove** the `existing && existing.status === 'pending'` flip-to-succeeded branch. It
  is dead code today (pending rows had NULL processor_refund_id), and once A.5 sets the id
  it would wrongly flip an async-pending refund to succeeded at *creation* time (the #1
  bug). Finalization now belongs solely to `charge.refund.updated` (status-bearing).
- **Keep** out-of-band detection, already-finalised idempotent no-op, amount-mismatch.
- Net: with `processor_refund_id` now set on pending rows, `findByProcessorRefundId`
  matches app refunds → they are recognised (not misclassified as out-of-band).
- The parent-payment recovery previously living here moves to `charge.refund.updated`.

### A4 — Stale-invoice auto-refund flips payment (fixes #3)

`src/modules/payments/application/use-cases/confirm-payment.ts`

- After a successful stale-invoice auto-refund (Phase B), **flip the payment row from
  `pending` to the new terminal status `auto_refunded`** (money was captured then fully
  refunded; invoice settled elsewhere; no F4 markPaid, no CN).
- **Do NOT create a `refunds` row** (stale auto-refund has no credit note — refunds
  require a CN to be `succeeded`; see Key-fact #5).
- Record the Stripe `processor_refund_id` in the existing
  `payment_auto_refunded_stale_invoice` / `_concurrent_manual_mark` audit (already done)
  so #3b can recognise it.

#### A4b — suppress the false out-of-band alert for stale auto-refunds

- `process-charge-refunded` + `process-refund-updated` OOB branch: before emitting
  `out_of_band_refund_detected`, check whether the incoming `processor_refund_id` matches
  a recorded stale-invoice auto-refund. Extend the existing repo method
  `findStaleInvoiceAutoRefund(invoiceId)` (drizzle-payments-repo.ts:475) to a
  `findAutoRefundByProcessorRefundId(processorRefundId)` lookup over the auto-refund audit
  rows. Recognised → emit a benign reconciliation audit + skip the OOB metric/alert.

### A5 — Stripe-aware sweep backstop (fixes #3/#1 double-fault residue)

`src/modules/payments/application/use-cases/sweep-stale-pending-refunds.ts`

- Replace blind flip-to-`failed` with: `stripe.refunds.retrieve` (via gateway) then
  finalize by real status — `succeeded` → issue CN + flip payment; `failed`/`canceled` →
  mark failed; still `pending` → skip. Closes the rare double-fault where a refund
  succeeded at Stripe but no `charge.refund.updated` transition event was delivered.
- Adds `processorGateway` + `tenantSettingsRepo` + `invoicingBridge` to the sweep deps
  (composition root wires them). Retrieve is scoped by `stripeAccount` (Connect).

### A-migration (PR-A)

1. `ALTER payments_status_enum` → add `auto_refunded`.
2. `ALTER payments_card_metadata_iff_card` → add `auto_refunded` to the all-NULL-allowed
   status set.
3. New `audit_log` event types (pgEnum + domain const + retention map + 2 audit-parity
   test counts): `refund_reconciled_via_webhook`, `refund_pending_awaiting_processor`,
   and (if needed) `stale_auto_refund_reconciled`. Exact list finalized in the plan.
4. **No `refunds` CHECK migration** (Key-fact #1).

### Domain changes (PR-A)

- `payment.ts`: add `auto_refunded` to `PAYMENT_STATUSES` + `TERMINAL_PAYMENT_STATUSES`;
  it is **NOT** in `one-succeeded-payment-per-invoice`'s `SUCCEEDED_LINEAGE`.
- `payment-status-transitions.ts`: add edge `pending → auto_refunded`; `auto_refunded: []`.
- `refund.ts`: update the `processorRefundId` comment/invariant doc — it may be non-null
  while `pending` (set once Stripe accepts); only `credit_note_id` is `NOT NULL iff succeeded`.
  `assertRefundComplete` already tolerates this (pending checks only `completed_at`).

### #8 — verify-first (in PR-A)

`fail-payment.ts` / `confirm-payment.ts` / `initiate-payment.ts` resume path.

1. Write a failing integration/unit test replaying the **resume-race**: a member clicks
   retry *before* the `payment_intent.payment_failed` webhook flips the row (row still
   `pending`) → `initiatePayment` resumes the same PI (findPending keys only on
   `status='pending'`) → good card → `payment_intent.succeeded` arrives *after*
   `payment_failed` committed `failed`. Confirm `confirmPayment` drops the success as
   `already_succeeded` with no invoice flip, no auto-refund, no forensic audit.
2. If confirmed, fix by the least-invasive correct guard:
   - **Option (i)** `confirmPayment`: when the row is terminal-`failed` but a genuine
     `payment_intent.succeeded` (real charge) arrives, treat it like the stale/illegal
     path — emit a forensic audit + auto-refund the captured funds (money must not be
     silently stranded), OR
   - **Option (ii)** gate the initiate **resume** path so it does not resume a PI whose
     Stripe status is already terminal/`requires_payment_method` after a failed attempt.
   Choose after the test reveals the exact reachable window. Prefer (i) (defence at the
   settlement boundary, mirrors existing stale/illegal-transition ack pattern).

---

## PR-B — Refund pre-flight vs F4 credit-total (fixes #4)

`issue-refund.ts` + `refund-not-exceeding-remainder.ts` / `refundable-amount.ts`

- The FR-011b pre-flight computes `remaining = payment.amount − Σ(F5 succeeded refunds)`
  but ignores F4 manual credit notes (`invoices.credited_total_satang`). A manual F4 CN
  on an F5-paid invoice lets a refund pass F5's guard, move money at Stripe, then get
  rejected by F4 (`credit_exceeds_remainder`) → orphan refund with no CN.
- **Fix:** thread the invoice's `credited_total_satang` (via the F4 bridge
  `getInvoiceForPayment` / a dedicated bridge read) into the pre-flight so
  `remaining = min(payment-based, invoice-credit-based)` and reject **before** the Stripe
  call. Derive the returned `invoice.status` from F4 (authoritative), not from the F5
  refund sum.
- Depends on PR-A's refund shape; rebase PR-B onto PR-A (or land PR-A first).

---

## PR-C — Webhook route re-projection + status map (fixes #5, #6, #7)

Mechanical, low-risk:

- **#5** `webhooks/stripe/route.ts` re-projection: copy `amountProjectionFailed` into the
  rebuilt `dataObject` (currently dropped → H-4 dead on prod). Also carry the dispute
  `projection_failed` sentinel through.
- **#6** same re-projection: copy `disputeId`; and have the verifier project the real
  `charge` id (`raw['charge']`) so `dispute_created` audits record the true `charge_id`
  instead of the dispute id, and `dispute_id` is non-null.
- **#7** `payments/initiate/route.ts`: add `case 'invoice_data_corrupt' → 422` +
  a distinct `F5RouteErrorCode` + EN/TH/SV i18n, matching the documented contract.

---

## Testing strategy

- **PR-A** (security-critical, 100% branch): unit tests for `processRefundUpdated`,
  the A1 status-branch, the state-machine edge, `auto_refunded` completeness; contract
  tests for the new `charge.refund.updated` webhook branch; **integration** tests (live
  Neon) for: pending-refund persists `processor_refund_id` (CHECK-compat), webhook
  finalize succeeded/failed, stale auto-refund → `auto_refunded` + no OOB alert,
  Stripe-aware sweep, and the #8 resume-race replay. Apply migration → run integration
  before committing schema.
- **PR-B**: unit (pre-flight with F4 credited_total) + integration (manual CN then refund
  rejected before Stripe).
- **PR-C**: unit for route re-projection field copy + status map; audit-payload assertions
  for dispute id/charge id.
- Gates before each push: `pnpm lint && pnpm typecheck && vitest subset && check:* && (scoped) test:integration`.

## Rollout / risk

- All three PRs are additive-guard changes on a shipped money-path. `auto_refunded` is a
  new terminal state (no back-fill of existing rows needed — only new stale auto-refunds
  use it). New webhook subscription requires enabling `charge.refund.updated` delivery in
  the Stripe dashboard/endpoint config (ops step, noted at ship).
- HIGH fixes (#1/#2) ship in PR-A first; PR-B and PR-C can follow independently.

## Out of scope (explicit)

- Refactoring unrelated to these bugs.
- F11 multi-tenant Connect changes.
- Backfilling historical stuck rows (runbook/ops task, not code).

---

# v2 — Specialist review consolidation (SUPERSEDES v1 detail where conflicting)

Five project specialists reviewed design v1: **chamber-os-architect, reliability-guardian,
thai-tax-compliance-auditor, drizzle-migration-reviewer, pci-saqa-guardian**. All returned
**APPROVE-WITH-CHANGES** (no hard block). Three independent reviewers (tax, reliability,
architect) converged on the SAME critical fault: the async model turns A1/A2/A5 into three
uncoordinated credit-note issuers. The core direction (`charge.refund.updated` as
source-of-truth, `auto_refunded` terminal state, Key-fact #1 CHECK-compat) is **confirmed
correct** and must not be re-litigated.

## CRITICAL-1 — Credit-note issuance must be idempotent per `refundId` (tax#1 + reliability-B1 + architect-F1)

The async model adds CN issuers at A1 (sync card), A2 (webhook), A5 (sweep). CN is issued
in the F4 bridge tx **before** the F5 refund-row flip, so `expectedCurrentStatus='pending'`
guards only the flip, not the CN. A `charge.refund.updated(succeeded)` arriving during A1's
multi-second F4 CN render → **two credit notes, two §87 sequence numbers, double invoice
crediting**. Partial refunds are NOT caught by F4's remainder-guard (2×50% both fit). The
DB has no backstop: `credit_notes.source_refund_id` is a **non-unique** partial index
(migration 0038).

**Required fix (closes A1/A2/A5 with one DB-enforced guard):**
1. **Migration** (F4 table): partial UNIQUE index
   `credit_notes (tenant_id, source_refund_id) WHERE source_refund_id IS NOT NULL`.
   Sequence alloc + CN insert share one tx → the losing insert rolls the §87 sequence back
   cleanly (no gap); only an orphan PDF/Blob remains (acceptable ops residue).
2. `issueCreditNoteFromRefund` (F4 bridge): under the invoice lock, **read existing CN by
   `sourceRefundId` first → return it (ok) if present**; treat a unique-violation as
   "sibling already credited this refund" → reconcile to no-op.
3. Extract **shared `finalizeSucceededRefund`** helper used by A1 Phase B **and** A2 **and**
   A5; ALL pass `expectedCurrentStatus='pending'` on the refund `updateStatus`
   (fixes `issue-refund.ts:474` which currently omits it).
4. Integration test (live Neon): concurrent A1-succeeded + `charge.refund.updated(succeeded)`
   on a **partial** refund → exactly ONE CN, `credited_total` correct, no §87 gap.

## CRITICAL-2 — Failed auto-refund must not be silently suppressed (reliability-B2)

A4's `auto_refunded` (no `refunds` row) + A4b blanket OOB-suppression **hides a FAILED
auto-refund** (PromptPay auto-refund can go pending→failed): payment reads `auto_refunded`
("refunded") while the customer never got the money, and the only signal (`charge.refund.updated(failed)`)
is suppressed.

**Required fix:**
- A4b branches on incoming refund **status**: suppress the OOB alert only for
  `succeeded`/`pending`; **`failed`/`canceled` → raise a dedicated alert** (audit
  `auto_refund_failed_needs_manual_reconcile` + metric that pages ops).
- **Durable marker = a new column on `payments`** (e.g. `auto_refund_processor_refund_id`)
  written **atomically** with the `auto_refunded` flip — NOT the best-effort null-tx
  audit_log row. The A4b lookup reads this column, not `audit_log`.
- (Supersedes v1 A4b's `findAutoRefundByProcessorRefundId` over audit_log.)

## HIGH

- **H-a (architect-F2 / reliability-H5):** if any audit_log lookup is retained, it MUST match
  **both** `payment_auto_refunded_stale_invoice` AND `payment_auto_refunded_concurrent_manual_mark`.
  (Preferred: the `payments` column above removes this fragility entirely.)
- **H-b (reliability-H1):** `refundsRepo.updateStatus` currently **throws** on an
  `expectedCurrentStatus` zero-match; change it to **return `null`** (mirror
  `drizzle-payments-repo.ts`) so A2's "idempotent no-op" is real (else false 500s + Stripe retry).
- **H-c (reliability-H2 / architect-F3):** add `lockForUpdateByProcessorRefundId(tx, tenantId, reId)`
  (`.for('update')`); `processRefundUpdated` uses it, and must **port SB-1's exact lock
  ordering** (payment `FOR UPDATE` **before** the refunds aggregate read) from
  `process-charge-refunded.ts:295-341`.
- **H-d (reliability-H3):** VERIFY Stripe behaviour — does a **born-`succeeded`** refund emit
  `charge.refund.updated` at all? If not, a sync-card Phase-B double-fault has no webhook to
  reconcile → relies on A5 sweep only. Confirm A5 is a guaranteed backstop; consider a
  shorter sweep cadence for pending refunds. Document the finding in the plan.
- **H-e (reliability-H4):** the `charge.refund.updated` subscription is **load-bearing ops**
  — if not enabled, every async refund hangs. Add metric `refund_pending_awaiting_processor`
  + alert (>0 for > threshold) + an explicit go-live checklist gate.
- **PCI-1 (pci-F1):** thread the new `refundStatus` through **all three** projection layers
  (verifier `project()` refund branch → `VerifiedStripeEvent.dataObject` type → route
  re-projection `route.ts:559-598`) + add `'charge.refund.updated'` to `F5_HANDLED_EVENT_TYPES`.
  The refund branch is an explicit allow-list `{ id, status, charge-id, amount→satang }` only.
- **PCI-2 (pci-F2):** dispute charge-id extraction MUST be defensive `string | object.id | null`
  (mirror `extractLatestChargeId`), never `raw['charge']` verbatim (a Charge object can be
  expanded with card data → 10-y audit PCI leak).
- **PCI-3 (pci-F5):** A5 needs a NEW `retrieveRefund` **port + gateway** method — explicit
  allow-list `{ id, status, charge-id, payment_intent-id, amount→satang }`, `connectOptions`
  Connect-scoped, log allow-list only; add a PCI negative-assert test (no `destination_details`/card).

## MED

- **M-a (migration-F3):** flip `pending → auto_refunded` MUST set `completed_at`
  (`payments_completed_at_iff_not_pending`); prove with a live-Neon integration test
  (unit mocks miss it). A4 flip must be **guarded** (`expectedCurrentStatus='pending'`) and
  **atomic** with `markProcessed` in one tx (reliability-M1).
- **M-b (migration-F1):** for F5 an audit-event type touches **7 places**, not 4:
  (1) `F5AuditEventType` union, (2) `F5_AUDIT_RETENTION_YEARS` map, (3) `F5AuditPayloadByType`
  interface (2+3 are compile-forced), (4) migration `ALTER TYPE audit_event_type ADD VALUE`
  (idempotent DO-block), (5) `auditEventTypeEnum` pgEnum tuple in `auth/.../schema.ts`,
  (6) **i18n labels** `audit.eventType.<value>` in en/th/sv (`audit-event-label-coverage.test`
  fails otherwise), (7) do **NOT** add the migration to `F5_MIGRATIONS` in
  `check-audit-event-count.ts` (breaks the prose-count `check:audit-events`). F5 has **no**
  hardcoded `.length).toBe(N)` count test (that's F2/F8).
- **M-c (migration-F2 / architect-F9):** MINIMIZE new enum values — A2's succeeded-finalize
  should emit the existing `refund_succeeded` with a new discriminated `path` arm (there is
  already a `webhook_recovery` arm) rather than a brand-new `refund_reconciled_via_webhook`.
  Any genuinely-new reconcile audit must (a) use a covered prefix (`refund_…`, never
  `stale_auto_refund_…` which escapes the parity-test prefix filter) and (b) inherit
  **10-year** retention like `refund_succeeded` (RD §87/3), not the 5-y default.
- **M-d (migration-F4/F5):** ship **two** migration files — `0240_payments_auto_refunded_status`
  (DROP+ADD `payments_status_enum` + `payments_card_metadata_iff_card`, `DROP … IF EXISTS`)
  and `0241_*` audit-enum ADD VALUE (idempotent DO-block). Reserve 0240/0241; **re-check
  `git ls-tree origin/main drizzle/migrations | tail` for collision immediately before commit**
  (parallel branches in flight). Plus the CRITICAL-1 `credit_notes` unique-index migration.
- **M-e (tax#2):** cross-fiscal-year CN numbering — CN number uses the invoice's FY but
  `issueDate = settle date`; async widens the window (refund 31 Dec → settle 2 Jan; SweCham =
  calendar FY). Add a boundary integration test + **document** the chosen behaviour.
- **M-f (architect-F5):** PR-A and PR-C are **NOT independent** — both edit the verifier +
  route re-projection. Land the PR-C re-projection fix (#5/#6) **first**, then PR-A builds on
  the corrected single projection; add a `check:*`-style assertion that the route re-projection
  is a **superset of the verifier envelope keys** (kills the drop-field bug class permanently).
  → **Revised PR order: PR-C (route/verifier) → PR-A (lifecycle, incl. refund branch) → PR-B (pre-flight).**
- **M-g (architect-F4 / F-4):** mandatory **cross-tenant integration test** for
  `processRefundUpdated` (Principle I Review-Gate blocker); every new read stays inside
  `runInTenant` threading `tx` (no pool-global `db`).
- **M-h (architect-F6):** inventory every `PaymentStatus` consumer before adding `auto_refunded`
  — **F9 insights revenue/refund aggregation must classify `auto_refunded` as NON-revenue**
  (captured then returned, invoice never paid; mirrors the F9 credit-note revenue lesson),
  plus status badges + EN/TH/SV i18n labels.
- **M-i (reliability-M3/M4):** A5 sweep — bound Stripe-`retrieveRefund` latency vs Vercel
  timeout (cap rows / shorter per-call timeout); a refund Stripe reports still-`pending` past
  N days → escalation alert (not silent skip forever).

## LOW

- **L-a (architect-F7):** A.5 should use a narrow `attachProcessorRefundId(tx, {...})` repo
  method (touches only `processor_refund_id`, keeps `pending`), not the general `updateStatus`.
- **L-b (pci-F7):** bound the route raw-fallback `asSatang(BigInt(amountVal))` in try/catch
  (prod-unreachable; cosmetic).

## #8 (resume-race) — confirmed approach

Option **(i)** (reconcile at the settlement boundary) is endorsed by architect + reliability;
Option (ii) (gate resume) would block a **legitimate** retry (a failed PI sits at
`requires_payment_method`, the correct retry state). Implement (i): on a genuine
`failed → succeeded` late event (a real captured charge on a row already `failed`), emit a
forensic audit + auto-refund the captured funds; leave the row `failed` (do NOT add a
`failed → auto_refunded` edge). Trigger ONLY on `failed → succeeded`, never on the
`succeeded → succeeded` retry no-op. Verify-first with a failed-before-succeeded replay test.

## Endorsed — do NOT re-open

- Key-fact #1 biconditional (all 5 confirm): persist `processor_refund_id` on a `pending`
  refund with `credit_note_id` NULL → **no refunds CHECK migration**; A.5 must touch ONLY
  `processor_refund_id` (keep `completed_at` + `failure_reason_code` NULL).
- `auto_refunded` as a distinct terminal state OUTSIDE `SUCCEEDED_LINEAGE` (reusing `refunded`
  is wrong). Outside `payments_one_active_per_invoice`; inside `pi_uniq` (UPDATE, no dup).
- A3's "dead code today" claim is true; but A3 must **retain** the amount-mismatch sanity
  check and **port** SB-1 parent-payment recovery to `processRefundUpdated` (do not delete).
- Stale-invoice auto-refund issues **no** credit note = tax-correct (no §86/4 receipt was
  ever issued on the stale path, so §86/10 would be forbidden).
- **PR-B is MANDATORY** (tax#5): report `invoice.status` from F4's `credited_total_satang`
  (authoritative), and pre-flight `remaining = min(payment-based, invoice-credit-based)`.
