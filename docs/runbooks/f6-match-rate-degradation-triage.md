# F6 Match-Rate Degradation — Triage Runbook

**Alert source**: `eventcreate_match_rate_gauge` drops below SC-002 target (e.g., < 70% rolling 30-day for a tenant with > 100 registrations)
**Severity**: P2 (operational, not data-loss; routes to maintainer email)
**Last reviewed**: 2026-05-17 (Phase 10 T133)

## Symptoms

- Match-rate gauge tracking shows a sustained drop in the fraction of webhook deliveries resolving to a known F3 member.
- Admin email mentions the chamber complaining that attendees don't appear linked to membership records.
- `audit_log` shows `match_resolution_completed` rows skewing toward `match_type: 'non_member'` and `'unmatched'`.

## Most-likely root causes

1. **Member onboarding pace slowdown** — F3 hasn't added new members fast enough; attendee emails from new EventCreate registrations don't yet appear in F3 contacts.
2. **Domain corruption** — Member `domains` column has stale or missing entries, breaking the `member_domain` match path.
3. **Email casing drift** — Attendee emails arriving in a casing format that breaks the `attendee_email_lower` lookup (rare; the GENERATED column normalises).
4. **F3 member archival** — A burst of members was archived in F3, dropping match-rate for events those members previously attended.
5. **EventCreate UI change** — Chamber changed the EventCreate registration form to capture a different email field (e.g., business vs personal), invalidating prior fuzzy matches.

## Triage steps

1. **Cross-link with F3 onboarding pace**: query F3 `audit_log WHERE event_type IN ('member_created','contact_added') GROUP BY DATE(emitted_at)` for the affected period. If F3 onboarding count dropped → cause (1).
2. **Profile match-type distribution**: 
   ```sql
   SELECT payload->>'matchType', COUNT(*)
   FROM audit_log
   WHERE event_type = 'match_resolution_completed'
     AND emitted_at > NOW() - INTERVAL '7 days'
     AND tenant_id = $1
   GROUP BY 1 ORDER BY 2 DESC;
   ```
   Compare against the 30-day baseline. A sudden `non_member` spike with `member_domain` drop → cause (2).
3. **Audit F3 domain entries**: `SELECT COUNT(*) FROM contacts WHERE domain IS NOT NULL`. If recently shrunk → cause (2).
4. **Look for F3 archive burst**: `SELECT COUNT(*) FROM audit_log WHERE event_type='member_archived' AND emitted_at > NOW() - INTERVAL '30 days' AND tenant_id = $1`. If > 10 in 7 days → cause (4).
5. **Sample failed matches**: `SELECT payload->>'attendeeEmail', payload->>'matchType' FROM audit_log WHERE event_type='match_resolution_completed' AND payload->>'matchType' IN ('non_member','unmatched') ORDER BY emitted_at DESC LIMIT 20`. Look for clusters of similar email domains → cause (2) or (5).

## Mitigations

| Cause | Action | Owner |
|---|---|---|
| (1) Onboarding pace | Notify chamber to expedite F3 imports. Optionally bulk-import via F3 CSV. | Maintainer + chamber admin |
| (2) Domain corruption | Re-run F3 domain backfill: `pnpm tsx scripts/backfill-contact-domains.ts --tenant=<slug>` (if script exists; otherwise manual UPDATE per `f3-domain-backfill.md` follow-up). | Maintainer |
| (3) Casing drift | Verify `attendee_email_lower` GENERATED column is populated. Check Drizzle schema migration 0128 + 0131 indexes are applied. | Maintainer |
| (4) F3 archive burst | No mitigation needed — match-rate naturally drops when members leave. Update SC-002 baseline if archive was business-driven. | Chamber |
| (5) Form change | Coordinate with chamber to revert EventCreate registration form, OR run admin-relink for affected registrations via the relink dialog. | Chamber admin |

## Long-term improvements

- Phase 11 backlog: surface a "near-miss" hint on the Recent Deliveries panel listing the closest F3 member candidate for unmatched rows.
- Phase 11 backlog: pg_trgm fuzzy match upgrade if match-rate consistently below target after exhausting member_contact + member_domain paths.

## Verification

- After fix, watch `eventcreate_match_rate_gauge` for 24 hours — expect ≥10 percentage-point recovery if cause was (1)/(2).
- Confirm next 50 webhook deliveries show ≥1 match per fixed cause.
