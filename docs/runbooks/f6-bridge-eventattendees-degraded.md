# F6 → F8 bridge `eventAttendees` query degraded

**Alert source**: `eventcreate_bridge_event_attendees_query_failed_total{tenant}` rate > 0 sustained ≥5 min
**Priority**: WARN (not CRIT — bridge fails open; user-facing surface is preserved)
**Owner**: F6 EventCreate Integration

---

## Symptom

The F6 → F8 bridge adapter `drizzleEventAttendeesQuery.list(...)` is logging
`f6_event_attendees_query_failed` and falling open to `[]` (empty
attendance list) on sustained DB outage / RLS regression / pool
exhaustion. Source: `src/modules/events/infrastructure/drizzle-event-attendees-by-member.ts`.

The metric is incremented in the bridge's catch block; check Vercel
Analytics or the OTel collector for the counter rate by tenant.

---

## Impact

The F8 at-risk scorer (`src/modules/renewals/infrastructure/drizzle/drizzle-at-risk-scorer.ts`)
consults this bridge to count a member's recent event attendances as
one of the 8 at-risk factors. When the bridge fails open with `[]`:

- Members appear as "no engagement" → at-risk-score drops one band
- Renewal pipeline silently misses these members in tier-aware reminder
  cadence (the at-risk band drives reminder priority)
- No user-facing 500; F8 routes complete normally — **silent drift**
  classifies high-engagement members as low-engagement until the bridge
  recovers

The fail-open is the correct contract per `EventAttendeesPort` (no-throw,
empty-list semantics) but the metric is the SRE-visible signal that the
contract is being exercised in degraded mode.

---

## Diagnostics

1. **Check Neon connection pool health**: `vercel env pull` for the
   tenant; verify `DATABASE_URL` resolves; check Neon dashboard for
   pool exhaustion under
   `https://console.neon.tech/app/projects/<project-id>`.

2. **Check RLS regression**: SSH or use the SweCham Neon read-replica
   to run:
   ```sql
   SET LOCAL ROLE chamber_app;
   SET LOCAL app.current_tenant = '<tenant-slug>';
   SELECT count(*) FROM event_registrations
   WHERE matched_member_id IS NOT NULL
     AND pii_pseudonymised_at IS NULL;
   ```
   If this returns 0 for a tenant that should have attendance, the RLS
   policy or `pg_trgm` extension may have been silently disabled by an
   admin migration.

3. **Check tenant slug shape**: the bridge calls `asTenantContext(String(input.tenantId))`
   which throws on a malformed slug. Pino logs at level `error` with
   `event: 'f6_event_attendees_query_failed'` carry `errName` —
   `InvalidTenantSlugError` indicates a bug in F8 caller (passing
   a non-slug TenantId).

4. **Check pino stderr last-ditch**: if even the structured logger
   fails, the catch block doesn't have a stderr fallback (bridge is
   read-only — no dual-write semantics). Vercel Fluid Compute runtime
   logs should still surface the throw via the function-error channel.

---

## Mitigation

- **Bridge is read-only fail-open** — no production data is at risk;
  the at-risk scorer just receives `[]` and computes a lower-engagement
  score. SRE can defer to the next maintenance window for non-emergency
  fixes.
- **Rollback** the most recent F6 deploy if the metric rate-spike
  correlates with the deploy window. F6 ships dark behind
  `FEATURE_F6_EVENTCREATE=false` — if flag is OFF, the bridge is
  unreachable.
- If the flag is ON and the bridge is degrading the renewal pipeline:
  flip `FEATURE_F6_EVENTCREATE=false` via Vercel env + redeploy.
  At-risk scorer reverts to the stub-port shape (always `[]`) which is
  the same fail-open state.

---

## Resolution

1. Hard-fix the underlying query / RLS / pool issue.
2. Verify by manually invoking the bridge from a Node REPL:
   ```ts
   import { drizzleEventAttendeesQuery } from '@/modules/events/infrastructure/drizzle-event-attendees-by-member';
   await drizzleEventAttendeesQuery.list({
     tenantId: 'swecham' as TenantId,
     memberId: '<known-member-uuid>' as MemberId,
     since: new Date('2024-01-01'),
     limit: 100,
   });
   ```
   Should return `ReadonlyArray<EventAttendanceRecord>` of length > 0
   for any member with recent attendance.
3. Re-run F8 at-risk-recompute cron after restoration to clear the
   silent drift:
   ```
   POST /api/cron/renewals/at-risk-recompute
   ```
4. Verify the at-risk band on a few known active members has reverted
   to the expected band in the admin members table.

---

## Cross-references

- Source: `src/modules/events/infrastructure/drizzle-event-attendees-by-member.ts:56-130`
- F8 port: `src/modules/renewals/application/ports/event-attendees-port.ts`
- F8 scorer: `src/modules/renewals/infrastructure/drizzle/drizzle-at-risk-scorer.ts`
- Stub fallback contract: `src/modules/renewals/infrastructure/event-attendees-stub.ts`
- Metric definition: `src/lib/metrics.ts` (search `bridgeEventAttendeesQueryFailed`)
- Round 1 fix that introduced the fail-open contract: A4 (commit `8481f08b`)
- Round 2 finding that flagged the missing runbook: NEW-I1
