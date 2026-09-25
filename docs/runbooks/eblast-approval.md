# Runbook — E-Blast member approval (F119)

**Severity**: PAGE when `broadcasts_awaiting_member_oldest_age_seconds > 14 d` for any tenant, and
on any increase of `broadcasts_no_marketing_recipient_total`; WARNING at `> 7 d`
**Owner**: Broadcasts on-call (broadcasts module)
**Related code**:
- Use cases: `src/modules/broadcasts/application/use-cases/approval/**`
  (`start-formatted-version`, `save-formatted-version`, `send-version-to-member`,
  `record-member-decision`, `confirm-schedule`, `expire-stale-member-approvals`)
- Routes: `src/app/api/admin/broadcasts/[id]/{version,version/send,schedule,reject,cancel,images}`,
  `src/app/api/broadcasts/[id]/{decision,versions,cancel}`
- Pages: `/admin/broadcasts/[id]` (the formatting surface), `/portal/broadcasts/[id]` (the
  member sign-off screen)
- Flag: `isEblastMemberApprovalEnabled()` in `src/modules/broadcasts/infrastructure/feature-flags.ts`
  (`FEATURE_F7_BROADCASTS` **and** `FEATURE_EBLAST_MEMBER_APPROVAL`)
- Emails: the five `eblast_*` outbox types, rendered at send time by
  `src/lib/broadcast-approval-notifications.ts`, drained by `/api/cron/outbox-dispatch` (every 60 s)
- Clock: Block 3 of `/api/cron/broadcasts/prune-expired-drafts` (daily 04:30 UTC) —
  `docs/runbooks/cron-jobs.md` § Block 3
- Gauges: the broadcasts half of `/api/internal/metrics/broadcasts-gauges` (every 5 min)
- Spec authority: `specs/119-eblast-approval-workflow/` (`spec.md`, `quickstart.md` § 3.2 cutover
  + § 3.5 rollback matrix, `contracts/dashboard-and-notifications.md`)
- Metrics, alerts and the `M119.*` errorId taxonomy: `docs/observability.md` § 29

## What the feature does (so the audit trail reads correctly)

