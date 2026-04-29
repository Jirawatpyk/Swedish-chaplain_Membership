# Runbook — `broadcasts_halt_clear` (Q14 Admin Workflow)

**Owner**: Chamber admin (technical context: platform on-call)
**Severity**: warn (member dispatch is blocked until cleared; admin-experience friction)
**Source signal**: `members.broadcasts_halted_until_admin_review = true` for ≥ 1 member (admin queue red banner from Phase 3+ T121)
**Audit events**: `broadcast_member_halted_pending_review` (R3-NEW-1, halt-set path) · `broadcast_member_dispatch_resumed` (Q14, halt-clear path) · `broadcast_complaint_rate_per_broadcast_breach` (Q14, the upstream trigger)
**Last reviewed**: 2026-04-29 (Batch D T032 spec scaffolding)
**Status**: SPEC — admin clear-halt UI lands Phase 3+ (T122 clear-halt-dialog); operational steps below assume the use-case from T029 (`setMemberHalt`) is in place.

---

## Symptom

The admin queue page shows a top-of-page red banner: "1 (or more) members halted from broadcasting; review needed." (Phase 3+ T121 banner). The halted members cannot submit new broadcasts — submission attempts return HTTP 422 with `broadcast_member_halted_pending_review` per FR-002 precondition `k`.

The halt was set automatically when one of the member's broadcasts triggered a per-broadcast complaint rate > 5% per Q14 + SC-005 (b). The auto-halt is a SAFETY MEASURE to protect chamber sender reputation while admin investigates.

## Why this matters

- Halted members cannot exercise their tier benefit (E-Blast quota) until admin clears.
- The complaint rate breach indicates either:
  - **List quality issue** — member's recipient list contained recipients who didn't expect the email (corrective action: education + clean list).
  - **Content issue** — broadcast was misleading or off-topic (corrective action: content review + future submission gate).
  - **Abuse** — member is intentionally sending unwanted email to recipients (corrective action: revoke broadcast access + chamber legal-counsel involvement).

Without admin review + clearance, the auto-halt is permanent. The admin role is REQUIRED — manager-role users cannot clear (FR-014 same auth pattern as approve/reject/cancel).

---

## Triage steps (in order)

1. **Identify halted members**.
   ```sql
   SELECT m.member_id, m.company_name, m.broadcasts_halted_until_admin_review,
          (SELECT MAX(b.failed_to_dispatch_at) FROM broadcasts b
            WHERE b.tenant_id = m.tenant_id
              AND b.requested_by_member_id = m.member_id
              AND b.status IN ('sent', 'failed_to_dispatch')) AS last_dispatch
     FROM members m
    WHERE m.tenant_id = $tenant
      AND m.broadcasts_halted_until_admin_review = true;
   ```

2. **Identify the offending broadcast(s)** that triggered the halt.
   ```sql
   SELECT broadcast_id, subject, sent_at,
          (SELECT count(*) FROM broadcast_deliveries d
            WHERE d.tenant_id = b.tenant_id
              AND d.broadcast_id = b.broadcast_id
              AND d.status = 'complained') AS complaints,
          (SELECT count(*) FROM broadcast_deliveries d
            WHERE d.tenant_id = b.tenant_id
              AND d.broadcast_id = b.broadcast_id) AS total_events
     FROM broadcasts b
    WHERE b.tenant_id = $tenant
      AND b.requested_by_member_id = $halted_member_id
      AND b.status = 'sent'
      AND b.sent_at > now() - interval '90 days'
    ORDER BY b.sent_at DESC;
   ```
   - Calculate complaint rate: `complaints / total_events`. The Q14 threshold is 5%.
   - Cross-reference audit log: `SELECT * FROM audit_log WHERE event_type = 'broadcast_complaint_rate_per_broadcast_breach' AND payload->>'requested_by_member_id' = $halted_member_id;`

3. **Review broadcast content + recipient list quality**.
   - Phase 3+ admin detail page (T124) renders the offending broadcast HTML body + segment + recipient count.
   - Look for:
     - Misleading subject line.
     - Off-topic content (e.g., personal/political content on chamber email).
     - List quality: was the segment correctly targeted? Did the member use `custom` segment with emails outside the tenant graph (impossible per FR-015d but verify)?

4. **Decide remediation**.
   - **Education + clear**: list quality issue, member acted in good faith. Clear the halt + send instructional email to member.
   - **Content review + clear**: content was off-topic but not malicious. Clear the halt + add member to "elevated review" list (Phase 4+ feature).
   - **Suspend access**: abuse case. DO NOT clear; instead engage chamber legal-counsel + pursue membership review per chamber bylaws.

5. **Clear the halt** (admin role required; manager role denied).
   - Phase 3+ admin UI: T122 `clear-halt-dialog.tsx` — typed-phrase confirmation matching F4 destructive-action convention (e.g., type "CLEAR HALT").
   - For now (pre-T122 UI), via DB-level operation (admin user_id from F1 audit context):
     ```sql
     -- Run inside `BEGIN;` … `COMMIT;` so the audit row + flag-clear are atomic
     UPDATE members
        SET broadcasts_halted_until_admin_review = false
      WHERE tenant_id = $tenant
        AND member_id = $halted_member_id;

     -- Then INSERT audit_log row with event_type = 'broadcast_member_dispatch_resumed'
     -- payload: {member_id, cleared_by_user_id: $admin, reason: $admin_supplied_reason}
     -- (Phase 3+ T029 setMemberHalt use-case does this automatically inside an atomic tx)
     ```
   - Verify `audit_log` shows `broadcast_member_dispatch_resumed` row with the admin's user_id.

---

## Escalation

- **Halt cleared but member's NEXT broadcast also exceeds 5% complaint rate** → repeat offence; engage chamber legal-counsel + suspend broadcast access via `setMemberHalt(memberId, true)` permanently pending review.
- **Bulk halt event** (≥ 3 members halted in same hour) → likely tenant-wide deliverability incident; see [broadcast-deliverability-incident.md](./broadcast-deliverability-incident.md).
- **Halt was set in error** (auto-halt cron malfunction triggered on legitimate broadcast) → clear immediately + file P0 platform issue + capture audit chain for forensic review.

---

## Recovery

After halt cleared:

1. Member can submit new broadcasts immediately (no further restriction).
2. Member's quota is unchanged (the halt did NOT consume a quota slot — it just prevented new submissions).
3. If abuse case → halt remains permanent; escalate to chamber bylaws process.

---

## Prevention

- Phase 3+ Q14 banner (T121) makes halts visible to admins immediately on queue page load.
- Quarterly review of broadcast complaint-rate trends per tenant.
- Member onboarding doc references this runbook + the Q15 GDPR Art. 7 acknowledgement banner copy.
- Phase 4+ feature: "elevated review" mode for previously-halted members (extra approval step before broadcast goes out).
