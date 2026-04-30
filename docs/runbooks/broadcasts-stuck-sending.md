# Runbook — `broadcasts_stuck_sending`

**Owner**: Platform on-call (escalate to chamber admin if member-side communication needed)
**Severity**: alarm (broadcast delivery may be stuck; member quota slot may be inappropriately consumed)
**Source signal**: `broadcasts.stuck_sending_count` gauge (≥ 1 broadcast in `status='sending'` for > 24h triggers alarm) · audit `broadcast_resend_resource_missing` (R2-NEW-3 — emit lands Phase 3+ T161 reconciliation cron)
**Audit events**: `broadcast_resend_resource_missing` · `broadcast_send_timeout_completed` · `broadcast_failed_to_dispatch`
**Last reviewed**: 2026-04-29 (Batch D T032 spec scaffolding)
**Status**: SPEC — emit sites + reconciliation cron land Phase 3+ (T161); operational triage assumes the cron + audit events exist.

---

## Symptom

A broadcast row has been sitting in `status='sending'` for > 24h without transitioning to `sent` or `failed_to_dispatch`. The state-machine trigger from migration 0064 allows `sending → sent` and `sending → failed_to_dispatch` only — no automatic timeout. The 24h reconciliation cron (T161, R2-NEW-3) detects + emits `broadcast_resend_resource_missing` when the Resend API confirms the broadcast resource is missing or in a non-recoverable terminal state.

## Why this matters

- Member quota slot is in limbo: the broadcast has consumed `reserved` but not yet `quota_year_consumed` (FR-007 — only set on `sent` transition). Member is blocked from new submissions if cap reached.
- Recipients may or may not have received the email — Resend Broadcasts may have completed dispatch + the webhook event simply never arrived, OR Resend may have failed mid-dispatch.
- F4 transactional emails (auth invitations, invoice notifications) on the SAME Resend account are unaffected — F7 Broadcasts is a separate Resend product with its own dispatch queue.

---

## Triage steps (in order)

1. **Identify stuck broadcasts**.
   ```sql
   SELECT broadcast_id, requested_by_member_id, sending_started_at, resend_broadcast_id, subject
     FROM broadcasts
    WHERE tenant_id = $tenant
      AND status = 'sending'
      AND sending_started_at < now() - interval '24 hours';
   ```

2. **Cross-check Resend Broadcasts dashboard**.
   - Open Resend Dashboard → Broadcasts → search by `resend_broadcast_id` from step 1.
   - Status options:
     - **"sent"** at Resend → webhook event was lost; manually transition our row + emit `broadcast_send_timeout_completed`.
     - **"queued"** or **"sending"** at Resend → Resend's queue is stuck; engage Resend support.
     - **"cancelled"** at Resend → unusual; may indicate manual cancellation in Resend dashboard. Sync our row to `failed_to_dispatch` + emit `broadcast_failed_to_dispatch` with reason `resend_dashboard_cancellation`.
     - **Resource not found** at Resend → emit `broadcast_resend_resource_missing` + transition to `failed_to_dispatch`. This is the R2-NEW-3 path.

3. **Check delivery aggregate**.
   ```sql
   SELECT status, COUNT(*) FROM broadcast_deliveries
    WHERE tenant_id = $tenant AND broadcast_id = $stuck_id GROUP BY status;
   ```
   If `delivered` rows ≈ `estimated_recipient_count` → Resend completed dispatch but the bulk-completion webhook was lost. Safe to manually transition to `sent`.

4. **Manual remediation** (when Resend confirms dispatch but our row is stuck).
   - Phase 3+ admin UI (T124) will surface a "Force complete" action; for now this is a DB-level operation:
     ```sql
     -- Manual transition `sending → sent` with audit chain
     -- (Run inside `BEGIN;` … `COMMIT;` so the audit row + state flip are atomic)
     UPDATE broadcasts
        SET status = 'sent',
            sent_at = now(),
            quota_year_consumed = $current_quota_year,
            quota_consumed_at = now()
      WHERE tenant_id = $tenant
        AND broadcast_id = $stuck_id
        AND status = 'sending';

     -- Then INSERT a row in audit_log with event_type = 'broadcast_send_timeout_completed'
     -- (Phase 3+ adapter does this automatically)
     ```
   - The state-machine trigger (migration 0064) allows `sending → sent` so this UPDATE will succeed.
   - Verify: `quota_year_only_on_sent` CHECK constraint requires both `quota_year_consumed` + `quota_consumed_at` to be set on `sent`.

5. **Resend resource missing** — special case (R2-NEW-3).
   - If Resend returns 404 on `retrieveBroadcast(resend_broadcast_id)`, the upstream resource was deleted (rare; possibly Resend retention policy). Transition to `failed_to_dispatch` with reason `resend_resource_missing` + audit emit `broadcast_resend_resource_missing`.
   - Quota refund applies (member's `reserved` slot is released; nothing was actually sent).

---

## Escalation

- **≥ 3 broadcasts stuck across multiple members** → likely Resend Broadcasts service incident; check status.resend.com + engage Resend support.
- **Stuck broadcast contains time-sensitive content** (e.g., event reminder past event date) → notify originating member that dispatch may have been incomplete; offer corrective broadcast at no quota cost via admin proxy-submit.
- **R2-NEW-3 path triggers repeatedly** → may indicate webhook signature secret rotation lost track of in-flight broadcasts. See [credential-compromise.md](./credential-compromise.md).

---

## Recovery

After remediation:

1. Verify `broadcasts.stuck_sending_count` gauge returns to 0 within 1 reconciliation cron tick (~5 min).
2. Member quota counter rebalances automatically on next page load.
3. Document the incident if root cause was platform-side bug; file P1 if recurrent.

---

## Prevention

- Phase 3+ T161 reconciliation cron runs every 5 minutes and detects stuck broadcasts within 24h SLA.
- Webhook handler idempotency (FR-025 via UNIQUE `(tenant_id, resend_event_id)` index — migration 0065) prevents duplicate processing.
- Resend webhook delivery is at-least-once with 30-day retry window; lost events are rare but possible.
