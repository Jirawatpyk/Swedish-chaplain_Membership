# Runbook — `broadcasts_dispatch_failure`

**Owner**: Platform on-call
**Severity**: page (member-facing dispatch broken; quota slot consumed without delivery)
**Source signal**: `broadcasts.dispatch_failure_rate` gauge (> 10% / 1h triggers page) · counter `broadcasts.failed_to_dispatch.count` increment
**Audit events**: `broadcast_failed_to_dispatch` (Status: SPEC, emit lands Phase 3+ T100 / approve-broadcast use-case)
**Last reviewed**: 2026-04-29 (Batch D T032 spec scaffolding)
**Status**: SPEC — emit sites land Phase 3+ (T100 admin-approve fail path); operational triage assumes the metrics + audit emission exist.

---

## Symptom

Broadcasts are transitioning `approved → failed_to_dispatch` at elevated rate. Possible causes:

1. **Resend Broadcasts API outage** — Resend's create-broadcast or send-broadcast endpoint returning 5xx.
2. **Resend account quota exhausted** — chamber's monthly Broadcasts quota hit.
3. **Resend account suspended** — rare; would require chamber legal-counsel engagement.
4. **Application bug** — recent deploy broke the dispatch logic in `approve-broadcast.ts` or the bridge adapter.
5. **Idempotency-key collision** — same broadcast_id retried with a stale `inv-{tenantId}-{broadcastId}` key (Phase 3+ T100 handles this).

## Why this matters

- Member quota slot is at risk: `failed_to_dispatch` releases the `reserved` slot (FR-003); member can re-submit. But if the failure is platform-side, member sees inconsistent UX (broadcast vanishes; they don't know why).
- Admin-side queue may pile up if approvals fail repeatedly — admin loses confidence in the platform.
- Sustained failure rate > 10% indicates infrastructure incident, NOT user-side issue.

---

## Triage steps (in order)

1. **Verify the metrics signal**.
   - Vercel Analytics → `F7 Dispatch` dashboard → confirm `dispatch_failure_rate` spike is real (not just metric noise from low denominator).
   - Compare against `broadcasts.send_started.count` (denominator) — failure rate is meaningful only when ≥ 10 send attempts in window.

2. **Identify failed broadcasts + reasons**.
   ```sql
   SELECT broadcast_id, requested_by_member_id, failed_to_dispatch_at,
          failure_reason
     FROM broadcasts
    WHERE tenant_id = $tenant
      AND status = 'failed_to_dispatch'
      AND failed_to_dispatch_at > now() - interval '1 hour'
    ORDER BY failed_to_dispatch_at DESC;
   ```
   Group `failure_reason` to identify the dominant cause:
   - `resend_5xx_*` → Resend service outage (cause 1 above).
   - `resend_429` or `resend_quota_exceeded` → Resend rate-limit / quota (cause 2).
   - `resend_403_account_suspended` → Resend account issue (cause 3).
   - Anything mentioning "TypeError" / "undefined" → app-side bug (cause 4).

3. **Check Resend status page**.
   - status.resend.com → confirm Resend is fully operational. If incident posted → coordinate with Resend status update; cause 1 confirmed.

4. **Check Resend Broadcasts quota**.
   - Resend Dashboard → Broadcasts → Usage → check monthly send count vs plan limit.
   - If near limit → cause 2; engage chamber business owner to upgrade Resend plan or pause F7 dispatches.

5. **Recent deploy correlation**.
   - Vercel Deployments → if the alert started immediately after a deploy that touched `src/modules/broadcasts/application/use-cases/approve-broadcast.ts` or `src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts` → roll back via `vercel rollback <previous-deployment-url>` immediately.

6. **Idempotency-key collision check**.
   ```sql
   SELECT broadcast_id, COUNT(*) FROM broadcasts
    WHERE tenant_id = $tenant
      AND resend_broadcast_id IS NOT NULL
    GROUP BY broadcast_id, resend_broadcast_id
    HAVING COUNT(*) > 1;
   ```
   Should return 0 rows — the partial unique index `broadcasts_resend_broadcast_id_uniq` prevents collisions at DB level. If it returns rows, that's a P0 platform bug.

---

## Escalation

- **Resend incident confirmed** → flip `FEATURE_F7_BROADCASTS=false` (kill-switch) to halt new submissions; document incident; resume after Resend recovery.
- **Resend account suspension** → chamber legal-counsel + Resend support ticket; F7 effectively offline until resolved.
- **App-side bug** → roll back deploy; engage F7 feature engineer for fix + new spec-kit gate iteration.
- **Persistent failure with no clear cause** → escalate to platform engineer; capture sample failed broadcast_id + audit chain + Resend response body (redacted of any PII).

---

## Recovery

After fix is deployed:

1. Verify `broadcasts.dispatch_failure_rate` returns to baseline (< 1%) within 1h.
2. Notify originating members via [admin-side proxy email] that they can re-submit failed broadcasts at no quota cost (failed_to_dispatch already released the slot).
3. If kill-switch was flipped → re-enable after 30-min clean window.

---

## Prevention

- Phase 3+ retry policy with exponential backoff (1/2/4/8/16s × 5) per CHK020 — handles transient Resend 5xx automatically without surfacing as `failed_to_dispatch`.
- Monthly Resend quota monitoring; alert at 80% to give admin lead time to upgrade.
- Pre-deploy verification: `pnpm test:integration tests/integration/broadcasts/` GREEN required.
