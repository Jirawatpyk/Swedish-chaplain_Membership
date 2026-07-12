# F5 — Contract: REST API (`/api/payments/*` + `/api/refunds/*`)

**Branch**: `009-online-payment`
**Date**: 2026-04-23
**Source**: `spec.md` FR-001…FR-014 + FR-025, `plan.md` § Reliability, `data-model.md` § 2 + § 3.
**Purpose**: pin request/response shapes for member-initiated payment + admin-initiated refund routes. zod schemas in `src/modules/payments/application/schemas/**`. One contract test per route in `tests/contract/payments/`.

All routes:
- Require an active F1 session cookie (`__Host-session-id`); anonymous calls → `401`.
- Require valid CSRF Origin per F1 middleware.
- Are tenant-scoped via the `TenantContext` derived from session.
- Run on the default Node.js runtime (Vercel Fluid Compute) — payment routes are NOT Edge.
- Emit OTel spans + pino structured logs threaded by `correlation_id` (response header `X-Correlation-Id`).
- Return `application/json` UTF-8 unless explicitly stated.

Standard error envelope (matches F1+F4 convention):

```json
{
  "error": {
    "code": "card_declined",
    "message": "Card declined — please try another card or contact your bank.",
    "messageThai": "บัตรถูกปฏิเสธ — กรุณาลองบัตรอื่นหรือติดต่อธนาคารของคุณ"
  },
  "correlationId": "01J..."
}
```

`message` is i18n-resolved to the request locale; `messageThai` is included on every error so an EN-locale member with a Thai display still sees the Thai text. Internal codes are stable (snake_case) for analytics + alerting + log filtering.

---

## 1. `POST /api/payments/initiate`

Member initiates online payment for an issued invoice. Creates (or reuses) a Stripe PaymentIntent + `payments` row.

**Auth**: `member` role; CSRF; same-origin.
**Rate limit**: 10 / 5 min per `(tenant_id, actor_user_id)` → 429 on exceed.
**Idempotency**: optional `Idempotency-Key` request header. If absent, server derives from `(tenant_id, invoice_id, attempt_seq)`.

### Request

```
POST /api/payments/initiate
Content-Type: application/json
Cookie: __Host-session-id=…
Idempotency-Key: <optional>          // <= 255 chars
Accept-Language: th, en;q=0.9, sv;q=0.8

{
  "invoiceId": "inv_01J...",
  "method": "card" | "promptpay"     // selected from method-tabs UI
}
```

zod schema:

```ts
const InitiatePaymentInput = z.object({
  invoiceId: z.string().min(20).max(40),  // ULID-shaped
  method: z.enum(['card', 'promptpay'])
});
```

### Response — 201 Created (new or resumed PaymentIntent)

```json
{
  "payment": {
    "id": "pmt_01J...",
    "invoiceId": "inv_01J...",
    "method": "card",
    "status": "pending",
    "amountSatang": 5350000,
    "currency": "THB",
    "attemptSeq": 1,
    "initiatedAt": "2026-05-12T07:03:11.123Z",
    "processorEnvironment": "live"
  },
  "stripe": {
    "publishableKey": "pk_live_…",
    "clientSecret": "pi_3R…_secret_aB…",
    "paymentIntentId": "pi_3R…",
    "promptpayQrSvgUrl": null         // populated if method='promptpay' and intent already in 'requires_action' state
  },
  "correlationId": "01J..."
}
```

If a `pending` Payment already exists for the invoice + actor, the response IS the resumed one (same `clientSecret`). The HTTP status remains 201 to keep the client logic identical for first-attempt vs. resume.

### Response — 4xx errors

| HTTP | `error.code` | When |
|------|--------------|------|
| 400 | `invalid_input` | zod validation failed |
| 401 | `unauthorized` | no session OR CSRF mismatch |
| 403 | `forbidden_role` | role ≠ `member` |
| 403 | `invoice_not_accessible` | invoice does not exist, OR exists in a different tenant, OR exists but is not owned by the actor's company. **Both non-existence and cross-tenant existence return the SAME opaque 403 + `invoice_not_accessible` payload** so the client cannot distinguish the two (enumeration defence — PCI F-02 / Threat OQ-1 / Constitution Principle I). The use-case still emits the distinct `payment_cross_tenant_probe` audit row on the cross-tenant branch. |
| 409 | `invoice_not_payable` | invoice status NOT in `{issued, overdue}` (e.g. paid, voided, credited) |
| 409 | `online_payment_disabled` | `tenant_payment_settings.online_payment_enabled = false` OR `FEATURE_F5_ONLINE_PAYMENT=false` |
| 409 | `method_not_enabled` | requested method NOT in `tenant_payment_settings.enabled_methods` |
| 422 | `tenant_settings_incomplete` | tenant's `processor_publishable_key` / `processor_account_id` / `enabled_methods` missing |
| 422 | `invoice_data_corrupt` | F4 bridge detected a malformed invoice (e.g. negative `totalSatang`) and short-circuited before any Stripe call — no `payments` row inserted; client should not retry without operator intervention (F5R3v3 H-1) |
| 429 | `rate_limited` | rate limit exceeded; `Retry-After` header included |
| 502 | `processor_unavailable` | Stripe API call failed with retryable error after retries exhausted; no `payments` row inserted |
| 500 | `internal_error` | unexpected; correlation_id helps support trace |

