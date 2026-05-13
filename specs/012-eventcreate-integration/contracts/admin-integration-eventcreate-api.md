# Contract: Admin Integration Config — EventCreate

**Route prefix**: `/api/admin/integrations/eventcreate/**`
**Runtime**: Node.js
**Auth**: F1 session cookie — **`admin` role only** (FR-035)
**FR refs**: FR-022..FR-025, FR-008, FR-024, FR-033, FR-035

All endpoints are admin-only. The **entire `/admin/integrations/eventcreate/**` route prefix returns 404 for both `manager` and `member`** (surface-disclosure prevention per FR-035 — the existence of secret-bearing surfaces is sensitive). `role_violation_blocked` audit is emitted on every blocked attempt regardless of the returned status code. All endpoints scope to current tenant via `runInTenant`.

**Navigation visibility (R1, revised 2026-05-13 post-Phase-5-shakedown)**:

The admin sidebar / left-nav entry for `/admin/integrations/eventcreate` is **shown by default whenever the F6 kill-switch (`FEATURE_F6_EVENTCREATE`) is enabled** for the deployment. The route layer (page server component + 5 API route handlers) gates surface disclosure via the same kill-switch + admin-only role check (FR-035), so showing the nav entry never leaks the surface to non-admin actors.

**Why the revision** (original strict R1 → relaxed):
- Original R1 (drafted Session 2026-05-12 round 2): hide the entry when `(a) no tenant_webhook_configs row exists AND (b) last_received_at IS NULL for 30 days`, to avoid cluttering the workspace of CSV-only tenants.
- During Phase 5 implementation shakedown the strict R1 logic created a chicken-and-egg discoverability trap: a fresh tenant has no row → entry hidden → admin must reach the wizard via direct URL or the events-list empty-state CTA → but the events-list nav entry itself was a Phase 4 gap (never added). End-to-end the wizard was unreachable from the sidebar for any tenant on day 1.
- This contract section explicitly classified the toggle as "purely a navigation-affordance decision" — the relaxation stays within that licence and is documented here for spec-drift traceability rather than relying solely on the tasks.md completion note.

**Currently active behaviour**:
- `FEATURE_F6_EVENTCREATE=false` → entry hidden, route 404, surface invisible.
- `FEATURE_F6_EVENTCREATE=true` → entry visible to admin role. Manager + member still receive 404 + `role_violation_blocked` audit at the route layer (FR-035 unchanged).

**Future per-tenant opt-out** (deferred): an `isEventcreateNavVisible(tenantSlug)` resolver remains exported from `src/lib/events-admin-integration-deps.ts` as a public helper; if a CSV-only tenant requests suppression, a per-tenant flag wired through `staffNavConfig.NavItem.visibilityFlag` can route to that resolver without re-deriving the freshness logic.

**Phase 4 gap fix bundled in this Phase 5 ship**: a missing `/admin/events` nav entry (no Phase 4 task added it) was added under the same `staffNavConfig.sections[0]` group so admins can reach the events list — which carries the "Set up EventCreate integration" empty-state CTA (FR-020 / US2 AS5 variant a) — from the sidebar without typing the URL.

---

## GET /api/admin/integrations/eventcreate

**FR**: FR-022 · Returns the integration config view + recent deliveries (FR-009 audit-derived).

**Query params**:

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `includeTestDeliveries` | boolean | false | When true, recent-deliveries panel shows all deliveries including `webhook_test_invoked` short-circuit rows. Default behaviour filters them out (per R5) so real production traffic isn't crowded out by test webhooks during Zap-setup debugging. |

### 200 OK

```jsonc
{
  "webhookUrl": "https://swecham.chamber-os.app/api/webhooks/eventcreate/v1/swecham",
  "secretConfigured": true,
  "secretLastFour": "1a2b",            // never the full secret post-initial-reveal
  "graceActiveUntil": null,             // ISO timestamp if rotation is within 24h; else null
  "ingestEnabled": true,                // FR-033
  "lastReceivedAt": "2026-06-01T10:23:15Z",
  "recentDeliveries": [
    {
      "receivedAt": "2026-06-01T10:23:15Z",
      "requestId": "01ARZ...",
      "signatureOutcome": "verified",
      "processingOutcome": "matched_member_contact",
      "matchedMemberId": "01H...",
      "registrationId": "01H..."
    }
    // ... up to 10
  ],
  "recentDeliveriesIncludeTests": false   // R5 — by default the panel shows the last 10 NON-TEST deliveries
                                          //  (test rows have processing_outcome = 'short_circuited_test' per P8).
                                          //  Admin can toggle "Include test deliveries" to see all 10.
}
```

### 200 OK — first visit (no secret yet)

```jsonc
{
  "webhookUrl": "https://swecham.chamber-os.app/api/webhooks/eventcreate/v1/swecham",
  "secretConfigured": false,
  "ingestEnabled": false,
  "recentDeliveries": []
}
```

---

## POST /api/admin/integrations/eventcreate/generate-secret

**FR**: FR-024 · One-time-reveal flow. Generates a fresh 32-byte secret, persists, returns the **plaintext value exactly once**. Cannot be called again unless secret was never generated OR was just rotated (see `/rotate-secret`).

### 200 OK

