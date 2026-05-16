# F6 Webhook Signature Burst — Runbook

**Alert source**: `eventcreate_webhook_receipts_total{signature_outcome!='verified'}` rate > 5/min per tenant for 10 minutes
**Severity**: P2 (does not page; routes to maintainer email via Resend)
**Last reviewed**: 2026-05-17 (Phase 10 T131)

## Symptoms

- Vercel log-based alert fires with subject `F6 SIGNATURE BURST`.
- Grafana / OTel dashboard shows the `signature_outcome` label cardinality (`rejected_signature`, `rejected_no_config`, `rejected_grace_expired`) dominating `verified`.
- Admin email may include a forwarded "test webhook failing" report from a chamber.

## 5 most-likely root causes (ranked by historical frequency)

1. **Zapier secret rotation mismatch** — Admin rotated the webhook secret via the wizard but did not update the corresponding Zap. The 24h grace window has now expired and every delivery rejects.
2. **Secret leak / replay attack** — A third party obtained an old secret and is replaying captured payloads. Signature verifies against an active or grace secret BUT the request body has been tampered or the timestamp is far outside the freshness window.
3. **Clock drift** — Zapier server clock or our Vercel function clock has skewed > 5 minutes, so HMAC timestamp tolerance window rejects valid deliveries.
4. **Schema drift** — Zapier started sending a new payload field that our zod schema rejects BEFORE signature verification (rare; only if Zap was edited mid-flight).
5. **Misconfigured Zap** — A different tenant's Zap was accidentally pointed at this tenant's webhook URL. The cross-tenant signature mismatches.

## Triage steps

1. **Confirm scope**: Vercel logs → filter `event:f6_webhook_signature_outcome AND signature_outcome != verified` for the last 1 hour. If single tenant → cause (1) / (5). If multiple tenants → cause (3).
2. **Pull last 10 rejected deliveries**: query `audit_log WHERE event_type = 'webhook_signature_rejected' AND tenant_id = $1 ORDER BY emitted_at DESC LIMIT 10`. Look at `payload.rejectionReason` field for the precise sub-cause.
3. **Probe the test webhook**: ask the admin to click "Send test webhook" in `/admin/integrations/eventcreate`. A success indicates the ACTIVE secret works → cause (5) on the Zap side. A failure indicates the secret is rotated and stale → cause (1).
4. **Inspect signature header**: `audit_log.payload.signaturePresent` + `signatureFreshnessSeconds` — if `freshness > 300` → cause (3). If `secretIdentifier` does not match either active or grace → cause (2).
5. **Look for cross-tenant probes**: `audit_log WHERE event_type = 'cross_tenant_probe'` for the same window. If present → cause (5).

## Mitigations

| Cause | Action | Owner |
|---|---|---|
| (1) Rotation mismatch | Walk admin through Zapier secret update (see `f6-secret-rotation-procedure.md`). Optionally extend grace window by emergency re-rotation with admin still possessing old. | Maintainer + admin |
| (2) Replay attack | Force-expire grace via `runForceExpireGraceSecret` use-case + rotate to fresh active secret. Notify DPO if PII exposure suspected. | Maintainer (DPO if PII) |
| (3) Clock drift | Check Vercel Fluid Compute region health. Notify Zapier if their clock is the issue. | Maintainer |
| (4) Schema drift | Compare incoming payload (from `audit_log.payload.malformedFields`) against `eventcreate-payload.ts` zod schema. Update schema if Zapier added new fields; coordinate with chamber to revert Zap if undesired field surface change. | Maintainer |
| (5) Misconfigured Zap | Disable ingest via `runToggleIngest({enabled:false})` until misconfig resolved. | Maintainer |

## Verification after mitigation

- Probe the test webhook → expect `signature_outcome=verified`.
- Watch `eventcreate_webhook_receipts_total` rate for 15 minutes → confirm `rejected_*` rate drops below alert threshold.
- Confirm no new `webhook_signature_rejected` audit rows for the affected tenant in the next 30 minutes.

## Escalation

- **2 hours unresolved**: maintainer escalates to DPO (PDPA Section 37 breach notification consideration).
- **24 hours unresolved**: re-evaluate as P1 if signature failures correlate with member-facing data loss.

## Related runbooks

- `f6-secret-rotation-procedure.md` — SOP for clean secret rotation
- `f6-audit-fallback-double-failure.md` — when audit emit ALSO fails on rejection paths
- `f6-admin-event-detail-not-found.md` — distinguish enumeration from signature failure
