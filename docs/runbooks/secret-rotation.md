# Runbook — Secret rotation

**Owner**: Platform on-call + Security
**Severity**: warn (planned) | critical (incident-driven)
**Source signal**: scheduled rotation (quarterly) OR `cron_bearer_auth_rejected` audit burst OR suspected compromise.
**Audit events**: `cron_bearer_auth_rejected` (cron path), `webhook_signature_rejected` (F5/F7 webhook paths)
**Last reviewed**: 2026-05-09 (F8 Phase 9 / T246)

---

## Scope

This runbook covers rotation of every secret currently provisioned in Vercel env for SweCham/Chamber-OS production:

| Secret | Owner feature | Storage | Rotation cadence | Dual-key support |
|---|---|---|---|---|
| `CRON_SECRET` | F4 + F5 + F7 + F8 cron coordinators | Vercel env | Quarterly | No (cutover) |
| `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` | F8 portal renewal-link signer | Vercel env | Quarterly | **Yes** (dual-key) |
| `RENEWAL_LINK_TOKEN_SECRET_FALLBACK` | F8 portal renewal-link verifier | Vercel env | Quarterly | **Yes** (dual-key) |
| `UNSUBSCRIBE_TOKEN_SECRET` | F7 unsubscribe link signer | Vercel env | Quarterly | No (cutover) |
| `STRIPE_SECRET_KEY` | F5 Stripe API + webhook | Vercel env | Annual or compromise | No (Stripe rolls keys) |
| `STRIPE_WEBHOOK_SECRET` | F5 webhook signature verify | Vercel env | Annual or compromise | No |
| `RESEND_API_KEY` | F1+F4+F8 transactional Resend | Vercel env | Annual or compromise | No |
| `RESEND_BROADCASTS_API_KEY` | F7 broadcasts (separate pool) | Vercel env | Annual or compromise | No |
| `RESEND_BROADCASTS_WEBHOOK_SECRET` | F7 webhook signature verify | Vercel env | Annual or compromise | No |
| `AUTH_COOKIE_SIGNING_SECRET` | F1 session cookie | Vercel env | Annual (forces sign-out) | No |
| `KV_REST_API_TOKEN` / `UPSTASH_REDIS_REST_TOKEN` | Rate-limit cache | Upstash dashboard | Annual or compromise | No |

**NEVER** rotate without first documenting the trigger reason in the change-log + the affected secret in this runbook's "Last rotation" table.

---

## A. Cutover rotation (single-key secrets)

Used for: `CRON_SECRET`, `UNSUBSCRIBE_TOKEN_SECRET`, `STRIPE_*`, `RESEND_*`, `AUTH_COOKIE_SIGNING_SECRET`, Upstash tokens.

1. **Generate new value** (≥32 random bytes):
   ```bash
   openssl rand -hex 32
   ```
   For Stripe / Resend / Upstash: use the provider's dashboard rotate-key flow.

2. **Stage the new value in Vercel preview env** first:
   ```bash
   vercel env add <SECRET_NAME> preview
   ```
   Trigger a preview deployment; verify the affected feature works end-to-end (e.g. fire a manual cron pass, send a test reminder email, click an unsubscribe link).

3. **Promote to production**:
   ```bash
   vercel env add <SECRET_NAME> production
   vercel env rm <SECRET_NAME> production --previous   # remove old value
   ```
   Trigger a production redeploy. **Production redeploy is the cutover moment** — old secret invalidated immediately. Sessions signed with old `AUTH_COOKIE_SIGNING_SECRET` will sign-out users; `CRON_SECRET` rotation requires the cron-job.org Bearer to be updated within ≤5 min to avoid `cron_bearer_auth_rejected` audit burst.

4. **Update external systems** (cron-job.org Bearer headers, Stripe webhook endpoint, Resend webhook endpoint) within the cutover window. cron-job.org provides a UI to bulk-update Bearer across the 7 chamber endpoints.

5. **Monitor for 24h**: watch `cron_bearer_auth_rejected` + `webhook_signature_rejected` audit counters. Sustained >5/min is a **cutover-window failure** (external system not updated) — flip the rotated secret back via Vercel rollback to previous deployment.

6. **Audit trail**: append the rotation to the "Last rotation" table at the bottom of this file.

---

## B. Dual-key rotation (F8 renewal link tokens)

Used for: `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` + `RENEWAL_LINK_TOKEN_SECRET_FALLBACK`. The dual-key procedure is mandatory because in-flight reminder emails carry tokens signed with the OLD key — a cutover would invalidate every unclicked link in the wild.

Reference: research.md R16 (renewal-link token rotation).

**Procedure** (4-step rolling window):

1. **Step 1 — Pre-rotation state**: PRIMARY = key-A (used to sign new tokens), FALLBACK = empty or previous key. Verifier accepts tokens signed with either.

2. **Step 2 — Promote**: copy current PRIMARY → FALLBACK. PRIMARY remains key-A.
   ```bash
   vercel env pull .env.production.tmp
   # set RENEWAL_LINK_TOKEN_SECRET_FALLBACK = current RENEWAL_LINK_TOKEN_SECRET_PRIMARY
   vercel env add RENEWAL_LINK_TOKEN_SECRET_FALLBACK production
   ```
   Redeploy. Verifier still accepts key-A (now via FALLBACK lookup).

3. **Step 3 — Generate new key-B**:
   ```bash
   openssl rand -hex 32
   ```
   Set as new PRIMARY:
   ```bash
   vercel env rm RENEWAL_LINK_TOKEN_SECRET_PRIMARY production
   vercel env add RENEWAL_LINK_TOKEN_SECRET_PRIMARY production   # paste key-B
   ```
   Redeploy. **All NEW tokens signed with key-B; OLD tokens still verify against key-A via FALLBACK**.

4. **Step 4 — Drain window** (30 days = max token TTL per FR-026): wait. Once any in-flight token signed with key-A has either been redeemed, expired, or rendered moot by a completed renewal, the old key is no longer needed. Audit `renewal_self_service_initiated` events to confirm zero new initiations against key-A.

5. **Step 5 — Drain & remove FALLBACK**:
   ```bash
   vercel env rm RENEWAL_LINK_TOKEN_SECRET_FALLBACK production
   ```
   Redeploy. Final state: PRIMARY = key-B, FALLBACK = empty. Rotation complete.

**Compromise-driven** (suspected secret leak): collapse the 30-day drain window to ≤24h. Send a portal-broadcast notice to all members with active reminder cycles asking them to re-request a renewal link. Audit-trail every member affected.

---

## Compromise response (any secret)

1. **Pin** `READ_ONLY_MODE=true` in Vercel env + redeploy → stops every state-changing route in 30s. F8 cron coordinators short-circuit per Phase 9 / T241.
2. **Revoke** the suspected secret at the provider (Stripe / Resend / Upstash) immediately.
3. **Rotate** per Section A or B above with `--previous` flag set to ensure old value gone.
4. **Audit-trail review**: query `audit_log` for the 24h window before suspicion timestamp; flag anomalous `cron_bearer_auth_rejected` / `webhook_signature_rejected` / cross-tenant probe rows.
5. **Postmortem** within 5 business days; file under `docs/postmortems/`.

---

## Last rotation

| Secret | Date | Trigger | Operator |
|---|---|---|---|
| _none_ | — | — | — |
