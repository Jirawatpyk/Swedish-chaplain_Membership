# Runbook — broadcast audience build (108 PR-C, 1:N contact audience)

**Owner**: Platform on-call (escalate to the chamber admin when a member's broadcast is refused or delayed)
**Severity**: alarm (a member's E-Blast is refused, delayed, or its compose-time count is unavailable — never silent under-delivery: the build fails CLOSED)
**Source signal**: `broadcasts.dispatch_resolve_failed.total{tenant,phase}` (a tick answered `dispatch.server_error` — the alarm for a slipping schedule; **`phase=resolve` is the case this runbook is about**, the other phases are listed under § C step 1) · `broadcasts.approved_overdue_count{tenant}` (approved rows > 1 h past `scheduled_for`) · `broadcasts.recipient_count_ms` (SLO-F7-013 — compose-time count p95) · `broadcasts.audience_resolved.total{segment,mode}` · `broadcasts.audience_pages.total` · `broadcasts.marketing_opt_out_filter_count` · route error `count_unavailable` (503) on the two recipient-count endpoints · log events `broadcasts.recipient_count.resolve_failed` / `.resolve_threw` (count), `cron.broadcasts.dispatch.server_error` — **now emitted by BOTH legs** (round 4 L4 added it to the import arm, which counted without logging) and carrying a bounded `errClass` rather than a `[REDACTED]` free-text `reason` (round 4 L3). *(Round 4 D8: this list also named `cron.broadcasts.dispatch_batches.recipient_resolution_failed` and `cron.broadcasts.split_large.recipient_resolution_failed`. Neither string exists anywhere in `src/` — `ca51f59a1` deleted both crons on this branch. § C:67 carries a note about the deletion three screens below; this line, which is what an operator reads FIRST, did not.)*
**Audit events**: `broadcast_member_missing_primary_contact_email` (per eligible member with no eligible contact for a NON-preference reason, capped at 50 per submit — above the cap ONE `member_missing_primary_contact` row with `truncated: true, totalOrphans, reported`; payload carries `orphan_reason`) · `broadcast_failed_to_dispatch` (existing F7) · `member_cross_tenant_probe` (admin count endpoint, unknown `member_id`)
**Last reviewed**: 2026-09-07 (108 PR-C T091; corrected the same day by the review — step order, the verification command, the log-event names)
**Status**: LIVE behind `FEATURE_CONTACT_MARKETING_RECIPIENTS` (default `false`)

> **Scope**: this runbook covers HOW the audience of a broadcast is built and counted since 108 PR-C, and what to do when that build is slow, refused, or unavailable. A broadcast stuck in `sending` AFTER a successful build is `broadcasts-stuck-sending.md`; a Resend-side dispatch failure is `broadcasts-dispatch-failure.md`. There is NO "audience building" state. **Round 4, whole-branch review #6 — the sentence that stood here said the Contacts-Import path (US5 T086/T087/T106) is DEFERRED to a follow-up PR. It is not: it SHIPPED on the Phase-9 branch, gated by `FEATURE_F7_IMPORT_AUDIENCE` (default `false`), and §§ C.4 and D1 OF THIS FILE document how to operate and roll it back.** The scope line was written at PR-C time and never swept when the code landed — so the first paragraph an on-call engineer reads told them a subsystem the same file troubleshoots does not exist.

---

## What the build is (read this once)

One resolver, `resolveSegmentRecipients` (`src/modules/broadcasts/application/use-cases/resolve-segment-recipients.ts`), runs at THREE moments with the same deps, so the number the member sees at compose is the set that is dispatched (SC-004):

| Moment | Caller | Phase | What a failure looks like |
|---|---|---|---|
| Compose (live count) | `GET /api/broadcasts/recipient-count` (member) · `GET /api/admin/broadcasts/recipient-count?member_id=` (staff proxy) | `submit` | 503 `count_unavailable`; the compose form shows the "count unavailable" line (the form stays usable — submit still re-resolves) |
| Submit | `submit-broadcast` / `proxy-submit` | `submit` | 422 `audience_too_large` with the TRUE count and the cap, or 500 on a resolver error |
| Dispatch (every tick) | `dispatch-scheduled` cron — `buildAudienceTick` with the import flag ON, `dispatchScheduledBroadcast` with it OFF | `dispatch` | a resolver error → the row STAYS `approved` and the NEXT tick retries (FR-044), counted by `broadcasts.dispatch_resolve_failed.total`; no partial audience is ever pushed. An audience that GREW past the ceiling between submit and dispatch → `failed_to_dispatch`, reason `audience_too_large` (terminal; the member gets the FR-021 notification) |

Steps inside the resolver, in the ORDER the code runs them. The code's own step comments number them 1 source · 2 eligibility (in the F3 SQL) · 3 self-exclusion · 4 dedupe · 5 suppression · 5b opt-out · 6 empty · 7 ceiling — this list folds eligibility into step 1, so from "self-exclusion" on its numbers are one LOWER than the code's:

1. **Source** — member-based segments (`all_members`, `tier`) read the F7→F3 bridge `getContactsBySegment`, which walks F3's keyset pages of **5,000 rows** to exhaustion (`buildBroadcastRecipientContactsQuery` — eligible members: `status='active'`, not erased, not halted, + tier; eligible contacts: live and not opted out of marketing, the 0294 partial-index predicate). Audience mode decides which contacts: `primary_only` (flag OFF — the primary contact only) or `all_contacts` (flag ON — every eligible contact). A failed page **throws** → `resolve.server_error`. It never answers `[]` on error (research R8: an empty answer would be a silent truncation). A `tier` segment with no codes is REFUSED by F3, never read as "everyone". `custom` lists and `event_attendees_last_90d` are sourced elsewhere and skip this read. On the `all_contacts` leg the bridge also asks F3 for the number of opted-out live contacts the SQL excluded (`countOptedOutContactsBySegment`, fail-closed) — see step 5.
   **Orphans** — an eligible member with no eligible contact is reported with a REASON: `no_primary_email` (primary_only leg), `no_eligible_contact` (no live contact at all) or `all_opted_out` (every contact objected). Only the first two get the missing-contact audit at submit; `all_opted_out` is a preference drop. The sender is never their own orphan.
2. **Self-exclusion** — by member id on member-based segments only (every contact of the sending member; custom lists are exempt; attendees are not member-keyed).
3. **Dedupe by address.**
4. **Suppression anti-join** — `marketing_unsubscribes` looked up in chunks of 5,000 addresses.
5. **Marketing opt-out filter** (step 5b in the code) — `filterMarketingOptedOut` through the real bridge, **fail-closed** (a failed lookup rejects the tick rather than mailing people who objected); metric `broadcasts_marketing_opt_out_filter_count`. On the `all_contacts` leg F3 already excluded those contacts in SQL, so this measures ~0 there and the step-1 count carries the true number.
6. **Empty check, then the ceiling**: the accepted ceiling is `configured` — 5,000, or 50,000 when BOTH `FEATURE_F7_IMPORT_AUDIENCE` AND `FEATURE_CONTACT_MARKETING_RECIPIENTS` are ON. *(Round 3 finding 3-11: this said "the F7.1a batching flag", i.e. `FEATURE_F71A_US1_PAGINATION`, which nothing reads for the ceiling — an operator following it would set a Vercel var, trigger a production redeploy, and see the ceiling not move.)* **The ENFORCED ceiling is `min(configured, 500)` whenever `FEATURE_F7_IMPORT_AUDIENCE` is off — which is its default, and its state at merge.** With the import ON the clamp does not apply, because one call carries any audience regardless of size; with it OFF the legacy serial push (~2.08 req/s, ~623 per `maxDuration = 300`) is the real bound and 500 is that bound with a margin. *(This paragraph carried a "CORRECTED 2026-09-08" marker over a sentence saying "that clamp was interim and Phase 9b removed it", which contradicted its own next sentence AND the code: Phase 9b's batching is what got removed, by `ca51f59a1` on this branch, and the clamp is live. A correction marker is not evidence of correctness — check § D1 and `audience-ceiling.ts` against each other instead.)* So with the import on a submit at 800 recipients is ACCEPTED — if you are triaging one that was refused, the cause is the configured ceiling or the resolver, not the per-tick bound.

`droppedByPreference` in the count response = opt-out drops (step 5 on any segment kind, plus the SQL-excluded opt-outs on the `all_contacts` leg — counted WITHOUT the sender's own company, round 2 C17) + suppression drops on custom/attendee segments only. On member-based segments a suppression drop is not a "preference" the member can see (FR-053a — no address ever leaves the server). The count body carries `droppedByPreference` on EVERY answer (round 2, C8): the pipeline runs to the end before it refuses, so "0 recipients, 12 excluded by preference" is distinguishable from "0 recipients, nobody there". The MEMBER body never carries `orphans` (a fact about other members); the staff body does.

The page walk is NOT a snapshot: each page is its own `runInTenant` transaction. Keyset order means no block is skipped by concurrent inserts or deletes after the cursor, but a contact inserted BEFORE the cursor mid-walk is missed until the next resolve. Do not build a reconciliation on the assumption of a consistent read.

## Symptom → cause → action

### A. Compose shows "recipient count unavailable" (503 `count_unavailable`)

1. Find the correlation id in the route log. `broadcasts.recipient_count.resolve_failed` is the typed failure of one of the THREE bridge reads inside the resolver's `try` — the keyset page walk, the opted-out count (`countOptedOutContactsBySegment`) or the primary-only member read (its `err` is the bridge's message, which names the read); `broadcasts.recipient_count.resolve_threw` is a THROWN suppression lookup, opt-out filter, attendee read or a resolver programming error (its `err` is the error class only). Also check `broadcasts_recipient_count_ms{outcome="unavailable"}` — it alarms when every count is failing.
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
2. **Turn on the Contacts-Import build to raise the ceiling** — `FEATURE_F7_IMPORT_AUDIENCE=true` in Vercel env + redeploy. *(This bullet has said three different things in one day: "turn on F7.1a batching", then "NO-OP", then "batching IS the remedy again". Batching is deleted. This is the remedy.)* With it ON the whole audience goes to Resend in ONE call regardless of size, so the per-tick clamp stops applying and the accepted ceiling is the configured 5,000 — or 50,000 with `FEATURE_CONTACT_MARKETING_RECIPIENTS` as well. Above ~1,000 contacts the Resend plan is the limit, not the code: a batch beyond it fails loudly with a `permanent` 4xx, which is the intended signal to upgrade. Narrowing the segment (option 1) is still the faster answer for a one-off.

Never raise `audienceCeiling` by hand for one member: the ceiling is a Resend-facing safety bound, not a quota.

### C. Dispatch tick cannot build the audience, or is slow

1. **Alarm**: `broadcasts.dispatch_resolve_failed.total` rising for ≥ 15 min on one tenant, or `broadcasts.approved_overdue_count ≥ 1` for 30 min. Unlike a Resend failure, a resolver error has NO FR-021 wall-clock budget: the row stays `approved` until a tick succeeds, nothing transitions it and nobody is notified — without these two signals a schedule slips silently. Find the broadcast id in `cron.broadcasts.dispatch.server_error` and tell the requesting member. **Read the counter's `phase` label before this triage tree** (2026-09-10 follow-up 5 — until then the counter fired for every `dispatch.server_error` alike and this paragraph said "the log event says which"): `resolve` → continue here; `lock` (Step-1 row read) and `persist_broadcast_id` (the pre-send `resend_broadcast_id` write) → Neon, not F3 — the second one reads the row back and then: write landed → resource KEPT (`persist_ack_lost_id_kept`, the next tick inherits it); write absent → resource reclaimed (`minted_broadcast_reclaimed`); read-back itself failed → resource KEPT (`persist_read_back_failed_resource_kept` — a junk draft is the cheaper wrong), so during a Neon outage that outlasts the read-back you WILL see one draft per tick in the Resend dashboard until it clears, and they are safe to delete by hand; `inherited_status` → the probe on an inherited id answered a status this build cannot interpret and REFUSED (`inherited_resource_unrecognised_status`, critical) — deliberately NOT on a retry clock, because a clock would turn "unknown whether sent" into "failed, member told"; recovery is adding the status to `normaliseStatus` and deploying, or deleting the resource at Resend so the probe answers `not_found`; `gateway` (import leg only) → a Resend retryable still inside the FR-021 budget. (This paragraph named `dispatch-batches` as a second uncovered case until 108 Phase 9; that cron was deleted.) A `malformed_segment` (a `tier` row with no codes) is NOT counted here: it is a terminal `failed_to_dispatch` on both dispatch legs — a data defect to fix in the row, never a retry. (The import leg reached this only after 108 Phase 9 review S6; before that it fell through to a transient `dispatch.server_error` and retried for ever.)
2. **Size**: `broadcasts.audience_pages.total` is CUMULATIVE — read it as a rate, not a size. Each completed resolve costs one page per 5,000 rows plus one exhaustion page (20,000 contacts = 5 pages; T081 pins "4 full pages plus the empty proof page"); N broadcasts on one segment in a tick walk the pages ONCE (per-tick memo). 20,000 contacts measured **3.1–3.4 s** from a ~220 ms-RTT workstation (first measured 3.7 s; the spread between runs of identical code is ~200 ms, so treat these as one figure) and are budgeted < 3 s from Vercel `sin1` (same region as Neon) — `tests/integration/broadcasts/audience-pagination-20k.test.ts`. That budget is UNVERIFIED from `sin1` until the first prod sample (perf review: projected 1.4–1.8 s).
3. If SLO-F7-013 (`broadcasts.recipient_count_ms{outcome="ok"}` p95) is breached in prod, run the EXPLAIN from that test's last two cases against prod READ-ONLY (`node --env-file=.env.production`, dummy `EXPORT_DOWNLOAD_TOKEN_SECRET`): the deep-cursor case asserts the keyset bound sits INSIDE an `Index Cond` on `members` (`member_id >=`) — a cursor that shows up as a `Filter` instead means every page is re-scanning the tenant from its first member (the shape round 2 fixed); a Nested Loop over a Seq Scan on `contacts` is the N+1 shape the 0294 index prevents; a missing index after a restore is the usual cause (§ A step 4 has the query).

4. **`broadcasts.audience_import_stuck_count` ≥ 1 for 30 min — a Contacts-Import has not completed** (108 US5, T106). Alarm, not page.

   `buildAudienceTick` already turns such a row terminal (`audience_import_stuck`), but only on a tick that reaches that broadcast. This gauge counts them independently, and that is why it is worth reading first: **several broadcasts, or broadcasts across tenants, means "Resend's import pipeline has stopped answering", not "this broadcast is unhappy"**. No per-broadcast status can tell you that.

   The row is `approved` with `audience_import_id` set and `audience_import_completed_at` NULL. **Nothing has been sent** — the send happens only after the completion rule passes — so there is no partial delivery to unwind. Once the use case marks it `failed_to_dispatch` the member gets the FR-021 notification and can re-submit.

   Do NOT treat `completed` alone as success. `status: completed` with `failed: 0` and `total: 0` was observed once in five identical probes (research § R9 V2 (c)); the rest of the completion rule — parts summing to `total`, and `total` equal to the count WE resolved — is what stands between that and a send to an empty audience.

   **Free-plan limits, worth checking before blaming the code**: 3 audiences (`POST /audiences` fails outright for a fourth — measured 2026-09-08) and 1,000 contacts, counted account-wide across ephemeral audiences until `cleanup-audiences` reaps them (grace 1 h, cron every 15 min). Both surface as a `permanent` 4xx, which fails the broadcast loudly rather than silently, and that is the intended signal to upgrade the plan.

### D1. The Contacts-Import build must be switched off (rollback)

**⚠️ DRAIN FIRST — THIS ROLLBACK IS NOT SAFE AT AN ARBITRARY MOMENT. Read to the
SQL below before you set anything.**

*(Round 2 R2-46: this section used to open with the command and put the warning on
the next line. An on-call engineer scanning for what to type executes before
reading — and the failure mode this section exists to prevent is delivering to a
half-built audience. The heading was also `E` while sitting between `C` and `D`;
the two rollback sections are `D1` and `D2` now, so the file reads A, B, C, D1,
D2 in the order it is printed — and the two rollbacks sit together, which is how
an operator meets them.)*

The command, once the drain below returns 0 rows:
`FEATURE_F7_IMPORT_AUDIENCE=false`, or remove the variable — `src/lib/env.ts`
defaults it to `false`, so absent is a valid boot that resolves to off.

The flag routes each tick to one leg or the other. `dispatchScheduledBroadcast`
does not read `audience_import_*` at all, but it DOES reuse
`resend_audience_id` — so a row mid-import handed back to the legacy leg gets
contacts pushed into an audience the import is still filling, and is then sent
with no completion rule applied. That is the one way this feature can deliver to
a half-built audience.

Run against prod and require **0 rows** before removing the variable:

```sql
SELECT tenant_id, broadcast_id, audience_import_submitted_at
  FROM broadcasts
 WHERE audience_import_id IS NOT NULL
   AND audience_import_completed_at IS NULL
   AND status = 'approved';
```

`status = 'approved'` is load-bearing (round 2 R2-6): only an `approved` row can
be stranded by the rollback. A `failed_to_dispatch` row also has an import id
with no completion stamp, and counting it reports work that does not exist.

This predicate **IMPLIES** — and is not identical to —
`broadcasts_audience_import_pending_idx`, whose partial condition is the first two
clauses only. The index is therefore still used and the query is still cheap; it
just returns a subset of the index's rows. (The two were described as "the same
predicate", which stops being true the moment either grows a clause. Round 4 D5:
the correction then stated the implication BACKWARDS — "IMPLIED BY" — and it is
the direction that carries the conclusion. Query ⇒ index is what licenses "the
index is still used"; index ⇒ query would not. `schema.ts:392` had it right the
same day, in the same words, pointing the other way.) A row that will not drain is stuck (§ C.4) — let it reach
`failed_to_dispatch` — **worst case ~35 minutes** (up to 30 min for
`IMPORT_STUCK_AFTER_MS` plus one 5-minute tick to act on it), which is the number
to plan the maintenance window around — and re-submit it after the rollback,
rather than flipping
underneath it.

What changes on the OFF leg: the accepted ceiling becomes `min(configured, 500)`,
because the serial push drains ~623 contacts per 300 s tick at the measured
2.08 req/s. Broadcasts already `sending` are unaffected.

### D2. The 1:N audience must be switched off (rollback)

`FEATURE_CONTACT_MARKETING_RECIPIENTS=false` in Vercel env + redeploy (~30 s, no code deploy).

What changes: every NEW resolve (compose count, submit, every dispatch tick) sources the primary contact only (`primary_only`), and the ceiling returns to 5,000. *(⚠️ CORRECTED 2026-09-09: 5,000 is the CONFIGURED ceiling, not the enforced one. With `FEATURE_F7_IMPORT_AUDIENCE` off — the default — the enforced bound is `min(configured, 500)`. This sentence previously described a Phase 9b batch/split model that `ca51f59a1` deleted.)* Rolling those back is a code revert (`vercel promote`). A broadcast already `approved` but not yet dispatched is re-resolved at its dispatch tick, so it shrinks to primaries — that is the intended blast radius, not a bug. **One edge (round 2, errors LOW)**: if that primary-only audience is STILL over 5,000, the re-resolve answers `broadcast_audience_too_large`, which dispatch treats as TERMINAL — `failed_to_dispatch` plus the FR-021 member notification — so the rollback kills that broadcast rather than shrinking it. Not reachable at SweCham's scale (~150 members); at a tenant where it is, cancel such broadcasts before the flip and tell the members. A broadcast already `sending` is unaffected (its recipient rows are written).

What does NOT change with the flag: nine things, listed in full in `specs/108-contact-recipient-rules/quickstart.md` § Rollback matrix row C. The two an operator is most likely to be surprised by: **`marketing_unsubscribes.contact_id` is written by every unsubscribe from merge onward** (no flag read — do not drop the column while this code is deployed), and **the sender is no longer excluded from a custom list or the attendee segment** (pre-108 their primary address was filtered out of every segment kind). Rolling any of the nine back is a code revert, not a flag flip.

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
- `tests/contract/broadcasts/cron-dispatch-scheduled.contract.test.ts` · `tests/unit/broadcasts/application/build-audience-tick.test.ts` · `tests/integration/broadcasts/audience-import-two-tick.test.ts`
- `check:money-recipient` does not cover marketing mail; the resolver's own unit suite (`tests/unit/broadcasts/application/resolve-segment-recipients.test.ts`, pinned at 100/100) covers every drop rule, the orphan reasons and the ceiling-from-deps.