A member submits an E-Blast as before. Marketing can still **approve it as submitted** or
**reject** it — today's flow, unchanged. The new path: marketing **starts a formatted version**
(the member's original is kept untouched as version 0), edits a working copy, and **sends it to
the member**. The member approves it, asks for changes (with a reason), or later withdraws an
approval; marketing then **confirms the send time**, and only at that moment is the approved
version copied onto the E-Blast record the dispatcher sends. A member who never answers is
reminded, warned and — on day 30 — the E-Blast closes on its own. Nothing is ever approved on the
member's behalf.

| Stage (status) | Label (staff) | Whose turn | Leaves by |
|---|---|---|---|
| `submitted` | Awaiting marketing review | Marketing | approve as submitted → Scheduled · Start formatted version → In design · reject · cancel |
| `in_design` | In design | Marketing | Send to member → Awaiting member approval · reject · cancel |
| `awaiting_member_approval` | Awaiting member approval | **Member** | approve → Member approved · request changes → Changes requested · day 30 → Expired · reject · cancel |
| `changes_requested` | Changes requested by member | Marketing | Start formatted version (next round) → In design · reject · cancel |
| `member_approved` | Member approved — awaiting schedule | Marketing | Confirm schedule → Scheduled · member withdraws approval → Changes requested · Start a new version (voids the approval) → In design · reject · cancel |
| `approved` | **Scheduled** | nobody | the dispatcher at `scheduled_for` → Sending · member withdraws approval → Changes requested · "Cancel the confirmed time" → Changes requested · Start a new version → In design · cancel. **No reject edge** — use cancel. |
| `expired_no_member_response` | Expired — no member response | nobody | terminal. The member submits a new E-Blast. |

"Sending begins" is entry into `sending`. Until then the member may withdraw and marketing may
reject (except from Scheduled, above) or cancel; from `sending` on, both answer 409
`sending_started`.

Every step is one audit row, on the same transaction as the state change:
`broadcast_version_started`, `broadcast_version_sent_to_member`, `broadcast_member_approved`,
`broadcast_member_changes_requested`, `broadcast_member_approval_withdrawn`,
`broadcast_member_approval_voided`, `broadcast_schedule_confirmed` (with `proposed_send_at`,
`confirmed_send_at`, `differs`, `mode`), and the three system rows the daily tick writes —
`broadcast_approval_reminder_sent`, `broadcast_approval_expiry_warned`,
`broadcast_approval_expired`. Payloads carry ids, rounds and `note_length` / `reason_length` —
never the subject, body, note or reason text. The **history** (versions and decisions) is its own
record, in `broadcast_versions` and `broadcast_member_decisions`, and is what both sides see on
their detail pages.

**The SC-002 proof chain** for any sent E-Blast whose content marketing changed:
`broadcasts.approved_version_id` → the `broadcast_member_decisions` row with
`decision = 'approved'` → the `broadcast_versions` row (frozen since `sent_to_member_at`) → the
`broadcast_schedule_confirmed` audit row that promoted it.

## Triage order (do these before touching anything)

1. **Is the flag on on this deployment?** With it off, `POST /api/admin/broadcasts/[id]/version`
   on a `submitted` E-Blast answers **404** and "Start formatted version" is not offered on a
   submitted row. Everything already in a new stage keeps working (§ Flag rollback). **With the
   flag off, none of the five `eblast_*` emails is delivered** — so a "the member never got the
   email" report while the flag is off is expected behaviour, not a fault.
2. **Where is the row, and since when?** (read-only session)
   ```sql
   SELECT broadcast_id, status, stage_entered_at, current_round, member_reminder_stage,
          member_expiry_notified_at, proposed_send_at, scheduled_for, approved_version_id
     FROM broadcasts
    WHERE tenant_id = '<tenant>'
      AND status IN ('submitted','in_design','awaiting_member_approval','changes_requested',
                     'member_approved','approved')
    ORDER BY stage_entered_at;
   ```
   `stage_entered_at` is the clock for "time in stage", the stalled flag and the reminder/expiry
   tick; every real status change stamps it (a reschedule `approved → approved` does not).
3. **Were the emails sent?**
   ```sql
   SELECT notification_type, status, attempts, last_error, locale, created_at, updated_at,
          context_data->>'kind' AS kind, context_data->>'audience' AS audience
     FROM notifications_outbox
    WHERE tenant_id = '<tenant>'
      AND notification_type::text LIKE 'eblast\_%'
      AND context_data->>'broadcastId' = '<broadcast uuid>'
    ORDER BY created_at;
   ```
   `pending` + `attempts = 0` + no `last_error` = held by the flag (or not yet ticked).
   `permanently_failed` + `last_error = 'request_superseded'` = stale at send time and closed on
   purpose (§ After a re-flip). `last_error = 'read_failed'` = a read the arm depends on failed
   this tick; the row retries (§ The `read_failed` and `no_template_handler` symptoms).
   `last_error = 'no_template_handler'` → the same section.
4. **Open the E-Blast** at `/admin/broadcasts/<id>`: the approval-round card shows whose turn it
   is, the time in stage, the round and both send times; the version history sits below the
   workspace.

## Stuck stage — what each one means and what to do

The dashboard flags a row as **stalled** at **48 h** in a marketing-held stage and **3 days** in
the member-held stage (FR-027). The age alerts (§ 29.4) bind to the member-held stage only.

### `submitted` — Awaiting marketing review (marketing)

Nobody has decided. With the flag on, each marketing user was emailed
(`eblast_submitted_marketing`); with it off, nobody was, exactly as before this feature. Decide
it: approve as submitted, reject with a reason, or start a formatted version. Starting a version
ends the approve-as-submitted option for that E-Blast (the member must then approve).

### `in_design` — In design (marketing)

A working copy exists and has not been sent. Finish it and **Send to member**. Two refusals keep
a row here:

- **409 `no_portal_user`** — the member company has no ACTIVE member-role portal login, so nobody
  can sign off. The detail page says so. Invite a portal user, or reject with a reason. Approve as
  submitted is no longer available once a version was started.
- **422 `image_source_not_allowlisted`** — an image in the version points at a host no longer on
  the tenant's image allow-list; the response and the detail page's warning name each image and
  why. Replace the image, save, and send again.

A conflicting save by a second staff user is refused **409 `version_changed`** with the current
content; the page offers "Reload (discards your edits)".

### `awaiting_member_approval` — Awaiting member approval (member)

The version was emailed to the member's approval contact — the contact linked to the login that
submitted the E-Blast, else the primary contact, else the lowest-id active portal contact — in
that contact's language, with the day 3 / 7 / 23 / 30 timeline. **Marketing cannot pull the
version back** (there is no `awaiting_member_approval → in_design` edge) and **cannot approve on
the member's behalf** — a staff session is refused 403 on the decision route.

1. Confirm the email actually went: step 3 of Triage. If the flag was off when the version was
   sent, the member was **not emailed** and the clock is still running — contact the member by
   hand.
2. Check the tick is serving the row: `member_reminder_stage` should be 1 after day 3, 2 after
   day 7, 3 after day 23. A row past day 3 with stage 0 means Block 3 is failing (§ The expiry
   clock).
3. Contact the member. If the E-Blast is no longer wanted, **reject** it with a reason (the member
   is told) or **cancel** it. Otherwise the day-30 closure is the designed end.

A lapsed member can still open the E-Blast and decide on it (reading and deciding are not benefit
actions — five exact portal paths are exempt from the lapsed gate); the existing sending rules
apply at send time.

### `changes_requested` — Changes requested by member (marketing)

The member asked for changes, or withdrew an approval (`approved_version_id` and `scheduled_for`
were both cleared). The reason is on the detail page, attached to the round it concerns. **Start
formatted version** (the next round), or reject with a reason. Marketing may send byte-identical
content again with a note explaining why (FR-011); the round number moves only when a version is
sent.

### `member_approved` — Member approved — awaiting schedule (marketing)

**Confirm schedule.** The dialog offers only the modes the route accepts here: keep the member's
proposed time (only when there is one and it is at least 5 minutes away), choose another time,
or send now. At this moment the approved version is **promoted** onto the E-Blast record in the
same statement as the status flip — the only post-submit content write the database allows. The
promotion re-checks every image host; a de-allow-listed image refuses it with 422
`image_source_not_allowlisted` (replace it via a new version, which voids the approval and needs
the member again). The member is emailed the confirmed time, with an explicit "this is not the
time you proposed" line when they differ.

The proposal is `proposed_send_at`: written by the submit (`draft → submitted`) from the time the
member requested, and frozen from then on by the immutability trigger — a later confirm or
reschedule moves `scheduled_for`, never the proposal. A member who requested no time has `NULL`
("The member did not propose a time.", and "keep" is not offered — 409 `no_proposal`). Rows
submitted before `0308` carry a proposal only if they were still `submitted` at that deploy (the
backfill); every other historical row shows "not recorded".

### `approved` — Scheduled (nobody)

The approved content is on the record and `scheduled_for` is set; the F7 dispatcher
(`/api/cron/broadcasts/dispatch-scheduled`, every 5 min) sends it when due. A row stuck here past
its time is an F7 dispatch problem — see `docs/runbooks/broadcasts-dispatch-failure.md`,
`docs/runbooks/broadcasts-queue-overflow.md` and `cron-jobs.md` § F7. A Scheduled row is **never
expired**. The schedule dialog here offers "Choose another time", "Send now" and "Cancel the
confirmed time" (→ Changes requested, approval and time both cleared) — not "keep the proposal".
To stop it otherwise: start a new version (voids the approval) or cancel the E-Blast. Reject is
not offered here. When it comes due, the dispatcher re-checks the member's standing: it HOLDS the
send while the membership is awaiting payment, and refuses a halted member or an ended membership
— see § Dispatch standing refusal.

### `expired_no_member_response` — Expired (closed)

Terminal and cannot be reopened (the DB state machine has no edge out). The allowance place is
free (`quota_year_consumed` stays NULL). The member submits a new E-Blast if they still want one.

## Dispatch standing refusal

F119 PR-A — unflagged, so it applies to every F7 send, flag on or off. Just before any Resend
call, both dispatch legs re-read the rules submit applies (`decideDispatchStanding` →
`readMemberSendStanding`): the F7 halt flag and F8 membership access. The approval edges read
them too, but an E-Blast can sit `approved` for days, and a refund or full credit note ends
coverage at once (`0306`).

The answer is one of three (the maintainer's decision, R1):

- **Held** — the membership is `suspended`: an unpaid renewal whose paid period has ended, a new
  member's first bill still unpaid, or `pending_admin_reactivation`. (Since #397 an early renewal
  bill no longer suspends a member who paid for the current period.) Nothing is sent.
- **Refused, permanently** — the member's E-Blasts are **halted** (the complaint-rate auto-halt),
  or the membership has **ended** (F8 `terminated`: cancelled / coverage ended, lapsed, refunded).
- **Undecided** — the standing read failed. Nothing is sent; the next tick asks again.

**What it looks like**

| Signal | Held (awaiting payment) | Refusal (halted / membership ended) | Read failure |
|---|---|---|---|
| Row | stays `approved` — every tick (5 min) re-checks it; the only write is the FR-021 retry-clock reset (`dispatch_first_failed_at = NULL`, only if it was set) | `failed_to_dispatch`, `failure_reason` = `member_halted` or `member_not_in_good_standing` | stays `approved` — the next tick asks again |
| Staff detail page | once `scheduled_for` has passed: an info note "Held — the member's membership is awaiting payment; the E-Blast will send automatically once it is settled, or fail if the membership ends" | a "Why this E-Blast was not sent" note under the status, naming the cause | nothing new |
| Audit | **none** (a row every 5 min would bury the log) | `broadcast_failed_to_dispatch` **and** `broadcast_member_halted_pending_review` / `broadcast_membership_suspended_blocked` with `surface: 'dispatch'`, actor `system:cron`, `actor_role: null` (one tx). The membership row also carries `access` — always `terminated` here (a suspended member is held); at submit / approve / schedule confirm it is `suspended` or `terminated` | none |
| Member | nothing | the FR-021 "did not go out" email: a factual reason, "contact the chamber", and that they can submit the content as a new E-Blast once the chamber has resolved it | nothing |
| Quota | unchanged (still reserved) | the slot is released (design D1) | unchanged (still reserved) |
| Logs / metrics | `broadcasts.dispatch.standing_held` (info; `broadcastId`, `leg`) + `broadcasts_dispatch_standing_held_total` (+1 per tick); the cron summary's `held` bucket | `broadcasts_failed_to_dispatch_count{failure_reason="member_ineligible"}` — never `app_error` | `broadcasts_dispatch_resolve_failed_total{phase="standing"}` + a `cron.broadcasts.dispatch.server_error` warn with `errClass` |

**How a held row resumes.** Nothing to do by hand. The moment the member pays and the cycle
completes, F8 answers `full` and the next tick sends — after `scheduled_for`, by however long the
hold lasted (the `broadcast_send_started` row's `delaySeconds` records how late). If the member
never pays, the cycle lapses (`terminated`) and the next tick refuses it permanently
(`member_not_in_good_standing`, member emailed, slot released). To stop a held E-Blast sooner,
cancel it (an `approved` row is cancellable).

**Side effects of a hold, know them before triaging an alarm:**

- `broadcasts_approved_overdue_count` counts a held row after an hour and its alarm (≥ 1 for 30
  min) stays on for the whole hold. `broadcasts_dispatch_standing_held_total` climbing for the
  same tenant means "waiting for payment", not "stuck".
- **Import leg only** (`FEATURE_F7_IMPORT_AUDIENCE` on): a hold on tick 2 keeps the tick-1 Resend
  audience (and its submitted import) until the row resumes or is refused — one of the Free plan's
  three audiences. On resume the completion rule still applies: an audience that changed during
  the hold is refused as `count_mismatch` (FR-044 a), not sent.
- **Import leg only — false import-stuck alarm.** The hold returns before `confirmImport`, so a
  row held on tick 2 or later keeps `audience_import_id` set and `audience_import_completed_at`
  NULL while its status stays `approved`. `broadcasts.audience_import_stuck_count` matches exactly
  that shape (`broadcasts-gauges`: `status = 'approved'`, import submitted more than 30 min ago), so
  it counts the held row and its alarm stays on until the member pays (the next tick confirms the
  import) or the cycle lapses (the refusal makes the row terminal). It reads as "Resend's import
  pipeline has stopped answering" when it is really a wait for payment. The gauge cannot tell a
  held row apart without reading member standing, so the code is unchanged; **resolve this before
  `FEATURE_F7_IMPORT_AUDIENCE` is turned on** (dormant while it is off, as it is in prod). Until
  then: a stuck count on one tenant with `broadcasts_dispatch_standing_held_total` climbing for the
  same tenant is a hold.
- **Both legs:** a hold does not spend the FR-021 retry budget. Since migration `0311` (F119
  PR-E) the hour counts from the FIRST retryable Resend failure of the dispatch attempt
  (`broadcasts.dispatch_first_failed_at`), not from `scheduled_for`, so a row resuming days late
  gets its full hour. The column is reset on every status change, on a re-time, on every held tick
  (the one write a hold makes — no audit row, no email; a failed reset logs
  `broadcasts.{dispatch,audience_import}.retry_clock_clear_failed` and the tick is still held)
  and right after a successful `sendBroadcast`. So a failure → a two-day hold → payment → one blip
  is a fresh hour, not `retry_budget_exhausted`.
- **Residual — a read-only freeze does NOT reset the clock.** A paused cron cannot write, so a row
  that failed before a `READ_ONLY_MODE` freeze keeps its stamp; if the freeze outlasts the rest
  of the hour, the first retryable failure after the lift is terminal and the member email's
  "unreachable for over an hour" then describes the freeze. **Mitigation:** after lifting a long
  freeze, list the `approved` rows carrying a stamp
  (`SELECT broadcast_id, dispatch_first_failed_at FROM broadcasts WHERE status = 'approved' AND
  dispatch_first_failed_at IS NOT NULL`, per tenant) and clear them with the same SQL as the
  rollback bullet below: `UPDATE broadcasts SET dispatch_first_failed_at = NULL WHERE status =
  'approved' AND dispatch_first_failed_at IS NOT NULL` (as the migration owner, or after
  `SET LOCAL app.current_tenant = '<tenant>'` once per tenant). A staff-page re-time is NOT the
  general fix: confirm-schedule refuses a legacy-approved row (`current_round = 0` →
  `round_zero`) and a row a tick already handed to Resend (`resend_broadcast_id` or
  `audience_import_id` set → `sending_started`). A re-time clears the clock only on a round ≥ 1
  row with neither id (`cron-jobs.md` § Read-only mode).
- **A retryable failure of the inherited-id probe is never budgeted** (legacy leg; review M1). The
  probe runs only when an earlier tick minted the Resend broadcast, and an unanswered probe cannot
  say whether that mail already went out — so it retries every tick
  (`broadcasts.dispatch.inherited_probe_retryable`, warn) instead of going terminal and telling the
  member a delivered E-Blast failed. The operator signal for a probe that never answers is
  `broadcasts_approved_overdue_count`, as for the `inherited_status` refusal.
- **Rolling PR-E back:** `vercel promote` leaves the `dispatch_first_failed_at` column in place and
  the old code never clears it, so a row stamped by the new code and then re-approved under the
  old code keeps a stale stamp after the redeploy — after such a rollback-and-redeploy, run
  `UPDATE broadcasts SET dispatch_first_failed_at = NULL WHERE status = 'approved' AND
  dispatch_first_failed_at IS NOT NULL` (`broadcasts` is RLS + FORCE: as the migration owner, or
  after `SET LOCAL app.current_tenant = '<tenant>'` once per tenant). Never edit or revert
  migration `0311` itself.

A refusal is **permanent by the maintainer's rule, halted members included**: there is no edge out
of `failed_to_dispatch`, and clearing a halt does not revive the row. A halt is re-read UNCACHED
before it refuses (the cron memoises the halt list per tick), so a halt cleared mid-tick is not made
permanent by the memo. Mail a prior tick already handed to Resend is never refused (legacy leg: the
inherited-id probe; import leg: a `resend_broadcast_id` this leg attached, i.e. on a row that also
carries `audience_import_id` — a legacy-leg row carried across a flag flip IS gated).

**What staff do**

1. Open `/admin/broadcasts/<id>`; the note says held, or names the refusal. On a refusal the
   member has already been emailed.
2. **Held** — nothing to do on the row; it sends by itself once paid. Chase the renewal payment in
   F8 if appropriate, or cancel the E-Blast if it should not go out late.
3. **Halted** — the member's E-Blasts were halted by the complaint-rate auto-halt. Review the halt
   as usual (`/admin/broadcasts` halt banner → Clear halt). Nothing to do on this row.
4. **Membership ended** — terminated (lapsed, refunded, fully credited, cancelled). Resolve the
   membership in F8 if that is wrong.
5. If the member still wants refused content sent, they (or staff by proxy) submit a **new**
   E-Blast once eligible. The released slot is available to it.
6. **Read failures** that persist (`phase="standing"` > 0 for 15 min) mean the F3 halt read or the
   F8 renewal-cycle read is failing: check Neon, the `errClass` on the cron's warn line, and the
   `[membership-access-bridge] access lookup failed — failing closed` warns. Nothing is sent while
   it lasts, so a scheduled send slips; `broadcasts_approved_overdue_count` notices after an hour.
7. `phase="terminal_write"` on the live leg means a refusal (or any terminal failure) could not be
   written: nothing was recorded and nobody was told; the row stays `approved` and the next tick
   tries again. Persisting → Neon.

**Query** — standing refusals in the last 7 days:

```sql
SELECT timestamp, event_type, payload->>'broadcast_id' AS broadcast_id,
       payload->>'related_member_id' AS member_id,
       payload->>'access' AS access  -- membership rows only; NULL on a halt and on rows written before PR-D
  FROM audit_log
 WHERE tenant_id = '<tenant>'
   AND event_type IN ('broadcast_member_halted_pending_review', 'broadcast_membership_suspended_blocked')
   AND payload->>'surface' = 'dispatch'
   AND timestamp > now() - interval '7 days'
 ORDER BY timestamp DESC;
```

## The expiry clock

Block 3 of the daily `prune-expired-drafts` tick (04:30 UTC = 11:30 Bangkok), for rows in
`awaiting_member_approval` **only** — a row at `member_approved` or Scheduled is never touched.

| Day (from `stage_entered_at`) | Action | `member_reminder_stage` | Emails (`eblast_approval_lifecycle`) | Audit |
|---|---|---|---|---|
| 3 | reminder | → 1 | member | `broadcast_approval_reminder_sent { reminder: 'day3' }` |
| 7 | final reminder | → 2 | member | `broadcast_approval_reminder_sent { reminder: 'day7' }` |
| 23 | expiry warning | → 3 | member **and** every marketing recipient | `broadcast_approval_expiry_warned { days_waiting }` |
| 30 | close as `expired_no_member_response`, stamp `member_expiry_notified_at` | unchanged | member **and** every marketing recipient | `broadcast_approval_expired { days_waiting, allowance_released: true }` |

- **Counter-driven reminders.** `member_reminder_stage` records the highest threshold already
  served, so each fires once however many ticks run. A tick that finds several due (the cron
  missed days) serves **only the latest** — a member never gets two reminders on one day.
- **Date-only expiry.** Day 30 closes the row whatever the counter says, so a cron outage between
  day 23 and day 30 cannot keep an E-Blast open past the date the member was told.
- **Every new version restarts the clock**: sending a version re-stamps `stage_entered_at` and
  resets the counter to 0.
- A reminder with no active portal contact to send to still moves the counter (it must not fire
  daily forever) but writes **no** "reminder sent" audit row; the log line is
  `M119.cron.approval_lifecycle.no_member_recipient`.
- The tick runs **whatever the flag says** — with the flag off the rows are still reminded and
  closed, but the emails wait in the outbox.
- If `FEATURE_F7_BROADCASTS` is off the whole tick answers 200 `{ skipped: true }` and the clock
  does not run at all.

**Reading the tick** — the response body carries `approvalLifecycleOk`, `remindersSent`,
`warningsSent`, `expired`, `approvalLifecycleRowsFailed`. A failed scan answers
`approvalLifecycleOk: false` and the tick 500s at the end, after the draft prune and the image
sweep ran. A failed row is left for tomorrow, logged at `error` with
`errorId: 'M119.cron.approval_lifecycle.rows_failed'` (per-row cause on the
`M119.cron.approval_lifecycle.row_failed` message), and the tick stays 200. Bounds: ≤ 200 rows per
list per tick, oldest first; 5 s statement timeout on the scan and on each row.

Manual run (dev only; prod runs from Vercel Cron):
```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3100/api/cron/broadcasts/prune-expired-drafts
```

## Alarm — the age gauge (> 7 d warning, > 14 d page)

`broadcasts_awaiting_member_oldest_age_seconds` is the age of the longest-waiting
`awaiting_member_approval` row. At 7 days both reminders have gone and nothing moved; at 14 days
it is nine days ahead of the day-23 warning. Work § Stuck stage — `awaiting_member_approval`.
If the gauge sits at an unchanged value for hours while rows move, check
`broadcastsGaugesOk` in the gauges tick body: a failed broadcasts half emits nothing and the
last value is re-reported (`docs/observability.md` § 29.1).

## Alarm — no marketing recipient (page)

`broadcasts_no_marketing_recipient_total` moved: a hand-off (a submit, a member decision or
whole-E-Blast withdrawal, the day-23 warning, the day-30 closure) resolved its roster to nobody.
The roster is every ACTIVE user whose role the permission evaluator grants `broadcasts.write`
outside the admin tiers (today: `marketing`); when there is none, every ACTIVE `broadcasts.write`
holder (admin, super_admin, marketing). An empty result means the tenant has no active
marketing user **and** no active admin. The hand-off committed; nobody was queued. Re-enable a
staff user, then open `/admin/broadcasts` and work the rows by hand — the missed emails are not
re-sent. Note the counter moves on submit **even with the flag off** (the enqueue is
unconditional).

## Reading the four gauges

| Gauge | Healthy | Worth a look |
|---|---|---|
| `broadcasts_awaiting_member_approval_count` | small, moving | the same count for days — members are not answering; check the reminders went |
| `broadcasts_awaiting_member_oldest_age_seconds` | < 3 d | > 7 d warns, > 14 d pages. 0 = nothing waiting |
| `broadcasts_changes_requested_count` | small | rising — marketing is not picking up change requests (a marketing-held stage; stalled at 48 h) |
| `broadcasts_marketing_turn_count` | small | growing — the review queue is not being worked. **Non-zero before the flip**: it counts `submitted` rows too. It must equal the staff nav badge whenever the badge shows (the flag is on, or a row is in an approval-round stage — with the flag off and no row in the round the badge is hidden while the gauge still counts `submitted`); a divergence then means the two read different predicates |

All four are zero-filled per tenant every 5 minutes and none is flag-gated.

## The image sweep and its backstop

Images leave an E-Blast's reach in the **same transaction** as the event that ends it:
`broadcast_image_removed` with `reason` `rejected` (staff reject), `withdrawn` (member withdrawal
**or** staff cancel), `draft_discarded`, `draft_pruned` or `member_erased`. The **bytes** are
deleted by the daily sweep (Block 2 of the same tick, `cron-jobs.md` § Block 2) under the
last-reference rule — only when no live image row of either owner kind shares the
`content_hash` **and** no live E-Blast or template body still embeds the URL.

**A closed-never-sent E-Blast's own content no longer holds its images.** The rule skips the body
and the version bodies of a `rejected`, `cancelled` or `expired_no_member_response` E-Blast that
never entered sending (Domain `holdsImageReferences`), so rejected / cancelled / expired E-Blast
images are deleted on the next sweep, and their detail pages show broken images. A sent or
in-progress E-Blast (its versions included) or a template that embeds the same URL keeps it.

**The backstop is the next daily tick, not 24 hours.** The sweep runs at 04:30 UTC and reaps at
most **200 rows per arm per tenant per tick**; a backlog (a bulk erasure, a burst of rejections)
clears over successive ticks, and a row whose transaction fails is retried the next day. "Within
24 hours" is a ceiling nothing enforces — do not promise it on a DSR. While a stamped row waits,
its bytes are still served at their public URL. Watch `broadcasts_image_sweep_row_failed_total`
(alarm on two consecutive days, `docs/observability.md` § 22.12).

The reject/cancel stamping is **new with PR-2 and unflagged**: from the merge, rejecting or
cancelling any E-Blast — including one in today's flow — stamps its images and the next sweep
deletes their bytes.

## The `read_failed` and `no_template_handler` symptoms

**`last_error = 'read_failed'`** on an `eblast_*` row means a read the arm depends on failed this
tick — the arm logged `M119.outbox_dispatch.eblast.read_failed` first. The row retries and usually
clears; if every attempt fails it ends `permanently_failed` **as `read_failed`** (#400 item 4 —
before PR #400 PR-B an exhausted read failure was labelled `no_template_handler`, which sent the
operator looking for a missing template). The F114 change-request arms answer the same since
#400 W3; three of their reads log a line naming the read
(`…change_request.{replacement,roster,prefix}_read_failed`), the repository reads that return a
Result (the request, member and contact reads, in both arms) do not log — `last_error` is the only trace there.

**`last_error = 'no_template_handler'`** means the dispatcher's payload builder returned **null**
— no arm rendered the row. All five `eblast_*` types have an arm (a contract test enumerates the
enum with a positive control), so on a healthy deploy null means one of:

1. **Malformed `context_data`** — logged `M119.outbox_dispatch.eblast.malformed_context` with the
   missing field. It will not clear; find what enqueued it.
2. **PR-2 was reverted while `eblast_*` rows were pending** — the pre-PR-2 drainer neither skips
   these types nor has an arm for them, so **every** held row lands here (§ Flag rollback,
   layer 2).

The ladder is five attempts: retries after 60 s, 5 min, 30 min and 3 h, and the **fifth failure
is terminal** — about **3.6 hours** from the first attempt, not the "~16 h" the contract states
(the 12 h step of the shared backoff table is never waited, because attempt 5 does not retry).
The terminal flip writes `status = 'permanently_failed'`, one `email_dispatch_failed` audit row
(`reason: 'read_failed'` or `'no_template_handler'`, as above) and increments
`outbox_permanent_failures_total{reason=…}` under the same label, which pages on a sustained rate
(`docs/observability.md` § 14.3). `request_gone` and `recipient_gone` are terminal on the first
tick with the same audit; `request_superseded` is terminal, silent (no audit) and counted on
`outbox_superseded_total`.

```sql
SELECT notification_type, last_error, status, count(*)
  FROM notifications_outbox
 WHERE notification_type::text LIKE 'eblast\_%'
   AND updated_at > now() - interval '1 day'
 GROUP BY 1, 2, 3
 ORDER BY 1, 2, 3;
```

## Flag rollback

`quickstart.md` § 3.5 is the full matrix; this is what each layer does to rows and emails, as the
tests prove it (`tests/contract/broadcasts/eblast-flag-matrix.test.ts` for both flag states;
`tests/integration/broadcasts/eblast-send-and-promote.test.ts` "flag off: the rows are enqueued
and NOT delivered … after the flip …" on live Neon). Setting or removing the variable **is** a
production deploy — only the maintainer does it.

### Layer 1 — remove `FEATURE_EBLAST_MEMBER_APPROVAL` and redeploy

- **Entry closes**: `POST …/version` on a `submitted` row → 404 (nothing written, no probe
  audit); "Start formatted version" is hidden on submitted rows. Approve-as-submitted and reject
  behave as before the feature.
- **In-flight rows stay completable**: save and send a working copy, start the next round from
  Changes requested / Member approved / Scheduled (round ≥ 1), the member's decisions, confirm
  schedule, reject and cancel all keep working. Nothing is stranded (FR-034).
- **The clock keeps running**: reminders, the day-23 warning and the day-30 expiry still apply.
- **The five `eblast_*` emails are held at the drainer**: rows are still enqueued; the drainer
  does not select them — `pending`, `attempts = 0`, no `last_error`, never the
  `no_template_handler` ladder. **Consequence to act on**: a version sent while the flag is off
  does **not** email the member, and neither do its reminders — yet the 30-day clock runs. Tell
  the member by hand, or cancel the E-Blast.
- The staff nav badge hides unless a row is in an approval-round stage.
- **A permanent flag-off (retirement) needs a purge**: the held rows keep a recipient address in
  `to_email` for as long as they wait, and every submit adds more. The `DELETE` and its RLS note
  are in `quickstart.md` § 3.5 row 1; never run it ahead of a planned re-flip.

#### After a re-flip

The held rows drain on the first outbox tick. Each arm re-reads the E-Blast **at send time** and
closes a stale row silently as `request_superseded`:

| Type | Delivered only if, at send time … |
|---|---|
| `eblast_submitted_marketing` | the E-Blast is still `submitted` |
| `eblast_version_sent_member` | it is still `awaiting_member_approval` in the same round, and the version was sent |
| `eblast_schedule_confirmed_member` | `scheduled_for` is set and the confirmed approval still governs the row |
| `eblast_approval_lifecycle` | it is still in the status the tick left it (awaiting, or expired for the closure) in the same round |
| `eblast_member_decided_marketing` | the member has not decided again since (no decision in a later round, no later decision in the same round — e.g. an approval then its withdrawal) and the E-Blast has not closed (`sent`, `rejected`, `cancelled`, `failed_to_dispatch`, `expired_no_member_response`). A row recording a member **withdrawal** is exempt from that re-check — it is itself the closing event — **but only while it is fresh** (the paragraph below) |

A member self-cancel notice (`eblast_member_decided_marketing`, `decision: 'withdrawn'`) is delivered only while `broadcasts.cancelled_at` is within `EBLAST_WITHDRAWN_NOTICE_MAX_AGE_DAYS` (7 days); on the flip, older withdrawals queued while the flag was off are superseded silently (`request_superseded`) instead of going out in one batch — the E-Blast list still shows them as withdrawn.
The withdrawal itself stays on the E-Blast's timeline and in the audit trail
(`broadcast_member_approval_withdrawn`) regardless.

Staff rows also re-check the recipient against the live roster (a user who left gets nothing —
`recipient_gone`); member rows go to the approval contact's **current** address and language.

### Layer 2 — revert PR-2

Before the revert deploy, in this order:

1. **Cancel every row in a new stage** — `in_design`, `awaiting_member_approval`,
   `changes_requested`, `member_approved` — from `/admin/broadcasts/<id>` (Cancel, typed phrase +
   reason). The pre-PR-2 code has no label, action or transition for those statuses; the 0308
   enum values and triggers stay, so the rows would sit unreachable. `expired_no_member_response`
   rows are terminal and harmless but also unlabelled.
2. **Scheduled rows** (`approved`) that went through a round already hold the approved content
   and will be sent by the pre-PR-2 dispatcher normally; the member simply loses the ability to
   withdraw. Cancel any the member has not finally agreed to.
3. **Close the pending `eblast_*` outbox rows.** The pre-PR-2 drainer has no skip and no arm for
   them, so each would walk the `no_template_handler` ladder (~3.6 h) into `permanently_failed`
   with an `email_dispatch_failed` row and page `outbox_permanent_failures_total`:
   ```sql
   UPDATE notifications_outbox
      SET status = 'permanently_failed', last_error = 'f119_pr2_reverted', updated_at = now()
    WHERE status = 'pending' AND notification_type::text LIKE 'eblast\_%';
   ```
   `notifications_outbox` is RLS + FORCE: run this as the migration-owner role (which bypasses
   RLS), or inside a transaction after `SET LOCAL app.current_tenant = '<tenant>'` once per
   tenant — as the application role without the GUC it updates zero rows and reports success.
   (`outbox-purge` removes the closed rows after 90 days.)

After the revert, `stage_entered_at` is no longer stamped by the application, so a later
re-merge sees stale "time in stage" on rows that changed status in between.

### Layer 3 — revert PR-1

Revert PR-2 first (it builds on PR-1). What PR-1's revert does and does not undo is in
`quickstart.md` § 3.5 row 3.

### What no layer undoes

Migrations `0304` and `0308` are undone by **no** layer; reversing either is a new migration, and
`ALTER TYPE … ADD VALUE` (5 `broadcast_status`, 14 `audit_event_type`, 5 `notification_type`
values) **cannot be reversed at all**.

## Related

- `specs/119-eblast-approval-workflow/quickstart.md` § 3.2 (cutover, the unflagged-on-merge list),
  § 3.4 (flag matrix), § 3.5 (rollback matrix), § 4 (the SweCham UAT)
- `specs/119-eblast-approval-workflow/uat-walkthrough-en.md` / `uat-walkthrough-th.md`
- `docs/observability.md` § 29 (metrics, spans, alerts, `M119.*`), § 22.12 (the image sweep)
- `docs/runbooks/cron-jobs.md` § F7 prune-expired-drafts, Blocks 2 and 3
- `docs/runbooks/member-erasure.md` § E-Blast approval round (erasure reach)
- `docs/compliance/processing-records.md` § F119 PR-2 (the RoPA precondition of the flag)
