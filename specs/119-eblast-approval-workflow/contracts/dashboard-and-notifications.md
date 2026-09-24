# Contract — Dashboard, notifications, audit, metrics and cron

**Delivery**: everything in this file ships in **PR-2**, with the approval round it reports on. The
dashboard and the trial were originally a third PR; the maintainer merged them into PR-2 on
2026-09-18 (`plan.md` Amendment 8) because the stage labels § 1.2 relabels, the metric registrations
§ 4.2 lists and the FR-051 pass on the rebuilt queue all belong in the same PR as the stages and the
emitters — five round-3 findings (C1, C2, H4, M2, M7) were that boundary and nothing else. The one
exception is `broadcasts_preview_rendered_total` / `broadcasts_preview_render_ms`, registered in
**PR-1** by T122a because `POST …/preview` emits them there.

## 1. Dashboard = the existing queue (FR-030)

`/admin/broadcasts` stays **the** list. No second page, no parallel query, no forked filter bar —
FR-030 says so in as many words. What changes:

### 1.1 Filters (`src/components/broadcast/admin/queue-filters.tsx`)

| control | today | after |
|---|---|---|
| Stage chips | derived from `OFFERED_BROADCAST_STATUSES` (`:40-75`), grouped by the hand-listed `IN_REVIEW_STATUSES` (`:64-69`) | **four** of the five new statuses — `in_design`, `awaiting_member_approval`, `changes_requested`, `member_approved` — join `IN_REVIEW_STATUSES`; the fifth, **`expired_no_member_response`, joins `TERMINAL_STATUSES` (`:74-75`)** because it is a closed outcome in `TERMINAL_BROADCAST_STATUSES` with `turnOf` null (data-model § 8.1b), and filing a terminal stage under "In review" would offer marketing a row nobody can act on (`/speckit.analyze` H4). All 13 offered stages appear either way, and the loading skeleton (which sizes from `OFFERED_BROADCAST_STATUSES.length`, `loading.tsx:65`) follows automatically |
| Chip label | a **count** per stage (FR-025); selecting a chip filters the list. Count changes are announced through the list's **single existing `role="status"` region** (`queue-table-client.tsx:439-447`) — **never** a second live region. The stage label must fit its chip in EN, TH **and SV**, where strings run up to **+28 %**: the SV lengths of the five new labels are a live-look item (research V2) and the chip truncates with a `title`/tooltip rather than reflowing the strip | new |
| Chip visibility when the flag is off | n/a | a new-stage chip is offered only when the tenant has ≥ 1 row in it (research R18 — never offer a filter that can only return zero rows) |
| Member | existing `memberId` dropdown | unchanged (FR-030) |
| Date range | existing `fromDate` / `toDate` — rendered and written to the URL, but never passed to the list query (every range returned every row) | wired (FR-030): bounds **`submitted_at`**, as whole calendar days in the tenant's timezone — `[00:00 of fromDate, 00:00 of the day after toDate)` (`tenantDayRangeUtc`, half-open so no sub-millisecond gap at the end of the `to` day). A never-submitted row (a draft) is outside any range. It combines by AND with every other filter, the Upcoming preset's `from=now` bound on `scheduled_for` included ("sends scheduled from now on that were submitted in this range"). The list API refuses a day that is not a real calendar day (400); the page ignores it. The stage chip counts stay per stage for the whole tenant — they do **not** honour the range, the member filter or the Upcoming bound (FR-025's backlog; R18 offers a chip by them) — so with any of those on, the view's announced total falls back to the page's own rows (`queueViewNarrowed`) and the Stage group shows a note, which is also its accessible description, that its counts cover every E-Blast in each stage (`chipCountsScope`) |
| **Upcoming sends** | — | a preset: `?status=approved&sort=scheduled_for&from=now` — scheduled E-Blasts in send-time order, so same-day clashes are obvious (FR-028) |

URL remains the source of truth (every view is a link); `status_all=1` sentinel semantics unchanged.

### 1.2 Row columns (`queue-table.tsx` → `queue-table-client.tsx` / `queue-card-list.tsx`)

| column | source | FR |
|---|---|---|
| Member · Subject · Segment · Recipients | existing | — |
| **Stage** | `stageOf(status)` — the status badge relabelled to the FR-019 vocabulary (`approved` → "Scheduled") | FR-019, FR-026 |
| **Whose turn** | `turnOf(status)` → **"Marketing"** (Awaiting marketing review, In design, Changes requested, Member approved) · **"Member"** (Awaiting member approval) · **"—"** (Draft, Scheduled, Sending and every closed stage). There is **no "system" turn** — a stage nobody is waiting on reads "—" | FR-026 |
| **Time in stage** | the existing `ageBadge` struct (`queue-table.tsx:110-121`), re-based on `stage_entered_at` and applied to **every** waiting stage, not only `submitted` | FR-026, FR-027 |
| **Round** | `broadcasts.current_round` — the **count of versions sent to the member** (0 = never formatted). A withdrawn approval does **not** start a round: the number moves only when marketing sends the next version | FR-026 |
| **Proposed** / **Confirmed** send time | `proposed_send_at` / `scheduled_for`, tenant time zone | FR-026 |
| **Last activity** | `stage_entered_at` | FR-026 |
| Delivery results | `recipients / delivered / bounced / complained` from the existing `broadcast_deliveries` aggregate, on `sent` rows | FR-029 |

**Layout as built (amended after the 2026-09-24 dashboard UX review).** The fields above are all
kept, but twelve separate columns pushed the Actions column off screen at 1280 px, so the table
groups them into eight: Member · Subject · **Stage** (badge, "Round N" and, on `sent` rows, the
delivery line) · Whose turn · **Time in stage** (with "since {date}", which is Last activity) ·
**Send time** (the confirmed time; the proposal shown beneath it when it differs, or marked
"Proposed" before confirmation) · **Audience** (segment and recipient count) · Actions. Submitted
moves to the detail page. The sorted column carries `aria-sort` and a visible hint; a view whose
every stage is someone's turn sorts longest-in-stage first, any other view most recent first.

**At phone width** (`QueueCardList`, < md) the card shows **member, subject, stage, whose turn and
time in stage** only; **round, proposed and confirmed send times move to the detail page** (FR-026).
No horizontal scroll and no hidden-column menu.

**Stalled flag (FR-027)**: one comparison against `stage_entered_at` — marketing-held stages
(`submitted`, `in_design`, `changes_requested`, `member_approved`) at the **48 h** review target
(`SLA_RED_HOURS`, `queue-table.tsx:97-98`); member-held (`awaiting_member_approval`) at the
**3-day** first-reminder threshold. **Those two numbers are the whole of "stalled".** The existing
24 h `SLA_AMBER_HOURS` level keeps rendering as the pre-warning it already is, but it is **not**
stalled: it is never counted as stalled, never labelled "Stalled", and never announced as one
(FR-027). Same badge struct, so label and
variant cannot drift apart. The flag is conveyed by an **icon *and* a text label** — never by colour
alone — and is **available to assistive technology**: the icon is `aria-hidden` and the badge carries
the visible text, so a screen reader reads "Stalled — 3 days" rather than nothing (FR-027). No
`aria-label` on a role-less span.

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

## 2. Audit events (14 new — five places each, research R24)

All emitted with `AuditPort.emit`/`emitTyped` on the **same transaction** as the state change.
`actorRole` is the session role, `?? null`, never a literal (`check:actor-role-truth`) — which
resolves to **`member`** for every portal-user action (decision, upload, test copy), to the staff
session role for a marketing/admin action, and to **`system`** for the reminder, warning, expiry and
image-sweep rows the cron writes (spec § Audit trail). Payloads
carry ids, keys, counts and lengths — **never** the subject, body, note or reason text.

Member-activity events carry snake_case **`member_id`** so migration 0009's `last_activity_at`
trigger fires (it reads only that key); staff- and system-driven events carry
**`related_member_id`** so a staff decision or a cron closure does not refresh the member's recency
(the #336/#337 rule).

**This table is the single source of truth for every F119 audit payload.** The route contracts
(`portal-eblast-approval-api.md`, `admin-eblast-formatting-api.md`) name which event a route emits
and otherwise **reference this table rather than restating a field list** — restating it is how the
two files drifted apart on four events (`/speckit.analyze` M6). The **member key** column is
load-bearing and not cosmetic: migration 0009's `last_activity_at` SECURITY DEFINER trigger fires on
snake_case **`member_id`** and on no other key, so an event listed here as `member_id` that ships as
`related_member_id` — or as camelCase `memberId` — silently stops updating the member's activity
(#336/#337).

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
| `broadcast_image_uploaded` | member or staff | `member_id` (member upload) / `related_member_id` (staff, template) | `owner_kind, owner_id, image_id, byte_size, mime_type, content_hash` |
| `broadcast_image_removed` | staff or system | `related_member_id` | `owner_kind, owner_id, image_id, blob_deleted: bool, blob_disposition` (sweep rows only, F7-1: `'deleted'\|'kept_shared_row'\|'reclaimed_by_sibling'` — the summary is derived from it; `blob_deleted` is true only for `'deleted'`)`, reason`. **Live reason vocabulary** (the same as data-model.md § `broadcast_images.deleted_at`): `'draft_discarded'` (`DELETE /api/broadcasts/draft/[id]`, API-only today) · `'draft_pruned'` (the 30-day prune cron) · `'member_erased'` (the F3 erasure cascade, via `markDeletedForMember` inside the content-redaction tx) — the three `ImageRemovalReason` values of `_mark-owner-images-removed.ts` — plus the sweep's own two outcomes `'sweep'` / `'sweep_orphaned'` (T035, `reclaim-orphaned-images.ts`). `'withdrawn'` / `'rejected'` arrive with PR-2 (T081: the member-withdrawal and staff-rejection paths stamp `deleted_at` in the same transaction as the state change); they have NO emit site in PR-1. There is no `'erasure'` or `'sweep_referenced'` value: the erasure reason is `'member_erased'`, and a referenced sweep row is RETAINED (un-stamped, no audit row, only `broadcasts_image_sweep_retained_total{tenant}`) |

The two image values are **new**, not reused. Spec § Audit trail requires "image uploaded / removed"
to be auditable, and the existing `broadcast_image_*` values are **refusals and configuration only**
(`broadcast_image_too_large`, `broadcast_image_unsafe`, `broadcast_image_allowlist_updated` —
`audit-port.ts:136-138`): today a successful upload and a removal leave no audit trace at all. They
ship in migration `0304` with `broadcast_images`. Neither payload ever carries the blob URL.

Rejection and withdrawal from a new stage reuse the existing `broadcast_rejected` /
`broadcast_cancelled`; cross-boundary misses reuse `broadcast_cross_tenant_probe` /
`broadcast_cross_member_probe` (including the member image route's new ownership check, US6-AS7);
a refused permission reuses `permission_denied`.

**Retention**: 5 years for all fourteen (`f7RetentionFor` returns 5 — `audit-port.ts:257`); no tax
document is produced, so none is a 10-year event.

**The five places** (CLAUDE.md § Gotchas, F7 flavour): `F7_AUDIT_EVENT_TYPES`
(`audit-port.ts:50-178`, **55 → 69**, with the static assert at `:234` **and** the assert's own
docblock at `:180-192` — which today still reads "the tuple length is 60" and itself says to update
"the tuple, this literal, and the header taxonomy" — **and** the file-header taxonomy comment, all
updated in the same edit; a stale count comment beside a self-checking assert is how the next
author gets the number wrong) ·
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

**Flag rule — all five are behind `FEATURE_EBLAST_MEMBER_APPROVAL`, at the drainer**
(maintainer decision, round 4 H2; the F114 precedent). The **enqueue** may still happen — the
submit transaction writes its `eblast_submitted_marketing` row whatever the flag says, so nothing
in the state-changing path branches on an env var — but the outbox drainer
(`src/app/api/cron/outbox-dispatch/route.ts`) **skips these five `notification_type` values while
the flag is off**, exactly as it skips F114's two. With the variable absent from the environment,
therefore, **nothing here is emailed to anyone**: rows accumulate, wait, and drain on the first tick
after the flip. That is what makes FR-034's "behave as today" true for
`eblast_submitted_marketing` — today nobody is emailed on submit, and with the flag off nobody is.
A skipped row is **not** an error and must not set `lastError`, must not count an attempt and must
not reach the `default:` arm's `no_template_handler` ladder; it is simply not selected. Built by
**T152a**, whose RED lives in `tests/contract/broadcasts/eblast-flag-matrix.test.ts` beside
T149/T150.

**FR-021b fixes what each side may see, and it is narrower than it looks.**

- **Staff hand-off emails carry four things and nothing else**: the E-Blast's **subject**, the
  **member company name**, the **new stage**, and a **link**. Never the body, never the member's
  feedback or reason, never marketing's note, never the send times. The detail page is where a staff
  user reads the rest — behind the session, the permission check and the audit trail. (An earlier
  draft of this contract had `eblast_member_decided_marketing` carry the member's reason verbatim and
  `eblast_submitted_marketing` carry the proposed send time; both are now forbidden.)
- **Member emails MUST state**: what changed, who acted (as "the chamber" — never a staff user's
  name, the F114 `organisation` precedent), the **proposed and the confirmed send time when they
  differ**, and a link back.

| type | to | one row per | `context_data` | rendered content |
|---|---|---|---|---|
| `eblast_submitted_marketing` | marketing recipients (§ 3.1) | recipient | `{ tenantId, broadcastId, recipientUserId }` | **subject + member company + stage ("Awaiting marketing review") + link** to `/admin/broadcasts/<id>` — nothing more (FR-021b). US5 AS1: staff are **not** notified on submit today, and with the flag off they still are not: the row is enqueued and the drainer skips it until the flip (round 4 H2) |
| `eblast_version_sent_member` | the member's contact | broadcast | `{ tenantId, broadcastId, versionId, round }` | what changed ("Round N is ready for your approval"), who acted ("the chamber"), marketing's note, the proposed send time, **and the full timeline: a reminder on day 3, a final reminder on day 7, a warning on day 23 and automatic closure on day 30** (FR-021b) — the member is told the clock at the moment it starts. Link to `/portal/broadcasts/<id>` |
| `eblast_member_decided_marketing` | marketing recipients | recipient | `{ tenantId, broadcastId, versionId: string \| null, round: number \| null, decision }` — **`versionId` and `round` are nullable**: the same type carries a whole-E-Blast withdrawal raised from `submitted` or `draft`, where no version and no round exist. The arm MUST render from the broadcast alone in that case and MUST NOT throw; an arm that throws is indistinguishable from the missing-arm `default: null` below and retries silently for ~16 h (`/speckit.analyze` M7) | **subject + member company + the new stage + link**. The `decision` discriminator selects the stage wording (`approved` → "Member approved — awaiting schedule"; `changes_requested` / `approval_withdrawn` → "Changes requested by member"; `withdrawn` → "Withdrawn"). **The member's reason is NOT in the email** (FR-021b) — it is on the detail page |
| `eblast_schedule_confirmed_member` | the member's contact | broadcast | `{ tenantId, broadcastId, versionId }` | what changed, who acted, the confirmed time in the tenant time zone **and the proposed time beside it with an explicit "this is not the time you proposed" line whenever they differ** (FR-018, FR-021b), and a link back |
| `eblast_approval_lifecycle` | member **and** marketing | recipient | `{ tenantId, broadcastId, versionId, round, kind, audience }` | `kind ∈ reminder_day3 \| reminder_day7 \| expiry_warning_day23 \| expired_day30`; day-23 and day-30 go to **both** sides (FR-022a). The **staff** rendering of each kind obeys the four-field rule above; the member rendering restates the remaining timeline |

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
| `broadcasts_version_saved_total` | counter | `tenant` |
| `broadcasts_member_decide_ms` | histogram | `tenant` |
| `broadcasts_preview_render_ms` | histogram | `tenant` |

**Six counters and two histograms — and each registration lands in the PR that emits it.**
`broadcasts_preview_rendered_total` and `broadcasts_preview_render_ms` are registered by **T122a in
PR-1**, because `POST …/preview` (T032) ships there; the other four counters, `broadcasts_member_decide_ms`
and the three remaining spans are registered by **T122 in PR-2**. An emit against an unregistered
field does not typecheck, so a registration a PR behind its emitter is not a documentation defect but
a broken build (`/speckit.analyze` round 3 C1). `broadcasts_version_saved_total` is emitted by
`PATCH /api/admin/broadcasts/[id]/version` (a save is not a hand-off, so it is counted rather than
audited) and was previously named only in `admin-eblast-formatting-api.md`, i.e. absent from this
inventory, from `src/lib/metrics.ts` and from `docs/observability.md` § 28 — it would have shipped
unregistered (`/speckit.analyze` M2). This table is the registration list; a metric not on it does
not exist.

### 4.3 Alerts (`docs/observability.md` § 28 — the file ends at § 27, line 2205)

| condition | severity | why |
|---|---|---|
| `broadcasts_awaiting_member_oldest_age_seconds > 7 d` | warning | the second reminder has been sent and nothing moved |
| `broadcasts_awaiting_member_oldest_age_seconds > 14 d` | page | well inside the 30-day expiry clock and **nine days ahead of the day-23 warning**, so a human sees it before either automatic step fires (the earlier note said "halfway to the 30-day expiry" — 14 is not half of 30, and the warning falls after it, not before) |
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
touch `vercel.json`, the runbook and the alert rules for no observable gain. **It also keeps the
existing `CRON_SECRET` bearer check** that guards every handler under `src/app/api/cron/**`: the new
block joins an already-authenticated route and MUST NOT introduce an unauthenticated entry to it —
an unguarded lifecycle tick would let anyone expire another tenant's E-Blasts on demand
(`/speckit.analyze` M8). Likewise `/api/internal/metrics/broadcasts-gauges` keeps the guard it has
today; this feature adds four gauges to it and changes nothing about its access control.

Order inside the block:

1. **Image sweep** — for every `broadcast_images` row with `deleted_at IS NOT NULL`, delete the blob
   **iff** no live row of **either** `owner_kind` — no E-Blast **and** no template — shares its
   `content_hash` (the last-reference rule, data-model § 4), then remove the row and audit
   `broadcast_image_removed { …, reason: 'sweep', actor_role: 'system' }`. The **reference** was
   removed from the content at the moment of erasure/withdrawal/rejection; this daily tick is what
   makes "the file is deleted once nothing references it" true (spec § Personal data), **on the next
   daily tick, 200 rows per arm per tenant** — not within a flat 24 h, which nothing enforces when a
   bulk erasure leaves more than that behind. The sweep is the SOLE deleter: there is no
   best-effort delete after the stamping transaction commits, and this paragraph used to claim one.
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

**Expiry applies only while awaiting the member** (FR-022a): steps 2 and 3 select on
`status = 'awaiting_member_approval'` and nothing else, and that is the only `from` state with an
`expired_no_member_response` target in the DB state machine. Once the member has approved, or
marketing has confirmed a schedule, **no expiry can occur** — a row can sit at `member_approved` or
`approved` indefinitely without the tick touching it. A lapsed member changes nothing here: the clock
keeps running (spec § Edge Cases).

**Never auto-approved** (FR-014, US5 AS3): the block has no path to `member_approved` or `approved`.
A contract test asserts that running it against a row that has been waiting 400 days produces
exactly one expiry and no approval, and that a row parked at `member_approved` for 400 days is
untouched.

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
- **FR-021b containment**: every **staff**-audience rendering is asserted to contain the subject, the
  member company, the stage and the link, and to contain **none** of the body, the member's reason,
  marketing's note or the send times — with a positive control that fails when the reason is spliced
  back in. The **member** `eblast_version_sent_member` rendering is asserted to state day 3, day 7,
  day 23 and day 30; `eblast_schedule_confirmed_member` is asserted to carry both times and the
  "not the time you proposed" line when they differ, and only the confirmed time when they do not.
- `marketingRoles()` is derived, not literal: with `marketing` removed from `MARKETING_KEYS`'
  `broadcasts.write`, the roster changes without touching this code.
- Empty roster → `staffNotified: false` + `broadcasts_no_marketing_recipient_total` incremented.
- The queue: stage counts match seeded rows; `whoseTurn` is correct for **every** status, including
  `null` for `draft`, `approved`, `sending` and all five closed statuses (no "system" value is ever
  produced); `round` does not move on a withdrawn approval and does move on the next send; a
  marketing-held row older than 48 h and a member-held row older than 3 days are both flagged, with
  the stalled badge carrying a text label the accessible name exposes, **while a marketing-held row
  at 30 h (past 24 h amber, short of the 48 h target) is NOT flagged, NOT counted and NOT
  announced as stalled**; a **proxy-submitted** E-Blast (staff submitted on the member's behalf)
  appears in the list with the same columns as a member-submitted one, so the dashboard covers
  every E-Blast that goes through the platform (FR-031); the upcoming preset orders by
  `scheduled_for`; a `manager` gets the full list and no action controls; at < md the card renders
  member/subject/stage/turn/time only.
- The cron block: one reminder per threshold across a 40-day simulated clock (injected
  `ClockPort`), zero approvals, exactly one expiry, a row at `member_approved` or `approved`
  untouched after 400 days, and a second run in the same day is a no-op.
