# F5 — Contract: Stripe Webhook (`POST /api/webhooks/stripe`)

**Branch**: `009-online-payment`
**Date**: 2026-04-23
**Source**: `spec.md` FR-007…FR-010 + FR-011a + FR-026, `plan.md` § Reliability, `data-model.md` § 5, `research.md` § 3 + § 7.
**Purpose**: pin the contract for the Stripe → Chamber-OS webhook endpoint: signature verification, idempotency, event dispatch, environment + API-version segregation, tenant resolution, and per-event-type behaviour.

---

## 1. Endpoint

```
POST /api/webhooks/stripe
Runtime: Node.js (NOT Edge — raw body required for HMAC verification)
Authentication: Stripe signature header ONLY (no session, no CSRF, no API key)
Body parser: disabled — handler reads raw body via NextRequest.text()
```

`next.config.mjs` (or route segment config) opts the route OUT of body parsing:

```ts
export const config = { api: { bodyParser: false } };
// App Router equivalent: read request.text() before any json parsing
```

---

## 2. Required headers

| Header | Required | Notes |
|--------|----------|-------|
| `Stripe-Signature` | YES | HMAC-SHA256 of `<timestamp>.<payload>` keyed with the endpoint secret. Verified by `stripe.webhooks.constructEvent(rawBody, sigHeader, secret)`. |
| `Content-Type` | YES | `application/json; charset=utf-8` |
| `User-Agent` | (informational) | Logged for audit; not authoritative |

Missing `Stripe-Signature` → **401** + audit `webhook_signature_rejected{reason='missing_header'}` + NO body parse.

---

## 3. Verification + idempotency pipeline

```
┌──────────────────────────────────────────────────────────────────────────┐
│ POST /api/webhooks/stripe                                                │
└──────────────────────────────────────────────────────────────────────────┘
   │
   ▼
1. Read raw body (request.text())
   │
   ▼
2. Read Stripe-Signature header
   │   missing → 401 + audit webhook_signature_rejected{reason='missing_header'}
   │
   ▼
3. webhookVerifier.constructEvent(rawBody, sig, ENDPOINT_SECRET)
   │   throws → 401 + audit webhook_signature_rejected{reason='bad_signature'|'tampered_body'}
   │
   ▼
4. Check event.livemode matches process.env.STRIPE_LIVE_MODE
   │   mismatch → 200 OK + audit payment_environment_mismatch + insert processor_event with outcome='rejected_environment_mismatch'
   │   (200 prevents Stripe retry storms; we acknowledge the mismatch but do nothing)
   │
   ▼
5. Check event.api_version matches STRIPE_API_VERSION env var
   │   mismatch → 200 OK + audit webhook_api_version_mismatch + insert processor_event with outcome='rejected_api_version_mismatch'
   │   (per FR-026; does NOT process the event because schema may differ)
   │
   ▼
6. Insert into processor_events (id=event.id, outcome='processed', payload_sha256=hash(rawBody))
   │   ON CONFLICT (id) DO NOTHING — if already exists, return 200 (idempotency, FR-008)
   │   (this is the ONLY pre-tenant-resolution table write — see plan.md § Constitution Check Principle I)
   │
   ▼
7. Resolve tenant via tenant_payment_settings.processor_account_id = event.account
   │   not found → 200 OK + audit (warn) + processor_event.outcome='acknowledged_only'
   │
   ▼
8. UPDATE processor_events SET tenant_id=<resolved> WHERE id=event.id
   │
   ▼
9. runInTenant(tenantCtx, async () => dispatch by event.type)
   │
   ▼
10. UPDATE processor_events SET processed_at=now()
   │
   ▼
   200 OK
```

All non-200 paths emit metrics + audit BEFORE returning. Stripe will retry 5xx responses with exponential backoff for up to 3 days; we MUST NEVER return 5xx for "could not match an in-app row" — that is a 200 + warning log + audit, NOT a server error.

