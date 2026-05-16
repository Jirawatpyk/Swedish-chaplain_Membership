# F6 Admin Event Detail 404 — Runbook (Enumeration vs Stale URLs)

**Alert source**: distinct `event_id_hash` values ≥ 10 within 5 minutes from a single `actor_user_id` on `audit_log WHERE event_type='admin_event_detail_not_found'`
**Severity**: P2 (enumeration probe) — escalate to P1 if cross-tenant pattern detected
**Last reviewed**: 2026-05-17 (Phase 10 T132 / per Phase 4 retrospective alert contract)

## Background

The Phase 4 admin detail route emits `logger.warn` with `admin_event_detail_not_found` on every 404. This includes legitimate stale URLs (browser tabs, bookmarks to archived events) AND potential enumeration attempts. The hashed `event_id_hash` field (first 16 chars of SHA-256) is the correlation key — distinct hashes per actor in a short window suggest probing rather than user error.

## Symptoms

- Vercel alert fires with subject `F6 ENUMERATION SUSPECTED`.
- `audit_log WHERE event_type='admin_event_detail_not_found' AND actor_user_id = $1 ORDER BY emitted_at DESC LIMIT 50` shows 10+ distinct `event_id_hash` values inside a 5-minute window.
- Sometimes accompanies bulk requests for non-existent events from the same actor.

## Root causes (most → least likely)

1. **Browser tab restoration** — admin restored a session that had tabs pointing to since-archived/deleted events. Each tab fires a `not_found` independently. Distinct hashes but same admin.
2. **Bookmark sweep** — admin clicked through 10+ bookmarks at once. Legitimate but noisy.
3. **Automated tool / script** — admin ran a script (curl loop, custom dashboard) hitting stale event URLs. Distinct hashes, high velocity.
4. **Actual enumeration probe** — actor (admin or hijacked admin session) is iterating event IDs to discover existing data. Distinct random-looking hashes, narrow time window, sometimes high request rate.
5. **Cross-tenant probe** — admin session valid for tenant A is attempting to access tenant B's event URLs by guessing eventIds. Most concerning.

## Triage steps

1. **Profile actor**: 
   ```sql
   SELECT actor_user_id, COUNT(DISTINCT payload->>'eventIdHash') AS unique_hashes,
          MIN(emitted_at) AS first, MAX(emitted_at) AS last
   FROM audit_log 
   WHERE event_type = 'admin_event_detail_not_found'
     AND emitted_at > NOW() - INTERVAL '1 hour'
   GROUP BY 1 HAVING COUNT(DISTINCT payload->>'eventIdHash') >= 10
   ORDER BY unique_hashes DESC;
   ```
2. **Check if cross-tenant**: filter `cross_tenant_probe` audits for the same actor + window. If present → cause (5), escalate immediately.
3. **Inspect actor's session**: F1 `sessions` table — `SELECT * FROM sessions WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`. Look for unusual IP / user-agent. Confirm with admin via out-of-band channel (phone/Slack) that the session is theirs.
4. **Sample event_id_hashes**: if hashes appear sequential (e.g., visible pattern) → script-driven. If random → human-clicking or enumeration.
5. **Check request rate**: requests > 10/min from one actor for non-existent events → suspect (3)/(4).

## Mitigations

| Cause | Action |
|---|---|
| (1)/(2) Tab/bookmark | No action — silence alert for the actor for 24h. |
| (3) Script | Coordinate with admin to halt script; explain rate-limit concern. No security action needed. |
| (4) Enumeration | Force-revoke admin's session: `runRevokeAllSessions(userId)` from F1 admin tools. Notify admin out-of-band. Audit recent admin actions for malicious mutations. |
| (5) Cross-tenant | **P1 immediately** — revoke session, notify DPO, audit `audit_log` for any data exposure in window, file PDPA breach notification draft. |

## Tuning

If the alert fires too frequently on cause (1)/(2):
- Move threshold from `≥10 distinct hashes / 5 min` to `≥20 / 5 min`
- Or: only alert if accompanied by `cross_tenant_probe` audit emission in the same window

## Verification after mitigation

- For (4)/(5): confirm session is revoked + `audit_log WHERE actor_user_id = $1` shows no further activity.
- For PDPA breach: confirm draft sent to DPO within 72 hours per Section 37.
