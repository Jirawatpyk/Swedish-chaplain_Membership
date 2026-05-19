# Broadcasts Audit Event Taxonomy Changes — Operations Coordination

**Owner**: Platform engineering
**Audience**: Ops, on-call, dashboard maintainers
**Last update**: 2026-05-19 (Phase 3F.11.18)

## Summary

F7.1a Phase 3F.11.3 (commit `1a9870db`) split the
`broadcast_cross_tenant_probe` audit event into two distinct events
based on actor + forensic intent:

| Event type | Actor | Forensic intent | SIEM relevance |
|---|---|---|---|
| `broadcast_cross_tenant_probe` | admin or member | **Security-forensic** — actor attempted to access another tenant's broadcast | HIGH (page on-call) |
| `broadcast_webhook_batch_missing` | `system:resend-webhook` | **Operational-forensic** — benign Resend webhook race (admin force-deleted batch between BYPASSRLS lookup + incrementCounter) | LOW (log only) |

Migration `0173_f71a_webhook_batch_missing_event.sql` added the new
event type to the `audit_event_type` enum. The single use-case emit
site at `apply-batch-webhook-event.ts:108` was updated to emit the new
type instead of the old.

## What changed for ops dashboards

### IF you have a dashboard query filtering on `broadcast_cross_tenant_probe`

**Before** (F71A pre-3F.11.3):
```sql
SELECT * FROM audit_log
WHERE event_type = 'broadcast_cross_tenant_probe';
```
This used to capture BOTH security probes AND the benign webhook race
window. Post-3F.11.3, this query MISSES the webhook race cases.

**Recommended update** (operational view):
```sql
SELECT * FROM audit_log
WHERE event_type IN (
  'broadcast_cross_tenant_probe',     -- security (paging)
  'broadcast_webhook_batch_missing'   -- operational (informational)
);
```

**Recommended update** (security-only view — for SIEM page alerts):
```sql
SELECT * FROM audit_log
WHERE event_type = 'broadcast_cross_tenant_probe';
-- This is now CORRECTLY filtered to genuine security signals only.
```

### IF you have an SLO / alert based on the old event type

Re-tune the threshold. Pre-3F.11.3, `broadcast_cross_tenant_probe`
fired on BOTH security probes + webhook races, so volume was the sum
of both. Post-3F.11.3, security-only volume should be near-zero on
healthy operation (genuine probes are rare attack telemetry).
Webhook-race volume baselines per the F-15 sweep metric (see runbook
`broadcasts-stuck-providerid-missing.md`).

## Verification queries

Run on live Neon to confirm both event types are emitting correctly:

```sql
-- Security-forensic only (admin + member actors)
SELECT
  to_char(created_at, 'YYYY-MM-DD HH24:MI') AS hour,
  actor_user_id,
  COUNT(*) AS n
FROM audit_log
WHERE event_type = 'broadcast_cross_tenant_probe'
  AND created_at > now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 1 DESC;

-- Operational-forensic only (Resend webhook system actor)
SELECT
  to_char(created_at, 'YYYY-MM-DD HH24:MI') AS hour,
  COUNT(*) AS n,
  COUNT(DISTINCT (payload->>'broadcastId')) AS distinct_broadcasts
FROM audit_log
WHERE event_type = 'broadcast_webhook_batch_missing'
  AND created_at > now() - interval '7 days'
GROUP BY 1
ORDER BY 1 DESC;
```

## Related events (F71A US1 audit taxonomy)

The full F71A US1 audit-event tuple (54 events, 5-year retention) is
defined in `src/modules/broadcasts/application/ports/audit-port.ts`.
Key F71A events relevant to ops:

| Event | Fires when | Severity |
|---|---|---|
| `broadcast_dispatched_in_batches` | `splitBroadcastIntoBatches` commits N batch_manifests | INFO (operational) |
| `broadcast_send_started` | `dispatchBroadcastBatch` sends a batch to Resend | INFO |
| `broadcast_failed_to_dispatch` | Resend gateway throws on any stage | WARN |
| `broadcast_resend_resource_missing` | Resend ACK received but DB persist of provider_broadcast_id failed (F-15 surface) | ERROR |
| `broadcast_partial_delivery_accepted` | Admin clicks "Accept partial delivery" | INFO |
| `broadcast_retry_initiated` | Admin clicks "Retry failed batches" | INFO |
| `broadcast_retry_completed` | All retry batches reach terminal | INFO |
| `broadcast_webhook_batch_missing` | Webhook race window — operational-forensic (NEW Phase 3F.11.3) | WARN |
| `broadcast_cross_tenant_probe` | Admin or member probed an unknown broadcast — security-forensic | ALERT |

## References

- `specs/014-email-broadcast-advance/findings-index.md` — Round 2/3 finding-ID taxonomy
- `src/modules/broadcasts/application/ports/audit-port.ts` — F7AuditEventType source of truth (54 events)
- `drizzle/migrations/0173_f71a_webhook_batch_missing_event.sql` — enum value addition
- `src/modules/broadcasts/application/use-cases/apply-batch-webhook-event.ts` — emit site
- Constitution v1.4.2 Principle I sub-clause 4 — forensic-trail mandate