### Side effects

- Inserts (or reuses) one `payments` row.
- Calls `processorGateway.createPaymentIntent({ amount: invoice.totalSatang, currency: 'thb', payment_method_types: [method], metadata: { invoiceId, tenantId, paymentId } }, idempotencyKey)`.
- Writes `payment_initiated` audit (FR-020) on first attempt; **does not write a duplicate audit on resume** (idempotency on `(payment_id, audit_event_type='payment_initiated')`).
- Emits `payments.initiate.count{tenant, method}` + `payments.initiate.duration_ms{tenant, method}` metrics.

---

## 2. `POST /api/payments/[id]/cancel`

Member-initiated cancellation (closes drawer mid-flow). Server-side calls Stripe `paymentIntents.cancel`.

**Auth**: `member` role + own-payment ownership.
**Rate limit**: 20 / 5 min per `(tenant_id, actor_user_id)`.

### Request

```
POST /api/payments/pmt_01J.../cancel
Cookie: __Host-session-id=…
```

(empty body)

### Response — 200 OK

```json
{
  "payment": {
    "id": "pmt_01J...",
    "status": "canceled",
    "completedAt": "2026-05-12T07:05:42.000Z"
  }
}
```

### Response — 4xx errors

| HTTP | `error.code` | When |
|------|--------------|------|
| 401 | `unauthorized` | no session |
| 403 | `payment_not_accessible` | payment does not exist, OR exists under a different tenant, OR exists but is not owned by the actor. **Collapsed opaque 403 for enumeration defence** (PCI F-02 / Threat OQ-1 / Constitution Principle I). The use-case still emits `payment_cross_tenant_probe` on the cross-tenant branch. |
| 409 | `payment_not_cancelable` | status ≠ `pending` (already terminal) |
| 502 | `processor_unavailable` | Stripe cancel failed; row NOT mutated |

### Side effects

- `UPDATE payments SET status='canceled', completed_at=now()`
- Audit `payment_canceled` with `actor_type='member'`

---

## 3. `POST /api/refunds/initiate`

Admin initiates a refund (full or partial) against a succeeded Payment.

**Auth**: `admin` role only; CSRF; same-origin. `manager` role is rejected (403).
**Rate limit**: 20 / 5 min per `(tenant_id, actor_user_id)`.
**Concurrency**: server-side `SELECT … FOR UPDATE` on `payments(id)` for the duration of the request to serialise concurrent refunds (FR-011b).

### Request

```
POST /api/refunds/initiate
Content-Type: application/json
Cookie: __Host-session-id=…
Idempotency-Key: <optional>

{
  "paymentId": "pmt_01J...",
  "amountSatang": 350000,                                  // > 0; ≤ remaining
  "reason": "Tier downgrade — partial refund of upgrade fee"
}
```

zod schema:

```ts
const InitiateRefundInput = z.object({
  paymentId: z.string().min(20).max(40),
  amountSatang: z.number().int().positive().max(2_000_000_000),  // 20M THB upper bound
  reason: z.string().min(1).max(500).regex(/^[^\r\n]+$/)         // single-line; HTML-escaped at render
});
```

### Response — 201 Created (refund accepted by Stripe)

```json
{
  "refund": {
    "id": "rfnd_01J...",
    "paymentId": "pmt_01J...",
    "invoiceId": "inv_01J...",
    "amountSatang": 350000,
    "reason": "Tier downgrade — partial refund of upgrade fee",
    "status": "succeeded",
    "processorRefundId": "re_3R...",
    "creditNoteId": "cn_01J...",                  // F4 credit note created
    "completedAt": "2026-05-15T03:14:22.456Z"
  },
  "payment": {
    "id": "pmt_01J...",
    "status": "partially_refunded",
    "refundedAmountSatang": 350000,
    "remainingRefundableSatang": 5000000
  },
  "invoice": {
    "id": "inv_01J...",
    "status": "partially_credited"
  }
}
```

### Response — 202 Accepted (async — awaiting processor confirmation)

An async Stripe refund (`pending` / `requires_action` at creation, e.g. some PromptPay/bank-debit rails) is NOT booked at creation time — no F4 credit note is created synchronously. The eventual `charge.refund.updated` webhook finalises it (§ contracts/stripe-webhook.md).

