# F6 Webhook Precondition Burst — Runbook

**Alert source**: rate(audit `webhook_ingest_precondition_failed`) > 2/min per tenant for 5 minutes
**Severity**: P2 (routes to maintainer email via Resend)
**Last reviewed**: 2026-05-17 (Phase 10 T131)

## Symptoms

- Vercel alert fires with subject `F6 PRECONDITION BURST`.
- `audit_log.payload.preconditionKind` distribution dominated by:
  - `ingest_disabled` (admin paused ingest)
  - `feature_flag_off` (FEATURE_F6_EVENTCREATE=false)
  - `body_oversized` (>1 MB)
  - `request_id_replay` (idempotency cache hit)
- Webhooks return 200 (idempotent) or 412 / 503 (gated) but no row written.

## Root causes

1. **Intentional admin pause** — chamber admin toggled `runToggleIngest({enabled:false})` via the wizard during incident response or rotation.
2. **Feature flag toggled off** — env var `FEATURE_F6_EVENTCREATE` flipped to false in Vercel dashboard (deliberate kill-switch use).
3. **Body oversize burst** — Zapier or attacker sending payloads exceeding the 1 MB rejection threshold.
4. **Idempotency cache replay** — Zapier retrying same `X-Request-ID` multiple times. Normal protective behavior unless the same key fires >100/hour.
5. **Body-decode race** — internal — corrupted POST body decode hits the precondition check before body validation.

## Triage steps

1. **Determine precondition mix**: SQL query against `audit_log`:
   ```sql
   SELECT payload->>'preconditionKind' AS kind, COUNT(*)
   FROM audit_log
   WHERE event_type = 'webhook_ingest_precondition_failed'
     AND emitted_at > NOW() - INTERVAL '15 minutes'
     AND tenant_id = $1
   GROUP BY 1 ORDER BY 2 DESC;
   ```
2. **Check ingest_disabled state**: `SELECT enabled, ingest_paused_at, ingest_paused_by FROM tenant_webhook_configs WHERE tenant_id = $1`. If `enabled=false` → cause (1). Confirm with admin via email/chat that the pause was intentional.
3. **Verify feature flag**: `env.features.f6EventCreate` — if false in prod env vars → cause (2). Coordinate with maintainer.
4. **Profile body sizes**: `SELECT AVG((payload->>'bodyBytes')::int), MAX((payload->>'bodyBytes')::int) FROM audit_log WHERE event_type='webhook_ingest_precondition_failed' AND payload->>'preconditionKind' = 'body_oversized' AND emitted_at > NOW() - INTERVAL '1 hour'`. If max > 5 MB → suspect attacker; if 1-2 MB → suspect Zap adding large attachments.
5. **Check idempotency replay rate**: `SELECT COUNT(DISTINCT request_id) FROM audit_log WHERE event_type='webhook_ingest_precondition_failed' AND payload->>'preconditionKind' = 'request_id_replay' AND emitted_at > NOW() - INTERVAL '1 hour'`. Compare against unique requestIds — if ratio > 10:1 → Zap retry storm.

## Mitigations

| Cause | Action |
|---|---|
| (1) Intentional pause | No action; silence alert for 2 hours via Vercel dashboard. Schedule re-enable. |
| (2) Flag off | No action if intentional. If unintentional → restore flag + redeploy. |
| (3) Body oversize | Review Zap output — likely chamber added a large field. Coordinate with chamber to trim. If attacker → escalate to security review. |
| (4) Idempotency replay | If Zap retry storm — adjust Zap retry/backoff config. F6 absorbs idempotently; no data loss. |
| (5) Body-decode race | Pull Vercel runtime logs for `event:f6_webhook_body_decode_failed`. Likely transient; if repeating, file bug + check function memory pressure. |

## Verification

- Watch alert window for 15 minutes → rate drops below threshold.
- Run a successful test webhook → confirms ingest path is healthy.

## Escalation

- **30 minutes unresolved + member-impacting** (e.g., chamber's actual webhook deliveries are being lost) → escalate to P1.
