# F5 — Phase 0 Research & Resolved Decisions

**Branch**: `009-online-payment`
**Date**: 2026-04-23
**Source**: derived from `spec.md` (Q1–Q6 resolved), `plan.md`, Constitution v1.4.0, `docs/saas-architecture.md`, `docs/phases-plan.md` Decision R2.
**Purpose**: resolve every unknown in Technical Context, document alternatives considered, and pin the concrete technology + architecture choices so `/speckit.tasks` can emit TDD-ordered tasks without further decisions.

All "NEEDS CLARIFICATION" from the plan template were pre-resolved either in the spec (Q1–Q6) or by Constitution pre-locks. No outstanding unknowns remain.

---

## 1. Processor choice + payment methods

**Decision**: Stripe (global) + PromptPay (Thai national QR rail, delivered via Stripe's PaymentIntent API with `payment_method_types: ['promptpay']`).

**Rationale**:
- Pre-locked by Constitution § Compliance: Payment + `docs/phases-plan.md` Decision R2.
- Native THB + PromptPay support ("out of the box"): no secondary PromptPay gateway needed; Stripe generates the QR payload + handles bank-side settlement + routes refunds back to the originating bank account automatically.
- Stripe Elements (hosted fields) preserves SAQ-A scope by construction — NO cardholder data touches our server (Constitution Principle IV, NON-NEGOTIABLE).
- Same processor will power F11 SaaS Billing (Layer A tenant-subscription charges); operational surface stays single.
- Mature SDK + webhook signature primitive + quarterly changelog + Thailand business entity.

**Alternatives considered**:
- **Omise** (Thai-native): PCI-certified, strong Thai coverage (PromptPay, TrueMoney, internet banking), but weaker global card acceptance (declines on some non-Thai issuers), less mature JS SDK, and adds a second processor to maintain when F11 ships. Keeping one processor wins.
- **2C2P** (Thai-native, payment switch): business-grade, strong in POS + e-commerce checkout, but the hosted-fields pattern is less polished than Stripe Elements; JS integration is closer to a redirect flow; PCI SAQ-A scope is preservable but requires more careful integration.
- **Adyen**: strong global, but Thai PromptPay coverage is through partners rather than native; complexity of merchant account setup is high for a single-tenant MVP.

**Scope for MVP** (Q1 answer):
- **Card** (Visa, Mastercard, American Express, JCB) via Stripe Elements `PaymentElement` component.
- **PromptPay** via Stripe PaymentIntent + `image_url_svg` QR payload.
- Google Pay / Apple Pay via `Payment Request Button` — **deferred post-MVP**; Stripe supports these cheaply, but initial UX focus is the two explicit rails named in the feature title.

---

## 2. Stripe SDK version + API version pinning (Q5 / FR-026)

**Decision**: Pin Stripe server SDK to `stripe@^19` (exact-minor pin, to be finalised in `/speckit.tasks` to the latest stable as of the task date). Pin Stripe API version via `STRIPE_API_VERSION` env var (zod-validated at boot per `src/lib/env.ts`). The value is passed to both (a) the server SDK's `apiVersion` option and (b) the webhook handler's `Stripe-Version` header on the response. Client SDK: `@stripe/stripe-js@^6` + `@stripe/react-stripe-js@^4`.

**Rationale**:
- Webhook payload schemas evolve between Stripe versions. A silent account-default upgrade can break production without a test failure; pinning surfaces drift as test failures.
- Env-var-backed pin means upgrades are (a) explicit PRs, (b) regenerated golden fixtures, (c) contract tests re-run, (d) quarterly review cadence.
- `webhook_api_version_mismatch` audit event (FR-026) catches runtime drift between Stripe-account default and our pin.

**Alternatives considered**:
- **SDK default version**: simplest, but is exactly what FR-026 and Q5 were created to avoid.
- **Pin in SDK, allow any webhook version**: inconsistent — client calls pinned but handler accepts anything; contract tests lose determinism.
- **Pin + weekly Stripe changelog diff CI job**: appealing but YAGNI for MVP; quarterly review is sufficient for SweCham's volume.

**Concrete version to pin**: to be set during `/speckit.tasks` as the latest stable Stripe API version (e.g. `2025-09-30.basil`). The `plan.md` leaves the exact value open so it reflects the current `latest` at the time implementation begins.

---

## 3. Webhook handling architecture

**Decision**: Single tenant-neutral webhook endpoint `POST /api/webhooks/stripe` pinned to Node.js runtime. Signature verification via Stripe SDK's `webhooks.constructEvent(rawBody, signature, secret)`. Idempotency via unique constraint on `processor_events.id` (Stripe event id is globally unique across test + live modes). Tenant resolution via lookup on Stripe account id → `tenant_payment_settings.processor_account_id`. Separate webhook endpoints for test vs live modes are achieved via separate Vercel deployments (dev/staging = test keys, prod = live keys) — NOT separate routes.

**Rationale**:
- Raw body access for signature verification is the primary constraint; Next.js Edge runtime's raw-body support has historically been fragile across framework upgrades. Node.js runtime is Stripe's documented recommendation.
- A single endpoint URL is simpler to register with Stripe + easier to rotate the webhook secret. Tenant scoping is enforced at the application layer post-verification.
- `processor_events.id` PK + upsert-on-conflict-do-nothing is the minimum-complexity idempotency primitive (FR-008).
- Environment segregation (FR-010 / Q5) is enforced by checking `event.livemode` against the expected mode for the current env — mismatch = `payment_environment_mismatch` audit event.

**Event types handled** (FR-009):
- `payment_intent.succeeded` → `confirm-payment.ts`
- `payment_intent.payment_failed` → `fail-payment.ts`
- `payment_intent.canceled` → `handle-cancel-event.ts`
- `charge.refunded` → `detect-out-of-band-refund.ts` (reconciliation branch) + in-app-refund finalisation branch
- `charge.dispute.created` → `handle-dispute.ts` (alert-only, FR-009)

**Other events acknowledged + logged but no-op**: `charge.created`, `charge.succeeded`, `charge.updated`, `payment_intent.created`, `payment_intent.processing`, `payment_intent.requires_action`. Recorded in `processor_events` with `outcome = 'acknowledged_only'`.

**Alternatives considered**:
- **Tenant-scoped webhook URL per tenant** (`/api/webhooks/stripe/:tenantId`): inverts the threat model (URL becomes a tenant oracle; each tenant needs a separate Stripe webhook endpoint registration). Rejected.
- **Webhook processing in a background queue** (Vercel Queues / Upstash QStash): adds a queue dependency + async processing latency; for ~800 events/week volume, synchronous processing inside the webhook handler with a 500ms p95 budget is plenty. Rejected for MVP (can retrofit if volume grows).
- **Edge runtime with manual `request.arrayBuffer()`**: works today but constantly required re-verification across Next.js minor bumps. Rejected — single endpoint not worth the maintenance tax.

---

## 4. Payment lifecycle + idempotency strategy

**Decision**: One `payments` row per PaymentIntent attempt. Member-initiated `POST /api/payments/initiate` uses the idempotency-key pattern `inv-{invoice_id}-attempt-{seq}` where `seq` increments only after a terminal failed/canceled state on the previous attempt. Resume-on-reopen (member closes tab and returns) reads the existing pending `payments` row for the invoice and reuses its `clientSecret` — no new PaymentIntent created. The `payments.processor_payment_intent_id UNIQUE` index enforces "one live Intent per attempt".

**Rationale**:
- Stripe's Idempotency-Key semantics return the same PaymentIntent on retries with the same key, which is exactly the resume-on-reopen behaviour we want (US1 AS4).
- Post-failure retry = new attempt = new key = new PaymentIntent — standard Stripe pattern.
- Unique index on `processor_payment_intent_id` catches any SDK-level race condition that would otherwise create duplicate rows.

**State transitions** (Payment aggregate):
- `pending` → `succeeded` (webhook `payment_intent.succeeded`)
- `pending` → `failed` (webhook `payment_intent.payment_failed`)
- `pending` → `canceled` (webhook `payment_intent.canceled` OR member-initiated `POST /api/payments/[id]/cancel`)
- `succeeded` → `partially_refunded` (first partial refund succeeds via `issue-refund.ts`; FR-011b)
- `partially_refunded` → `partially_refunded` (subsequent partials, cumulative still < amount_satang)
- `partially_refunded` | `succeeded` → `refunded` (cumulative refund sum reaches amount_satang)
- `failed`, `canceled`, `refunded` are terminal.

**Concurrent tab handling**: first tab creates PaymentIntent X; second tab opens same invoice → server reads existing pending row → returns same `clientSecret` → Stripe Elements on both tabs use the same Intent → first-to-submit wins; second tab's confirmation call returns the already-succeeded Intent. No duplicate charge possible.

**Alternatives considered**:
- **One Intent per invoice** (not per attempt): fails the "retry after decline" case because a confirmed Intent cannot be re-confirmed; we'd need to cancel + create a new one, which is two round-trips vs. one.
- **Random UUID idempotency-key per request**: no resume-on-reopen semantics; member would accidentally create many Intents by reloading.
- **Client-generated correlation id (localStorage)**: handles same-tab resume but not return-from-different-device or email-deep-link resume.

---

## 5. Refund architecture (Q2 + Q6 / FR-011, FR-011a, FR-011b)

**Decision**: In-app-only refund initiated by admin (Q2 answer). Free-form THB amount, multiple partial refunds per payment allowed, cumulative sum capped at payment total (Q6 answer). Pre-flight server-side validation rejects over-cap attempts before the Stripe API call. Concurrent refund attempts on the same `payments` row are serialised via Postgres row-level lock (`SELECT … FOR UPDATE`). Each successful refund creates exactly one F4 credit note through the public barrel `issueCreditNoteFromRefund(tenantCtx, invoiceId, {refundId, amountSatang, reason})`.

**Out-of-band refund handling** (FR-011a): webhook `charge.refunded` events whose `processor_refund_id` does NOT match an in-app `refunds` row → write `out_of_band_refund_detected` audit + emit `out_of_band_refund_rejected_total` metric + alert. NO F4 credit note, NO invoice-status transition. Admin resolves manually via runbook `docs/runbooks/out-of-band-refund.md`.

**Rationale**:
- Single refund path = single audit surface = single source-of-truth for tax-document generation. Out-of-band reconciliation would double the state-machine surface and introduce drift between Chamber-OS ledger and Stripe dashboard.
- Row-level lock is sufficient for ≤ 2 concurrent admin attempts; advisory lock overhead (F4 pattern) not needed.
- Per-refund credit note matches F4's one-amount-per-CN convention; line-item refund (F4-mirror) is more complex UX with no real-world win for this domain.

**Refund state machine**:
- `pending` → `succeeded` (Stripe returns `status=succeeded`)
- `pending` → `failed` (Stripe returns `status=failed` or the API call throws)
- No retry of failed refund — admin creates a new one (different `processor_refund_id`, different idempotency-key).

---

## 6. F4 integration contract

**Decision**: F5 calls F4 exclusively through the `@/modules/invoicing` public barrel. Three new exports added to F4's barrel (landing on F5's branch, not retroactively on F4's):

1. **`markPaidFromProcessor(tenantCtx, invoiceId, { method, paymentIntentId, chargeId, settlementDate }): Result<Invoice, Error>`** — thin wrapper around the existing F4 `markPaid` use-case that maps processor metadata into F4's `payment_method ∈ {'stripe_card','stripe_promptpay'}`, `payment_date = settlementDate`, `payment_reference = chargeId`. Invoked inside the F5 `confirm-payment` webhook branch.
2. **`issueCreditNoteFromRefund(tenantCtx, invoiceId, { refundId, amountSatang, reason }): Result<CreditNote, Error>`** — wrapper around F4's existing `issue-credit-note` use-case. Amount is a single line (single amount, description = reason). Links `credit_notes.source_refund_id = refundId` for cross-reference.
3. **`getInvoiceForPayment(tenantCtx, invoiceId): Result<InvoiceForPayment, Error>`** — read-only DTO returning just the fields F5 needs to decide (a) is this invoice payable (`status in {issued, overdue}`), (b) what is the total amount in satang, (c) is the invoice still owned by this tenant+member. Avoids F5 reaching into F4's Invoice aggregate root.

Additionally, F4's `Money` VO (satang-minor-units, immutable, total-ordering) is re-exported from F4's barrel as `AmountSatang` so F5's Domain can use the same value object without duplicate code.

**Rationale**:
- Unidirectional dependency `payments → invoicing`. F4 does NOT import from `@/modules/payments` — F4 stays shippable as standalone Phase 1.
- Narrow barrel surface + explicit Result-returning contract + contract tests at the F4/F5 boundary = easy review + easy deprecation if F4 refactors.
- Same pattern as F4 extended F3's `@/modules/members` barrel with `getMemberIdentityForInvoicing` in its own branch.

**Alternatives considered**:
- **Direct Drizzle access** to `invoices` table from F5: violates Principle III. Rejected.
- **F5 re-implements `markPaid`**: silently drifts from F4 over time. Rejected.
- **Shared `src/modules/finance-core/` module** holding Money + invoice abstractions: over-engineering for two modules. Rejected; keep F4 as the primary owner of invoice semantics.

---

## 7. Tenant isolation with webhook pre-tenant bypass

**Decision**: Webhook signature verification + `processor_events` row insert run under a minimal pre-tenant bypass (RLS disabled on `processor_events` for INSERT only, via a `tenant_id` default NULL + a policy `USING (tenant_id = current_setting('app.current_tenant', TRUE) OR tenant_id IS NULL)`). Immediately after the tenant is resolved via `tenant_payment_settings.processor_account_id` lookup, the transaction re-enters `runInTenant(tenantCtx, ...)` and `UPDATE processor_events SET tenant_id = $1 WHERE id = $2` fills in the tenant binding. All downstream Payment/Refund reads + writes happen inside `runInTenant`.

**Rationale**:
- The webhook handler cannot know `tenant_id` until it parses the event payload — we can't set `app.current_tenant` before signature verification because we have no tenant yet.
- The bypass window is narrow (pre-resolution only) and covers a single append-only idempotency-log table. Payments/refunds/audit rows are ALL written post-resolution under full RLS.
- Post-resolution UPDATE fills in `tenant_id` so the row is properly scoped for forever reads.

**Alternatives considered**:
- **Per-tenant webhook URL**: inverts threat model (tenant enumeration via URL). Rejected.
- **Header-based tenant hint**: Stripe webhooks don't support custom headers reliably. Rejected.
- **Two-phase webhook**: receive event, respond 200, then enqueue for async processing under `runInTenant`: adds queue latency + adds a queue dependency. Rejected for MVP; can retrofit.

---

## 8. Stripe test-mode fixtures + local dev

**Decision**: Dev + staging use Stripe test mode; production uses live. Local dev uses the Stripe CLI (`stripe listen --forward-to localhost:3100/api/webhooks/stripe`) which creates an ephemeral test webhook signing secret for the dev session. Test cards for contract + integration tests: `4242 4242 4242 4242` (success), `4000 0000 0000 9995` (declined `insufficient_funds`), `4000 0025 0000 3155` (3D Secure requires), `4100 0000 0000 0019` (declined `card_declined`). Test PromptPay: `stripe.confirmPromptPayPayment()` with test clientSecret triggers a 30-second-delayed `payment_intent.succeeded` webhook; we use the CLI's `--latest` flag to replay the event synchronously in tests.

**Rationale**:
- Stripe CLI is the documented dev workflow; no mocking required for end-to-end integration tests.
- Test cards cover the top-4 decline classes from the SC-006 top-20 catalogue; the remaining 16 codes are unit-tested at the reason-code-translation layer.

**Alternatives considered**:
- **Mocking Stripe SDK end-to-end**: fast but fragile; we'd miss real Stripe API contract changes. Rejected (except for unit tests that don't need the network).
- **Dedicated Stripe sandbox per developer**: overkill; shared team test account is sufficient.

