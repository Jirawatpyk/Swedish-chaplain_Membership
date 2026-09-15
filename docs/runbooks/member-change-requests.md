# Runbook — Member change requests (F114)

**Severity**: PAGE when `members_change_request_oldest_age_seconds > 14 d` for any tenant;
WARNING at `> 7 d`, on `members_change_request_no_reviewers_total > 0`, and on three
consecutive ticks with `membersGaugesOk = false`
**Owner**: Membership on-call (members module)
**Related code**:
- Use cases: `src/modules/members/application/use-cases/change-requests/**`
- Routes: `src/app/api/portal/change-requests/**`, `src/app/api/admin/change-requests/**`,
  `src/app/api/admin/settings/member-changes/route.ts`
- Gauges: the `members` block of `src/app/api/internal/metrics/broadcasts-gauges/route.ts`
  (native Vercel Cron, `*/5 * * * *`, UTC — no cron of its own, see `cron-jobs.md`)
- Emails: the two outbox types `member_change_request_submitted_staff` and
  `member_change_request_decided_member`, drained by `/api/cron/outbox-dispatch` (every 60 s)
- Spec authority: `specs/114-member-change-approval/` (`spec.md` FR-001…FR-040,
  `quickstart.md` § 3 cutover + rollback matrix, `contracts/notifications-and-audit.md`)
- Metrics + alert catalogue: `docs/observability.md` § 27

## What the feature does (so the audit trail reads correctly)

A member proposes edits to the company-level fields ("Group B") from `/portal/edit`. Nothing is
written to the member record. The proposal is a `member_change_requests` row in state `pending`,
one per submitting person at a time; every reviewer (an active `admin` / `super_admin`) is
emailed once; a staff user holding `members.write` decides it field by field on
`/admin/change-requests/[id]`; approved fields are applied in the same transaction and the
member is emailed the outcome. Two switches gate the whole path, in this order:

1. the **platform flag** `FEATURE_MEMBER_CHANGE_APPROVAL` (Vercel env; OFF = every F114 route
   answers 404, no portal / nav / dashboard state, the immediate self-service path is widened
   back — FR-039);
2. the **tenant setting** `tenant_member_settings.member_change_approval_enabled`, flipped on
   `/admin/settings/member-changes` (audited `member_change_approval_setting_changed
   { previous, next }` — FR-031). Setting OFF = member edits save immediately again; rows already
   pending stay in the queue and stay decidable (FR-032).

Every transition is one audit row: `member_change_request_submitted`, `_decided`, `_withdrawn`
(`withdrawn_reason: member | replaced | erasure`), `_rate_limited`, and the setting event above.
Payloads carry ids, field KEYS and outcomes only — never a value, a reason text or an email.

## Triage order (do these before touching anything)

1. **Is the path on?** `GET /api/admin/settings/member-changes` (admin session) →
   `{ approvalEnabled, pendingCount }`. A 404 means the platform flag is off on this deployment.
2. **Does the queue show the row?** `/admin/change-requests` (default: pending, oldest first;
   `?state=decided&outcome=…` for history). The header shows the pending count and the oldest age.
3. **Were the reviewers emailed?** In the DB (read-only session):
   ```sql
   SELECT id, status, attempts, last_error, created_at, sent_at
     FROM notifications_outbox
    WHERE notification_type = 'member_change_request_submitted_staff'
      AND context_data->>'requestId' = '<request uuid>';
   ```
4. **Decide it** — or reject it with a reason so the member is told why. Deciding is the fix for
   almost every alarm below; the alarms exist because nobody was looking.

## Alarm 1 — `oldest_age_seconds` > 7 d (warning) / > 14 d (page): a stuck pending queue

The thresholds are bound to the one-month data-subject-request clock (GDPR Art. 12(3) / PDPA
§ 30 — FR-037): a proposal is expected to be decided well inside the month a data subject can
hold the chamber to, so the operational alarm doubles as the statutory backstop.

Causes, in the order to check:

1. **Nobody opened the queue.** The staff email did arrive (triage step 3 shows `sent`), the
   dashboard "Needs attention" row and the nav badge show the count. Nudge a reviewer; at > 14 d
   escalate to the chamber's data-protection contact the same day — the request is a
   rectification proposal and the clock is running.
