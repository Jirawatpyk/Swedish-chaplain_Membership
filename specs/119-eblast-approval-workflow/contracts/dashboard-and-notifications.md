# Contract — Dashboard, notifications, audit, metrics and cron

## 1. Dashboard = the existing queue (FR-030)

`/admin/broadcasts` stays **the** list. No second page, no parallel query, no forked filter bar —
FR-030 says so in as many words. What changes:

### 1.1 Filters (`src/components/broadcast/admin/queue-filters.tsx`)

| control | today | after |
|---|---|---|
| Stage chips | derived from `OFFERED_BROADCAST_STATUSES` (`:40-75`), grouped by the hand-listed `IN_REVIEW_STATUSES` (`:64-69`) | the five new statuses join `IN_REVIEW_STATUSES`, so all 13 offered stages appear and the loading skeleton (which sizes from `OFFERED_BROADCAST_STATUSES.length`, `loading.tsx:65`) follows automatically |
| Chip label | a **count** per stage (FR-025); selecting a chip filters the list | new |
| Chip visibility when the flag is off | n/a | a new-stage chip is offered only when the tenant has ≥ 1 row in it (research R18 — never offer a filter that can only return zero rows) |
| Member | existing `memberId` dropdown | unchanged (FR-030) |
| Date range | existing `fromDate` / `toDate` | unchanged |
| **Upcoming sends** | — | a preset: `?status=approved&sort=scheduled_for&from=now` — scheduled E-Blasts in send-time order, so same-day clashes are obvious (FR-028) |

URL remains the source of truth (every view is a link); `status_all=1` sentinel semantics unchanged.

### 1.2 Row columns (`queue-table.tsx` → `queue-table-client.tsx` / `queue-card-list.tsx`)

| column | source | FR |
|---|---|---|
| Member · Subject · Segment · Recipients | existing | — |
| **Stage** | `stageOf(status)` — the status badge relabelled to the FR-019 vocabulary (`approved` → "Scheduled") | FR-019, FR-026 |
| **Whose turn** | `turnOf(status)` → "Marketing" / "Member" / "Us" (system) / — | FR-026 |
| **Time in stage** | the existing `ageBadge` struct (`queue-table.tsx:110-121`), re-based on `stage_entered_at` and applied to **every** waiting stage, not only `submitted` | FR-026, FR-027 |
| **Round** | `broadcasts.current_round` (0 = never formatted) | FR-026 |
| **Proposed** / **Confirmed** send time | `proposed_send_at` / `scheduled_for`, tenant time zone | FR-026 |
| **Last activity** | `stage_entered_at` | FR-026 |
| Delivery results | `recipients / delivered / bounced / complained` from the existing `broadcast_deliveries` aggregate, on `sent` rows | FR-029 |

**Stalled flag (FR-027)**: amber/red from one comparison against `stage_entered_at` —
marketing-held stages (`submitted`, `in_design`, `changes_requested`, `member_approved`) at the
existing 24 h / **48 h** review target (`SLA_AMBER_HOURS` / `SLA_RED_HOURS`,
`queue-table.tsx:97-98`); member-held (`awaiting_member_approval`) at the **3-day** reminder
threshold. Same badge struct, so label and variant cannot drift apart.

**Preserved**: the shared TanStack instance behind `QueueTable` + `QueueCardList` (< md), the
fixed-bottom bulk action bar, the single permanently-mounted `role="status"` announcer
(`queue-table-client.tsx:439-447`), `finalFocus` on every dialog, and the `manager` read-only mode.

**FR-036**: the dashboard shows recipient **counts** only. No contact-level data is added to any
query here; the "who receives it and their opt-in state" question links to the existing
108 Marketing audience page.

### 1.3 In-app waiting count (FR-023)

The staff nav item for E-Blasts carries a badge counting the **marketing-turn** set
(`submitted`, `in_design`, `changes_requested`, `member_approved`) for the tenant, computed by the
same Domain predicate as the gauge, as a live indexed `count(*)` at render — not a cron snapshot,
so it is correct immediately (the F114 `NeedsAttentionList` precedent). Hidden while the flag is off
**and** no row is in a new stage. Visible to every role holding `broadcasts.read`, including
`manager` (spec: "Admins and super-admins still see the waiting count").

