# Feature Specification: F5 — Online Payment (Stripe + PromptPay)

**Feature Branch**: `009-online-payment`
**Created**: 2026-04-23
**Status**: Draft
**Input**: User description: "Online Payment (Stripe + PromptPay)"

## Context

F5 is the Phase 2 opener: once admins finish the Phase 1 Excel replacement (F1–F4),
F5 removes manual payment reconciliation from their daily workflow by letting members
pay their issued membership invoices online with a Thai-preferred rail (PromptPay QR)
and a globally-preferred rail (credit/debit card). Payment confirmation flows back
into the F4 invoice state machine automatically — an online-paid invoice transitions
to `paid` and F4 auto-emails the tax-compliant receipt PDF without admin involvement.

Tenant-scoped per SaaS architecture (`docs/saas-architecture.md`). Phase 2 is still
single-tenant (SweCham / TSCC) and uses SweCham's own payment-processor account; the
data model is multi-tenant-aware (`tenant_id`-scoped settings + payments) so F11 (SaaS
Billing) can introduce per-tenant Stripe Connect onboarding later without a schema
migration. Sensitivity: **🔒 PCI** (Constitution Principle IV — NON-NEGOTIABLE) **plus
⚠ Finance** — full audit trail required. Review gate requires **≥2 reviewers** and a
**signed security checklist** (or the Constitution § IX.5-stack solo-maintainer
substitute when no second human reviewer is available).

**Why built on Stripe** (decision pre-locked in Constitution § Compliance: Payment
and `docs/phases-plan.md` Decision R2): native THB + PromptPay support, hosted
Elements preserve SAQ-A scope (cardholder data never touches our servers), strongest
Thai + global coverage among PCI-DSS-certified processors, and the same processor
will serve F11 (SaaS Billing) so the operational surface stays single.

**Why PromptPay alongside cards**: Thai corporate members overwhelmingly pay via bank
transfer; PromptPay QR is the national real-time bank rail with near-zero processor
fees and is culturally the default for B2B payments. Card-only would push most Thai
members back to offline bank-transfer-plus-manual-admin-reconciliation, defeating the
Phase 2 self-service goal.

**Scope boundary — F5 vs. F8 vs. F11**:

