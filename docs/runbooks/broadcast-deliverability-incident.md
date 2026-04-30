# Runbook — `broadcast_deliverability_incident`

**Owner**: Platform on-call (escalate to chamber legal-counsel for Q14 SC-005 (b) > 5% complaint-rate breach)
**Severity**: alarm (deliverability spike risks Resend domain reputation lockout — affects ALL F1 transactional + F7 broadcast email)
**Source signal**: `broadcasts.bounce_rate_per_broadcast` gauge (> 2% per broadcast triggers warning; > 5% triggers Q14 SC-005 (b) auto-halt + page) · `broadcasts.complaint_rate_per_broadcast` gauge (≥ 0.1% triggers warning; ≥ 0.5% triggers page; > 5% triggers SC-005 (b) auto-halt)
**Audit events**: `broadcast_complaint_rate_per_broadcast_breach` (Q14 — Status: SPEC, emit lands Phase 3+ T100 / US2 admin-approve path) · `broadcast_complaint_received` · `broadcast_member_halted_pending_review` (R3-NEW-1) · `broadcast_member_dispatch_resumed` (admin clear-halt)
**Last reviewed**: 2026-04-29 (Batch D T032 spec scaffolding)
**Status**: SPEC — emit sites land Phase 3+ (T036+); operational triage steps assume the metrics + audit event tables exist and the kill-switch helper from T031 is wired into route handlers.

---

## Symptom

Resend webhook deliveries are firing `email.bounced` (hard bounce) or `email.complained` (recipient marked as spam) at elevated rates against a SweCham broadcast. The per-broadcast aggregation in `broadcast_deliveries` shows ≥ 2% bounce or ≥ 0.1% complaint relative to dispatched recipient count. Vercel Analytics dashboard `F7 Deliverability` shows a red row for one or more `broadcast_id` values.

## Why this matters

Resend tracks aggregate sender reputation per domain. Sustained bounces / complaints lead to:

1. **Soft-throttling** — Resend reduces our daily send quota silently (recoverable in 24-72h).
2. **Domain blacklisting** — major mailbox providers (Gmail, Outlook365) start dropping our messages without bounce, including F1 transactional (auth invitations, password resets, F4 invoice emails). RECOVERY TIME: WEEKS-MONTHS.
3. **PDPA / GDPR exposure** — a complaint is a strong signal the recipient was on a list they didn't expect. Per Q14 + SC-005 (b), per-broadcast complaint rate > 5% auto-halts the originating member's future broadcasts pending admin review (`broadcast_member_halted_pending_review` → manager-role users CANNOT clear; admin-only per FR-014).

A single bad broadcast can poison sender reputation for the whole tenant — the priority is to **stop the bleed first** (auto-halt is automatic; cancel any pending broadcast cron dispatches), then investigate the root cause.

---

## Triage steps (in order)

1. **Verify the metrics signal**.
   - Vercel Analytics → `F7 Deliverability` dashboard → confirm bounce_rate / complaint_rate spike correlates with the alert window.
   - Compare against the prior 7-day rolling baseline. A spike > 4× baseline is a confirmed incident; a spike < 2× is likely a single-broadcast outlier.
   - Identify the offending `broadcast_id` from the dashboard rows or via:
     ```sql
     SELECT broadcast_id, status, COUNT(*) FILTER (WHERE status='bounced') AS bounces,
            COUNT(*) FILTER (WHERE status='complained') AS complaints, COUNT(*) AS total
       FROM broadcast_deliveries
      WHERE tenant_id = $tenant
        AND event_timestamp > now() - interval '24 hours'
      GROUP BY broadcast_id, status
      ORDER BY total DESC;
     ```

2. **Confirm Q14 auto-halt fired** (if complaint rate > 5%).
   - `SELECT member_id, broadcasts_halted_until_admin_review FROM members WHERE tenant_id = $tenant AND broadcasts_halted_until_admin_review = true;`
   - Cross-check against `audit_log WHERE event_type = 'broadcast_complaint_rate_per_broadcast_breach' AND ...` for the audit emit timestamp.
   - If auto-halt did NOT fire despite > 5% complaint rate → escalate to platform engineer (auto-halt cron may have failed) AND manually set `broadcasts_halted_until_admin_review = true` for the offending member while investigating.

3. **Cancel any pending dispatches from the same member**.
   - `UPDATE broadcasts SET status = 'cancelled', cancelled_at = now(), cancellation_reason = 'deliverability incident manual halt' WHERE tenant_id = $tenant AND requested_by_member_id = $member AND status IN ('submitted', 'approved');`
   - Note: state-machine trigger from migration 0064 enforces transitions — `submitted` and `approved` can be cancelled.

4. **Investigate the recipient list quality**.
   - For the offending broadcast: `SELECT recipient_email_lower, status, error_message FROM broadcast_deliveries WHERE tenant_id = $tenant AND broadcast_id = $offending_id ORDER BY status;`
   - Look for patterns:
     - Many `hard_bounce` of `*@old-domain.com` → outdated member contact list (member needs to refresh primary contact email).
     - Many `complained` from a single segment → segment was poorly targeted (e.g., tier:premium broadcast sent to tier:gold by mistake).
     - Random complaints (< 1%) → expected baseline from list churn; no further action.

5. **Apply suppression bulk-fix if root cause is bad list**.
   - Already-complained / bounced emails are auto-suppressed via FR-027 cascade — they will NOT be re-emailed. Verify:
     ```sql
     SELECT count(*) FROM marketing_unsubscribes WHERE tenant_id = $tenant AND reason IN ('hard_bounce', 'complaint');
     ```
   - If suppression count is implausibly low (cascade may have failed) → escalate to platform engineer for FR-027 cascade replay.

---

## Escalation

- **Domain blacklist confirmed** (`mxtoolbox.com` blacklist scan returns hits) → page chamber legal-counsel + DPO; pause F7 cron dispatch globally via `FEATURE_F7_BROADCASTS=false` Vercel env flip; engage Resend support ticket to delist.
- **Persistent breach across multiple members in same hour** → likely cross-member campaign or segment-resolution bug; flip kill-switch + engage F7 feature engineer.
- **Q14 auto-halt mass-fires** (≥ 3 members halted in 1 hour) → tenant-level deliverability emergency; engage chamber DPO + kill-switch.

---

## Recovery

After fix is deployed:

1. Verify bounce + complaint rates return to baseline (24h soak window).
2. Admin clear-halt per [broadcasts-halt-clear.md](./broadcasts-halt-clear.md) for affected members IF root cause was member-side list quality (NOT a platform bug).
3. If kill-switch was flipped OFF → re-enable `FEATURE_F7_BROADCASTS=true` after 24h clean window.
4. Document the incident in `specs/010-email-broadcast/retrospective.md` if it qualifies as a near-miss or actual breach (PDPA §37 24h notification clock).

---

## Prevention

- Audit member primary-contact email refresh cadence quarterly (Q4 each year).
- Monitor weekly bounce_rate baseline trend — escalate to platform engineer if creeping above 1% sustained.
- Verify segment-resolution unit tests (Phase 3+ T044) cover the "all_members vs tier filter" cross-leak case.
