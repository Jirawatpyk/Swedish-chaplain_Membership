# Runbook — broadcast audience build (108 PR-C, 1:N contact audience)

**Owner**: Platform on-call (escalate to the chamber admin when a member's broadcast is refused or delayed)
**Severity**: alarm (a member's E-Blast is refused, delayed, or its compose-time count is unavailable — never silent under-delivery: the build fails CLOSED)
**Source signal**: `broadcasts.dispatch_resolve_failed.total{tenant}` (a tick could not build the audience — the alarm for a slipping schedule) · `broadcasts.approved_overdue_count{tenant}` (approved rows > 1 h past `scheduled_for`) · `broadcasts.recipient_count_ms` (SLO-F7-013 — compose-time count p95) · `broadcasts.audience_resolved.total{segment,mode}` · `broadcasts.audience_pages.total` · `broadcasts.marketing_opt_out_filter_count` · route error `count_unavailable` (503) on the two recipient-count endpoints · log events `broadcasts.recipient_count.resolve_failed` / `.resolve_threw` (count), `cron.broadcasts.dispatch.server_error` (dispatch-scheduled), `cron.broadcasts.dispatch_batches.recipient_resolution_failed` / `cron.broadcasts.split_large.recipient_resolution_failed` (batch crons)
**Audit events**: `broadcast_member_missing_primary_contact_email` (per eligible member with no eligible contact for a NON-preference reason, capped at 50 per submit — above the cap ONE `member_missing_primary_contact` row with `truncated: true, totalOrphans, reported`; payload carries `orphan_reason`) · `broadcast_failed_to_dispatch` (existing F7) · `member_cross_tenant_probe` (admin count endpoint, unknown `member_id`)
**Last reviewed**: 2026-09-07 (108 PR-C T091; corrected the same day by the review — step order, the verification command, the log-event names)
**Status**: LIVE behind `FEATURE_CONTACT_MARKETING_RECIPIENTS` (default `false`)

> **Scope**: this runbook covers HOW the audience of a broadcast is built and counted since 108 PR-C, and what to do when that build is slow, refused, or unavailable. A broadcast stuck in `sending` AFTER a successful build is `broadcasts-stuck-sending.md`; a Resend-side dispatch failure is `broadcasts-dispatch-failure.md`. There is NO "audience building" state and NO import-based build in PR-C — the Resend Contacts Import path (US5 T086/T087/T106) is DEFERRED to a follow-up PR (see `specs/108-contact-recipient-rules/reviews/pr-c.md` § US5 scope decision).

---

## What the build is (read this once)

One resolver, `resolveSegmentRecipients` (`src/modules/broadcasts/application/use-cases/resolve-segment-recipients.ts`), runs at THREE moments with the same deps, so the number the member sees at compose is the set that is dispatched (SC-004):

| Moment | Caller | Phase | What a failure looks like |
|---|---|---|---|
| Compose (live count) | `GET /api/broadcasts/recipient-count` (member) · `GET /api/admin/broadcasts/recipient-count?member_id=` (staff proxy) | `submit` | 503 `count_unavailable`; the compose form shows the "count unavailable" line (the form stays usable — submit still re-resolves) |
| Submit | `submit-broadcast` / `proxy-submit` | `submit` | 422 `audience_too_large` with the TRUE count and the cap, or 500 on a resolver error |
| Dispatch (every tick) | `dispatch-scheduled-broadcast` cron, `split-large-broadcasts` + `dispatch-batches` for split broadcasts | `dispatch` | a resolver error → `dispatch.server_error`: the row STAYS `approved`, the NEXT tick retries (FR-044), and `broadcasts.dispatch_resolve_failed.total` counts it — no partial audience is ever pushed. An audience that GREW past the ceiling between submit and dispatch → `failed_to_dispatch`, reason `audience_too_large` (terminal; the member gets the FR-021 notification) |

Steps inside the resolver, in the ORDER the code runs them (`resolve-segment-recipients.ts` numbers its steps the same way):

1. **Source** — member-based segments (`all_members`, `tier`) read the F7→F3 bridge `getContactsBySegment`, which walks F3's keyset pages of **5,000 rows** to exhaustion (`buildBroadcastRecipientContactsQuery` — eligible members: `status='active'`, not erased, not halted, + tier; eligible contacts: live and not opted out of marketing, the 0294 partial-index predicate). Audience mode decides which contacts: `primary_only` (flag OFF — the primary contact only) or `all_contacts` (flag ON — every eligible contact). A failed page **throws** → `resolve.server_error`. It never answers `[]` on error (research R8: an empty answer would be a silent truncation). A `tier` segment with no codes is REFUSED by F3, never read as "everyone". `custom` lists and `event_attendees_last_90d` are sourced elsewhere and skip this read. On the `all_contacts` leg the bridge also asks F3 for the number of opted-out live contacts the SQL excluded (`countOptedOutContactsBySegment`, fail-closed) — see step 5.
   **Orphans** — an eligible member with no eligible contact is reported with a REASON: `no_primary_email` (primary_only leg), `no_eligible_contact` (no live contact at all) or `all_opted_out` (every contact objected). Only the first two get the missing-contact audit at submit; `all_opted_out` is a preference drop. The sender is never their own orphan.
2. **Self-exclusion** — by member id on member-based segments only (every contact of the sending member; custom lists are exempt; attendees are not member-keyed).
3. **Dedupe by address.**
4. **Suppression anti-join** — `marketing_unsubscribes` looked up in chunks of 5,000 addresses.
5. **Marketing opt-out filter** (step 5b in the code) — `filterMarketingOptedOut` through the real bridge, **fail-closed** (a failed lookup rejects the tick rather than mailing people who objected); metric `broadcasts_marketing_opt_out_filter_count`. On the `all_contacts` leg F3 already excluded those contacts in SQL, so this measures ~0 there and the step-1 count carries the true number.
6. **Empty check, then the ceiling**: `audienceCeiling` = 5,000 unless BOTH the F7.1a batching flag AND the 1:N flag are ON (then 50,000). Over the ceiling → `broadcast_audience_too_large { count, cap }` with the TRUE count — never a cut list.

`droppedByPreference` in the count response = opt-out drops (step 5 on any segment kind, plus the SQL-excluded opt-outs on the `all_contacts` leg) + suppression drops on custom/attendee segments only. On member-based segments a suppression drop is not a "preference" the member can see (FR-053a — no address ever leaves the server). The count body carries the measured fields only when the resolver COMPLETED; a refusal (`exceeds: true`, or an empty audience) sends `count`, `ceiling`, `exceeds` and nothing else. The MEMBER body never carries `orphans` (a fact about other members); the staff body does.

The page walk is NOT a snapshot: each page is its own `runInTenant` transaction. Keyset order means no block is skipped by concurrent inserts or deletes after the cursor, but a contact inserted BEFORE the cursor mid-walk is missed until the next resolve. Do not build a reconciliation on the assumption of a consistent read.

## Symptom → cause → action

### A. Compose shows "recipient count unavailable" (503 `count_unavailable`)

1. Find the correlation id in the route log. `broadcasts.recipient_count.resolve_failed` is the typed page-read failure (its `err` is the bridge's message); `broadcasts.recipient_count.resolve_threw` is a THROWN suppression lookup or opt-out filter (its `err` is the error class only). Only the page read produces `resolve.server_error`; the other two throw.
2. Neon reachable? (Vercel runtime logs + the Neon console; `docs/runbooks/db-environment-branching.md` says which branch prod is.) A statement timeout on the 5,000-row page is the first suspect on a cold compute.
3. The member CAN still submit — submit re-resolves. Do not tell them to wait for the count.
4. If only ONE tenant sees it, check the two `contacts` indexes the build relies on **directly** — `pnpm db:verify:prod` does NOT cover them (`scripts/verify-schema.ts` has no `contacts` assertion):

```sql
SELECT indexname FROM pg_indexes
WHERE tablename = 'contacts'
  AND indexname IN ('contacts_marketing_recipients_idx', 'contacts_tenant_lower_email_all_idx');
-- expect both rows
```

Rate limit: 30 counts/min per (tenant, user) — a 429 here is the client debounce failing (400 ms, one in-flight request), not the build.

### B. Submit refused with `audience_too_large`

The count in the error IS the audience. Two remedies, in order:

1. Narrow the segment (tier instead of all members), or
2. Turn on F7.1a batching (`FEATURE_F71A_US1_PAGINATION` in `src/lib/env.ts` — deployment-wide, not per tenant). With the 1:N flag also ON it raises the ceiling to 50,000 and routes the broadcast through `split-large-broadcasts` above `SPLIT_THRESHOLD_RECIPIENTS` = 10,000. With the 1:N flag OFF the ceiling stays 5,000 regardless (review H-2: the wide ceiling belongs to the wide audience).

Never raise `audienceCeiling` by hand for one member: the ceiling is a Resend-facing safety bound, not a quota.

### C. Dispatch tick cannot build the audience, or is slow

1. **Alarm**: `broadcasts.dispatch_resolve_failed.total` rising for ≥ 15 min on one tenant, or `broadcasts.approved_overdue_count ≥ 1` for 30 min. Unlike a Resend failure, a resolver error has NO FR-021 wall-clock budget: the row stays `approved` until a tick succeeds, nothing transitions it and nobody is notified — without these two signals a schedule slips silently. Find the broadcast id in `cron.broadcasts.dispatch.server_error` (or the batch crons' `recipient_resolution_failed`) and tell the requesting member.
2. **Size**: `broadcasts.audience_pages.total` is CUMULATIVE — read it as a rate, not a size. Each completed resolve costs one page per 5,000 rows plus one exhaustion page (20,000 contacts = 5 pages; T081 pins "4 full pages plus the empty proof page"). 20,000 contacts measured **3.7 s** from a ~220 ms-RTT workstation and are budgeted < 3 s from Vercel `sin1` (same region as Neon) — `tests/integration/broadcasts/audience-pagination-20k.test.ts`.
3. If SLO-F7-013 (`broadcasts.recipient_count_ms` p95) is breached in prod, run the EXPLAIN from that test's last case against prod READ-ONLY (`node --env-file=.env.production`, dummy `EXPORT_DOWNLOAD_TOKEN_SECRET`) and look for a Nested Loop over a Seq Scan on `contacts` — that is the N+1 shape the 0294 index prevents; a missing index after a restore is the usual cause (§ A step 4 has the query).

### D. The 1:N audience must be switched off (rollback)

`FEATURE_CONTACT_MARKETING_RECIPIENTS=false` in Vercel env + redeploy (~30 s, no code deploy).

What changes: every NEW resolve (compose count, submit, every dispatch tick) sources the primary contact only (`primary_only`) and the ceiling returns to 5,000. A broadcast already `approved` but not yet dispatched is re-resolved at its dispatch tick, so it shrinks to primaries — that is the intended blast radius, not a bug. A broadcast already `sending` is unaffected (its recipient rows are written).

What does NOT change: suppression, the marketing opt-out filter, self-exclusion, dedupe and the ceiling check all apply in both modes. The opt-out honour is PR-D behaviour and is not behind this flag.

What becomes stale: a count a member saw at compose before the flip. SC-004 holds per tenant STATE, and the audience mode is part of that state.

## Why this matters

- FR-041 / research R8: the audience is never silently truncated — every failure path here is loud (refusal, retry + counter), so "no alarm" means the build is complete, not that it was skipped.
- FR-022a (PR-D): a person's marketing objection is honoured at dispatch. Step 5 is fail-closed on purpose; do not "fix" a slow tick by making it best-effort.
- SC-004: compose count = dispatch set. Any remedy that bypasses the resolver at one moment breaks this.

## Verification query (read-only, prod)

Eligible-contact count for one tenant, the way the resolver sees it in `all_contacts` mode (compare with the STAFF count endpoint for the same member — the member body omits `orphans`):

```sql
SELECT count(*) FILTER (WHERE c.contact_id IS NOT NULL) AS contacts,
       count(*) FILTER (WHERE c.contact_id IS NULL)     AS orphans
FROM members m
LEFT JOIN contacts c
       ON c.tenant_id = m.tenant_id AND c.member_id = m.member_id
      AND c.removed_at IS NULL
      AND c.marketing_opt_out_at IS NULL
WHERE m.tenant_id = $1 AND m.status = 'active' AND m.erased_at IS NULL
  AND NOT m.broadcasts_halted_until_admin_review;
```

The endpoint's `count` is this `contacts` figure MINUS suppression, the sender's own contacts and duplicate addresses; `orphans` matches directly. (`contacts.email` is NOT NULL, so no email predicate is needed.)

## Escalation

- SLO-F7-013 breached for > 30 min, `dispatch_resolve_failed.total` rising ≥ 15 min, or any member's broadcast slips two scheduled ticks → page the platform on-call; inform the chamber admin, who tells the member.
- A count that DISAGREES with a dispatched set for the same tenant state (SC-004 broken) is a stop-the-line bug: capture both correlation ids and open an incident before any manual re-send.

## Prevention

- T081 (`RUN_SCALE_TESTS=1`) runs in the nightly integration sweep with the 20,000-contact proof; a laptop run needs `PERF_AUDIENCE_20K_MS` for the out-of-region RTT (disclose the value you used).
- `tests/contract/broadcasts/cron-{dispatch-scheduled,dispatch-batches,split-large-broadcasts}.contract.test.ts` pin that every dispatch cron passes the composition root's mode + ceiling to the resolver and counts a failed build; `tests/unit/broadcasts/infrastructure/broadcasts-deps-audience.test.ts` pins the flag matrix behind mode + ceiling.
- `check:money-recipient` does not cover marketing mail; the resolver's own unit suite (`tests/unit/broadcasts/application/resolve-segment-recipients.test.ts`, pinned at 100/100) covers every drop rule, the orphan reasons and the ceiling-from-deps.