2. **No reviewer exists** (`members_change_request_no_reviewers_total > 0`, log
   `change-request.submit.no_reviewers`). The request was created and nobody was emailed. The
   question this answers is whether an active reviewer EXISTS, which needs no address — so the
   query selects none (privacy review P-L1: do not pull staff emails into a terminal or a
   paste-buffer to count rows):
   ```sql
   SELECT id, role, status FROM users
    WHERE role IN ('admin', 'super_admin') AND status = 'active';
   ```
   Identify and act on the people in `/admin/users` (the same list, under the RBAC + audit
   surface). Re-enable or invite a reviewer there. The pending rows are still there and drain on
   the next decision; no re-submission is needed.
3. **The email was queued but never sent** — see Alarm 3.
4. **The reviewer cannot decide** (the review page shows the rows read-only): the session holds
   `members.read` only (a manager / marketing user). Seeing the queue needs `members.read`,
   deciding needs `members.write` (FR-026).
5. **The queue is empty but the gauge says otherwise**: the gauge comes from a cross-tenant
   `GROUP BY tenant_id`; make sure you are looking at the right tenant, then check Alarm 4.

## Alarm 2 — "why did nobody get an email?" (coalescing is not a defect)

FR-011 coalescing: a person who resubmits within **1 hour** of the last staff email queues
**no new email** — the earlier email's link already opens the current values (the audit row
carries `coalesced: true`, the API answers `staffNotified: false`). One notification per
submitting person per hour is the contract (SC-013). Nothing to fix; the request is in the queue.

Genuine no-email cases:

| Symptom | Where to look | Fix |
|---|---|---|
| No `member_change_request_submitted_staff` outbox row at all | `change-request.submit.no_reviewers` in the logs; counter `members_change_request_no_reviewers_total` | Alarm 1, cause 2 |
| Row exists, `status = 'pending'`, `attempts = 0`, minutes old | the drainer runs every 60 s; while the platform flag is OFF it **skips** both F114 types at query time (the F4 R7-B4 precedent) and drains them when the flag returns | check the flag on the deployment that runs the cron; otherwise `cron-jobs.md` § outbox-dispatch |
| Row `permanently_failed`, `last_error` set, audit `email_dispatch_failed` with the F114 `notification_type` | Resend delivery (the transactional key, not the broadcasts one) | `docs/runbooks/audit-emit-loss.md` is NOT this; follow the outbox section of `cron-jobs.md`; a retry is the drainer's job, do not resend by hand |
| The member never got the decision email | `member_change_request_decided_member` row; the decided audit event says `member_notified: false` + `member_notification_skipped: 'recipient_gone'` when the submitting contact was removed between submit and decide | expected — the decision stands (FR-017), the history page on the portal shows it; nothing to resend |

## Alarm 3 — a member reports 429 on submit ("why am I rate limited?")

FR-008: no person can CREATE more than **10 requests in 24 hours**, counted from the durable
request history inside the submit transaction — not from Upstash, so the cap holds with the
rate-limiting service down (SC-013). The response carries `Retry-After` = when the oldest of
the ten leaves the window, and one audit row `member_change_request_rate_limited
{ related_member_id, window_count, retry_after_seconds }` (keyed `related_member_id` on
purpose — a refused attempt is not member activity, so the member's `last_activity_at` does not
move). Withdrawals and replacements do not free a slot: `withdrawn` rows still count as created.

```sql
SELECT id, state, withdrawn_reason, submitted_at
  FROM member_change_requests
 WHERE submitted_by_user_id = '<user uuid>'
   AND submitted_at > now() - interval '24 hours'
 ORDER BY submitted_at;
```

Ten rows in the window = the cap is working. Do not delete rows to "unblock" a member (the
history is the audit trail and the GDPR export); the window rolls forward on its own. A member
who hits it is usually re-submitting to "fix" a typo — the replace path already withdraws the
earlier pending request as `replaced`, so tell them the latest submission is the one in review.

Distinct from the per-actor **ATTEMPT bucket** the routes share
(`src/lib/change-request-attempt-bucket.ts`). It is keyed per **tenant + user** — never per IP
and never per session — at 10 / 10 min on the two by-id portal reads (`GET …/[id]`,
`POST …/[id]/acknowledge`, where it bounds the `member_cross_tenant_probe` row a miss writes
into the append-only trail) and 60 / 10 min on submit and withdraw. It answers the SAME 429
envelope (`{ error: 'rate_limited', retryAfterSeconds }` + `Retry-After`) with **no audit row**,
so grep the LOGS for `*.attempts_exhausted` (`M114.portal.submit.attempts_exhausted`,
`…withdraw…`, `…history_item…`, `…acknowledge…` — each route names itself) and read the metric as
`members_change_request_refused_total{reason=attempt_throttled}`; `reason=rate_limited` is the
durable 10 / 24 h cap above, alone. It is Upstash-backed with a per-process fallback window, and
a refusal produced in that weaker world is preceded by `<prefix>.attempt_bucket_fell_back`. It
clears on its own — nothing to reset by hand.

