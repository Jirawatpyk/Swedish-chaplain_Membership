# Quickstart — 119 E-Blast Two-Sided Approval Workflow

How to prove the feature end to end on the **dev** Neon branch, and how to cut it over.
Implementation detail lives in `tasks.md`; shapes in `data-model.md` and `contracts/`.

## 0. Prerequisites and migration

- `.env.local` points at the **dev** Neon branch (never prod — the integration guard in
  `tests/integration-setup.ts` refuses a prod host).
- Flags in `.env.local`: `FEATURE_F7_BROADCASTS=true`, `FEATURE_F71A_BROADCAST_ADVANCED=true`,
  `FEATURE_F71A_US2_IMAGES=true`, `FEATURE_F71A_US7_TEMPLATES=true` (all already on for SweCham),
  plus the new `FEATURE_EBLAST_MEMBER_APPROVAL=true`. With the new flag absent, every US3/US6
  improvement is still live and the approval round simply cannot be entered.
- Personas: `e2e-member-empty` (a member contact with a portal login — the `e2e-member` persona is
  **LAPSED** by the F8 fixture and will 403), a `marketing` user, an `admin`, a `manager`.
- The maintainer runs `pnpm dev` on :3100 themselves; do not start or kill it.
- Before running e2e, check the dev roster is sane: a leaked-test-admin population makes every
  hand-off fan one outbox row out to each and turns a submit into a minutes-long transaction.

```bash
# apply BOTH migrations to the dev branch
pnpm db:migrate                 # 0304 then 0305

# a duplicate `when` makes db:migrate a SILENT no-op that still prints "✓ applied" —
# verify the DDL actually landed, do not trust the migrator's output
psql "$DATABASE_URL" -c "SELECT unnest(enum_range(NULL::broadcast_status));"          # expect 15 values
psql "$DATABASE_URL" -c "SELECT to_regclass('public.broadcast_versions'), to_regclass('public.broadcast_member_decisions'), to_regclass('public.broadcast_images');"
psql "$DATABASE_URL" -c "SELECT column_name FROM information_schema.columns WHERE table_name='broadcasts' AND column_name IN ('proposed_send_at','stage_entered_at','current_round','approved_version_id','member_reminder_stage','member_expiry_notified_at');"   # expect 6
psql "$DATABASE_URL" -c "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('broadcast_versions','broadcast_member_decisions','broadcast_images');"   # expect t,t ×3

# the FR-012a amendments actually replaced the function bodies — read the SOURCE, not a fixture
psql "$DATABASE_URL" -c "SELECT prosrc FROM pg_proc WHERE proname='broadcasts_immutable_after_submit_fn';" | grep -c "member_approved"   # expect >= 2 (E1 and E2)
psql "$DATABASE_URL" -c "SELECT prosrc FROM pg_proc WHERE proname='broadcasts_state_machine_fn';"          | grep -c "awaiting_member_approval"

pnpm db:verify                  # schema canaries
pnpm check:multi-tenant         # the 3 new tables + tenant_broadcast_settings are registered
pnpm check:audit-events && pnpm check:audit-counts && pnpm check:i18n
```

**Why one file can both add an enum value and use it**: `scripts/run-migrations.ts` extracts every
`ALTER TYPE … ADD VALUE` and replays it in AUTOCOMMIT **before** the transactional pass (the 0301
precedent), which is what lets `0305` add `'awaiting_member_approval'` and create a partial index on
it. Keep one `ADD VALUE` per line, or the extraction misses them.

---

## 1. Story walkthroughs — each is the manual twin of a RED acceptance test

### US1 — marketing formats, the member signs off, marketing schedules

1. As `e2e-member-empty`, `/portal/broadcasts/new`: write a subject and a body, pick a send time a
   week out, Submit. Expect stage **Awaiting marketing review**; `/admin/broadcasts` shows it; the
   `marketing` user's inbox has one "new E-Blast submitted" email (nobody was emailed on submit
   before this feature).
2. As `marketing`, open it → **Start formatted version**. Expect: a working copy seeded from the
   member's text, the member's original shown beside it **unchanged**, stage **In design**.