---

## 9. UX placement + Sheet drawer (Q4 / FR-025)

**Decision**: Embedded inline `Sheet` drawer on `/portal/invoices/[id]` — no new route, no loading.tsx, no breadcrumb. Two tabs inside the drawer: Card (Stripe `PaymentElement`) + PromptPay (QR + countdown). Confirmation state: drawer auto-closes + invoice detail page re-renders in `paid` state + `sonner` success toast. Mobile full-screen variant on `sm:` and below. Deep-link via `?pay=1` query param for F8 reminder emails.

See `plan.md` § Project Structure for the full `src/app/(member)/portal/invoices/[id]/_components/pay-sheet/**` component tree.

---

## 10. Kill switch + feature flag

**Decision**: Dual layer:
1. **Global feature flag** `FEATURE_F5_ONLINE_PAYMENT` env var (zod-validated boolean). When `false`, ALL F5 surfaces return 503 + the Sheet drawer is not rendered. This is the "kill the whole feature" lever, operated by redeploying with env change.
2. **Per-tenant toggle** `tenant_payment_settings.online_payment_enabled` (boolean). When `false` for a tenant, that tenant's members see the bilingual fallback UI; admin can flip this without a deploy.

Both are checked on every `POST /api/payments/initiate` call. Setting the per-tenant flag to `false` emits `online_payment_toggled` audit and — best-effort — cancels in-flight PaymentIntents for that tenant via a batch Stripe call.