```json
{
  "refund": {
    "id": "rfnd_01J...",
    "status": "pending",
    "processorRefundId": "re_3R..."
  },
  "message": "Refund submitted — awaiting confirmation from the payment processor.",
  "messageThai": "ส่งคำขอคืนเงินแล้ว — กำลังรอการยืนยันจากผู้ให้บริการชำระเงิน",
  "correlationId": "01J..."
}
```

`error.code` `refund_pending` is NOT an error — it is the internal use-case outcome discriminator that the route maps to this 202 response (surfaced here for symmetry with the error table below; it never appears in an `error` envelope).

### Response — 4xx errors

| HTTP | `error.code` | When |
|------|--------------|------|
| 400 | `invalid_input` | zod failed |
| 401 | `unauthorized` | no session |
| 403 | `forbidden_role` | role ≠ `admin` |
| 404 | `payment_not_found` | id does not exist OR cross-tenant |
| 409 | `payment_not_refundable` | payment status ≠ `succeeded`/`partially_refunded` |
| 409 | `refund_exceeds_remaining` | `amountSatang > remaining` (FR-011b pre-flight) |
| 409 | `refund_in_progress` | another concurrent refund holds the row lock; client may retry |
| 502 | `processor_unavailable` | Stripe `refunds.create` failed with retryable error after exhausted retries; `refunds` row inserted with `status='failed'` |
| 502 | `f4_preflight_read_error` | the PRE-FLIGHT F4 credited-total read (`getInvoiceCreditedTotal`) failed BEFORE any Stripe call — money did NOT move, safe to retry, NO orphaned Stripe refund exists (DISTINCT from `f4_bridge_error` below — B.1 review Fix#1) |
| 502 | `f4_bridge_error` | Stripe `refunds.create` DID succeed but the POST-Stripe F4 credit-note bridge failed — money moved; ops reconciles via `docs/runbooks/out-of-band-refund.md` |

### Side effects (success path)

- Inserts `refunds` row with `status='pending'` then `'succeeded'` after Stripe returns
- Calls `processorGateway.createRefund({ payment_intent: <pi>, amount: amountSatang, reason: 'requested_by_customer', metadata: { refundId, reason } }, idempotencyKey)`
- Calls F4 `issueCreditNoteFromRefund(tenantCtx, invoiceId, { refundId, amountSatang, reason })` → returns `creditNoteId`
- Updates `payments.status` to `partially_refunded` or `refunded` per FR-011b
- Audits: `refund_initiated` → `refund_succeeded`; F4 audits `credit_note_issued` + `invoice_partially_credited` | `invoice_credited`
- Triggers F4 outbox row → emails member with credit-note PDF (per F4 FR-024 path) + body line "Refund of THB 3,500.00 processed on 2026-05-15"

### Side effects (failure path)

- `refunds` row remains with `status='failed'` + `failure_reason_code` from Stripe
- NO F4 credit note created (atomicity per FR-013)
- NO Payment.status change
- Audit `refund_failed`

---

## 4. Common request/response headers

Every F5 route sets:

| Header | Direction | Purpose |
|--------|-----------|---------|
| `X-Correlation-Id` | response | correlation id (echoed if request supplied; else generated) |
| `Strict-Transport-Security` | response | inherited from middleware HSTS |
| `Content-Security-Policy` | response | inherited; payment routes do NOT need Stripe CSP additions (those are page-level) |
| `Cache-Control: no-store, private` | response | no caching of payment responses |
| `Idempotency-Key` | request | optional — accepted on POST routes |
| `Retry-After` | response | set on 429 + 502 transient |

---

## 5. zod schema source-of-truth

All input/output schemas live in `src/modules/payments/application/schemas/` and are re-exported from `src/modules/payments/index.ts` so client components can use the SAME schema for client-side parsing. This is the contract — any drift between server zod and client usage = type error at build time.

---

## 6. Test fixtures (Stripe test mode)

| Fixture | Card / Method | Outcome |
|---------|---------------|---------|
| `4242424242424242` (any CVC, any future expiry) | Card | `payment_intent.succeeded` |
| `4000000000009995` | Card | `payment_intent.payment_failed` with `failure_reason_code='insufficient_funds'` |
| `4000002500003155` | Card | requires 3D Secure challenge, then succeeds |
| `4100000000000019` | Card | `payment_intent.payment_failed` with `failure_reason_code='card_declined'` |
| `stripe.confirmPromptPayPayment(testClientSecret)` | PromptPay | succeeds via test webhook after ~30s; harness uses `stripe trigger payment_intent.succeeded` for sync replay |
| `stripe trigger charge.refunded --override charge.id=<live_charge>` | Refund | injects an out-of-band refund event for FR-011a tests |

Used by `tests/contract/payments/*` and `tests/integration/payments/*`.