3. Format it: an H2 heading, a banner image, a paragraph, a call-to-action button. Add a note to the
   member. Save. Expect `broadcast_versions` to hold `version_no = 0` (the original, materialised at
   step 2) and `version_no = 1` (the working copy), and `broadcasts.subject`/`body_html` to be
   **untouched**.
4. Preview → the dialog shows the complete email: chamber logo header (or the chamber name if no
   logo is on file), the body with the real button and banner, the footer with the postal address
   and the unsubscribe link. Switch desktop ⇄ phone. Close → focus returns to the Preview button.
5. **Send to member.** Expect stage **Awaiting member approval**, `current_round = 1`, the version
   now read-only (try `PATCH …/version` → 409 `stage_changed`), and one email to the member's
   contact in **their** language.
6. As the member, `/portal/broadcasts/<id>`: the formatted version rendered through the same
   wrapper, the original beside it, marketing's note, the proposed send time, the expiry date.
   **Approve.** Expect stage **Member approved — awaiting schedule** and the marketing inbox
   notified.
7. As `marketing`, **Confirm schedule**: the member's proposed time is shown and pre-selected.
   Keep it. Expect stage **Scheduled**, and — the FR-012a promotion —
   `SELECT subject, body_html FROM broadcasts WHERE broadcast_id = …` now **equals the approved
   version byte-for-byte**. The member is emailed the confirmed time.
8. Let the dispatcher run (or set `scheduled_for` to the past on the dev branch) → **Sending** →
   **Sent**. Verify the delivered email equals the version the member approved (US1 AS6).
9. **Negative (FR-007)**: submit a second E-Blast and choose **Approve as submitted**. Expect no
   member sign-off round, no version rows, today's behaviour exactly.

### US2 — the member asks for changes, and later withdraws an approval

1. At **Awaiting member approval**, choose "Request changes" and leave the reason blank → refused,
   "a reason is required" (US2 AS1).
2. Give a reason → stage **Changes requested by member**; marketing is notified; the reason appears
   on the staff detail attached to **round 1**.
3. As marketing, **Start formatted version** again → round 2, send it → the member sees both rounds
   and both notes in order.
4. Approve round 2, confirm the schedule, then as the member choose **Withdraw approval** with a
   reason before the send time. Expect: stage back to **Changes requested by member**,
   `scheduled_for` **cleared**, `approved_version_id` **cleared**, marketing notified, and the
   history showing the withdrawal and its reason (FR-015a).
5. **Negative**: with the broadcast in `sending`, withdraw → 409 `sending_started`; the send
   completes (spec § Edge Cases).
6. **Allowance**: through every one of those stages, the member's quota display shows the place held;
   after a reject or a withdrawal it is released, and `quota_year_consumed` is still NULL (SC-007).

### US3 — the writing tool