---

## 4. Per-event-type contract

### 4.1 `payment_intent.succeeded`

Trigger: a PaymentIntent settled successfully (card captured, PromptPay transfer received, etc).

**Behaviour**:

```
1. SELECT … FOR UPDATE on payments WHERE processor_payment_intent_id = event.data.object.id
   │   not found → 200 OK + warn log "payment_intent.succeeded for unknown intent"
   │
2. Read F4 invoice via getInvoiceForPayment(tenantCtx, payments.invoice_id)
   │
3. If invoice.status NOT IN ('issued', 'overdue'):
   │   AUTO-REFUND in full via processorGateway.createRefund({payment_intent, amount}, idempotencyKey)
   │   audit payment_auto_refunded_stale_invoice with cause = 'invoice_voided' | 'invoice_credited' | 'invoice_already_paid'
   │   200 OK + admin alert
   │   STOP HERE
   │
4. UPDATE payments SET status='succeeded', processor_charge_id=event.data.object.latest_charge, completed_at=event_time, card_brand+card_last4+card_exp_*=...(if card)
   │
5. Audit payment_succeeded
   │
6. Invoke F4 markPaidFromProcessor(tenantCtx, invoice_id, { method, paymentIntentId, chargeId, settlementDate })
   │   F4 transitions invoice → paid, generates receipt PDF, enqueues outbox email, audits invoice_paid
   │   atomic with our payments UPDATE in same Postgres tx
   │
7. 200 OK
```

**Idempotency**: step 6 (F4 markPaid) is idempotent per F4 FR-007. Re-delivery of same event id never creates duplicate receipts.

**Test contract** (`tests/contract/payments/post-webhooks-stripe-events.contract.test.ts`):

- Fixture event with `livemode=true`, `api_version=<pinned>`, `data.object={id:'pi_test_1', amount:5350000, currency:'thb', latest_charge:'ch_test_1', payment_method_types:['card'], charges.data[0].payment_method_details.card.last4='4242', brand='visa', exp_month=12, exp_year=2027}`
- Expected: `payments.status='succeeded'`, `payments.card_last4='4242'`, F4 `invoices.status='paid'`, `audit_log` rows: `payment_succeeded`, `invoice_paid`

---

### 4.2 `payment_intent.payment_failed`

**Behaviour**:

```
1. SELECT … FOR UPDATE on payments
   │   not found → 200 + log
2. UPDATE payments SET status='failed', failure_reason_code=event.data.object.last_payment_error.code, completed_at=event_time
3. Audit payment_failed
4. 200 OK
```

No F4 invocation. No auto-refund.

---

### 4.3 `payment_intent.canceled`

**Behaviour**:

```
1. SELECT … FOR UPDATE on payments
   │   not found → 200 + log (canceled an intent we don't know about — rare, e.g. via Stripe dashboard)
2. UPDATE payments SET status='canceled', completed_at=event_time
3. Audit payment_canceled with actor_type='webhook'
4. 200 OK
```

If our own `POST /api/payments/[id]/cancel` call triggered the cancel, the audit may show two canceled events (one from member, one from webhook). The second is a no-op state-wise — `UPDATE … WHERE status='pending'` returns 0 rows when the row is already canceled.

---

### 4.4 `charge.refunded`

The single most subtle event because it covers BOTH our in-app refunds AND out-of-band refunds (FR-011a).

**Behaviour** (per refund object inside the event):

```
For each refund in event.data.object.refunds.data:
  1. SELECT FROM refunds WHERE processor_refund_id = refund.id
  2. If found:
       - in-app refund — already created by /api/refunds/initiate
       - if status='pending', UPDATE status='succeeded' + completed_at
       - else no-op (we already updated it inline at the API call)
  3. If NOT found:
       - OUT-OF-BAND REFUND DETECTED (FR-011a)
       - audit out_of_band_refund_detected with refund_id, charge_id, amount, runbook_url='docs/runbooks/out-of-band-refund.md'
       - emit metric out_of_band_refund_rejected_total{tenant, processor_env}
       - alert admin via standard alert channel
       - DO NOT create F4 credit note
       - DO NOT change payment status
       - 200 OK (Stripe doesn't care about our reconciliation choice)
```

