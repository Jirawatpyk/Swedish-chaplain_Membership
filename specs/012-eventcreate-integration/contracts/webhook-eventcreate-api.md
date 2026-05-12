# Contract: EventCreate Webhook Receiver

**Endpoint**: `POST /api/webhooks/eventcreate/v1/{tenantSlug}`
**Runtime**: Node.js (NOT Edge) — needs raw body for HMAC verify
**Auth**: HMAC-SHA256 signature in `X-Chamber-Signature` (no session, no API key)
**FR refs**: FR-001..FR-013, FR-015..FR-018, FR-037

This is F6's only public endpoint. Every chamber tenant operating an EventCreate Zap points its "Webhooks by Zapier" action at the tenant-specific URL on this endpoint.

---

## Request

### URL parameters

| Param | Type | Notes |
|-------|------|-------|
| `tenantSlug` | string | The tenant's URL slug (e.g., `swecham`). Resolved against the `tenants` table; on miss → HTTP 404. Tenant context is set from this value AND cross-checked against the tenant whose secret verifies the signature (FR-006). |

### Required headers

| Header | Value | Notes |
|--------|-------|-------|
| `Content-Type` | `application/json` | Strict — non-JSON returns 415 |
| `X-Chamber-Signature` | `sha256=<hex>` | HMAC-SHA256 hex of `${timestamp}.${rawBody}` keyed by tenant webhook secret (FR-002) |
| `X-Chamber-Timestamp` | `<unix epoch seconds>` | Must satisfy `abs(server_now - timestamp) <= 300` else 401 (FR-003) |
| `X-Request-ID` | UUID v4 (or any opaque string) | Idempotency key, persisted in `eventcreate_idempotency_receipts` (F6-owned table; see data-model § 1.4) with `source='eventcreate_webhook'`; duplicates within 7d return 409 (FR-004) |

### Body schema (zod, see `data-model.md` § 10)

```jsonc
{
  "eventType": "attendee.registered",      // or "purchase.completed"
  "tenantSlug": "swecham",                  // informational only — tenant resolved from URL path
  "event": {
    "externalId": "event_abc123",
    "name": "SweCham Midsummer Celebration 2026",
    "description": null,
    "startDate": "2026-06-21T18:00:00+07:00",
    "endDate": "2026-06-21T22:00:00+07:00",
    "location": "Anantara Riverside, Bangkok",
    "category": "networking",
    "isMemberDiscounted": true,
    "isPartnerBooth": false,
    "eventCreateUrl": "https://events.swecham.com/midsummer-2026"
    // unknown keys preserved into events.metadata per FR-011a
  },
  "attendee": {
    "externalId": "att_xyz789",
    "email": "jane@fogmaker.com",
    "fullName": "Jane Andersson",
    "companyName": "Fogmaker International AB",
    "ticketType": "Member — Free",
    "ticketPricePaid": 0,
    "paymentStatus": "paid",
    "registeredAt": "2026-06-01T10:23:15Z",
    "metadata": { "dietary": "vegetarian" }
    // unknown keys preserved into event_registrations.metadata per FR-011a
  }
}
```

---

## Responses

### 200 OK — `webhook_receipt_verified`

The signature verified, the timestamp was in range, the request ID was new, and the strict-transactional ACID unit (FR-037) committed successfully. The event row was upserted, the registration row was inserted, quota effects applied if applicable.

```jsonc
{
  "ok": true,
  "matched": "member_contact",            // 'member_contact' | 'member_domain' | 'member_fuzzy' | 'non_member' | 'unmatched'
  "matchedMemberId": "01H1ABC...",         // ULID, null if non-member/unmatched
  "eventCreated": true,                    // true if this delivery created the event row; false if upserted
  "registrationId": "01H2DEF...",
  "quotaEffect": {
    "countedAgainstPartnership": false,
    "countedAgainstCulturalQuota": true
  }
}
```

### 401 Unauthorized — `webhook_signature_rejected` OR `webhook_replay_rejected`

Generic body — never reveal which failure (FR-002, oracle prevention):

```jsonc
{
  "type": "https://chamber-os.app/errors/webhook-unauthorized",
  "title": "Webhook authentication failed",
  "status": 401,
  "detail": "Signature or timestamp validation failed. See audit log for outcome."
}
```

