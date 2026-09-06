# Runbook — broadcast audience build (108 PR-C, 1:N contact audience)

**Owner**: Platform on-call (escalate to the chamber admin when a member's broadcast is refused or delayed)
**Severity**: alarm (a member's E-Blast is refused, delayed, or its compose-time count is unavailable — never silent under-delivery: the build fails CLOSED)
**Source signal**: `broadcasts_recipient_count_ms` (SLO-F7-013 — compose-time count p95) · `broadcasts_audience_resolved_total{segment,mode}` · `broadcasts_audience_pages_total` · `broadcasts_marketing_opt_out_filter_count` · route error `count_unavailable` (503) on the two recipient-count endpoints · `resolve.server_error` in the dispatch tick log
**Audit events**: `broadcast_member_missing_primary_contact_email` (one per eligible member with no eligible contact — non-blocking) · `broadcast_failed_to_dispatch` (existing F7) · `member_cross_tenant_probe` (admin count endpoint, unknown `member_id`)
**Last reviewed**: 2026-09-07 (108 PR-C T091 — written with the code, not before it)
**Status**: LIVE behind `FEATURE_CONTACT_MARKETING_RECIPIENTS` (default `false`)

> **Scope**: this runbook covers HOW the audience of a broadcast is built and counted since 108 PR-C, and what to do when that build is slow, refused, or unavailable. A broadcast stuck in `sending` AFTER a successful build is `broadcasts-stuck-sending.md`; a Resend-side dispatch failure is `broadcasts-dispatch-failure.md`. There is NO "audience building" state and NO import-based build in PR-C — the Resend Contacts Import path (US5 T086/T087/T106) is DEFERRED to a follow-up PR (see `specs/108-contact-recipient-rules/reviews/pr-c.md` § US5 scope decision).

---

## What the build is (read this once)

One resolver, `resolveSegmentRecipients` (`src/modules/broadcasts/application/use-cases/resolve-segment-recipients.ts`), runs at THREE moments with the same deps, so the number the member sees at compose is the set that is dispatched (SC-004):

| Moment | Caller | Phase | What a failure looks like |
|---|---|---|---|
| Compose (live count) | `GET /api/broadcasts/recipient-count` (member) · `GET /api/admin/broadcasts/recipient-count?member_id=` (staff proxy) | `submit` | 503 `count_unavailable`; the compose form shows the "count unavailable" line (the form stays usable — submit re-resolves) |
| Submit | `submit-broadcast` / `proxy-submit` | `submit` | 422 `audience_too_large` with the TRUE count and the cap, or 500 on a resolver error |
| Dispatch (every tick) | `dispatch-scheduled-broadcast` cron, `dispatch-batches` for split broadcasts | `dispatch` | a resolver error → `dispatch.server_error`: the row STAYS `approved` and the NEXT tick retries (FR-044) — no partial audience is ever pushed. An audience that GREW past the ceiling between submit and dispatch → `failed_to_dispatch`, reason `audience_too_large` (terminal; the member gets the FR-021 notification) |

Steps inside the resolver, in order:

1. **Source** — member-based segments (`all_members`, `tier`) read the F7→F3 bridge `getContactsBySegment`, which walks F3's keyset pages of **5,000 rows** to exhaustion (`buildBroadcastRecipientContactsQuery` — eligible members: `status='active'`, not erased, not halted, + tier; eligible contacts: live and not opted out of marketing, the 0294 partial-index predicate). Audience mode decides which contacts: `primary_only` (flag OFF — the primary contact only) or `all_contacts` (flag ON — every eligible contact). A failed page **throws** → `resolve.server_error`. It never answers `[]` on error (research R8: an empty answer would be a silent truncation). `custom` lists and `event_attendees_last_90d` are sourced elsewhere and skip this read.
2. **Orphans** — an eligible member with no eligible contact is reported (`contactId: null`); the caller emits `broadcast_member_missing_primary_contact_email` and continues. Orphans are counted in the response `orphans` field, never in `count`.
3. **Suppression anti-join** — `marketing_unsubscribes` looked up in chunks of 5,000 addresses.
4. **Marketing opt-out filter** — `filterMarketingOptedOut` through the real bridge, fail-closed (a failed lookup rejects the tick rather than mailing people who objected); metric `broadcasts_marketing_opt_out_filter_count`.
5. **Sender self-exclusion** — by member id on member-based segments only (the sender's own contacts are dropped; custom lists are exempt; attendees are not member-keyed).
6. **Dedupe by address**, then the **ceiling**: `audienceCeiling` = 5,000 with F7.1a batching OFF, 50,000 with it ON. Over the ceiling → `broadcast_audience_too_large { count, cap }` with the TRUE count — never a cut list.

`droppedByPreference` in the count response = opt-out drops (any segment kind) + suppression drops on custom/attendee segments. On member-based segments the suppression drop is not a "preference" the member can see (FR-053a — no address ever leaves the server).

## Symptom → cause → action

### A. Compose shows "recipient count unavailable" (503 `count_unavailable`)

1. Check the route log for `resolve.server_error` with the correlation id — the message names the failing step (page read, suppression lookup, opt-out filter).
2. Neon reachable? (Vercel runtime logs + the Neon console; `docs/runbooks/db-environment-branching.md` says which branch prod is.) A statement timeout on the 5,000-row page is the first suspect on a cold compute.
3. The member CAN still submit — submit re-resolves. Do not tell them to wait for the count.
4. If only ONE tenant sees it, check that tenant's `contacts` count and the 0294 / 0296 indexes on `contacts` with `pnpm db:verify:prod`.

Rate limit: 30 counts/min per (tenant, user) — a 429 here is the client debounce failing (400 ms, one in-flight request), not the build.

### B. Submit refused with `audience_too_large`

The count in the error IS the audience. Two remedies, in order:

1. Narrow the segment (tier instead of all members), or
2. Turn on F7.1a batching (`FEATURE_F71A_US1_PAGINATION` in `src/lib/env.ts` — deployment-wide, not per tenant; it raises the ceiling to 50,000 and routes the broadcast through `split-large-broadcasts` above `SPLIT_THRESHOLD_RECIPIENTS` = 10,000).

Never raise `audienceCeiling` by hand for one member: the ceiling is a Resend-facing safety bound, not a quota.

### C. Dispatch tick slow or timing out

1. `broadcasts_audience_pages_total` tells you the size: pages × 5,000. 20,000 contacts measured **3.7 s** from a ~220 ms-RTT workstation and are budgeted < 3 s from Vercel `sin1` (same region as Neon) — see T081 (`tests/integration/broadcasts/audience-pagination-20k.test.ts`).
2. If SLO-F7-013 (`broadcasts_recipient_count_ms` p95) is breached in prod, run the EXPLAIN from that test's last case against prod READ-ONLY (`node --env-file=.env.production`, dummy `EXPORT_DOWNLOAD_TOKEN_SECRET`) and look for a Nested Loop over a Seq Scan on `contacts` — that is the N+1 shape the 0294 index prevents; a missing index after a restore is the usual cause.
3. A tick that rejects with `resolve.server_error` retries next tick with the SAME audience rule (FR-044). Unlike a Resend failure, a resolver error has NO FR-021 wall-clock budget: the row stays `approved` until a tick succeeds, nothing transitions it and nobody is notified. That is why three consecutive rejects on one broadcast are an incident: its `scheduled_for` is slipping silently; tell the requesting member.

### D. The 1:N audience must be switched off (rollback)

`FEATURE_CONTACT_MARKETING_RECIPIENTS=false` in Vercel env + redeploy (~30 s, no code deploy).

What changes: every NEW resolve (compose count, submit, every dispatch tick) sources the primary contact only (`primary_only`). A broadcast already `approved` but not yet dispatched is re-resolved at its dispatch tick, so it shrinks to primaries — that is the intended blast radius, not a bug. A broadcast already `sending` is unaffected (its recipient rows are written).

What does NOT change: suppression, the marketing opt-out filter, self-exclusion, dedupe and the ceiling all apply in both modes. The opt-out honour is PR-D behaviour and is not behind this flag.

What becomes stale: a count a member saw at compose before the flip. SC-004 holds per tenant STATE, and the audience mode is part of that state.

## Why this matters

- FR-041 / research R8: the audience is never silently truncated — every failure path here is loud (refusal or retry), so "no alarm" means the build is complete, not that it was skipped.
- FR-022a (PR-D): a person's marketing objection is honoured at dispatch. Step 4 is fail-closed on purpose; do not "fix" a slow tick by making it best-effort.
- SC-004: compose count = dispatch set. Any remedy that bypasses the resolver at one moment breaks this.

## Verification query (read-only, prod)

Eligible-contact count for one tenant, the way the resolver sees it in `all_contacts` mode (compare with the admin count endpoint for the same member):

```sql
SELECT count(*) FILTER (WHERE c.contact_id IS NOT NULL) AS contacts,
       count(*) FILTER (WHERE c.contact_id IS NULL)     AS orphans
FROM members m
LEFT JOIN contacts c
       ON c.tenant_id = m.tenant_id AND c.member_id = m.member_id
      AND c.removed_at IS NULL AND c.email IS NOT NULL
      AND c.marketing_opt_out_at IS NULL
WHERE m.tenant_id = $1 AND m.status = 'active' AND m.erased_at IS NULL
  AND NOT m.broadcasts_halted_until_admin_review;
```

The endpoint's `count` is this `contacts` figure MINUS suppression, self-exclusion and duplicate addresses (opt-out is already excluded above); `orphans` matches directly.

## Escalation

- SLO-F7-013 breached for > 30 min, or any member's broadcast slips two scheduled ticks → page the platform on-call; inform the chamber admin, who tells the member.
- A count that DISAGREES with a dispatched set for the same tenant state (SC-004 broken) is a stop-the-line bug: capture both correlation ids and open an incident before any manual re-send.

## Prevention

- T081 (`RUN_SCALE_TESTS=1`) runs in the nightly integration sweep with the 20,000-contact proof; a laptop run needs `PERF_AUDIENCE_20K_MS` for the out-of-region RTT (disclose the value you used).
- `check:money-recipient` does not cover marketing mail; the resolver's own unit suite (`tests/unit/broadcasts/application/resolve-segment-recipients.test.ts`) pins every drop rule and the ceiling-from-deps.