---

### 4.5 `charge.dispute.created`

**Behaviour**:

```
1. SELECT FROM payments WHERE processor_charge_id = event.data.object.charge
   │   not found → 200 + log
2. Audit dispute_created with dispute_id, amount, reason
3. Alert admin via standard alert channel + link to runbook (post-MVP `docs/runbooks/payment-dispute.md` — TBD)
4. 200 OK
```

NO state machine for disputes in MVP. Admin handles via Stripe dashboard.

---

### 4.6 Other events

Any event type NOT in {`payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `charge.dispute.created`} is acknowledged + recorded in `processor_events` with `outcome='acknowledged_only'`. Returns 200. Logs at INFO level for observability.

This catches forward-compatibility events that future Stripe API versions may add — we never 4xx/5xx an unknown event type because that triggers Stripe retry storms.

---

## 5. Response shapes

| HTTP | Body | When |
|------|------|------|
| 200 | `{"received": true}` | All accepted/processed/idempotent-replay paths |
| 401 | (empty) | Missing or invalid signature |

200 always returns the same JSON envelope so Stripe sees a consistent successful response regardless of internal processing branch. Stripe does NOT inspect the response body; only the HTTP status matters.

---

## 6. Webhook secret rotation

Rotation procedure (operational runbook):

1. Generate new webhook endpoint in Stripe Dashboard alongside the old one (Stripe permits multiple active endpoints per account).
2. Set `STRIPE_WEBHOOK_SECRET_ROTATING` env var to the new secret in Vercel; redeploy.
3. Update the verifier to try BOTH secrets in `Promise.any` — accept verification from either; log which one matched.
4. Wait for the old endpoint to receive zero events for 24 hours (Stripe replays unprocessed events for up to 30 days; 24h is the operational window for SweCham's volume).
5. Delete the old endpoint in Stripe Dashboard.
6. Set `STRIPE_WEBHOOK_SECRET = STRIPE_WEBHOOK_SECRET_ROTATING`; unset `_ROTATING`; redeploy.

Documented in `docs/runbooks/stripe-webhook-rotation.md` (post-MVP runbook).

---

## 7. Stripe IP allowlist (optional, defense-in-depth)

Stripe publishes its source IP ranges. Our endpoint MAY allowlist these for an additional defence layer (refuse other IPs at the WAF), but this is NOT a substitute for signature verification — Stripe's IPs occasionally change and signature verification is the authoritative check. MVP does NOT ship the allowlist (not worth the operational burden); defer to post-MVP if signature-rejection metric shows abuse traffic.

---

## 8. Test contract

`tests/contract/payments/post-webhooks-stripe-events.contract.test.ts` exercises:

- (a) signature missing → 401
- (b) signature malformed → 401
- (c) signature valid + livemode mismatch → 200 + audit `payment_environment_mismatch`
- (d) signature valid + api_version mismatch → 200 + audit `webhook_api_version_mismatch`
- (e) signature valid + duplicate event id → 200 + no side-effect
- (f) signature valid + `payment_intent.succeeded` happy path → 200 + Payment.status='succeeded' + F4 markPaid called
- (g) signature valid + `charge.refunded` for unknown refund → 200 + audit `out_of_band_refund_detected`
- (h) signature valid + unknown event type → 200 + processor_event.outcome='acknowledged_only'
- (i) Tenant resolution miss → 200 + audit warn

`tests/integration/payments/webhook-signature.test.ts` adds the cross-cutting "verify before parse" assertion (signature failure path completes BEFORE we attempt to JSON.parse the body).