1. Toolbar: heading, quote, divider, bulleted and numbered lists, bold, underline, link with its own
   text, image, CTA button, banner — every one of them has a visible control, and nothing typeable by
   shortcut (`# `, `> `, `---`, ` ``` `, `~~strike~~`) produces something the platform later strips.
2. Insert an image without a description → the block cannot be inserted and the prompt says why
   (FR-040).
3. Add a CTA button → it renders in the chamber's brand colour in the preview **and** in a test copy;
   there is no colour or font control anywhere.
4. **Send test copy** → arrives at your own address, marked `[TEST]`; the stage, the version history
   and the allowance are unchanged. Compare the test copy with the preview and with a delivered
   email — element for element, nothing stripped (SC-011).
5. Empty message → the inline preview shows an empty state, not a blank box.
6. Switch the interface to Thai → italic is not offered (FR-044).
7. Save a draft, change nothing, navigate away → **no** "unsaved changes" warning (FR-045).
8. As `marketing`, the compose-on-behalf form offers drafts, images, the template picker, the
   member's allowance, the subject counter, the preview and the unsaved-changes guard (FR-039).

### US4 — the dashboard

1. Seed E-Blasts across every stage. `/admin/broadcasts` → a count per stage chip; selecting one
   filters the list.
2. Each row shows member, subject, stage, whose turn, time in stage, round, proposed and confirmed
   send times, last activity.
3. A marketing-held row older than 48 h and a member-held row older than 3 days are both flagged
   stalled.
4. The **Upcoming sends** preset lists scheduled E-Blasts in send-time order.
5. A sent row shows recipients / delivered / bounced / complained.
6. As `manager`: everything is visible, no action control exists (not merely disabled), and
   `POST …/version` → 403 + `permission_denied` in the audit.

### US5 — reminders and expiry (with an injected clock)

1. Submit → the marketing roster is emailed. Remove the `marketing` user and submit again → the
   admins are emailed instead (FR-021a); remove them too → nothing is sent, the
   `broadcasts_no_marketing_recipient_total` counter moves and the alert would page.
2. Drive the lifecycle block with `stage_entered_at` backdated 3, 7, 23 and 30 days:
   ```bash
   curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3100/api/cron/broadcasts/prune-expired-drafts
   ```
   Expect, in order: one day-3 reminder, one day-7 reminder, one day-23 warning **to both sides**,
   then closure as **Expired — no member response** with both sides told and the allowance place
   freed. Running it twice on the same day changes nothing. **Nothing is ever auto-approved.**
3. Send a new version mid-wait → `member_reminder_stage` resets to 0 and the clock restarts from the
   new version (FR-022a).
4. The nav badge counts the E-Blasts waiting on marketing, from anywhere in the staff portal.

### US6 — the screens

1. Type a subject and a message, then pick a template → you are asked to confirm before your text is
   replaced (the audit's BLOCKER #1).
2. Open a submitted E-Blast from the member's list → its subject **and content** are readable
   (FR-049).
3. Break a route (stop the DB) on each of `/portal/broadcasts/[id]`, `/admin/broadcasts`,
   `/admin/broadcasts/[id]`, the templates pages and the settings pages → the platform's error state
   with a retry appears on every one.
4. With a screen reader, trigger a validation error on the message → the error is announced on the
   editor itself.
5. Toolbar: one tab stop, arrow keys between controls (FR-048).
6. `pnpm test:e2e --grep "@a11y" --workers=1` → zero serious or critical findings on every E-Blast
   screen (SC-013).

### US7 — the safe trial

See § 4 below.

---

## 2. Automated proof

```bash
# unit + contract (fast)
pnpm vitest run tests/unit/broadcasts/domain tests/unit/broadcasts/application tests/unit/broadcast
pnpm vitest run tests/contract/broadcasts

# integration — pass FILE PATHS, never "-- <pattern>" (that runs the whole ~40-min suite)
pnpm test:integration tests/integration/broadcasts/eblast-approval-tenant-isolation.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-approval-cross-member-probe.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-immutability-trigger.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-state-machine-edges.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-allowance-bucket.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-erasure-reach.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-content-parity.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-dashboard-pagination.test.ts

# e2e — local only, workers=1 is mandatory, run in <= 10-minute FOREGROUND chunks
pnpm test:e2e --grep "@eblast" --workers=1
pnpm test:e2e --grep "@a11y"   --workers=1
pnpm test:e2e --grep "@i18n"   --workers=1

# pinned coverage — a green `pnpm test` is NOT the CI coverage job
pnpm vitest run tests/unit/broadcasts --coverage \
  --coverage.include=src/modules/broadcasts/application/use-cases/approval/record-member-decision.ts

# every gate before the PR
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout \
  && pnpm check:fixme && pnpm check:template-seed && pnpm check:money-recipient \
  && pnpm check:audit-events && pnpm check:audit-counts && pnpm check:multi-tenant \
  && pnpm check:staff-page-guard && pnpm check:api-route-guard && pnpm check:actor-role-truth \
  && pnpm check:env-example && pnpm check:portal-guard
```

**Expected**: the isolation test creates two tenants, writes versions, decisions and images in each,
and proves zero cross-tenant reads **and** writes in both directions on all three tables
(Constitution I.3 — a Review-Gate blocker). The cross-member test proves member B cannot read or
decide member A's E-Blast inside one tenant. The immutability test proves a direct DB `UPDATE` of
`subject`, `body_html` or `scheduled_for` is still refused on every non-exempt transition and in
every new stage, and permitted on exactly the two exempt edges. The parity test compares the element
and attribute multiset across editor → sanitiser → preview → send-time render, with a positive
control that fails when a tag is dropped from one config.

**Note on the pagination budget**: assert it in a **single-file** run. A folder run puts 100+ files
on one Neon compute and the contention alone can quadruple a query's p95; the pre-push hook exports
`INTEGRATION_FOLDER_RUN=1`, and the test reports rather than asserts when it sees it.

---

## 3. Cutover (prod)

### 3.1 PR-1 — the writing tool and the screens (unflagged)

PR-1 **ships live on merge**. There is no flag to hold it back and setting an env var IS a
production deploy on this repo (`vercel.json` has no `ignoreCommand`).

| Pre-merge gate | Why it blocks |
|---|---|
| The **byte-identical wrapper snapshot** — with no brand colour, no postal address, no logo on file and no design block in the body, `renderBroadcastHtml` output equals today's byte for byte | PR-1 changes the wrapper every live SweCham send uses. Without this, the tool upgrade is an unreviewable change to production email |
| SC-011 element parity, with its positive control | The shared sanitiser policy replaces three hand-maintained configs; the parity test is what makes "nothing is stripped" a property rather than a promise |
| `@tiptap/extension-image` re-pinned `^3.22.5` → `3.22.5` | A caret on an editor extension means a patch release can change the serialised HTML the sanitiser and the block parser both key on |
| e2e `@eblast` + `@a11y` green on chromium **and** mobile-safari | The compose layout changes at two breakpoints |
| The live-look items (research V2): 320 px toolbar, empty-preview first paint, deferred-preview layout shift, NVDA on the toolbar, SV chip lengths | They cannot be settled by reading code |

After merge: the chamber logo appears in E-Blast headers automatically for SweCham (the logo is
already on file for invoices — FR-041a), and the footer keeps the current synthetic address line
until step 3.3.

### 3.2 PR-2 — the approval round (ships DARK)

1. Merge → prod auto-migrates `0304` and `0305` on deploy (`vercel-build`). Run
   `pnpm db:verify:prod` and the `pg_proc` checks from § 0 against prod, read-only.
2. **Do not set `FEATURE_EBLAST_MEMBER_APPROVAL` yet.** Setting the env var is the deploy and the
   flip in one action.
3. Unflagged and live the moment PR-2 merges — none of the rollback layers in § 3.5 undoes these:
   - the five `broadcast_status` values, the twelve `audit_event_type` values and the five
     `notification_type` values (`ADD VALUE` is irreversible);
   - the two amended trigger functions (a reversal is a new migration);
   - `proposed_send_at` now recorded at submit for **every** E-Blast, and the backfill of rows
     currently in `submitted`;
   - the widened allowance bucket and cancel cascade — they read the same set, which currently
     contains no rows in the new stages, so behaviour is unchanged until the flag is on;
   - `stage_entered_at` stamped on every status change.
4. **Update the record of processing (RoPA)** before the flag goes on: the new purpose ("review and
   member sign-off of E-Blast content; accountable version history"), the new personal data
   (versions, notes, decision reasons, staff-uploaded images), the new disclosure (hand-off
   notification emails to staff and to the member's contact), the new export category
   (`broadcast-versions.json`) and the retention note that a **sent** outbox row keeps the
   recipient's address frozen at enqueue under the existing outbox retention. This is a
   **precondition** of step 5, not a follow-up.
5. Set `FEATURE_EBLAST_MEMBER_APPROVAL=true` in Vercel only when ready to redeploy immediately and
   only after step 4. From that moment "Start formatted version" is offered on submitted E-Blasts.
6. **First-round observation**: run one real E-Blast through format → send → approve → confirm →
   sent. Confirm the marketing email arrived, the member email arrived in their language, the stage
   chips and the nav badge read correctly, and
   `SELECT subject = (SELECT subject FROM broadcast_versions WHERE id = b.approved_version_id)
    FROM broadcasts b WHERE b.broadcast_id = …` is `true`. Record it in `reviews/cutover.md`.

### 3.3 Brand settings (operator, any time after PR-1)

On `/admin/settings/broadcasts/brand` (admin or super-admin — **not** marketing): set the chamber's
primary colour (refused if white text on it is below WCAG AA 4.5:1) and the postal address. Until
the address is set, the footer shows the chamber name only and the page flags it missing. The logo
is read-only here; changing it stays on `/admin/settings/invoicing`, super-admin only, because it
prints on issued tax documents.

### 3.4 Flag matrix

| | `FEATURE_F7_BROADCASTS` off | F7 on, `FEATURE_EBLAST_MEMBER_APPROVAL` off | both on |
|---|---|---|---|
| Every E-Blast route and page | 503 `feature_disabled` (proxy) | live | live |
| Writing tool, preview, design blocks, images, brand page, screen fixes | off with F7 | **live** | live |
| "Start formatted version" | off | **404 / hidden** | offered |
| Member approve / request changes / withdraw approval | off | **available for rows already in a new stage** (FR-034) | available |
| Confirm schedule | off | available | available |
| New stage chips on the queue | off | shown only if rows exist in them | shown |
| Nav waiting count | off | hidden unless rows exist | shown |
| Reminders / day-23 warning / day-30 expiry | off | run for rows already awaiting | run |
| Today's approve / reject flow | off | **byte-identical to before** (SC-006) | unchanged |

### 3.5 Rollback matrix (FR-034)

| Layer | Action | In-flight rows | Time |
|---|---|---|---|
| 1 — platform flag off | remove `FEATURE_EBLAST_MEMBER_APPROVAL` in Vercel + redeploy | kept; no **new** E-Blast can enter the round; rows already in a new stage stay completable and cancellable, and the reminder/expiry clock keeps running so nothing sits forever | one deploy |
| 2 — code revert of PR-2 | revert the PR | rows in a new stage become unreachable by the application until the code returns — **cancel them first** (`/admin/broadcasts` → Cancel), because the enum values and the triggers stay | one deploy |
| 3 — code revert of PR-1 | revert the PR | the wrapper returns to today's; brand columns and `broadcast_images` rows are orphaned but harmless | one deploy |

Migrations `0304` and `0305` are **not** undone by any layer; reversing them is a new migration, and
`ALTER TYPE … ADD VALUE` cannot be reversed at all.

---

## 4. SweCham UAT (FR-035, US7, SC-005)

The walkthrough is delivered as a written EN + TH document; this section is its precondition list.

**Precondition — the staff-only recipient list must actually resolve.**
`validateCustomRecipients` accepts any **contact email in the tenant graph**, so a "staff only"
custom recipient list works **only if each staff address exists as a contact of the designated test
member**. Before the trial:

1. Create (or designate) a test member company in prod, e.g. "SweCham Internal Test".
2. Add each participating SweCham staff address as a **contact of that member**, marketing-opted-in.
3. Give that member a plan with at least 3 E-Blasts of allowance so the walkthrough's rounds and
   rejections do not exhaust it.
4. Use the **custom recipient list** audience on every trial E-Blast and name only those addresses.

Without step 2 the recipient validation refuses the list and the trial stalls at submit — this is
the single most likely way the UAT fails on day one.

**Other preconditions**

- The Resend account is on the **Free** plan (1,000 contacts, 3 segments), so at most **two**
  broadcasts can be in flight at once; the audience ceiling is 500 recipients per tick. Sequence the
  walkthrough accordingly.
- The approval round itself makes **no** Resend Broadcasts call until the schedule is confirmed, so a
  long design round consumes no Resend capacity.
- Brand settings (§ 3.3) set, so the trial exercises the logo header, the brand-coloured button and
  the real footer address.
- `FEATURE_EBLAST_MEMBER_APPROVAL` on, and the RoPA updated (§ 3.2 step 4).

**Walkthrough** (the SC-005 path): submit → format → request changes → re-format → approve → confirm
schedule → sent, with **zero** emails delivered outside the staff-only list. Verify after each send
that the delivery report names only those addresses.

---

## 5. Watch after cutover

- `broadcasts_awaiting_member_oldest_age_seconds` — warning at 7 days, page at 14 (both inside the
  30-day expiry clock).
- `broadcasts_no_marketing_recipient_total` — any non-zero value means a hand-off notified nobody.
- `email_dispatch_failed` audit rows whose `notification_type` starts `eblast_` — in particular
  `no_template_handler`, which would mean a notification type shipped without its dispatcher arm and
  has been retrying silently for up to 16 hours.
- `broadcasts_marketing_turn_count` versus the nav badge — a divergence means the gauge and the live
  count are reading different predicates.
- The first week's `broadcast_schedule_confirmed` rows with `differs: true` — if marketing is
  routinely overriding the member's proposal, FR-018's "call out the difference" copy is doing real
  work and the member's expectations may need managing.
