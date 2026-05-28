# F5 Post-Ship Architectural Tasks

These items came out of `/speckit.review` (2026-04-27) and are
**deliberately deferred** to after the F5 ship gate. Each entry
documents the deviation, why immediate fix-it scope was inappropriate,
and the trigger condition for re-opening the work.

The fix-it batches that landed for review are tracked in commits
`f9cf1b1` (CRITICAL + HIGH) and `5b5d839` + `<batch D>` (MEDIUM + LOW).

---

## P-01 — Application-layer observability cross-cut → port refactor

**Origin**: CR-1 (code-reviewer agent, ~95% confidence)

**Current state**: Application use-cases (`src/modules/payments/application/use-cases/*.ts`)
import `@/lib/metrics`, `@/lib/otel-tracer`, and `@/lib/fiscal-year`
directly. This is a literal Clean Architecture (Constitution Principle
III) violation — Application is supposed to depend on its own port
interfaces only.

**Why deferred**:

- F1 (Auth & RBAC) shipped with the **identical** pattern at the same
  Constitution authority gate without an explicit Complexity Tracking
  entry. The pattern is *de facto* accepted as an industry-standard
  cross-cutting-concern exception (logger / metrics / tracer fan-out
  through every use-case).
- A proper port refactor (`MetricsPort` + `TracerPort` injected via DI,
  6 use-cases × 3 modules touched, fixture mock objects updated in
  every unit test) is a ~600 LOC change with non-trivial regression
  risk pre-ship.
- `plan.md` is off-limits per the `/speckit.fixit.run` workflow —
  adding a Complexity Tracking entry retroactively would violate the
  fixit constraints even though that is the formal Constitution-
  compliant path.

**Re-open trigger**: when F2 / F3 / F4 / F5 are ALL post-ship and a
maintainer is rationalising the platform-wide observability strategy
(e.g. introducing a third-party APM, moving away from
`@vercel/otel`, or formalising the Constitution Principle III
exception in v1.5.0). At that point the port refactor unblocks
swapping observability backends without touching use-case bodies.

**Estimated effort**: 8–12 hours.

---

## P-02 — `cancelPayment` two-phase split for Stripe lock contention

**Origin**: H-2 (errors-agent, 80% confidence)

**Current state**: `cancelPayment` calls `stripeGateway.cancelPaymentIntent`
INSIDE the `paymentsRepo.withTx` callback while holding a `FOR UPDATE`
row lock on the `payments` row. The Stripe SDK call has a 10 s timeout;
during that window any concurrent webhook (`payment_intent.succeeded`,
`payment_intent.payment_failed`) targeting the same payment row blocks
on the lock, serialising webhook processing behind a member-cancel
UI action.

The H-2 fix-it batch closed the **observability gap** (forensic audit
emit on Stripe-call failure) but kept the synchronous structure.

**Why deferred**:

- The `issueRefund`-style two-phase split (lock → release → Stripe
  call → re-lock → write) requires either an intermediate state
  (`canceling`) in the payment-status enum + migration, or a
  re-design of the lock semantics that fits within the existing
  `pending → canceled` transition.
- Pre-ship, both options carry meaningful regression risk against the
  state-machine invariants pinned by `payment-state-machine.test.ts`
  (24 tests).
- The lock-contention impact is bounded: a member-initiated cancel is
  rare (member typically just closes the sheet) and Stripe webhook
  processing has its own retry budget (24 h) so a 10 s contention
  window is recoverable.

**Re-open trigger**: when production telemetry shows `payments.cancel`
span p95 > 8 s OR webhook delivery delay alerts fire on the
`payment_intent.*` path with cancel-lock as the documented cause.

**Estimated effort**: 6–10 hours (state machine + migration + tests).

---

## P-03 — Pay-sheet component split (817 LOC → ≤200 LOC orchestrator)

**Origin**: H-15 / M-10 (simplify agent)

**Current state**: `src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/pay-sheet-internal.tsx`
is 817 lines and intermingles two state machines (card flow + PromptPay
flow), 3DS poll, two refresh handlers, two retry counters, settled-once
guard, ref tracking, derived announcement, and both panel-switch IIFEs.

**Why deferred**:

- The dispatcher / OTel-span helper subsets of this work landed in
  Tier 1 of the post-review remediation (`emitTerminalStateAck`
  helper, etc.). The pay-sheet component split is the largest
  remaining simplify opportunity.
- The proper split (`useCardFlow()` + `usePromptPayFlow()` hooks +
  inline `<CardPanelView>` / `<PromptPayPanelView>` subcomponents)
  is a 400+ LOC delta in a security-sensitive file (PCI SAQ-A
  iframe boundary) and the existing E2E coverage is shape-coupled
  to the current DOM structure. Pre-ship the regression risk against
  9 viewports × 3 locales × 2 methods is too high.

**Re-open trigger**: when the next payment-method tab is added (e.g.
Apple Pay / Google Pay / direct-debit) — the third tab is the moment
the inline-IIFE panel switch becomes painful, and the refactor pays
for itself.

**Estimated effort**: 12–16 hours (refactor + refresh E2E baselines).

---

## P-04 — `F5AuditEvent.payload` per-event-type narrowing

**Origin**: L-2 (types-agent, 80% confidence)

**Current state**: `audit-port.ts` defines `payload: Record<string,
unknown>` for all 20 F5 event types. A typo in a payload key
(`processor_payment_intent_id` vs `payment_intent_id`) is silently
accepted; only ad-hoc unit-test assertions catch it.

**Why deferred**:

- Proper typing requires a `F5AuditPayloadMap` keyed by literal
  `F5AuditEventType` and a generic `emit<E>(...)` signature on
  `AuditPort`. Every emit call site (~50) gets type-narrowed
  automatically but the AuditPort interface change is invasive.
- F4 + F1 use the same `Record<string, unknown>` shape — refactoring
  F5 alone would create asymmetry; refactoring all three is
  platform-wide work.

**Re-open trigger**: when a real audit-log query bug surfaces in
production (admin can't filter on a typo'd payload key) OR when a
new feature adds 5+ audit event types and the typo risk is acute.

**Estimated effort**: 6–10 hours platform-wide.

---

## Items NOT promoted to post-ship (false positives / out-of-scope)

| Origin | Reason not promoted |
|--------|---------------------|
| H-6 (PromptPay E2E webhook step) | False positive — no `test.fixme()` exists, only narrative docstring. The test runs via stubbed `retrievePaymentIntent`. |
| H-7 (3 pre-declared audit events) | Out-of-MVP per `audit-port.ts` docstring — these types are intentionally forward-declared for post-MVP features (settings UI, manual-mark race recovery) so the enum + DB migration stay aligned. No emit site = no test gap. |
| H-8 (stale-invoice E2E) | Real harness gap (admin-void wired + Stripe webhook trigger harness + member refund-notification surface) — needs F-stack rather than refactor. Equivalent integration coverage exists. |
| L-7 (admin audit-timeline UI fixme) | UI not implemented; integration-level coverage exists. Same harness category as H-8. |
| H-11 (audit event type for terminal-state ack) | **APPLIED** in post-review batch — migration 0052 + `payment_acknowledged_terminal_state` event + `emitTerminalStateAck` helper landed. |
| L-5 (audit-retention vacuous case) | **APPLIED** — replaced with trigger-existence assertion (the DB-layer append-only invariant is what makes the vacuous case acceptable). |
