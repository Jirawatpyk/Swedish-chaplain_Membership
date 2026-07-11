# F5 Online Payment — Bug-fix Design (Refund lifecycle + webhook/route hardening)

**Date:** 2026-07-11
**Author:** Claude (adversarial bug-hunt → design)
**Status:** Approved (design), pending implementation plan
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