### 1.4 Performance (SC-008)

Counts + first page < 2 s at 1,000 E-Blasts of history, served by
`broadcasts_stage_queue_idx (tenant_id, status, stage_entered_at DESC)`. Measured by
`tests/integration/broadcasts/eblast-dashboard-pagination.test.ts`, which seeds 1,000 rows across
all stages, asserts the budget and asserts the index appears in `EXPLAIN`. Note the budget is
asserted **alone**, not inside a folder run: 100+ files on one Neon compute contend, and the hook
exports `INTEGRATION_FOLDER_RUN=1` so the test reports rather than asserts there.

---

## 2. Audit events (12 new — five places each, research R24)

All emitted with `AuditPort.emit`/`emitTyped` on the **same transaction** as the state change.
`actorRole` is the session role, `?? null`, never a literal (`check:actor-role-truth`). Payloads
carry ids, keys, counts and lengths — **never** the subject, body, note or reason text.

Member-activity events carry snake_case **`member_id`** so migration 0009's `last_activity_at`
trigger fires (it reads only that key); staff- and system-driven events carry
**`related_member_id`** so a staff decision or a cron closure does not refresh the member's recency
(the #336/#337 rule).

| event | actor | member key | payload (beyond the key) |
|---|---|---|---|
| `broadcast_version_started` | staff | `related_member_id` | `broadcast_id, version_id, round, from_stage` |
| `broadcast_version_sent_to_member` | staff | `related_member_id` | `broadcast_id, version_id, round, note_length, notified: bool` |
| `broadcast_member_approved` | member | `member_id` | `broadcast_id, version_id, round, note_length` |
| `broadcast_member_changes_requested` | member | `member_id` | `broadcast_id, version_id, round, reason_length` |
| `broadcast_member_approval_withdrawn` | member | `member_id` | `broadcast_id, version_id, round, reason_length, cancelled_schedule_at \| null` |
| `broadcast_member_approval_voided` | staff | `related_member_id` | `broadcast_id, voided_version_id, round, cancelled_schedule_at \| null` |
| `broadcast_schedule_confirmed` | staff | `related_member_id` | `broadcast_id, version_id, proposed_send_at, confirmed_send_at, differs: bool, mode` |
| `broadcast_approval_reminder_sent` | system | `related_member_id` | `broadcast_id, version_id, round, reminder: 'day3'\|'day7'` |
| `broadcast_approval_expiry_warned` | system | `related_member_id` | `broadcast_id, version_id, round, days_waiting` |
| `broadcast_approval_expired` | system | `related_member_id` | `broadcast_id, version_id, round, days_waiting, allowance_released: true` |
| `broadcast_test_copy_sent` | member or staff | `related_member_id` | `broadcast_id \| null, version_id \| null, recipient_hash` |
| `broadcast_brand_settings_changed` | staff | — | `previous: { primaryColor, postalAddress }, next: { … }` |

Rejection and withdrawal from a new stage reuse the existing `broadcast_rejected` /
`broadcast_cancelled`; image events reuse the existing `broadcast_image_*`; cross-boundary misses
reuse `broadcast_cross_tenant_probe` / `broadcast_cross_member_probe`; a refused permission reuses
`permission_denied`.

**Retention**: 5 years for all twelve (`f7RetentionFor` returns 5 — `audit-port.ts:257`); no tax
document is produced, so none is a 10-year event.

**The five places** (CLAUDE.md § Gotchas, F7 flavour): `F7_AUDIT_EVENT_TYPES`
(`audit-port.ts:50-178`, **55 → 67**, with the static assert at `:234` updated in the same edit) ·
`DB_ONLY_AUDIT_EVENT_TYPES` (`auth/infrastructure/db/schema.ts:522-678` — every `broadcast_*` value
lives there, not in the pgEnum tuple) · the migration's one-per-line `ALTER TYPE … ADD VALUE
IF NOT EXISTS` · `audit.eventType.<name>` labels in EN/TH/SV with Thai script · and
`scripts/lib/enum-migration-guard.ts` `REQUIRED_ENUM_VALUES`, which this feature extends to cover
`broadcast_status` and `notification_type` as well — a silently-no-op `ADD VALUE` would 500 every
hand-off in prod instead of failing the deploy.

**SC-002 proof**: for any sent E-Blast whose content marketing changed, the chain is
`broadcasts.approved_version_id` → the `broadcast_member_decisions` row with
`decision = 'approved'` (naming the contact who approved) → the `broadcast_versions` row (immutable
since `sent_to_member_at`) → the `broadcast_schedule_confirmed` audit row that promoted it. A
reviewer can walk it without reading content.

---

## 3. Notifications (5 new `notification_type` values)

All enqueued with the existing outbox port **on the state-changing transaction** (at-least-once; a
retry may deliver twice, never decide twice). `context_data` carries **ids and discriminators only**;
the dispatcher arm reads the rows at send time inside
`runInTenant(asTenantContext(row.tenantId), …)` and renders there — the F114 precedent at
`src/app/api/cron/outbox-dispatch/route.ts:415-542`, and the reason is that the erasure scrub of the
version/decision rows must also blank anything a not-yet-sent email would show, while a **sent**
outbox row (retained 90 days by `outbox-purge`) holds no content at all.

`locale` on the row is the recipient's: the member contact's `preferred_language` for member rows
(FR-024), the platform default for staff rows (`users` has no locale column — the F114 finding).

| type | to | one row per | `context_data` | rendered content |
|---|---|---|---|---|
| `eblast_submitted_marketing` | marketing recipients (§ 3.1) | recipient | `{ tenantId, broadcastId, recipientUserId }` | member + subject + proposed send time + link to `/admin/broadcasts/<id>` (US5 AS1 — staff are **not** notified on submit today) |
| `eblast_version_sent_member` | the member's contact | broadcast | `{ tenantId, broadcastId, versionId, round }` | "Round N is ready for your approval", marketing's note, the proposed send time, the expiry date, link to `/portal/broadcasts/<id>` |
| `eblast_member_decided_marketing` | marketing recipients | recipient | `{ tenantId, broadcastId, versionId, round, decision }` | `decision ∈ approved \| changes_requested \| approval_withdrawn \| withdrawn`; the member's reason **verbatim, escaped, plain text** (never markup or a link); link to the detail |
| `eblast_schedule_confirmed_member` | the member's contact | broadcast | `{ tenantId, broadcastId, versionId }` | the confirmed time in the tenant time zone and, when it differs from the proposal, an explicit "this is not the time you proposed" line (FR-018) |
| `eblast_approval_lifecycle` | member **and** marketing | recipient | `{ tenantId, broadcastId, versionId, round, kind, audience }` | `kind ∈ reminder_day3 \| reminder_day7 \| expiry_warning_day23 \| expired_day30`; day-23 and day-30 go to **both** sides (FR-022a) |

Every one of the five **must** ship with its `case` arm in `buildPayload`
(`outbox-dispatch/route.ts:194`) in the same PR: the `default:` arm returns `null` (`:543`), which
sets `lastError = 'no_template_handler'` and retries on the 60 s/5 m/30 m/3 h/12 h ladder until
`attempts >= 5` — an arm-less type is a silent ~16-hour outage, not a loud failure. A contract test
asserts every value in the `notification_type` enum has an arm, with a positive control.

Misses reuse the existing `PayloadMiss` shapes: a deleted broadcast or version → `request_gone`; a
removed/erased contact → `recipient_gone`; a version superseded by a later round before the row was
sent → `request_superseded` (the silent path, no `email_dispatch_failed` alarm).

### 3.1 Who "marketing" means (FR-021a)

`src/lib/broadcast-marketing-deps.ts`:

```
marketingRoles()  = ROLES.filter(r => hasPermission(r, 'broadcasts.write'))  minus  ['admin','super_admin']
fallbackRoles()   = ROLES.filter(r => hasPermission(r, 'broadcasts.write'))            // the admin tiers
listRecipients()  = listActiveUsersByRole(marketingRoles().length ? marketingRoles() : fallbackRoles())
```

Derived from the **evaluator**, never from a literal `'marketing'` string, and never from
`ROLE_BUNDLES` (super-admin keys come from the evaluator's early return at `evaluator.ts:80`, so the
bundle gives the wrong answer). Today that resolves to `['marketing']`, with `['admin',
'super_admin','marketing']` as the fallback when no marketing user exists. `users` is cross-tenant
(no `tenant_id`, no RLS — Constitution I's F1 carve-out), so the read uses the global `db` exactly as
F114's does; F10's `user_tenants` is where it becomes tenant-scoped.

An **empty** roster on a hand-off (neither set has an active user) is counted
`broadcasts_no_marketing_recipient_total` and pages — nobody is being told, and the E-Blast will sit.

---

## 4. Metrics, logs, traces, alerts

### 4.1 Gauges — emitted from the **existing** broadcasts half of
`/api/internal/metrics/broadcasts-gauges` (`*/5 * * * *`, `vercel.json:8`). Same transaction, same
`observed` tenant set, same zero-fill convention (a count gauge reports 0, never its last value).
**No new cron job.**

| name | labels | source |
|---|---|---|
| `broadcasts_awaiting_member_approval_count` | `tenant` | `count(*) WHERE status = 'awaiting_member_approval'` |
| `broadcasts_awaiting_member_oldest_age_seconds` | `tenant` | `EXTRACT(EPOCH FROM now() - min(stage_entered_at))` over the same rows |
| `broadcasts_changes_requested_count` | `tenant` | `count(*) WHERE status = 'changes_requested'` |
| `broadcasts_marketing_turn_count` | `tenant` | `count(*) WHERE status IN ('submitted','in_design','changes_requested','member_approved')` |

`broadcasts_queue_pending` is **left unchanged** on `('submitted','approved')` — its alert threshold
(`docs/observability.md` § 22.3, line 1382) is calibrated to it, and widening it silently would move
an alert nobody re-tuned.

### 4.2 Counters and histograms (from the use cases)

| name | type | labels |
|---|---|---|
| `broadcasts_version_sent_total` | counter | `tenant, round` |
| `broadcasts_member_decision_total` | counter | `tenant, decision` |
| `broadcasts_approval_expired_total` | counter | `tenant` |
| `broadcasts_preview_rendered_total` | counter | `tenant, surface` (`inline`\|`dialog`\|`compare`) |
| `broadcasts_no_marketing_recipient_total` | counter | `tenant` |
| `broadcasts_member_decide_ms` | histogram | `tenant` |
| `broadcasts_preview_render_ms` | histogram | `tenant` |

### 4.3 Alerts (`docs/observability.md` § 28 — the file ends at § 27, line 2205)

| condition | severity | why |
|---|---|---|
| `broadcasts_awaiting_member_oldest_age_seconds > 7 d` | warning | the second reminder has been sent and nothing moved |
| `broadcasts_awaiting_member_oldest_age_seconds > 14 d` | page | halfway to the 30-day expiry with no response |
| `broadcasts_no_marketing_recipient_total > 0` | page | a hand-off notified nobody |

### 4.4 Logs and traces

pino with `requestId`, `tenantId`, hashed user id, `broadcastId`, `versionId`, `round`, `stage`;
failures carry `err: errKind(e)`. **Never** the subject, body, note, reason or a raw email address.
Every fault arm names itself `M119.<route>.<arm>`; deterministic 4xx refusals are audited or counted
by the use case, not logged as faults. OTel spans `broadcasts.version.send`,
`broadcasts.member.decide`, `broadcasts.schedule.confirm`, `broadcasts.preview.render`, with
attributes limited to `tenant.slug`, `broadcast.id`, `broadcast.stage`, `broadcast.round` — never
values.

---

## 5. Cron — the approval lifecycle rides an existing job

**No new cron job.** `/api/cron/broadcasts/prune-expired-drafts` (`vercel.json:14`, `30 4 * * *`
UTC = 11:30 Asia/Bangkok) gains a **second block** after the existing draft prune: its own
`db.transaction`, its own `SET LOCAL statement_timeout`, its own try/catch, its own
`approvalLifecycleOk` field in the response body, and a 500 only at the **end**, so a fault in one
half never drops the other (the F114 gauges-tick precedent). The route keeps
`export const GET = POST` — native Vercel Cron invokes GET — and keeps its name; renaming would
touch `vercel.json`, the runbook and the alert rules for no observable gain.

Order inside the block:

1. **Image sweep** — for every `broadcast_images` row with `deleted_at IS NOT NULL`, delete the blob
   **iff** no live row shares its `content_hash` (the last-reference rule, data-model § 4), then
   remove the row. This is the durable backstop; the normal path deletes best-effort right after the
   erasure/withdrawal transaction commits.
2. **Reminders and the warning** — for rows in `awaiting_member_approval`, ordered by
   `stage_entered_at`, driven by the pure `nextReminder(stage_entered_at, now, member_reminder_stage)`
   policy: day 3 → `reminder_day3` to the member and `member_reminder_stage = 1`; day 7 →
   `reminder_day7` and `= 2`; day 23 → `expiry_warning_day23` to **both** sides and `= 3`. One
   outbox row per recipient, one audit row per E-Blast. Exactly one per threshold, guaranteed by the
   stage counter rather than by date arithmetic, and reset to 0 on every entry into
   `awaiting_member_approval` so a new round restarts the clock (FR-022a: "the clock always runs from
   the latest version sent to the member").
3. **Expiry** — at day 30, transition `awaiting_member_approval → expired_no_member_response` in one
   `runInTenant` per row, stamp `member_expiry_notified_at`, audit `broadcast_approval_expired`,
   enqueue `expired_day30` to both sides. The allowance place is freed by construction: `expired` is
   in neither the reserved nor the consumed set, and `broadcasts_quota_year_only_on_sent` keeps
   `quota_year_consumed` NULL. A closed E-Blast cannot be reopened — `expired_no_member_response` is
   terminal in both the Domain map and the DB trigger.

**Never auto-approved** (FR-014, US5 AS3): the block has no path to `member_approved` or `approved`.
A contract test asserts that running it against a row that has been waiting 400 days produces
exactly one expiry and no approval.

**Bounds**: ≤ 200 rows per kind per tick (the tenant has ~2 in flight; the bound exists so a
backlog cannot make the tick unbounded), ordered oldest-first so nothing starves. Idempotent: a
second run in the same day changes nothing, because every action is guarded by the counter or the
terminal status.

Response body: `{ prunedDrafts: n, sweptImages: n, remindersSent: n, warningsSent: n, expired: n,
pruneOk: true, approvalLifecycleOk: true }`.

---

## 6. Contract tests (`tests/contract/broadcasts/eblast-dashboard-*.test.ts`, `…-notifications-*.test.ts`)

- Every new `notification_type` has a `buildPayload` arm (enumerated from the enum, with a positive
  control that fails when an arm is removed).
- Each arm renders from ids: the row's `context_data` is asserted to contain **no** subject, body,
  note or reason; a scrubbed version renders `[redacted]`; a deleted version yields
  `request_gone`, a removed contact `recipient_gone`.
- `marketingRoles()` is derived, not literal: with `marketing` removed from `MARKETING_KEYS`'
  `broadcasts.write`, the roster changes without touching this code.
- Empty roster → `staffNotified: false` + `broadcasts_no_marketing_recipient_total` incremented.
- The queue: stage counts match seeded rows; `whoseTurn` is correct for every stage; a
  marketing-held row older than 48 h and a member-held row older than 3 days are both flagged;
  the upcoming preset orders by `scheduled_for`; a `manager` gets the full list and no action
  controls.
- The cron block: one reminder per threshold across a 40-day simulated clock (injected
  `ClockPort`), zero approvals, exactly one expiry, and a second run in the same day is a no-op.