### 409 Conflict — `webhook_duplicate_rejected`

The `X-Request-ID` was already processed within the 7-day window. **No side effects.**

```jsonc
{
  "type": "https://chamber-os.app/errors/duplicate-webhook",
  "title": "Duplicate webhook delivery",
  "status": 409,
  "detail": "Request ID was already processed.",
  "requestId": "01ARZ3NDEKTSV4RRFFQ69G5FAV"
}
```

### 400 Bad Request — `webhook_malformed_rejected`

Required field missing or wrong type. Body lists field-level errors (Zod):

```jsonc
{
  "type": "https://chamber-os.app/errors/malformed-webhook",
  "title": "Webhook payload validation failed",
  "status": 400,
  "errors": [
    { "path": "attendee.email", "message": "Invalid email address" }
  ]
}
```

### 415 Unsupported Media Type

Non-JSON `Content-Type`:

```jsonc
{
  "type": "https://chamber-os.app/errors/unsupported-media-type",
  "title": "Unsupported media type",
  "status": 415,
  "detail": "Expected Content-Type: application/json"
}
```

### 429 Too Many Requests — `webhook_rate_limit_exceeded`

Tenant exceeded 60 req/min (FR-005). Header `Retry-After: <seconds>` set.

### 503 Service Unavailable — `ingest_disabled_tenant_admin` / `ingest_disabled_super_admin`

Tenant's `tenant_webhook_configs.enabled = FALSE` OR super-admin kill switch on. Header `Retry-After: 3600` set (FR-033).

### 5xx Internal Server Error — `webhook_rolled_back`

The strict-transactional ACID unit (FR-037) failed mid-flight and rolled back. The failure audit (`webhook_rolled_back`) is emitted in a separate post-rollback transaction. Zapier retries via standard backoff; on successful retry the idempotency receipt is fresh (no duplicate-side-effect risk).

---

## Signature computation (Zapier-side)

```text
message    = `${X-Chamber-Timestamp}.${rawBody}`
signature  = hmac_sha256_hex(tenant_webhook_secret_active, message)
X-Chamber-Signature header = `sha256=${signature}`
```

Verification side uses `crypto.timingSafeEqual` against both `webhook_secret_active` and (within 24h grace window) `webhook_secret_grace`. The Zapier Formatter step computes the HMAC using its built-in Crypto utility.

---

## Idempotency semantics

| Header | Layer | Behaviour |
|--------|-------|-----------|
| `X-Request-ID` | Transport idempotency | Same value within 7d → 409 (no side effects); persisted in F6-owned `eventcreate_idempotency_receipts` table. Different values for same logical attendee → fall through to attendee-externalId dedup. |
| `attendee.externalId` | Domain idempotency | Same `(tenant_id, event_id, external_id)` → 200 with original `matched` + `registrationId` (FR-011). New side effects: zero. |

Both layers are inside the same DB transaction per FR-037 → no race conditions possible.

---

## Audit events emitted

Per request, exactly one of these:

| HTTP outcome | Audit event |
|--------------|-------------|
| 200 success | `webhook_receipt_verified` (with `processing_outcome` payload field) PLUS one of `attendee_matched_*` / `attendee_non_member` / `attendee_unmatched` PLUS quota events if applicable |
| 200 (via 24h grace key) | `webhook_secret_grace_used` (additional) |
| 401 signature | `webhook_signature_rejected` |
| 401 timestamp | `webhook_replay_rejected` |
| 401 cross-tenant | `cross_tenant_probe` (high severity) |
| 409 | `webhook_duplicate_rejected` |
| 400 | `webhook_malformed_rejected` |
| 429 | `webhook_rate_limit_exceeded` |
| 503 | `ingest_disabled_tenant_admin` or `ingest_disabled_super_admin` |
| 5xx (rolled back) | `webhook_rolled_back` (in separate tx post-rollback) |

---

## Tests

Contract tests live in `tests/contract/events/webhook-eventcreate-v1.test.ts` and cover every response status code + audit-event mapping above. Integration tests in `tests/integration/events/` exercise the full ACID unit per `plan.md` Testing § list.
