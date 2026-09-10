# Runbook — `broadcasts_stuck_sending`

**Owner**: Platform on-call (escalate to chamber admin if member-side communication needed)
**Severity**: alarm (broadcast delivery may be stuck; member quota slot may be inappropriately consumed)
**Source signal**: `broadcasts.stuck_sending_count` gauge (≥ 1 broadcast in `status='sending'` for > 24h triggers alarm) · audit `broadcast_resend_resource_missing` (R2-NEW-3 — emit lands Phase 3+ T161 reconciliation cron)
**Audit events**: `broadcast_resend_resource_missing` · `broadcast_send_timeout_completed` · `broadcast_failed_to_dispatch`

> **108 PR-C**: there is NO `audience_building` state — the audience is resolved
> inside the dispatch tick and a failed build rejects the tick (retried next
> tick), so a broadcast cannot be "stuck building". A slow or refused build is
> `broadcast-audience-build.md`, not this runbook.

> **Single-audience vs batched**: this runbook covers SINGLE-AUDIENCE (≤10k) broadcasts stuck in `sending`. A `broadcast_send_timeout_completed` event is the 24h single-audience reconcile giving up on lost webhooks — a genuine timeout incident. A BATCHED (>10k) broadcast that rolls up to `partially_sent` emits the dedicated **`broadcast_partially_sent`** event (NOT `broadcast_send_timeout_completed`) — that is a NORMAL completion (≥1 batch failed or, at the 24h batched backstop, never confirmed), handled by the batch roll-up sweep (`reconcile-stuck-sending` cron → `sweepBatchCompletion`), not this single-audience path. Do not page on `broadcast_partially_sent` as a stuck-sending incident.
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

   **2b. What the cron does with each of those, since 2026-09-10 (follow-up 1).** The reconciler reads the SAME status and acts on exactly one of them: **`sent`** → it completes the row itself (`sending → sent`, quota consumed, `broadcast_send_timeout_completed` + `broadcast_sent` + `broadcast_quota_consumed`, delivery summary emailed — `sent_at` is now Resend's own `sent_at`, not the reconcile moment). **Every other present status** (`queued`, `sending`, `cancelled`, `draft`, or one this build does not recognise) is reported as **`unresolved_provider_status`** and the row is LEFT in `sending`: no transition, no quota consumed, no audit row, no email. Find it by `broadcasts.reconcile_unresolved_status.total{observed_status}` (alarm on any rate > 0) or the log line `broadcasts.reconcile.unresolved_provider_status` (critical, carries `broadcastId` + `resendBroadcastId` + `observedResendStatus`); the cron summary counts it as `unresolved_provider_status` and the tick returns 200 (nothing of ours failed). It re-reports every 15 minutes until you act — that is the alarm staying up, not a retry storm.

   **Two things a parked row does that you must know before acting** (whole-branch review of the follow-ups PR, 2026-09-10):
   - **It holds NO quota slot.** `countMemberQuotaBucketsOnTx` counts `submitted | approved` as reserved and `sent | partial_delivery_accepted` as used — `sending` is in neither. That is pre-existing (it was always true for the ≤ 24 h window); this outcome makes the window unbounded. So a member at cap N with one parked row can submit another, and hand-completing the parked one later makes the year's `sent` = N + 1. Run `countForMemberQuota` (or the § 1 query with `status IN ('sent','partial_delivery_accepted')`) for that member BEFORE step 4, and if they are at cap decide with the chamber whether the parked send counts.
   - **It takes a pre-select slot every tick.** The cron reads the 50 OLDEST `sending` rows (`ORDER BY sending_started_at ASC LIMIT 50`) and a parked row never leaves that set; at 50 parked rows a newer genuinely-sent-but-webhook-lost row is never reconciled. Structural, and unreachable at SweCham's scale (≈ 10 broadcasts / member / year) — but if `unresolved_provider_status` in the tick summary ever approaches 50, resolve the oldest first for that reason alone.

   Why the cron does not decide these: before this outcome existed, `markSent` never read the status, so ANY present resource consumed the member's annual quota — and the round-6 dispatch defect (a row advanced to `sending` with nothing sent) reached its harm here: quota burned, `broadcast_sent` audited, delivery summary emailed, for mail that never went out. Only `draft` is a MEASURED never-sent; `cancelled` and a stale `queued` are unmeasured in both directions. A decision in an append-only table with 5–10 year retention is the wrong place for a guess, so the guess is yours, with the dashboard and step 3 in front of you:
   - `draft` → the send never happened. Apply step 5's transition by hand (`sending → failed_to_dispatch`, reason `resend_resource_never_sent`; the reserved quota slot is released by the status alone) and tell the member yourself — the FR-021 notification is enqueued by the dispatch use case, not by a manual UPDATE. Then find out why the row reached `sending` with a draft behind it: that is a dispatch defect, not a Resend one.
   - `queued` / `sending` → engage Resend support (step 2 above); do NOT complete the row on the strength of the status alone — step 3's delivery aggregate is the evidence, and if it shows delivery, step 4.
   - `cancelled` → step 2's existing procedure (`failed_to_dispatch`, reason `resend_dashboard_cancellation`) once you have confirmed nothing went out.
   - unrecognised → the SDK or API moved under us; `resend.broadcasts.unknown_status` (error) carries the raw value. Add it to `normaliseStatus` and deploy, or resolve the row by hand from the dashboard.

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