```jsonc
{
  "ok": true,
  "secret": "whsec_eY3...REDACTED_FULL_VALUE_HERE",
  "secretLastFour": "1a2b",
  "warning": "Store this value in a password manager. It will not be shown again."
}
```

### 409 Conflict

Secret already exists. Caller must use `/rotate-secret` instead.

### 404 Not Found — non-admin actor

Manager OR member attempting any endpoint on this route prefix. Surface-disclosure prevention per FR-035. `role_violation_blocked` audit emitted.

### Audit

`webhook_secret_generated` on success; `role_violation_blocked` on non-admin attempt.

---

## POST /api/admin/integrations/eventcreate/rotate-secret

**FR**: FR-008 · Rotates the active secret. Current `webhook_secret_active` moves to `webhook_secret_grace`, `grace_rotated_at = NOW()`, new active secret generated and returned one-time.

### 200 OK

```jsonc
{
  "ok": true,
  "secret": "whsec_NEW_VALUE...",
  "secretLastFour": "3c4d",
  "graceActiveUntil": "2026-05-13T08:42:00Z",
  "warning": "Old secret continues to verify for 24h. Update Zapier within this window."
}
```

### 429 Too Many Requests

3 rotations/hour per (tenant, actor) exceeded.

### Audit

`webhook_secret_rotated` (includes `previous_secret_last_four` and `new_secret_last_four`).

---

## POST /api/admin/integrations/eventcreate/test-webhook

**FR**: FR-023 · Sends a synthetic, signed payload to this tenant's own webhook URL and polls audit log for the result. Roundtrip should complete in <2s.

**Scope of the "Test webhook" feature (P8)**: the test verifies the **signature + transport round trip only** — it does NOT exercise the full ingest path:

1. The synthetic payload uses sentinel event + attendee external IDs (e.g., `event_external_id = '__test_webhook__'`, `attendee_external_id = '__test_webhook__-<timestamp>'`).
2. The receiver detects the sentinel external IDs at the very top of the ingest handler (BEFORE the strict-transactional ACID unit opens) and short-circuits — no rows are inserted into `events` or `event_registrations`, no quota is touched, no idempotency receipt is recorded.
3. The receiver still verifies the HMAC signature + timestamp skew + tenant-context match (the full security envelope) and emits a `webhook_test_invoked` audit row with `processing_outcome = 'short_circuited_test'`.
4. The admin sees in the recent-deliveries panel a row with `processing_outcome = 'short_circuited_test'` confirming the signature + transport works end-to-end.

This avoids the "what's the test event? does it get archived afterwards?" complexity: there's no event row to clean up because none was ever created. If the admin wants to verify the full ingest path (match logic, quota effects), they trigger a real Zap from EventCreate with a low-stakes test attendee and archive that event row afterwards.

### 200 OK — round-trip succeeded

```jsonc
{
  "ok": true,
  "testRequestId": "test-01H...",
  "deliveredAt": "2026-05-12T08:43:11Z",
  "verifiedAt": "2026-05-12T08:43:11Z",
  "processingOutcome": "matched_member_contact",  // synthetic uses a known seed contact
  "durationMs": 142
}
```

### 200 OK — but verification failed (informational, NOT a server error)

```jsonc
{
  "ok": false,
  "testRequestId": "test-01H...",
  "deliveredAt": "2026-05-12T08:43:11Z",
  "signatureOutcome": "rejected",
  "failureCategory": "signature_mismatch",        // diagnostic only; recovery is admin's
  "hint": "Did you save the secret correctly? Try rotating and reconfiguring Zapier."
}
```

### 429 Too Many Requests

10 tests/hour per (tenant, actor) exceeded.

### Audit

`webhook_test_invoked` (PLUS whatever the round-trip side emits — `webhook_receipt_verified` or `webhook_signature_rejected` etc.).

---

## POST /api/admin/integrations/eventcreate/disable

**FR**: FR-033 (per-tenant kill switch — admin-controlled portion) · **Body**: `{ "enabled": boolean, "reason": "string" }`

Toggles `tenant_webhook_configs.enabled`. When false, future webhook POSTs return 503.

### Audit

`ingest_disabled_tenant_admin` (when disabling) OR `ingest_disabled_tenant_admin` again with `enabled=true` payload (when re-enabling). Super-admin kill switch is a separate (super-admin-only) endpoint not in this contract.

---

## RBAC matrix (FR-035)

| Endpoint | admin | manager | member |
|----------|-------|---------|--------|
| GET (config view) | ✅ | ❌ 404 + audit | ❌ 404 + audit |
| POST generate-secret | ✅ | ❌ 404 + audit | ❌ 404 + audit |
| POST rotate-secret | ✅ | ❌ 404 + audit | ❌ 404 + audit |
| POST test-webhook | ✅ | ❌ 404 + audit | ❌ 404 + audit |
| POST disable | ✅ | ❌ 404 + audit | ❌ 404 + audit |

Both `manager` and `member` get **404** uniformly on this entire route prefix (NOT 403) per FR-035 because the existence of secret-bearing surfaces is itself sensitive disclosure. Distinction from `/admin/events/**`: there, manager has read access (200 on GET, 403 on mutations) since "events exist for this tenant" is not sensitive — but the secret/rotation/test surface is. Audit `role_violation_blocked` emitted on every blocked attempt regardless of returned status.
