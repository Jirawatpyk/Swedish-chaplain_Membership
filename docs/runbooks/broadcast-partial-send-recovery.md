# Runbook — `broadcast_partial_send_recovery`

**Owner**: Platform on-call (escalate to chamber admin if member communication required)
**Severity**: alarm (sustained partial-send rate > 5% over 1h)
**Source signal**: `broadcasts.partial_send_count[1h] / broadcasts.submit.count[1h] > 0.05`
**Audit events**: `broadcast_partial_delivery_accepted` (admin acceptance — emitted by `accept-partial-delivery.ts`) · `broadcast_retry_initiated` + `broadcast_retry_completed` (retry path emitted by `retry-failed-batches.ts` + `auto-retry-failed-batches.ts`). Per-batch failure forensics live in `broadcast_batch_manifests.last_failure_reason` column (NOT a discrete audit event) + the metric `broadcasts.failed_to_dispatch.count{tenant, failure_reason}` + the pino log line `broadcasts.batch.failed_transition_db_write_failed`.
**Last reviewed**: 2026-05-21 (M3 Round 2 review fix — replaced nonexistent `broadcast_partial_delivery` + `broadcast_batch_failed` event refs with the real audit-event names from `audit-port.ts`).
**Status**: SPEC — operational once F7.1a US1 (pagination + per-batch dispatch) lands.

---

## Symptom

A broadcast has been marked `partially_sent` (some batches succeeded; some failed after the per-batch 3-retry budget exhausted). The admin sees a "retry failed batches" CTA on the broadcast detail page, with a per-batch breakdown.

A *sustained* partial-send rate above 5% over an hour fires this alarm — meaning systemic recovery effort is needed (one-off partial sends are expected baseline noise).

## Why this matters

- **Member-facing**: recipients in failed batches did not get the broadcast. Quota was consumed for sent batches but NOT for failed ones (per spec — quota is per-recipient, not per-broadcast).
- **Reputation impact**: chronic partial-send signals Resend account-level pressure (rate limit, suppression-list growth, reputation degradation).
- **Operational**: F7.1a's 3-retry per-batch budget is the *automatic* layer. This runbook covers the human decision tree once that budget exhausts.

## Triage steps (in order)

1. **Identify the failing broadcasts.**

   ```sql
   SELECT broadcast_id,
          requested_by_member_id,
          status,
          partial_delivery_accepted_at,
          manual_retry_count,
          (SELECT COUNT(*) FROM broadcast_batch_manifests
            WHERE tenant_id = $tenant
              AND broadcast_id = b.broadcast_id
              AND status = 'failed') AS failed_batches,
          (SELECT COUNT(*) FROM broadcast_batch_manifests
            WHERE tenant_id = $tenant
              AND broadcast_id = b.broadcast_id) AS total_batches
     FROM broadcasts b
    WHERE tenant_id = $tenant
      AND status = 'partially_sent'
      AND sending_started_at > now() - interval '24 hours'
    ORDER BY sending_started_at DESC;
   ```

   Cross-check against the admin UI batch breakdown surface — both should agree.

2. **Inspect the per-batch failure reason.**

   ```sql
   SELECT batch_index,
          recipient_count,
          status,
          last_failure_reason,
          last_failure_at,
          attempt_count
     FROM broadcast_batch_manifests
    WHERE tenant_id = $tenant
      AND broadcast_id = '$failing_broadcast_id'
    ORDER BY batch_index;
   ```

   Common `last_failure_reason` patterns:
   - `resend_429` — Resend account-level rate limit
   - `resend_5xx` — Resend incident
   - `resend_403` — likely sender-reputation hold; check Resend dashboard
   - `app_error` — Application-layer regression; surface in error log
   - `timeout` — per-batch dispatch > 300s function timeout (rare at K≤5 batches)

3. **Cross-check Resend account state.**

   Open Resend Dashboard:
   - **API → Rate limits**: are we hitting account-level caps? Inspect the rolling 1h send count vs the published per-account ceiling.
   - **Domains**: is the sending domain suspended or in reputation review?
   - **Suppressions**: did the failed batches share a member-segment with poor list quality?

4. **Decide: retry, accept-partial, or investigate.**

   See decision tree below.

## Decision tree