A sustained `attempt_throttled` rate from one tenant reads as enumeration; a sustained
`rate_limited` rate reads as one member re-submitting.

## Alarm 4 — the gauges are blind (`membersGaugesOk = false`, three ticks)

Log line `cron.broadcasts_gauges.members_query_failed` with `err`. The broadcasts half of the
tick and its 200 are unaffected by design; both age alerts above are blind until this clears.

1. `pnpm db:verify:prod` — the `member_change_requests` canaries (migrations 0300 / 0302) must be
   present on the deployed branch.
2. The block runs under its own `SET LOCAL statement_timeout = '10s'`; a timeout means the
   pending scan is no longer indexed — check `member_change_requests_tenant_state_submitted_idx`
   exists and `ANALYZE member_change_requests` (the 5,000-row pagination suite documents the
   planner's behaviour on stale stats).
3. Zero-fill is deliberate: a provisioned tenant with nothing pending reports **0** on both
   gauges (the C9 latch rule — a gauge that keeps its last value pages forever). A gauge that
   reads a stale non-zero for a tenant whose queue is empty is a regression, not a data fix. The
   tenant set is `tenant_member_settings` (every provisioned tenant) ∪ the pending `GROUP BY`
   keys, so a tenant with pending rows but no settings row is still observed.
4. `membersGaugesSkipped: 'flag_off'` in the tick body is NOT a fault: while
   `FEATURE_MEMBER_CHANGE_APPROVAL` is off the pending scan is skipped and both series are
   FORGOTTEN per tenant, so they go ABSENT rather than reporting a queue nobody can decide (the
   routes 404 while dark). Expect "no data" on both age alerts in that state; the series come
   back on the first tick after the flag returns. `membersGaugesOk` stays `true` — nothing
   failed.

## Dispatcher failures for the two F114 types

Both types render from `context_data` ids only (the dispatcher re-reads the request under the
tenant transaction at send time — research § V3). `outbox_status` has exactly three values —
`pending | sent | permanently_failed` (`src/modules/auth/infrastructure/db/schema.ts`) — so a row
that exhausts its retries is `permanently_failed` with `last_error`; the request itself is
unaffected and still decidable. There is **no `cancelled` status**: after an erasure the scrub
(`cancelPendingForMemberInTx`) DELETEs the still-`pending` F114 rows whose
`context_data->>'memberId'` is the erased member, so **no row at all** is the expected state
there — do not go looking for a cancelled one.

## Rollback (FR-039 — `quickstart.md` § 3 has the full matrix)

| Layer | Action | Pending rows | Time |
|---|---|---|---|
| 1 — tenant setting OFF | `/admin/settings/member-changes` (audited; the card warns with the pending count) | kept, still decidable; member edits save immediately again | seconds |
| 2 — platform flag OFF | remove `FEATURE_MEMBER_CHANGE_APPROVAL` in Vercel + redeploy (setting the var IS the deploy on this repo) | kept untouched; routes 404, nav / dashboard hidden; queued outbox rows wait and drain when the flag returns | one deploy |
| 3 — code revert | revert the PR | kept | one deploy |

**Switching back ON is a switch-ON.** FR-040 applies again in full: before layer 1 is reversed
for a chamber, that chamber's record of processing (RoPA) must list this activity — the
purpose ("review of member-proposed changes; accountable history"), the staff-notification
disclosure, the `change-requests.json` export category and the outbox-retention note. Rolling
the setting off does not retire the entry, and rolling it back on without one is the same
FR-040 gap the first cutover had to close. The card's own description says so; the full text is
`quickstart.md` § 3 step 3.

Never rolled back by any layer: migrations 0300 / 0301 / 0302, the seven enum values, the
`tenant_member_settings` column, and the unflagged PR-2 and PR-3 items listed in `quickstart.md` § 3.

## Related

- `docs/observability.md` § 27 — metrics, alert thresholds, forbidden log fields
- `docs/runbooks/cron-jobs.md` — the outbox drainer and the gauges tick
- `docs/runbooks/member-erasure.md` — the change-request scrub on erasure (FR-030)
- `docs/runbooks/cross-tenant-probe.md` — a cross-tenant read / decide attempt (FR-035)
- `specs/114-member-change-approval/quickstart.md` § 3–4 — cutover, rollback matrix, what to
  watch after the flip
