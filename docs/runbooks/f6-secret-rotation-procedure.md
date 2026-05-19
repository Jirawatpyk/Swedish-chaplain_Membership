# F6 Webhook Secret Rotation — Procedure Runbook

**Purpose**: SOP for rotating a chamber's webhook secret with the 24h grace window
**Audience**: Maintainer + chamber admin
**Last reviewed**: 2026-05-17 (Phase 10 T134)

## When to rotate

- **Routine**: every 6 months (recommended; not enforced).
- **Incident-driven**: suspected secret leak / replay attack / Zap re-vendor / departing admin had secret access.
- **Cycle restart**: after a `force_expire_grace_secret` event you want a fresh grace window.

## Pre-flight checks

- [ ] Confirm chamber admin is available for a 30-minute window — they must update Zapier within the 24h grace period or live webhooks will fail.
- [ ] Verify `audit_log` is healthy: `SELECT MAX("timestamp") FROM audit_log WHERE tenant_id = $1` — if > 5 minutes stale, rotate AFTER audit recovery.
- [ ] Notify DPO if rotation is incident-driven (PDPA Section 37 breach evaluation may be required).

## Procedure

### 1. Admin initiates rotation in the wizard

Path: `/admin/integrations/eventcreate` → Phase C → "Rotate webhook secret".

Admin sees a confirmation dialog showing:
- New secret last-4 (preview)
- Grace expiry timestamp (NOW + 24h, Asia/Bangkok)
- "I've saved this to a password manager" acknowledgement checkbox

Admin clicks "Rotate now" → system:
- INSERTs the new active secret into `tenant_webhook_configs.webhook_secret_active`
- MOVES the previous active secret to `webhook_secret_grace` with `grace_rotated_at = NOW()`
- Emits `webhook_secret_rotated` audit
- Increments `eventcreate_webhook_secret_rotated_total` counter
- Returns the plaintext NEW secret (one-time-reveal — never persisted in plaintext)

### 2. Admin saves the plaintext secret

Critical step — the plaintext is **shown once** in the dialog. Admin MUST:
- Copy the full secret (43-character base64url string)
- Paste into the Zapier integration's "Webhook secret" field
- Save the Zap

### 3. Verify with test webhook

In the wizard, admin clicks "Send test webhook" — this triggers a signed delivery FROM the chamber's Zap (or a synthetic local probe). System verifies:
- Signature matches the new active secret → `webhook_test_invoked` audit with `outcome: verified_with_active`
- Recent Deliveries panel refreshes showing the test row

If test fails → cause is most likely Zap not yet updated. The 24h grace window covers this — the OLD secret continues to verify for 24 hours.

### 4. Grace window monitoring

For 24 hours after rotation:
- Both old (grace) and new (active) secrets verify
- Every delivery that hits the grace path emits `webhook_secret_grace_used` audit
- Watch `audit_log WHERE event_type = 'webhook_secret_grace_used' AND tenant_id = $1` — should DROP to zero within an hour as Zapier picks up the new secret
- If grace events persist past 12 hours → coordinate with admin to verify Zap was actually saved

### 5. Grace expiry (T+24h)

- Drizzle adapter's verify path automatically refuses grace secrets older than 24h
- Any delivery still signed with the old secret returns `signature_rejected` → `f6-webhook-signature-burst.md`

## Emergency: force-expire grace early

If a leak is confirmed and you need to invalidate the old secret immediately:

```typescript
import { runForceExpireGraceSecret } from '@/lib/events-admin-deps';
await runForceExpireGraceSecret(tenantSlug, { actorUserId, occurredAt: new Date() });
```

Emits `webhook_secret_grace_force_expired` audit. Any Zap still on the old secret will start rejecting immediately — coordinate with admin first.

## Rollback

If the new secret was mis-saved by admin AND grace is still active:
- Admin can keep using the OLD secret (grace verifies) and the next rotation re-establishes a fresh active.
- After grace expires (24h), if admin lost the new secret, the only recovery is to rotate AGAIN — the previously-revealed plaintext is gone (never persisted).

## Constitution compliance

- Principle I tenant isolation: rotation runs inside `runInTenant`; the new secret is RLS-scoped.
- Principle IV PCI DSS: rotation is not PCI-scope (no card data).
- Principle VIII Reliability: the rotation is a single tx; partial failure rolls back via `runInTenantWithRollbackOnErr`.

## Verification after rotation

- [ ] `webhook_secret_rotated` audit row present with correct last-4
- [ ] Counter `eventcreate_webhook_secret_rotated_total` incremented
- [ ] Test webhook returns `verified_with_active`
- [ ] No `webhook_signature_rejected` audits in the next 30 minutes
- [ ] Grace events stop within 12 hours of rotation