- **F5 (this spec)** — the *payment surface* that lets a signed-in member pay an
  existing F4 **issued** invoice online. F5 does NOT generate invoices (that's F4),
  does NOT schedule renewal reminders (that's F8), and does NOT handle the SaaS
  platform charging tenants (that's F11).
- **F8 (Renewal Tracking)** — orchestrates when renewal invoices are created and when
  reminder emails (containing deep-links into the F5 portal payment surface) are sent.
  F8 depends on F5 but does not build UI inside F5.
- **F11 (SaaS Billing)** — charges tenants for the Chamber-OS subscription itself
  (Layer A). F5 charges members on behalf of the tenant (Layer B). The two layers
  are disjoint Stripe accounts and disjoint database tables.

## Clarifications

### Session 2026-04-23

- Q1 **(scope — MVP slice sizing)**: Do we ship card + PromptPay together as one P1 MVP slice, or sequence them (card first, PromptPay as a P2 follow-on)? → **A: Ship both together as P1 MVP.** Thai members are the majority and PromptPay is their default rail; ~80% of the infrastructure (webhook + reconciliation + refund path + `tenant_payment_settings` + audit events + i18n catalogue + PCI surface) is shared between the two methods, so sequencing saves little and delays the full Phase-2 promise (admin-free reconciliation). Both US1 and US2 are P1.
- Q2 **(security/audit — refund model)**: Who can initiate a refund for an online-paid invoice, and how does the system keep its state in sync with the processor? → **A: In-app admin only — out-of-band refunds (admin opens the processor dashboard and clicks "Refund") are REJECTED by the reconciliation webhook with a named audit event and an alert.** Rationale: Constitution Principle VIII (audit append-only) and Principle IV (PCI) prefer a single-path, atomic refund flow (refund + F4 credit note + status transition + email + audit all in one transaction). SweCham's small admin team can be trained away from using the processor dashboard for refunds; a post-MVP "Mark as refunded externally" escape hatch MAY be added if real-world incidents demand it (tracked as a follow-up ticket, not in F5 MVP).
- Q3 **(UX — pay-link for members without portal accounts)**: Should F5 support an admin-generated one-time pay-link that an unauthenticated accounting clerk can use, or is the MVP strictly signed-in portal payment? → **A: Hybrid — F5 MVP ships signed-in portal payment only; `tenant_payment_settings.allow_anonymous_paylink` flag exists in the schema (default OFF) as a placeholder for a post-MVP F5.1 release that will add signed-token pay-link infrastructure.** Rationale: pay-link is a mini-auth system (token signing, expiry, replay protection, revoke-on-void, GDPR token-hash retention, rate-limit) that needs its own threat model — we defer that security cost until we have evidence it is actually needed. Leading indicator: SC-001 (≥70% online-payment adoption in 90 days); if adoption underperforms + retrospective attributes the shortfall to portal-only friction, F5.1 is promoted out of the backlog.
- Q4 **(UX — payment-surface placement)**: Where does the payment UI live — embedded inline on the invoice detail page, on a dedicated `/pay` route, via Stripe Checkout redirect, or a hybrid? → **A: Embedded inline (Option A)** — Pay-now opens a shadcn `Sheet` drawer on `/portal/invoices/[id]` containing Stripe Elements + PromptPay QR tabs; success dismisses the drawer and re-renders the invoice detail page in `paid` state with a success toast (no new route, no redirect, no dedicated confirmation page). On mobile breakpoints the Sheet upgrades to a full-screen variant for touch-target comfort. F8 reminder-email deep-links point to `/portal/invoices/[id]?pay=1` — a query param auto-opens the drawer on mount. Rationale: preserves portal context (no Stripe-branded bounce), reuses existing `DetailContainer` 72rem + F4 invoice layout, keeps browser-back natural (close drawer = back to invoice), avoids the routing/loading/breadcrumb overhead of a dedicated `/pay` route, and aligns with Stripe Elements' designed embedded usage pattern.
- Q5 **(integration — Stripe API version pinning)**: Should the Stripe API version be pinned, or rely on the account default? → **A: Pin a specific Stripe API version (Option A)** — both the server-side Stripe SDK initialisation AND the webhook handler MUST pin a single API version (locked in `/speckit.plan` to the latest stable as of plan date), exposed via `STRIPE_API_VERSION` env var so version bumps are explicit PRs with regenerated golden fixtures + contract-test re-run. Rationale: webhook payload schemas evolve between Stripe versions and silent drift via account-default upgrade is the most common cause of "webhook works in test, breaks in prod" outages; pinning makes contract tests deterministic and reusable, makes upgrades a conscious quarterly review, and surfaces Stripe-side breaking changes as test failures rather than production incidents. Quarterly review cadence: tracked as a recurring engineering chore in the team retrospective.
- Q6 **(data model — refund amount granularity)**: Is refund amount free-form THB, line-item-based, preset percentages, or full-only in MVP? And are multiple partial refunds per payment supported? → **A: Free-form THB amount + multiple partial refunds per payment (Option A)** — admin enters any amount in range `(0, remaining]` where `remaining = payment.amount_thb − Σ(prior succeeded refunds)`; each refund creates exactly one F4 credit note (single line, amount = refund amount, description = refund reason); multiple partial refunds are supported and accumulate. Invoice F4 status transitions per F4 FR-021 rules: `paid → partially_credited` on first partial where cumulative < payment.amount, then `partially_credited → credited` when cumulative reaches payment.amount; Payment.status mirrors as `paid → partially_refunded → refunded`. Rationale: mirrors F4's existing one-amount-per-credit-note pattern, matches real-world refund scenarios (fractional corrections like "refund THB 3,500 of 53,500"), and avoids the UX complexity of line-item mapping while keeping single-attempt semantics at the data layer.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Member pays an issued invoice online with a credit or debit card (Priority: P1)

A signed-in member opens the portal, sees their company's open (unpaid, issued)
invoice, clicks "Pay now", enters card details on a processor-hosted card form
embedded in the portal, and completes payment. On success, the invoice transitions
to `paid` via the F4 `markPaid` path, the receipt PDF is auto-emailed per F4 FR-024,
the member sees a confirmation screen with receipt download, and the payment is
recorded with correlation to the processor charge identifier.

**Why this priority**: Card payment is the lowest-friction, highest-coverage rail
globally and the only realistic option for members on foreign cards (Swedish,
European, US). Without card support, any non-Thai member is blocked from online
payment and has to fall back to offline bank transfer + admin manual reconciliation.

**Independent Test**: Seed one member with one issued invoice for THB 53,500. Sign
in as that member, open `/portal/invoices/[id]`, click "Pay now", complete a test
card payment (processor test card), observe confirmation screen, verify invoice
status is `paid` with `payment_method = 'card'`, verify the receipt PDF lands in
the test mailbox within 1 minute, verify the audit log contains the full payment
lifecycle (`payment_initiated`, `payment_succeeded`, `invoice_paid`).

**Acceptance Scenarios**:

1. **Given** a signed-in member with an issued invoice for THB 53,500, **When** the member clicks "Pay now" and enters a valid test card, **Then** the invoice transitions to `paid`, the payment record stores the processor charge id + last-4 + brand + expiry (but never the PAN), an F4 receipt PDF is generated and emailed to the member's primary billing contact within 1 minute, and the audit log records `payment_initiated`, `payment_succeeded`, and `invoice_paid` in that order.
2. **Given** a member whose card requires 3D Secure / SCA, **When** the member initiates payment, **Then** the bank's challenge flow renders inside the payment surface, and on successful challenge the payment completes as above.
3. **Given** a card decline (insufficient funds, expired card, bank rejection), **When** the member submits the form, **Then** no `paid` transition occurs, a clear bilingual error message ("Card declined — please try another card or contact your bank" / "บัตรถูกปฏิเสธ") is shown, the invoice remains `issued`, the failure reason is recorded on a `payment_attempt` row, and `payment_failed` is written to the audit log with the declining bank's reason code (never the PAN).
4. **Given** a member who closes the browser tab mid-payment, **When** the member returns to the invoice, **Then** they see the same payment surface with no duplicate charge (the in-flight payment-intent is re-used, and any completed payment is reflected as `paid`).
5. **Given** a member trying to pay a voided or already-paid or credited invoice (e.g., an admin voided it between the member opening the page and submitting), **When** the member submits payment, **Then** the processor charge is either refused pre-flight by the system or the completed charge is **auto-refunded in full** (via processor refund API) and an audit event `payment_auto_refunded_stale_invoice` is written with an admin alert.

---

### User Story 2 — Member pays an issued invoice via PromptPay QR (Priority: P1)

A signed-in member opens the portal, sees their open invoice, chooses "Pay with
PromptPay", the portal displays a QR code (issued by the processor) that the member
scans with their Thai bank app, the member approves the transfer in the bank app,
and within seconds the portal updates to the confirmation screen. Same downstream
flow as US1 (F4 `markPaid`, receipt auto-emailed, audit written).

**Why this priority**: PromptPay is the de-facto Thai B2B payment rail. SweCham
members are overwhelmingly Thai corporates whose accountants default to PromptPay
because (a) no processor fee vs. ~3% for cards, (b) no credit-line impact, (c) no
card-in-hand required. Without PromptPay, Thai members will keep using offline
bank transfer and admins keep doing manual reconciliation.

**Independent Test**: Seed one Thai member with one issued invoice for THB 53,500.
Sign in, open invoice, click "Pay with PromptPay". Verify a valid QR code renders
(payload matches processor test fixture). Simulate the test-mode bank confirmation
event. Verify invoice transitions to `paid` with `payment_method = 'promptpay'`,
receipt emailed, audit lifecycle written.

**Acceptance Scenarios**:

1. **Given** a signed-in Thai member with an issued invoice for THB 53,500, **When** the member chooses "Pay with PromptPay", **Then** a QR image + amount + time-to-expire countdown + "scan with any Thai bank app" instruction are displayed in both TH (primary) and EN.
2. **Given** the QR has been displayed and the member completes the bank transfer within the QR's validity window, **When** the bank-transfer confirmation reaches the system, **Then** the portal updates to the confirmation screen (without the member needing to refresh), the invoice transitions to `paid`, and the payment record stores the processor charge id + the "promptpay" method indicator (no PAN / no card metadata).
3. **Given** the QR expires before the member pays (typical 10–15 minute window), **When** the member comes back later, **Then** a clear bilingual "QR expired — please start again" message is shown, a fresh QR can be generated, and no stale payment records are created.
4. **Given** a PromptPay transfer for the wrong amount (e.g., member's bank app rounds or the member edits the amount), **When** the confirmation reaches the system, **Then** the processor either refuses the charge pre-flight (amount-locked QR is preferred) or the system flags a `payment_amount_mismatch` audit event and does NOT mark the invoice paid; admin is alerted.
5. **Given** duplicate delivery of the same bank-transfer confirmation (processor retries its webhook), **When** the system processes the second delivery, **Then** no duplicate `payment_succeeded` event, no duplicate audit entry, and no duplicate `markPaid` transition occurs — the system is idempotent on the processor event id.

---

### User Story 3 — Admin sees which payments came in online and reconciles them (Priority: P2)

Admin opens the F4 invoice list and filters by "paid online". For each row, the
admin sees the payment method (card / PromptPay), the processor charge id as a
click-through to the processor dashboard, and the payment date. Admin can open an
invoice detail and see the payment lifecycle (initiated → succeeded) with the
actor (member X) and timestamps, enabling month-end reconciliation between the
Chamber-OS ledger and the processor dashboard.

**Why this priority**: Online payment without an audit-complete reconciliation view
is a compliance gap — the treasurer must be able to tie every online payment back
to a processor record during audit, and a monthly variance check between the two
systems is the standard control. Without this view, admins have to cross-reference
two systems manually, which partially negates the F5 efficiency gain.

**Independent Test**: After US1 + US2 produce some paid-online invoices, sign in as
admin, open `/admin/invoices`, filter by "paid online", verify the filter returns
exactly those invoices, click a row, verify the payment lifecycle is visible with
processor charge id + click-through URL to the live processor dashboard.

**Acceptance Scenarios**:

1. **Given** a month with 12 paid-online invoices (8 card + 4 PromptPay) and 6 manually-reconciled (offline bank transfer) invoices, **When** admin opens `/admin/invoices` and filters by "paid online", **Then** exactly 12 rows are returned with a method badge (card / PromptPay) and a processor charge id visible.
2. **Given** a paid-online invoice, **When** admin opens the detail, **Then** a "Payment timeline" panel shows `payment_initiated @ 10:00:03` → `payment_succeeded @ 10:00:41` → `invoice_paid @ 10:00:41` with actor = member email and a copy-to-clipboard action for the processor charge id.
3. **Given** a `manager` role (read-only on finance), **When** they view the same panel, **Then** they see the full timeline but no mutating actions (refund, resend receipt).

---

### User Story 4 — Admin issues a refund on an online-paid invoice (Priority: P2)

For a card-paid or PromptPay-paid invoice, admin clicks "Issue refund", chooses
full or partial amount (if partial is supported — see F4 credit-note rules),
provides a required reason, and the system (a) triggers the refund via the
processor, (b) creates an F4 credit note linked to the original invoice on success,
(c) emails the member a refund confirmation + credit-note PDF, (d) updates the
invoice's F4 status to `credited` or `partially credited` per F4 FR-021, (e) writes
the full audit lifecycle.

**Why this priority**: Refunds happen (duplicate payments, tier downgrades,
membership cancellations, disputed charges). Without an in-app refund surface,
admins must refund via the processor dashboard AND then manually create an F4
credit note — two separate systems to keep in sync, which is where reconciliation
bugs live.

**Independent Test**: After US1 produces a paid-online invoice for THB 53,500,
sign in as admin, open the invoice, click "Issue refund", select "full refund",
enter reason, submit. Verify: processor shows refund, F4 credit note is created
and linked, invoice transitions to `credited`, member receives refund email +
credit-note PDF within 1 minute, audit log shows the full refund lifecycle.

**Acceptance Scenarios**:

1. **Given** a card-paid invoice for THB 53,500, **When** admin issues a full refund with reason "Duplicate payment", **Then** the processor processes the refund (within processor SLA), an F4 credit note for THB 53,500 is created and linked to the invoice, the invoice transitions to `credited`, Payment.status transitions to `refunded`, the member receives a bilingual refund confirmation + credit-note PDF, and the audit log contains `refund_initiated`, `refund_succeeded`, `credit_note_issued`, and `invoice_credited`.
2. **Given** a PromptPay-paid invoice, **When** admin issues a refund, **Then** the processor routes the refund back to the originating Thai bank account per processor rules (member does NOT need to supply bank details in the portal), and the downstream F4 credit-note flow is identical to the card case.
3. **Given** a processor refund failure (insufficient processor balance, bank-rail outage), **When** admin initiates the refund, **Then** no F4 credit note is created (atomicity: credit note only on processor success), admin sees a clear bilingual error, and `refund_failed` is written to the audit log with the processor's failure reason code.
4. **Given** a `manager` role, **When** they open any paid-online invoice, **Then** the "Issue refund" button is not rendered, and a direct-route attempt returns a not-authorised response.
5. **Given** a card-paid invoice for THB 53,500, **When** admin issues a partial refund of THB 3,500 for reason "Contracted tier adjustment", **Then** an F4 credit note for THB 3,500 is created, Payment.status transitions to `partially_refunded`, invoice F4 status transitions to `partially_credited`, and the "Issue refund" action remains available on the invoice with remaining refundable = THB 50,000.
6. **Given** a card-paid invoice with one prior partial refund of THB 3,500 (remaining = THB 50,000), **When** admin attempts a second partial refund of THB 60,000, **Then** the request is rejected server-side pre-flight (no Stripe API call), a bilingual "Refund exceeds remaining refundable amount" error is shown, and no audit event is written.

---

### User Story 5 — Payment failure leaves the invoice untouched and is clearly surfaced (Priority: P3)

When any online payment fails (card declined, PromptPay QR expired, bank-rail
outage, processor webhook delayed, etc.), the invoice MUST remain in its previous
state, the member MUST see a clear bilingual explanation of what happened and what
to do next, the failure MUST be audited without leaking sensitive data, and the
member MUST be able to retry (or choose a different method) without creating a
duplicate ledger entry.

**Why this priority**: Failures are common — cards decline, QRs expire, mobile
networks drop. A robust failure surface is what separates a production-grade
payment flow from a demo. This is P3 because US1/US2 already cover the happy path
plus basic failure cases; US5 extends to the longer tail.

**Independent Test**: Use the processor's test fixtures to trigger each failure
class (decline code `card_declined`, `insufficient_funds`, `expired_card`,
PromptPay timeout, network drop mid-submit, 3D Secure rejection). For each, verify
the invoice state is unchanged, the UI message is bilingual + actionable, the
audit log records the specific failure reason code, and a retry with a valid
method completes the payment normally.

**Acceptance Scenarios**:

1. **Given** a declined card (`card_declined`), **When** the member submits payment, **Then** a bilingual message surfaces the bank's decline reason (translated via processor reason-code catalogue), the invoice stays `issued`, and the member can immediately try a different card without leaving the page.
2. **Given** a PromptPay QR timeout, **When** the expiry clock hits zero, **Then** the QR is replaced with a "QR expired — regenerate" CTA, and generating a fresh QR creates a new processor payment intent (no stale intent hanging).
3. **Given** the processor's webhook is delayed 2 minutes, **When** the member hits refresh, **Then** the portal shows "Payment processing — we'll email your receipt within 5 minutes; you may close this page" (instead of a spinner that eventually times out), and the eventual webhook delivery still completes the `paid` transition + receipt email.
4. **Given** the processor is unreachable (network outage at our end), **When** the member submits payment, **Then** a "Payment service temporarily unavailable — please try again in a few minutes" message appears, NO payment-intent is created (dry run on connectivity check), and no audit entry except a single connectivity-failure log line.

---

### User Story 6 — Auto-emailed payment confirmation + downloadable receipt (Priority: P3)

On successful online payment, the member receives a bilingual (TH primary + EN)
confirmation email that includes (a) a thank-you message with the amount paid,
(b) the F4 Thai-tax-compliant receipt PDF as an attachment, (c) a link back to
the portal invoice detail page. Sender address is the tenant's configured email
identity (F4 FR-033 / F7 identity registration), subject follows a stable tenant
template so accountants can auto-file by rule.

**Why this priority**: This is actually mostly an F4 responsibility — F4 already
auto-emails receipts on `markPaid` (F4 FR-024). US6 is the F5 hook that confirms
the online-payment path calls the same F4 use case (no bypass) and adds only a
light payment-specific annotation ("paid online via card ****4242" / "paid online
via PromptPay") to the email body. P3 because it's mostly defensive: we are
verifying we didn't accidentally bypass F4's email path.

**Independent Test**: Trigger US1 happy path. Verify the email arrives within 1
minute, the subject matches the F4 template format, the body includes the online
method annotation, and the attachment byte-matches the F4-generated receipt PDF
(SHA-256).

**Acceptance Scenarios**:

1. **Given** a card-paid invoice, **When** payment succeeds, **Then** a single email (not two) is sent to the primary billing contact within 1 minute, containing the F4 receipt PDF and a body line "Paid online via card ending ****4242 on 2026-05-12 14:03 ICT".
2. **Given** a PromptPay-paid invoice, **When** payment succeeds, **Then** the same email template is used with the body line "Paid online via PromptPay on 2026-05-12 14:03 ICT" and no card metadata is mentioned.
3. **Given** a tenant with `auto_email_on_issue = false` on the original invoice (admin disabled it), **When** payment succeeds online, **Then** the receipt-on-payment email still sends (F5 payment is a separate signal from F4 issue-time auto-email), unless the tenant has a separate `auto_email_on_payment = false` override (additive — covered by an Assumption below).

---

### Edge Cases

- **Processor webhook replay / out-of-order delivery**: the system MUST be idempotent on the processor's unique event id; a second delivery of the same event is a no-op.
- **Webhook signature mismatch**: any webhook whose signature fails verification MUST be rejected with 401 and logged to the audit (no state transition).
- **Race condition: admin marks the invoice paid manually (F4 `markPaid`) while a member's online payment is in-flight**: first commit wins (F4 `markPaid` is already idempotent via invoice status); the late online payment is auto-refunded in full via processor, and `payment_auto_refunded_concurrent_manual_mark` is audited with admin alert. Same rule as US1 scenario 5.
- **Partial processor outage (card rail up, PromptPay rail down or vice versa)**: the UI MUST hide or disable the broken method with a bilingual "Temporarily unavailable" badge; the tenant's configured fallback rail remains available; health-check status is derived from processor's status API not guessed.
- **Currency mismatch**: an invoice in THB MUST be charged in THB regardless of the card's native currency. The processor handles FX to the card issuer; the Chamber-OS ledger records the THB amount only. Multi-currency invoices (e.g., SEK or EUR priced) are OUT OF SCOPE for F5 (single-currency MVP aligned with F4).
- **Pay a zero-total invoice**: refused at F4 invoice level (zero-total invoices should not exist in a valid tax flow); F5 refuses pre-flight if ever encountered.
- **Pay a draft**: refused — only `issued` invoices are payable. F4's state machine is the source of truth.
- **Concurrent payment attempts on the same invoice (same member, two browser tabs)**: the system MUST collapse to a single processor payment-intent and reuse it; duplicate charges are prevented by processor-level idempotency keys scoped per-invoice.
- **Session expiry during payment**: if the member's session expires mid-flow, the portal MUST re-authenticate them and return them to the invoice. The processor payment-intent is scoped to the invoice, not the session, so no payment-intent is lost.
- **Member is archived / GDPR-deleted between invoice issue and payment**: the tax-document retention policy (F4 FR-029/030) keeps the invoice + receipt legally for 10 years; the payment record inherits the same 10-year retention (shared legal-obligation basis under PDPA/GDPR).
- **Tenant disables F5 mid-session** (admin toggles off online payments globally): the portal MUST gracefully show "Online payment temporarily disabled — contact admin for bank-transfer instructions" on the invoice page; any payment-intent already issued MUST be cancelled by admin-action-triggered processor call.
- **Stripe sandbox vs. live mode leakage**: environment segregation MUST be absolute — test keys MUST NOT be usable in production builds; a test-mode charge reaching a live-mode webhook (or vice versa) is rejected with a named audit event `payment_environment_mismatch`.
- **Sensitive-data leakage in logs**: PAN, CVV, full card track data, and webhook signing secrets MUST NEVER appear in logs. Only processor-issued token id, last-4, brand, and expiry month/year may be persisted. (Constitution Principle IV, NON-NEGOTIABLE.)
- **Reduced-motion / keyboard-only / screen-reader**: the payment surface, QR countdown, and confirmation screen MUST respect `prefers-reduced-motion`, be fully keyboard-navigable, and announce payment-status transitions via ARIA-live regions per `docs/ux-standards.md`.
- **i18n coverage**: all member-facing strings (button labels, status messages, error reasons, email bodies) MUST exist in EN + TH + SV. Processor decline-reason-code catalogue MUST have TH + SV translations for the top 20 codes (enumerated below in the Stripe decline-code catalogue); the long tail falls back to a generic bilingual "Payment could not be completed — please try another method" message.

**Top-20 Stripe decline-reason-code catalogue** (post-critique R2-P3, 2026-04-23 — i18n source-of-truth for SC-006): the following codes MUST have explicit EN+TH+SV translations in `messages/{en,th,sv}/payment-decline-reasons.json`. List ranked roughly by Stripe's documented frequency for online card payments; verified against Stripe docs at https://docs.stripe.com/declines/codes (retrieved 2026-04-23):

| # | Stripe code | Suggested EN message | Notes |
|---|-------------|----------------------|-------|
| 1 | `card_declined` | "Card was declined. Please try another card or contact your bank." | Most common generic decline |
| 2 | `insufficient_funds` | "Insufficient funds. Please use a different card." | Self-explanatory |
| 3 | `expired_card` | "Card has expired. Please use a different card." | |
| 4 | `incorrect_cvc` | "CVC is incorrect. Please re-enter the CVC code." | |
| 5 | `processing_error` | "Payment could not be processed. Please try again in a moment." | Stripe-side transient |
| 6 | `incorrect_number` | "Card number is incorrect. Please re-enter your card details." | |
| 7 | `lost_card` | "This card has been reported lost. Please use a different card." | |
| 8 | `stolen_card` | "This card has been reported stolen. Please use a different card." | |
| 9 | `pickup_card` | "Card cannot be used for this transaction. Please contact your bank." | |
| 10 | `restricted_card` | "Card cannot be used for this transaction. Please use a different card." | |
| 11 | `security_violation` | "Payment was blocked for security reasons. Please contact your bank." | |
| 12 | `service_not_allowed` | "Card does not support this type of transaction. Please use a different card." | |
| 13 | `transaction_not_allowed` | "Card does not allow this transaction. Please contact your bank or use a different card." | |
| 14 | `try_again_later` | "Payment temporarily unavailable. Please try again in a moment." | Stripe-side transient |
| 15 | `withdrawal_count_limit_exceeded` | "Daily card limit reached. Please try a different card or try again tomorrow." | |
| 16 | `currency_not_supported` | "Card does not support THB. Please use a different card." | |
| 17 | `do_not_honor` | "Card was declined by the bank. Please contact your bank." | Generic bank decline |
| 18 | `fraudulent` | "Payment was blocked. Please contact your bank if you believe this is an error." | NEVER expose "fraud" to user |
| 19 | `generic_decline` | "Card was declined. Please try another card or contact your bank." | Same as #1 (alias) |
| 20 | `invalid_account` | "Card account is invalid. Please use a different card." | |

The TH + SV translations live alongside in `messages/th/payment-decline-reasons.json` + `messages/sv/payment-decline-reasons.json` (one key per code id). Any decline code NOT in this list falls back to the generic bilingual "Payment could not be completed — please try another method" message + the raw Stripe code logged for engineering follow-up. SC-006 is verified via a unit test that maps all 20 codes to their translated strings + asserts no `undefined` outcome.
- **Stale `pending` Payment row** (post-critique X1+E3, 2026-04-23): Stripe webhooks abandoned after 3-day retention window can leave a `payments` row in `pending` indefinitely. When a member opens an invoice whose latest payment row is `pending` AND `initiated_at < now() - 24h`, the portal MUST display a banner: bilingual "Payment status is taking longer than expected. If you have already paid, please contact admin; otherwise you may try again." Admin observability via metric `payments.stale_pending_count{tenant}` (gauge); auto-sweep job is OUT OF SCOPE for F5 MVP and deferred to F5.0.1 if metric exceeds 1/month.
- **App-switching during PromptPay flow** (post-critique P6, 2026-04-23): mobile member switches from portal to bank app to scan QR + complete transfer, then returns to portal. The Sheet drawer MUST persist its state across app-switches (component remount handled gracefully); webhook-driven status update polls or websocket continues regardless of foreground/background state. Verified by Playwright `page.bringToFront()` simulation.
- **Manual-bank-transfer-after-QR mistake** (post-critique P7, 2026-04-23): member exits the QR flow and manually transfers to a different PromptPay receiver via their bank app — the system has no visibility (no webhook), invoice remains `issued`. Mitigation: clear bilingual UI text on the QR panel — "Only scan the QR code shown above; do NOT transfer manually to any other account."

## Requirements *(mandatory)*

### Functional Requirements

#### Payment lifecycle

- **FR-001**: System MUST allow any signed-in `member` user to initiate online payment for any `issued` (not draft, not voided, not paid, not credited) invoice belonging to their own company within their current tenant.
- **FR-002**: System MUST offer two payment methods in member-facing UI, gated by tenant configuration: (a) credit/debit card (processor-hosted form), (b) PromptPay QR. If only one method is enabled for the tenant, the method selector collapses to a single-method CTA.
- **FR-003**: System MUST record every payment attempt as a `payment` row linked to one invoice, with fields: processor payment-intent id, method, status (`pending` | `succeeded` | `failed` | `canceled` | `refunded` | `partially_refunded`), amount (THB), currency (locked to THB for F5), initiated_at, completed_at (nullable), failure_reason_code (nullable), refund_reason (nullable), actor user id, correlation id. A single invoice MAY have multiple attempt rows (one per retry) but at most one `succeeded` row at a time.
- **FR-004**: System MUST, on the first successful processor settlement for an invoice, invoke the existing F4 `markPaid` use case with `payment_method ∈ {'stripe_card','stripe_promptpay'}`, `payment_date = processor settlement timestamp`, `payment_reference = processor charge id` — thereby reusing the F4 receipt-generation + auto-email + audit flow end-to-end. F5 MUST NOT implement its own invoice-status transition path.
- **FR-005**: System MUST NEVER store, log, transmit, or persist raw PAN, CVV / CVC, or full card track data — not in databases, logs, error reports, telemetry, screenshots, or memory beyond the duration required for form submission. Only processor-issued token id, last-4, brand, and expiry month/year may be persisted. (Constitution Principle IV, NON-NEGOTIABLE.)
- **FR-006**: Card capture MUST be delegated to the processor's hosted card form (Stripe Elements / Payment Element). Self-hosted card input fields are forbidden. SAQ-A scope MUST be preserved.

#### Webhook + reconciliation

- **FR-007**: System MUST expose an HTTPS webhook endpoint that receives processor payment events, verifies the processor signature on every request, and rejects unsigned or mis-signed requests with 401 before parsing the body. The webhook secret MUST live in environment variables only.
- **FR-008**: System MUST be idempotent on the processor's unique event id — a duplicate delivery of the same event id MUST be a no-op that returns 200 without re-processing. An append-only `processor_event` table records every processed event id with received-at + processed-at timestamps and a payload SHA-256.
- **FR-009**: System MUST handle the minimal event set: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `charge.dispute.created` (alert-only in MVP; full dispute workflow is out of scope). Events outside this set MUST be acknowledged (200) and recorded in `processor_event` but not acted on.
- **FR-010**: System MUST enforce processor environment segregation — a test-mode event MUST NOT be able to alter a live invoice and vice versa. A mismatch is rejected with a named `payment_environment_mismatch` audit event.

#### Refund

- **FR-011**: System MUST allow `admin` role users to issue a refund against any `paid` (or `partially_refunded`) invoice whose payment method is an online method (card or PromptPay) **exclusively via the Chamber-OS admin UI**. In-app refund is the only supported path in F5 MVP (Q2 answer). Refund amount is a **free-form THB value** (Q6 answer) subject to: `0 < refund_amount ≤ (payment.amount_thb − Σ(prior succeeded refunds on same payment))`. Multiple partial refunds per payment are supported and MUST accumulate. A required refund reason is captured and persisted. Each refund creates exactly one F4 credit note (single line, amount = refund amount, description derived from the refund reason) — the line-item structure of the original invoice is NOT reproduced in the credit note (simpler model, aligned with F4 one-amount-per-CN convention).
- **FR-011a**: System MUST detect out-of-band refunds — a `charge.refunded` webhook event for which no corresponding in-app refund row exists — and REJECT the reconciliation: NO F4 credit note is created, NO invoice-status transition occurs, and a named `out_of_band_refund_detected` audit event is written with the processor charge id + processor-refund id + detection timestamp. Admin is alerted via the standard alert channel (observability per FR-021) with a link to the runbook at `docs/runbooks/out-of-band-refund.md` (to be authored during `/speckit.plan`). Admin resolves the divergence manually (void the dashboard refund if still possible, OR contact support — a "Mark as refunded externally" escape-hatch UI is explicitly out of scope for F5 MVP).
- **FR-011b** *(Q6 answer — amount validation + status transitions)*: On successful refund settlement, system MUST: (a) increment an internal `refunded_amount_sum` projection on the Payment row (or equivalent derived query) equal to Σ(refunds where status = 'succeeded'); (b) transition `Payment.status` from `succeeded → partially_refunded` when `refunded_amount_sum < amount_thb`, or from `succeeded|partially_refunded → refunded` when `refunded_amount_sum = amount_thb`; (c) drive the invoice F4 status transition via F4 FR-021 credit-note rollup — `paid → partially_credited` on first partial, `partially_credited → credited` when cumulative credit-note total reaches invoice total. A refund that would cause `refunded_amount_sum > amount_thb` MUST be rejected pre-flight (server-side validation) with a bilingual "Refund exceeds remaining refundable amount" error; NO Stripe API call is issued. Concurrent refund attempts on the same Payment row MUST be serialised (row-level lock or equivalent) so the sum check is race-free.
- **FR-012**: A successful refund MUST atomically create an F4 credit note linked to the original invoice with amount = refunded amount, transition the invoice's F4 status per F4 FR-021 rules (`credited` or `partially_credited`), email the member a bilingual refund confirmation + credit-note PDF, and write the full refund-lifecycle audit trail.
- **FR-013**: A failed refund MUST NOT create an F4 credit note (atomicity), surface a clear bilingual error to the admin, and log `refund_failed` with the processor's failure reason code.
- **FR-014**: `manager` role MUST NOT be able to initiate refunds; the action is absent in the UI and rejected server-side.

#### Tenant payment settings

- **FR-015**: System MUST expose a per-tenant `tenant_payment_settings` surface holding: processor environment (`test` | `live`), processor publishable key, processor account id, enabled methods (`card`, `promptpay`) as an array, global `online_payment_enabled` kill switch, optional `auto_email_on_payment` override (defaults to true; independent from F4's `auto_email_on_issue`), optional custom PromptPay QR expiry override (default 15 min). Secret processor keys MUST live in environment variables, NEVER in `tenant_payment_settings` rows. The processor account id and environment MAY be stored in-row so the F11 SaaS-Billing migration can swap SweCham's hard-coded env-var account for per-tenant Connect accounts without a schema change.
- **FR-016**: System MUST refuse to render the member payment UI for any tenant where `online_payment_enabled = false` OR `tenant_payment_settings` row is missing OR required fields (processor publishable key, account id, at least one enabled method) are incomplete. The member-facing UI MUST show a bilingual fallback "Online payment not available — please contact admin for bank-transfer instructions".
- **FR-016a**: `tenant_payment_settings` MUST include a forward-compatible `allow_anonymous_paylink` boolean column defaulting to **false** (Q3 answer — hybrid placeholder). F5 MVP does NOT render the pay-link UI, does NOT issue signed tokens, and does NOT expose an unauthenticated payment route — the column exists solely so F5.1 (post-MVP) can ship its pay-link infrastructure without a schema migration. Any attempt to toggle the flag to `true` in F5 MVP MUST be accepted at the data layer but have no user-facing effect (documented in admin UI with a "Coming in F5.1" badge). The leading indicator for promoting F5.1 out of the backlog is SC-001 + the `member_invite_to_payment_funnel_dropoff` metric (FR-021).

#### Tenant isolation + authz

- **FR-017**: System MUST enforce tenant isolation at both application and database layers per Constitution Principle I (v1.4.0 sub-clauses) — a user of tenant A MUST NOT access any invoice, payment, refund, or processor event of tenant B by any route (UI, API, direct DB query, webhook replay). A cross-tenant access attempt MUST be logged as a `payment_cross_tenant_probe` audit event.
- **FR-018**: Only users with `member` role in the invoice's tenant (and whose company matches the invoice's customer) MAY initiate payment for that invoice. **Admin-impersonate-pay (admin paying on a member's behalf) is OUT OF SCOPE for F5 MVP** — `admin` role gets a 403 on `POST /api/payments/initiate`. If implemented in a future minor release, it MUST require explicit second-factor confirmation AND audit `payment_initiated` payload MUST include `impersonator_user_id` distinct from `actor_user_id` (post-critique E6 clarification, 2026-04-23).
- **FR-019**: All payment-touching endpoints MUST be served over TLS 1.2+. HSTS MUST be enabled (already enforced at platform level).

#### Observability + audit

- **FR-020**: System MUST write an append-only audit entry for each of: `payment_initiated`, `payment_succeeded`, `payment_failed`, `payment_canceled`, `payment_auto_refunded_stale_invoice`, `payment_auto_refunded_concurrent_manual_mark`, `payment_environment_mismatch`, `payment_cross_tenant_probe`, `refund_initiated`, `refund_succeeded`, `refund_failed`, `out_of_band_refund_detected`, `webhook_signature_rejected`, `webhook_api_version_mismatch`, `tenant_payment_settings_updated`, `online_payment_toggled`. Each entry includes actor, tenant, invoice (if applicable), correlation id, timestamp (UTC), and a stable event-specific payload (NO sensitive card data, NO webhook signing secrets, NO raw PANs). Entries MUST NOT be mutable or deletable.
- **FR-021**: System MUST instrument the payment flow per `docs/observability.md`: a distributed trace spans member-initiated payment → processor → webhook → F4 `markPaid` → receipt email; metrics count successes, failures (by reason code), retries, and refunds per tenant + per method + per day; an SLO on payment-success p95 latency is defined before GA; an alert fires when webhook backlog exceeds 5 minutes. Two additional metrics MUST be emitted for Q2/Q3 validation: (a) `out_of_band_refund_rejected_total{tenant_id, processor_env}` — counts webhook-detected out-of-band refunds (re-evaluate Q2 answer if > 0 for two consecutive months), (b) `member_invite_to_payment_funnel_dropoff{tenant_id, step}` — tracks the portal-invite → first-login → first-payment funnel to detect whether portal-only friction is suppressing SC-001 (leading indicator for promoting F5.1 pay-link out of the backlog).
- **FR-022**: Audit retention for payment + refund events MUST be ≥5 years per Constitution Principle VIII; retention is shared with F4 tax-document retention (10 years) where the event is on a tax document.

#### i18n + accessibility

- **FR-023**: All member-facing strings, admin-facing strings, error messages, email bodies, and processor-reason-code translations used in F5 MUST exist in EN + TH + SV. Missing EN keys fail the build. TH + SV fall back to EN with a CI warning on release branches. Thai is the primary locale for the PromptPay flow (Thai-specific rail).
- **FR-024**: F5 surfaces MUST meet WCAG 2.1 AA (Constitution Principle VI): keyboard-navigable payment form, visible focus ring, screen-reader-announced status transitions, `prefers-reduced-motion` respected on QR-countdown animation, colour-contrast ≥ 4.5:1 on all text including error states.
- **FR-025** *(Q4 answer — UX placement)*: Payment surface MUST be rendered as an embedded shadcn `Sheet` drawer on the existing `/portal/invoices/[id]` route — NOT as a new `/pay` route, NOT as a Stripe Checkout redirect, NOT as a dedicated confirmation page. The Sheet MUST: (a) host Stripe Elements + PromptPay QR as two tabs inside a single container; (b) open on Pay-now click or via a `?pay=1` query param (for F8 email deep-links); (c) support closing via Escape, backdrop click, or the X button without creating stale payment intents; (d) on successful settlement, close automatically and re-render the invoice detail page in `paid` state with a success toast (`sonner`); (e) upgrade to full-screen Sheet on mobile breakpoints (`sm:` and below) for touch-target comfort per `docs/ux-standards.md`; (f) preserve WCAG 2.1 AA focus trap, initial-focus target (card number field or PromptPay tab selector), and Escape-to-close; (g) NOT introduce a new `loading.tsx` or new `DetailContainer` sibling — the Sheet reuses the existing invoice-detail layout surface.
- **FR-026** *(Q5 answer — API version pinning)*: System MUST pin a single Stripe API version across both the server-side SDK initialisation AND the webhook handler's `Stripe-Version` header. The pinned version MUST be sourced from a `STRIPE_API_VERSION` env var (zod-validated at boot per `src/lib/env.ts`); a missing or malformed value MUST refuse to boot. The locked version is recorded in `plan.md` and promoted via explicit PR (regenerate golden fixtures + re-run contract tests) — silent account-default upgrades are forbidden. Webhook events whose `api_version` field does not match the pinned version MUST be acknowledged (200) and recorded in `processor_event` with outcome `acknowledged_only`, AND emit a named `webhook_api_version_mismatch` audit event so an unintended Stripe-side bump is detected. A quarterly engineering review MUST evaluate whether to bump the pinned version.
- **FR-027** *(post-critique P4 best-practice update, 2026-04-23 — F4 email "Pay online" CTA bundled into F5 branch)*: The existing F4 invoice-issued email template (per F4 FR-024) MUST be extended on the F5 branch to include a bilingual "Pay online" call-to-action button linking to `/portal/invoices/[id]?pay=1`. The CTA MUST be the visually primary action in the email (button, not text link), positioned above the F4 invoice-PDF attachment paragraph, rendered in EN+TH+SV per the request locale, and include `utm_source=invoice_email&utm_medium=email&utm_campaign=f5_pay_online` query params for adoption-funnel attribution. The CTA MUST NOT render if the tenant has `online_payment_enabled = false` (per FR-016) — instead, the existing F4 email body is unchanged. This requirement guarantees a day-1 discovery path for online payment without depending on F8 (Renewal Tracking) shipping first; SC-001a's proof-of-life signal would otherwise depend entirely on members manually navigating to the portal. F4's email-template change is a small additive edit (~5 lines + i18n keys × 3 locales + 1 e2e test); F5 already extends F4's public barrel, so the cross-module surface is already open.

#### Sheet drawer + dialog UX (post-critique UX audit, 2026-04-23)

- **FR-028** *(Sheet drawer UX — extends FR-025)*: The pay-sheet drawer MUST satisfy the following Chamber-OS enterprise UX requirements (cross-references `docs/ux-standards.md` §§ 2, 4, 5, 6, 7, 8, 10, 15):
  - **(a) Focus management** (§ 7.2): on open, focus moves to the first interactive element of the active method tab — Card tab → first Stripe Elements input (Stripe handles internal focus via `<PaymentElement>`); PromptPay tab → "Refresh QR" button (or "Scan with bank app" instructions region if QR is fresh). On close, focus returns to the Pay-now button that opened the drawer (Radix Dialog default). Tab order is logical top-to-bottom; Tab-trap inside drawer until close.
  - **(b) Dark mode wiring** (§ 1.7): Stripe Elements `appearance` option MUST mirror the active theme from `next-themes` — `<Elements stripe={...} options={{ appearance: { theme: useTheme().resolvedTheme === 'dark' ? 'night' : 'stripe', variables: { colorPrimary: 'var(--primary)', colorBackground: 'var(--background)', colorText: 'var(--foreground)', borderRadius: 'var(--radius)' } } }}>`. Theme switch in user menu MUST re-render Elements with new appearance (Stripe Elements supports this via the `appearance` prop changing).
  - **(c) Idle-warning suppression while drawer is open** (§ 8.2 interaction): the F1 idle warning (29-min timeout) is **paused** for the duration the pay-sheet drawer is open. Reason: 3DS challenges + bank-app-switching can take 5+ minutes; auto-signing-out a member mid-payment is a worst-case UX failure. Implementation: drawer mount sends a `pauseIdleTimer()` event to the F1 idle-watcher; drawer close (success / cancel / Escape) sends `resumeIdleTimer()`. If the drawer is open for > 30 minutes (hard cap — covers drift), a softer in-drawer prompt asks "Are you still here? Click Continue to keep your payment session active." with 60s countdown before cancelling the PaymentIntent + closing drawer.
  - **(d) 3DS challenge in-flight state**: while the bank's 3DS challenge popup is open (Stripe surfaces this via `paymentIntent.status === 'requires_action'`), the Sheet body shows a "Verifying with your bank..." panel containing: bilingual title, animated shimmer (motion-safe) / pulse (motion-reduce), explanatory text "Complete the verification in the popup window. We'll confirm your payment as soon as your bank approves.", and a tertiary "Cancel payment" button (cancels PaymentIntent via API + closes Sheet). NO frozen-looking spinner.
  - **(e) Confirmation panel** after successful settlement: Sheet body replaced with success state — `<CheckCircle />` icon (motion-safe scale-in 200ms; motion-reduce instant), bilingual "Payment received" title, summary line ("Paid THB X via card ending ****4242 on 2026-05-12"), **primary CTA "Download receipt" linking to F4 receipt PDF** (signed URL, 60s TTL), secondary "Close" button. Sheet auto-closes after 5 seconds via countdown unless member clicks Close earlier OR clicks Download (which keeps Sheet open until download starts). Success toast (`sonner.success`) fires regardless of Sheet close path.
  - **(f) Skeleton shimmer placement** (§ 2.1, 2.4): on Sheet open, while PaymentIntent is being created server-side (~200-500ms RTT), the body renders skeleton shapes matching the real card-form layout (3 input rows + button); on tab switch (Card → PromptPay), the QR area renders an aspect-ratio-square skeleton until QR fetched. Minimum 300ms display per § 2.3.
  - **(g) Reduced-motion comprehensive coverage** (§ 10.1): every animation has a `motion-reduce:` fallback — Sheet slide-in (200ms ease-out → instant fade ≤ 200ms); QR countdown tick (1s pulse → instant numeric update); success toast slide (200ms → fade-only); shimmer (1.5s gradient → `animate-pulse`); 3DS verifying shimmer (1.5s → `animate-pulse`); confirmation `<CheckCircle />` scale-in (200ms → instant).
  - **(h) Mobile full-screen variant** (§ 9.1, 9.2): Sheet upgrades to **full-screen** on viewport `< 640px` (Tailwind `sm` breakpoint) — drawer takes 100vh × 100vw, sticky header bar with bilingual title "Pay {invoice number}" + close button (≥ 44 × 44 px tap target), sticky footer with payment-method tab strip + amount-due summary. Tappable targets all ≥ 44 × 44 px (WCAG 2.5.5 AAA). On `≥ 640px` Sheet renders as a right-side drawer 480px wide.
  - **(i) WCAG 2.2 opportunistic adoption** (mirrors F3 pattern): SC 2.4.11 Focus-Not-Obscured (Sheet sticky header MUST NOT obscure focused field — drawer has `overflow-y: auto` + scroll-padding to keep focused field 24px above header bottom); SC 2.5.8 Target-Size (every interactive element on Sheet ≥ 24 × 24 px minimum, ≥ 44 × 44 px on mobile).
  - **(j) Bilingual ARIA-live region**: payment-status transitions announced via `<div aria-live="polite" role="status">` — "Processing payment", "Verifying with your bank", "Payment received", "Payment failed: {reason}". Localised TH+EN+SV.

- **FR-029** *(Refund dialog UX — expands FR-011 + FR-014)*: The admin refund dialog MUST satisfy `docs/ux-standards.md` §§ 6, 11, 15 enterprise standards:
  - **(a) AlertDialog primitive** (§ 6.2): use shadcn `<AlertDialog>` (composed on Radix). Title in plain language: "Issue refund?" (EN), "ออกใบลดหนี้?" (TH), "Utfärda återbetalning?" (SV). Description = consequence: "Refunding {amount} THB to {member.company_name}. This will process the refund through Stripe, create a tax credit note, and email a refund confirmation to the member's primary billing contact. This action cannot be undone."
  - **(b) Form structure** (§ 11.1): two fields stacked vertically — (1) **Amount** input with label above ("Refund amount (THB) *"), required asterisk visible + `aria-required="true"`, help text below ("Maximum refundable: {remaining} THB", updates live as member types), `inputmode="decimal"` on mobile keyboard; (2) **Reason** textarea with label above ("Reason *"), required, max 500 chars, character counter below ("X / 500 characters"), placeholder bilingual examples ("e.g., Tier downgrade — partial refund of upgrade fee"). Both fields use shadcn `<Input>` / `<Textarea>` with `data-slot` styling.
  - **(c) Validation timing** (§ 11.3): amount validates `onBlur` (immediately surfaces "Refund exceeds remaining" or "Must be > 0") with `aria-invalid="true"` + inline error below field per § 4.1; reason validates `onChange` for max-500-char enforcement + `onBlur` for required check. Submit button disabled until both fields valid.
  - **(d) Buttons** (§ 6.2): Cancel (left-aligned on mobile, right-of-primary on desktop, secondary variant) + "Issue refund" (destructive variant, red). Focus on Cancel by default per § 7.2 (safer default for destructive action). Escape closes without action.
  - **(e) Loading state** (§ 6.2): on Confirm click, button shows spinner + label changes to "Processing..."; dialog stays open until Stripe responds. On success: dialog closes + success toast `sonner.success("Refund processed — credit note CN-{number} issued and emailed to member")` (auto-dismiss 5s). On failure: dialog stays open + inline error card surfaces above buttons ("Refund failed: {Stripe-translated reason code}. No credit note was created. Please try again or contact support."), Confirm button re-enables.
  - **(f) Typed-phrase confirmation** (§ 6.3) — applied **only to FULL refunds** (where amount = remaining): member must type the exact text `REFUND {member.company_name}` (case-sensitive) into a confirmation input below the form before Confirm enables. Partial refunds skip this step (less destructive — member still has remaining balance to refund again if needed). Rationale: full refund is the most consequential operation (transitions invoice → fully credited → terminal tax-document state).
  - **(g) Focus return**: on dialog close, focus returns to the "Issue refund" button on the admin invoice detail page that opened the dialog.
  - **(h) Mobile-friendly**: dialog is centered modal on `≥ sm`, full-width on `< sm` with appropriate padding; keyboard appears for Amount input (numeric keyboard on iOS / decimal keyboard on Android).

- **FR-030** *(Online-payment-disabled fallback as proper empty-state)*: When `online_payment_enabled = false` OR `FEATURE_F5_ONLINE_PAYMENT = false` OR tenant settings incomplete (per FR-016), the member-facing fallback MUST follow `docs/ux-standards.md` § 3.1 empty-state anatomy — NOT a bare-text alert. Replace the Pay-now button with an **inline empty-state card** containing: lucide icon `<CreditCardOff />` (48 × 48, muted-foreground), bilingual title ("Online payment unavailable" / "ไม่สามารถชำระเงินออนไลน์ได้" / "Onlinebetalning ej tillgänglig"), 1-2-line explanatory ("Please contact admin to receive bank-transfer instructions; you'll get a tax receipt by email after payment is reconciled."), and a primary action CTA: "Contact admin" → opens member's default mail client to the tenant's configured admin email address (`tenant.contact_email` from F1) with a pre-filled subject "Bank-transfer instructions for invoice {invoice_number}". Empty-state card uses shadcn `<Card>` with same `DetailContainer` 72rem width as the surrounding invoice detail; takes the place of the Pay-now button without changing other invoice-detail content. Localised in EN+TH+SV.

### Key Entities

- **Payment**: a single payment attempt against one invoice. Attributes: id, tenant_id, invoice_id, processor_payment_intent_id, processor_charge_id (nullable until settled), method (card / promptpay), status, amount_thb, initiated_at, completed_at, failure_reason_code, actor_user_id, correlation_id. Only the "last succeeded" row is authoritative for settlement; prior failed/canceled attempts are kept for audit.
- **Refund**: one refund against one succeeded Payment. Attributes: id, tenant_id, payment_id, processor_refund_id, amount_thb, reason, status (`pending` | `succeeded` | `failed`), initiated_at, completed_at, initiator_user_id, credit_note_id (F4 back-link, NOT NULL on success). A single Payment MAY have multiple `succeeded` Refund rows; invariant enforced by FR-011b: Σ(Refund.amount_thb where status='succeeded') ≤ Payment.amount_thb.
- **Tenant Payment Settings**: per-tenant configuration row governing processor environment, publishable key, account id, enabled methods, global kill switch, optional per-tenant email override. One row per tenant.
- **Processor Event**: append-only log of every processor webhook event processed. Attributes: id (= processor event id), tenant_id (resolved from the event's account id), event_type, received_at, processed_at, payload_sha256, outcome (processed / acknowledged_only / rejected_signature / rejected_environment_mismatch). Used for idempotency enforcement.
- **(Reused from F4)** Invoice, Credit Note, Tenant Invoice Settings — F5 is a consumer of these entities, not a re-modeller.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001a** *(adoption — proof-of-life, 30 days)*: **≥3 distinct successful online payments across both methods (card + PromptPay) within 30 days** of F5 ship. Validates the system works end-to-end with real members; independent of renewal-season timing. Failure to meet = real product or onboarding bug, not a calibration problem.
- **SC-001b** *(adoption — 90-day check)*: **≥30% of paid Phase-2-era invoices within 90 days** of F5 ship are paid via an online method. Online method = card or PromptPay combined. **Marked informational (not fail) if F5 ships outside SweCham's primary renewal window (typically Q1, Jan–Mar)** — annual-renewal SaaS adoption is heavily concentrated in renewal months, so an off-cycle 90-day check would unfairly fail this SC.
- **SC-001c** *(adoption — steady-state, 12 months)*: **≥70% of paid Phase-2-era invoices within 12 months** of F5 ship are paid via an online method, replacing manual bank-transfer-plus-admin-reconciliation for the majority of payments through one full renewal cycle. This is the real success measure for the F5 thesis. Post-critique calibration (P2/X3, 2026-04-23 best-practice update): the original single-target "≥70% in 90 days" was uncalibrated against Thai-corporate-accountant payment habits + annual renewal timing; the three-step ladder gives a fair early proof-of-life signal, an early-direction-check, and a steady-state target.
- **SC-002** *(efficiency)*: Admin time spent per month on "reconcile a bank-transfer notice with an invoice" drops to **zero minutes for online-paid invoices** (the reconciliation happens automatically on webhook); measured by asking the SweCham admin in a 1-question retrospective check-in one month after ship.
- **SC-003** *(performance — member-facing)*: Time from member clicking "Pay now" to the processor-hosted card form being interactive is **p95 < 1 second** on a typical Thai broadband connection; time from valid card submit to confirmation screen is **p95 < 5 seconds** (excluding 3D Secure challenge, which is bank-controlled).
- **SC-004** *(performance — PromptPay)*: Time from member clicking "Pay with PromptPay" to QR render is **p95 < 2 seconds**; time from bank-transfer confirmation at the processor to portal confirmation screen is **p95 < 10 seconds** (real-time webhook path).
- **SC-005** *(reliability)*: Webhook idempotency holds on **100% of duplicate event deliveries** in a 30-day soak test — zero double-paid, zero double-credited, zero duplicate receipt emails.
- **SC-006** *(reliability — failure surface)*: For every processor reason code in the top-20 catalogue, the member sees a bilingual (TH + EN) actionable message (NOT a generic "something went wrong"). Verified by unit test mapping all 20 codes to translated strings.
- **SC-007** *(compliance — PCI)*: A post-implementation compliance scan finds **zero occurrences of raw PAN, CVV, or full track data** in logs, database rows, error reports, telemetry, or source code. SAQ-A scope is preserved — the Chamber-OS server never receives cardholder data.
- **SC-008** *(compliance — audit)*: A random audit sample of 20 online payments across both methods produces a complete 3-step audit trail (`payment_initiated`, `payment_succeeded`, `invoice_paid`) **with no missing entries**; refunds produce the 4-step trail (`refund_initiated`, `refund_succeeded`, `credit_note_issued`, `invoice_credited`).
- **SC-009** *(security — webhook)*: 100% of webhook requests with invalid signatures are rejected with 401 before body parsing; measured by a targeted abuse test during the security-checklist review.
- **SC-010** *(tenant isolation)*: A cross-tenant probe attempt (user of tenant A trying to pay / refund / view a payment of tenant B) is refused AND audited at both application and database layers — verified by the mandatory Constitution Principle I cross-tenant integration test.
- **SC-011** *(reconciliation variance)*: Cumulative month-end variance between the Chamber-OS online-payments ledger and the processor dashboard is **≤ THB 1.00 (100 satang)** for three consecutive months — the small tolerance accommodates legitimate FX-rounding from foreign-card payments without flagging spurious variance. Variance > THB 1.00 in any month triggers a postmortem (per `docs/runbooks/out-of-band-refund.md` if attributable to refund drift, or a new generic reconciliation runbook for other causes). *(Post-critique audit-resolve P8, 2026-04-23 — was originally "zero THB"; tightened to define "zero" with a measurable tolerance after FX-rounding analysis.)*
- **SC-012** *(accessibility)*: WCAG 2.1 AA automated scan (axe-core) on the payment surface, QR countdown, and confirmation screen reports **zero serious or critical violations**; keyboard-only end-to-end payment completes successfully under Playwright + screen-reader simulation.
- **SC-013** *(kill switch)*: Setting `tenant_payment_settings.online_payment_enabled = false` takes effect on the member portal within **one request cycle** (no cache delay > 60 seconds); existing in-flight payment intents are gracefully cancelled.

## Assumptions

The following defaults supplement the three Q&A clarifications above.

### Scope

- **Single Stripe account for SweCham in F5**: Phase 2 is still single-tenant per `docs/saas-architecture.md` (Phase 0 = one tenant, one Stripe account). F5 reads SweCham's Stripe keys from environment variables AND persists a `tenant_payment_settings` row scoped by `tenant_id` so the data model is MTA-ready. F11 will later swap env-var keys for per-tenant Stripe Connect accounts without schema migration.
- **Card + PromptPay ship together as P1 MVP** (Q1 answer): no card-only sequencing; both methods land in the first F5 release.
- **In-app refund only — out-of-band refunds are rejected** (Q2 answer): no auto-reconciliation of processor-dashboard-initiated refunds; admin retraining + the `out_of_band_refund_detected` runbook are the operational mitigation. A "Mark as refunded externally" escape-hatch UI is explicitly out of scope for F5 MVP.
- **Portal-authenticated payment only in F5 MVP** (Q3 answer): no signed pay-link for unauthenticated clerks. The `tenant_payment_settings.allow_anonymous_paylink` column is a forward-compatible placeholder for F5.1; toggling it has no effect in F5 MVP. Promotion of F5.1 out of the backlog is gated by SC-001 + funnel-dropoff metric (FR-021).
- **Pay-in-full only**: members cannot split a payment across multiple transactions; the invoice transitions to `paid` only on a single full-amount settlement. Partial *refunds* (downgrades, prorations) are supported via the F4 credit-note flow (FR-011–FR-013); partial *payments* are out of scope.
- **THB-only currency in F5**: invoices are always in THB (F4 assumption); member's card-issuing currency is handled transparently by the processor's FX. Multi-currency invoices (SEK, EUR, USD) are out of scope for F5 and F4.
- **Renewal is F8, not F5**: F5 delivers the payment surface for any issued invoice. F8 (Renewal Tracking) generates the renewal invoices and sends the reminder emails that deep-link into F5. F5 leaves a well-defined hook for F8 to invoke but does not ship its own renewal logic.
- **Google Pay / Apple Pay are out of scope for MVP**: Stripe Payment Request Button can add them cheaply post-MVP; the title "Stripe + PromptPay" is taken literally to mean card form + PromptPay only.
- **Dispute (chargeback) workflow is out of scope for MVP**: `charge.dispute.created` webhook events are logged and alert admin but no in-app dispute-response UI is built. Admin handles disputes in the processor dashboard.

### Security + compliance

- **SAQ-A scope is non-negotiable**: the Chamber-OS server MUST NEVER receive cardholder data. Card capture is 100% via processor-hosted Elements. Any deviation requires a Constitution amendment.
- **Webhook signature verification is mandatory on every request**: no unsigned path, no shared-secret replay, no "trusted IP" shortcut.
- **Processor secret keys live in Vercel env vars only**: validated at boot by `src/lib/env.ts` (zod schema); the app refuses to start with a missing / malformed key.
- **Webhook environment segregation**: separate Stripe test-mode endpoint and live-mode endpoint; endpoint detects mismatched event-mode and rejects.
- **Audit retention ≥5 years for payment + refund events**; 10 years where the event touches an F4 tax document (shared legal-obligation basis under PDPA/GDPR).
- **Single refund path = single attack surface** (Q2 answer): consolidating refunds through the in-app admin UI keeps the audit trail atomic and reduces the surface area where mismatched ledgers (Chamber-OS vs. processor) can develop.
- **Pay-link infrastructure deferred** (Q3 answer): no signed-token endpoint, no token-hash storage, no anonymous payment route exists in F5 MVP — the corresponding threat model can be deferred to F5.1's own `/speckit.specify` cycle.

### UX + i18n

- **Stripe Elements (hosted fields / Payment Element)** is the card-capture technology (pre-locked by Constitution § Payment + phases-plan R2). No custom card UI.
- **PromptPay QR rendering** is delegated to the processor's provided image / payload. No in-house QR generator.
- **3D Secure / SCA** is handled inside the processor's flow transparently; no custom SCA UI.
- **Receipt email** is F4's responsibility (F4 FR-024); F5 only adds a body line identifying the online method. The tenant's `auto_email_on_payment` flag MAY suppress the email for out-of-portal workflows; defaults to true.
- **Accessibility parity**: the online payment surface MUST pass the same enterprise UX checklist as F4 (shimmer skeletons, toasts, keyboard nav, focus management, reduced-motion, ARIA-live for status transitions) per `docs/ux-standards.md`.

### Operational

- **Feature kill switch** `FEATURE_F5_ONLINE_PAYMENT` env flag gates the entire F5 surface (same pattern as `FEATURE_F4_INVOICING`); when off, the portal hides the Pay-now button and the webhook endpoint returns 503.
- **Sandbox vs. live**: the dev + staging environments use Stripe test mode; production uses live mode. A synthetic smoke test (test-card + test-PromptPay) runs on every production deploy.
- **No convenience fee / surcharge** is added on top of the invoice total for F5 MVP. Processor fees are the tenant's cost of doing business.
- **Reconciliation cadence**: admin reviews month-end variance monthly; any non-zero variance triggers a postmortem and a SC-011 regression investigation.
- **First-run bootstrap** of `tenant_payment_settings` for SweCham is a one-off migration seed (similar to F4 `tenant_invoice_settings`), not an admin UI in MVP. A `/admin/payment-settings` admin UI MAY follow in a post-MVP minor release.

### Dependencies

- **F1 (Auth & RBAC)**: shipped. Provides session, `member` / `admin` / `manager` roles, and CSRF middleware.
- **F4 (Invoices & Receipts)**: review-ready on `007-invoices-receipts`. Provides invoice state machine, `markPaid` use case, receipt PDF generation, tenant invoice settings, and the issue-time auto-email template. **F5 MUST merge after F4 is shipped** — the F4 `markPaid` public API is the F5 integration contract. Tracked as Phase 0 task T001 in `/speckit.tasks`: "Wait for F4 PR #12 to merge to main; rebase F5 branch on latest main; resolve any `src/modules/invoicing/index.ts` conflicts; land F5's 3 new exports + the F4 email-template 'Pay online' CTA extension as a small isolated commit before main F5 implementation begins" (post-critique E16, 2026-04-23). **F4 issue-time email "Pay online" CTA bundled into F5 branch** (post-critique P4 best-practice revision, 2026-04-23): rather than a deferred follow-up PR (which often slips in solo-maintainer workflows), the F4 email-template extension lands inside F5 per FR-027. This guarantees day-1 discovery for online payment and protects SC-001a's proof-of-life signal from depending on members proactively visiting the portal.
- **F8 (Renewal Tracking)**: will consume F5 pay-links. F8 depends on F5, not the reverse. F5 does not ship renewal UX.
- **F11 (SaaS Billing — Stripe Connect)**: not a dependency of F5, but F5's data model (tenant-scoped `tenant_payment_settings`) MUST allow F11 to swap env-var Stripe keys for per-tenant Connect accounts without schema migration.
- **Processor choice**: Stripe is locked in by Constitution § Compliance: Payment and phases-plan Decision R2. PromptPay is a Stripe-native Thai payment method — no separate processor integration is added.