**Rationale**:
- Global flag = emergency circuit breaker (e.g., webhook signature secret rotation gone wrong).
- Per-tenant flag = routine operational control (e.g., a tenant's Stripe account is under review).
- SC-013 ≤ 60s propagation guarantees a soft-ish "kill it now" response without a redeploy.

---

## 11. Observability — specific SLOs + alert thresholds

**Decision**:

| Surface | Metric | Target | Alert |
|---------|--------|--------|-------|
| Payment initiation API | p95 duration | < 1.2 s | p99 > 3 s for 10 min |
| Webhook processing | p95 duration | < 500 ms | p99 > 2 s for 10 min |
| PromptPay QR render | p95 duration | < 2 s | p99 > 5 s for 10 min |
| Webhook → portal confirmation | p95 wall-clock | < 10 s | p95 > 30 s for 10 min |
| Payment-success rate | rolling 1h, excluding bank-decline codes | ≥ 95% | < 95% for 1 h |
| Cross-tenant probe | count / 5 min | 0 | ≥ 1 (alarm); ≥ 5 / h (incident) |
| Webhook signature rejected | count / 5 min | 0 | ≥ 1 (alarm — possible abuse) |
| Out-of-band refund detected | count / month | 0 | ≥ 1 (email admin + runbook) |
| Webhook backlog | age of oldest unprocessed event | < 5 min | ≥ 5 min (page) |

**Availability SLO** (leading indicator for SC-011 = zero variance): **99.5% of non-bank-declined payment initiations complete successfully within their p95 budget over a rolling 30-day window**. Variance investigation runbook triggered if either (a) availability drops below 99.5%, (b) reconciliation-variance metric from SC-011 is non-zero for a month.

**Alternatives considered**:
- Tighter SLO (e.g., 99.9%): insufficient real-world baseline to commit; revisit after 90 days of prod data.
- Percentile-less alerting: loses sensitivity to regression. Rejected.

---

## 12. SAQ-A scope preservation — pre-implementation checklist

**Decision**: All 14 SAQ-A questions (per PCI DSS SAQ-A v4.0) answered and committed to `specs/009-online-payment/saq-a-attestation.md` during `/speckit.plan` Phase 1 (below). Re-attested before `/speckit.ship`. Any "non-compliant" answer is a ship blocker.

Key commitments (condensed — full text in saq-a-attestation.md):
1. No electronic storage, processing, or transmission of cardholder data (CHD) beyond processor-issued token id + last-4 + brand + expiry. ✅
2. Cardholder data environment (CDE) = Stripe only; our network is outside CDE. ✅
3. All payment pages served over HTTPS + HSTS. ✅
4. Stripe Elements loaded from `js.stripe.com` via CSP-pinned `script-src`. ✅
5. No access to raw PAN anywhere — no logs, no screenshots, no error reports, no telemetry. ✅

**Rationale**: SAQ-A is the cheapest PCI scope; any drift to SAQ-A-EP (where our server touches redirect/post-URL elements) or SAQ-D (where our server handles CHD directly) is ~10× the compliance burden. Pinning SAQ-A up-front is the highest-leverage decision.

---

## 13. Rate limits + abuse protection

**Decision** (already documented in plan.md § Storage):

| Endpoint | Limit | Scope |
|----------|-------|-------|
| `POST /api/payments/initiate` | 10 / 5 min | `(tenant_id, actor_user_id)` |
| `POST /api/payments/[id]/cancel` | 20 / 5 min | `(tenant_id, actor_user_id)` |
| `POST /api/refunds/initiate` | 20 / 5 min | `(tenant_id, actor_user_id)` |
| `POST /api/webhooks/stripe` | 600 / min | source IP (allowlist bypass for Stripe IPs) |

Reuses the F1 Upstash adapter unchanged. Exceeding a limit → 429 + bilingual "Too many attempts; please try again shortly" surface (no leaked detail).

---

## 14. Open items deferred to later phases

None remain for `/speckit.plan`. All six clarifications (Q1–Q6) are resolved in `spec.md`. The following are **explicitly deferred** and tracked here for traceability:

- **Exact Stripe API version string** → set during `/speckit.tasks` to the latest stable.
- **Stripe account id for SweCham** → `tenant_payment_settings.processor_account_id` row seeded during `0036_seed_swecham_payment_settings.sql` migration. Value supplied from Vercel env var `STRIPE_ACCOUNT_ID_SWECHAM` (not a secret — a public account identifier).
- **Runbook content** at `docs/runbooks/out-of-band-refund.md` → authored during `/speckit.plan` Phase 1 (below, as an artefact of this plan). The file exists and is linked from FR-011a.
- **F5.1 (pay-link) scope** → not in F5; forward-compat flag `allow_anonymous_paylink` only. Promotion criteria: SC-001 < 70% AND funnel-dropoff metric indicates portal-only friction.