```
What is the dominant `last_failure_reason` across failed batches?

├── `resend_429` (rate limit)
│   ├── Is the burst over (current rolling 1h < ceiling)?
│   │   ├── Yes → admin clicks "retry failed batches" in admin UI.
│   │   │   Confirm batches transition `failed` → `pending` → `sent`.
│   │   │   Monitor `manual_retry_count{broadcast_id=$id}` metric.
│   │   └── No → wait until the rolling 1h window clears
│   │       (typically 30-60 min). Document in incident log.
│
├── `resend_5xx` or `resend_403` (Resend-side problem)
│   ├── Check Resend status page (status.resend.com).
│   │   ├── Active incident → wait for upstream resolution + retry.
│   │   └── No incident → engage Resend support directly with the
│   │       `resend_broadcast_id` from `broadcasts.resend_broadcast_id`.
│
├── `app_error`
│   ├── Pull the relevant trace from Vercel Logs by `broadcast_id`.
│   ├── Common root causes:
│   │   - F7 sanitiser regression (body_html shape drift)
│   │   - Allowlist hostname extraction failure (US2)
│   │   - Drizzle repo runtime error (RLS drift)
│   ├── If the bug is fixed in a follow-up deploy → retry batches.
│   └── If the bug is not yet fixed → accept-partial OR cancel
│       the broadcast (FR-008d).
│
└── `timeout`
    ├── Inspect `broadcasts_batch_dispatch_duration_ms` p99.
    │   ├── Sustained high → bump per-batch parallelism or shrink
    │   │   batch size. File a tuning ticket.
    │   └── One-off spike → safe to retry.

Mixed reasons → investigate per-batch trace before deciding.
```

## Accept-partial-delivery path (FR-008d)

When the failed batches cannot be recovered (suppression-list issue, Resend account-suspended, etc.):

1. Admin opens the broadcast detail page in `/admin/broadcasts/[id]`.
2. Clicks "Accept partial delivery" → confirmation modal explains:
   - Failed batches will NOT be retried.
   - Quota consumed remains per sent batches.
   - An audit event `broadcast_partial_delivery_accepted` fires.
3. Broadcast transitions to terminal state `partially_sent` with `partial_delivery_accepted_at` + `partial_delivery_accepted_by_user_id` filled.
4. Failed-batch members are NOT re-enqueued automatically — they will be eligible for the next broadcast.

## Retry-failed-batches path

When the failure reason is transient (rate limit cleared, Resend incident resolved):

1. Admin opens the broadcast detail page.
2. Clicks "Retry failed batches" → confirmation modal explains:
   - Up to 3 retries per batch (per `manual_retry_count` budget per FR-008d).
   - Already-sent batches will NOT be re-sent (idempotency key prevents duplicates).
   - Audit event `broadcast_batch_retry_initiated` fires per batch.
3. Per-batch `pg_advisory_xact_lock('broadcasts-retry:'+tid+':'+bid)` serialises concurrent admin retries (FR-008d).
4. Watch the `broadcasts_batch_dispatch_duration_ms{tenant,batch_index}` panel for the retry batches.

## Investigation path

If neither retry nor accept-partial fits — typically when bug-fix-pending:

1. Document in `docs/observability/incidents-log.md` with `broadcast_id`, root-cause hypothesis, ETA for fix.
2. Communicate ETA to the chamber admin via chamber-internal comms (out-of-band — the broadcast itself is the comms channel, so use Slack / email).
3. Once the fix lands in production: retry the failed batches (the retry button is idempotent — already-sent batches are not duplicated).

## Post-incident actions

- Add a one-line entry to `docs/observability/incidents-log.md` (date, broadcast_id, failure_reason, action taken, recovery duration).
- If repeated partial-sends within a tenant (≥ 3 in 30 days): review the tenant's list quality + Resend sender reputation + segment quotas.
- If repeated partial-sends across multiple tenants: file a follow-up ticket to revisit the per-batch parallelism cap (default 4) in `BatchConcurrencyPolicy`.

## Related runbooks

- `docs/runbooks/broadcasts-dispatch-failure.md` — generic dispatch-failure triage (F7 MVP)
- `docs/runbooks/broadcasts-perf-regression.md` — when latency rather than failure rate is the symptom
- `docs/runbooks/broadcast-deliverability-incident.md` — when bounce/complaint rates correlate with partial sends

## Reference

- F7.1a spec FR-008 + FR-008d (partial-send semantics, retry budget, accept-partial path)
- F7.1a plan.md § VIII (Reliability — advisory-lock namespace `broadcasts-retry:`)
- `src/lib/metrics/broadcasts-f71a.ts` `partialSendCount()` + `manualRetryCount()` + `batchDispatchDurationMs()`
- Admin UI surface: `src/app/(staff)/admin/broadcasts/[id]/page.tsx` (batch breakdown + retry modal)
