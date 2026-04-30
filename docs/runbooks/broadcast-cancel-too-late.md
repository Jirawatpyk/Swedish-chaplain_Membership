# Runbook — `broadcast_cancel_too_late`

**Owner**: Platform on-call (escalate to chamber admin if recipient-side follow-up needed)
**Severity**: warn (admin-experience friction; not a security signal)
**Source signal**: `broadcasts.cancel_too_late_total` counter (≥ 3 / hour triggers warn)
**Audit event**: `broadcast_cancel_too_late` (Status: SPEC, emit lands Phase 3+ T103 / cancel-broadcast use-case)
**Last reviewed**: 2026-04-29 (Batch D T032 spec scaffolding)
**Status**: SPEC — emit sites land Phase 3+ (T036+); operational triage assumes the emit + state-machine trigger from migration 0064 are in place.

---

## Symptom

A member or admin clicked "Cancel" on a broadcast and received an HTTP 409 with body `broadcast_cancel_too_late`. The broadcast had already transitioned past the cancellation cutoff (Q10 + FR-004a — cancellable only in `submitted` or `approved` states). The dispatch has begun (`status IN ('sending', 'sent', 'failed_to_dispatch')`) and the email has been (or will shortly be) delivered to recipients.

## Why this matters

Once Resend Broadcasts API has been called with `sendBroadcast(...)`, the email delivery is committed to in-flight queues at Resend's end. We CANNOT recall the message — Resend has no "stop dispatch" API for broadcasts mid-send. The cancellation cutoff exists to make this physical reality explicit at the platform layer.

The friction is most likely member-experience: the member clicked Cancel a few seconds too late and now needs to send a follow-up to recipients (e.g., correction, retraction). This is NOT a platform bug, but the platform should help admins triage the fallout.

---

## Triage steps (in order)

1. **Identify the offending broadcast**.
   ```sql
   SELECT broadcast_id, requested_by_member_id, status, sending_started_at, sent_at,
          subject, estimated_recipient_count
     FROM broadcasts
    WHERE tenant_id = $tenant
      AND broadcast_id = $offending_id;
   ```
   Note the `status` — if `sending`, the broadcast is mid-flight; if `sent`, dispatch is complete.

2. **Determine the dispatch state**.
   - `status = 'sending'` + `sending_started_at` < 5 min ago → some recipients may not have received yet (Resend queues internally for ~10 min on bulk sends). The cancellation cutoff was hit, but real-world recipient impact may be limited.
   - `status = 'sent'` → all recipients have received; the email is in inboxes.

3. **Cross-check delivery aggregation**.
   ```sql
   SELECT status, COUNT(*) FROM broadcast_deliveries
    WHERE tenant_id = $tenant AND broadcast_id = $offending_id GROUP BY status;
   ```
   If `delivered` count is ≈ `estimated_recipient_count` → all recipients received. If significantly fewer → mid-flight; more recipients still pending.

4. **Communicate scope to the originating member**.
   - Surface (Phase 3+ admin UI T124 / detail page) shows the actual delivered count vs estimated.
   - Member can then send a follow-up correction email via a NEW broadcast submission (subject prefix "Correction:" recommended).
   - Manager-role users CANNOT submit; only the originating member or admin-proxy can per Q12.

5. **Verify state-machine trigger fired correctly**.
   - The DB-level `broadcasts_state_machine` trigger (migration 0064) RAISES `broadcast_invalid_state_transition` if a `cancel` is attempted from terminal states. The 409 returned to the client should match.
   - If the cancel succeeded mid-`sending` (e.g., row is now `cancelled` but `resend_broadcast_id` is set) → state-machine bug; escalate to platform engineer.

---

## Escalation

- **Member sent broadcast they were not authorised to send** (e.g., wrong segment) → chamber admin contacts the recipient list manually with retraction. NOT a platform issue.
- **Broadcast triggered Q14 auto-halt** (downstream complaint rate breach) → see [broadcast-deliverability-incident.md](./broadcast-deliverability-incident.md).
- **Cancel attempted from terminal state succeeded** (state-machine bug) → page platform engineer, capture broadcast_id + audit log row, file P0 issue.

---

## Recovery

No technical recovery needed — the cutoff is by design. The administrative recovery path:

1. Member submits a NEW broadcast labelled "Correction: <original subject>" if a retraction is appropriate.
2. Quota counter is consumed against the NEW broadcast (FR-007). The cancelled-too-late broadcast had its slot CONSUMED at `sent` transition (FR-007); cancelling it post-`sent` does NOT refund the slot.
3. If the member is now over-quota for a corrective email → admin can use `proxy-submit` (Q12) bypassing quota check (admin role override) for genuine emergency corrections; document via audit `broadcast_submitted` with `actor_role = 'admin_proxy'`.

---

## Prevention

- Compose-surface UX (Phase 3+ T088 preview pane) emphasises the "preview before submit" workflow + adds a clear "Submit will trigger admin review; cancellable until approved" copy.
- Schedule-picker (T087) shows a strong "Once approved + dispatched, this CANNOT be cancelled" disclosure.
- Member education: chamber on-boarding doc references this runbook for context.
