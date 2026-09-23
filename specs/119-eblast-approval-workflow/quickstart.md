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
psql "$DATABASE_URL" -c "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='audit_event_type' AND e.enumlabel IN ('broadcast_test_copy_sent','broadcast_brand_settings_changed','broadcast_image_uploaded','broadcast_image_removed','broadcast_version_started','broadcast_version_sent_to_member','broadcast_member_approved','broadcast_member_changes_requested','broadcast_member_approval_withdrawn','broadcast_member_approval_voided','broadcast_schedule_confirmed','broadcast_approval_reminder_sent','broadcast_approval_expiry_warned','broadcast_approval_expired');"   # expect 14

# the 0305 backfills ran: every row that was 'submitted' with a time carries a proposal, and no
# waiting row was left with a fresh stage clock. If the file put CREATE OR REPLACE of the
# immutability fn BEFORE the backfills, db:migrate aborted with broadcast_immutable_after_submit
# (round 3 H5) — and if stage_entered_at is uniformly "now", backfill 2 is missing (round 3 M3).
psql "$DATABASE_URL" -c "SELECT count(*) FROM broadcasts WHERE status='submitted' AND scheduled_for IS NOT NULL AND proposed_send_at IS NULL;"   # expect 0
psql "$DATABASE_URL" -c "SELECT count(*) FROM broadcasts WHERE stage_entered_at > now() - interval '5 minutes' AND submitted_at < now() - interval '1 day';"   # expect 0

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
   wrapper, the original beside it, marketing's note, the proposed send time, the expiry date. On a
   **phone** the formatted version comes **first** and the original is reachable **below it on the
   same page** (FR-008). The member's email states the day 3 / 7 / 23 / 30 timeline (FR-021b).
   **Approve** — the confirmation dialog says marketing will now confirm the send time and that the
   content cannot change without a new approval; the optional note is capped at 500 characters
   (FR-009). Expect stage **Member approved — awaiting schedule**, a page that shows the new stage
   and a way back to the E-Blast list, and the marketing inbox notified — with an email carrying
   **only** the subject, the member company, the new stage and a link (FR-021b).
7. As `marketing`, **Confirm schedule**: the member's proposed time is shown and pre-selected.
   Keep it. Expect stage **Scheduled**, and — the FR-012a promotion —
   `SELECT subject, body_html FROM broadcasts WHERE broadcast_id = …` now **equals the approved
   version byte-for-byte**. The member is emailed the confirmed time.
8. Let the dispatcher run (or set `scheduled_for` to the past on the dev branch) → **Sending** →
   **Sent**. Verify the delivered email equals the version the member approved (US1 AS6).
9. **Negative (FR-007)**: submit a second E-Blast and choose **Approve as submitted**. Expect no
   member sign-off round, no version rows, today's behaviour exactly — and the history on both sides
   showing a single **"approved as submitted"** entry with the staff user and the time.
10. **No portal user (spec § Edge Cases)**: proxy-submit an E-Blast for a member company that has no
    active portal user, start a formatted version and try **Send to member** → refused
    409 `no_portal_user`, with a warning on the detail page saying the only options are approving as
    submitted or inviting a portal user first.
11. **De-allow-listed image**: save a version with an image, remove that host from the tenant
    allow-list, then **Send to member** → refused 422 naming **which image and why**; the version
    stays editable. Do the same after approval and try **Confirm schedule** → the promotion is
    refused with the same code.
12. **Brand change mid-flow**: with a version awaiting the member, change the brand colour on
    `/admin/settings/broadcasts/brand` → nothing is voided, `approved_version_id` is unchanged, and
    the next preview and the send use the **new** colour (FR-041c).

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
   completes (spec § Edge Cases). "Sending begins" is entry into the **Sending** stage, i.e. the
   hand-over to the delivery provider — one stage earlier (`approved`/Scheduled) both a member
   withdrawal and a marketing rejection still succeed (FR-015).
6. **Allowance**: through every one of those stages, the member's quota display shows the place held;
   after a reject or a withdrawal it is released, and `quota_year_consumed` is still NULL (SC-007).
7. **Lapsed member**: lapse the test member's plan, then open the E-Blast as that member and approve
   → it **succeeds** (reading and deciding are not benefit actions); the existing refusal appears at
   send time instead, and the expiry clock is unaffected (spec § Edge Cases).
8. **Marketing may re-send unchanged content** (FR-011): after a change request, send a version whose
   subject and body are byte-identical with a note explaining why → accepted as the next round.

### US3 — the writing tool

1. Toolbar: headings (**H2 and H3 only** — no H1, the subject is the title), quote, divider,
   bulleted and numbered lists, bold, underline, link with its own text, image, CTA button, banner —
   every one of them has a visible control, and nothing typeable by shortcut (`# `, `> `, `---`,
   ` ``` `, `~~strike~~`) produces something the platform later strips (FR-038).
2. **Paste** a Word/Google-Docs fragment with colours, a table and a font change → the unsupported
   parts are dropped **at paste time** and a **single** non-blocking notice says so; paste again in
   the same session → no second notice (FR-038).
3. Link dialog: enter `javascript:alert(1)` or `ftp://…` → refused **in the dialog** with a message;
   `http`, `https` and `mailto` are accepted (FR-038).
4. Insert an image without a description → the block cannot be inserted and the prompt says why; the
   description field is labelled, accepts **1–125 characters**, and an empty value is announced as a
   field error (FR-040).
5. Add a CTA button → it renders in the chamber's brand colour in the preview **and** in a test copy;
   there is no colour or font control anywhere. Text of 61 characters → refused; a **fourth** CTA in
   one message → refused; at phone width the button **text wraps** and never overflows (FR-041).
6. Add a banner → full 600 px width, placeable anywhere in the body, description required (FR-041).
7. **Send test copy** → arrives at your own address, subject prefixed **`[Test]`**; the stage, the
   version history and the allowance are unchanged. It runs the identical pipeline — blocks, brand
   header, footer. Compare the test copy with the preview and with a delivered email — element for
   element, nothing stripped (SC-011). The **11th** test copy in an hour is refused (10/hour, FR-037).
8. Empty message → the inline preview shows the translated empty-state line, not a blank box; open
   the Preview dialog → **desktop 600 px** and **phone 375 px**, focus returns to the trigger on
   close, and the open/close transition respects `prefers-reduced-motion` (FR-043).
9. Switch the interface to Thai → the italic **control** is not offered; paste italic text or start
   from a template that contains italic → the italic content is **kept**, not stripped (FR-044).
10. Save a draft → the save control shows a **busy state** while saving and a **"Saved at HH:MM"**
    indicator afterwards; change nothing, navigate away → **no** "unsaved changes" warning (FR-045).
11. Toolbar at **320 px**: it **wraps onto further rows** — there is no overflow menu and no control
    is hidden; arrow keys move between controls, **Home/End** jump to the first and last, and focus
    is visible throughout (FR-048).
12. As `marketing`, the compose-on-behalf form offers drafts, images, the template picker, the
    member's allowance, the subject counter, the preview and the unsaved-changes guard (FR-039).
13. Start an E-Blast from a template that carries a banner and a CTA → the member can **edit and
    delete** both like any other content, and nothing marks them as template-derived (FR-046a).

### US4 — the dashboard

1. Seed E-Blasts across every stage. `/admin/broadcasts` → a count per stage chip; selecting one
   filters the list. A changed count is announced through the list's **one existing** `role="status"`
   region — confirm with a screen reader that there is no second announcer (FR-025).
2. Each row shows member, subject, stage, whose turn, time in stage, round, proposed and confirmed
   send times, last activity. **Whose turn** reads Marketing / Member / **"—"**; "—" for Draft,
   Scheduled, Sending and every closed stage, and there is no "system"/"Us" value anywhere (FR-026).
   Withdraw an approval → the round number does **not** change; send the next version → it does.
3. Narrow to **phone width**: the card shows member, subject, stage, whose turn and time in stage
   only; round and both send times are on the detail page, with no horizontal scroll (FR-026).
4. A marketing-held row older than 48 h and a member-held row older than 3 days are both flagged
   stalled — with an **icon *and* a text label**, never colour alone, and the label is in the
   accessible name (FR-027).
5. Switch the interface to **SV** and to **TH**: every stage chip label fits its chip (SV runs up to
   +28 %) and the strip does not reflow (FR-025, research V2).
6. The **Upcoming sends** preset lists scheduled E-Blasts in send-time order.
7. A sent row shows recipients / delivered / bounced / complained.
8. As `manager`: everything is visible, no action control exists (not merely disabled), `GET
   …/version` returns the full thread, and `POST …/version`, `…/test-copy`, `…/schedule` and the
   Brand page all → 403 + `permission_denied` in the audit (spec § Roles).

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
4. **Expiry is scoped**: park a row at **Member approved** and another at **Scheduled**, backdate
   both 400 days and run the tick → neither is touched. Expiry exists only while **Awaiting member
   approval** (FR-022a).
5. **SC-004 measurement**: "notified within 5 minutes" means the notification email has been
   **handed to the delivery service**, measured from the hand-off event — not delivered, not opened.
   Measure `enqueued_at` on the outbox row against the `sent_at` the dispatcher stamps when Resend
   accepts it; the 1-minute outbox tick plus the provider call is the whole budget. A provider
   failure is an `email_dispatch_failed` row, not an SC-004 breach.
6. The nav badge counts the E-Blasts waiting on marketing, from anywhere in the staff portal.

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
5. Toolbar: one tab stop, arrow keys between controls, **Home/End** to the ends, a visible focus
   state, and at 320 px it **wraps** with no overflow menu (FR-048).
6. **FR-051 is a finite list.** "Every E-Blast screen" means exactly these **nine**, and each one
   must pass the platform UX checklist at **`docs/ux-standards.md` § 15** and the automated WCAG
   2.1 AA scan (axe-core rules, run through the **`@a11y` e2e suite**) with **zero serious or
   critical findings** before the trial starts:

   | # | screen |
   |---|---|
   | 1 | portal compose — `/portal/broadcasts/new` |
   | 2 | portal E-Blast detail / sign-off — `/portal/broadcasts/[id]` |
   | 3 | portal benefits E-Blast tab |
   | 4 | staff queue — `/admin/broadcasts` |
   | 5 | staff detail / format — `/admin/broadcasts/[id]` |
   | 6 | staff compose-on-behalf — `/admin/broadcasts/new` |
   | 7 | template list / new / edit — `/admin/broadcasts/templates/**` |
   | 8 | E-Blast settings — `/admin/settings/broadcasts` |
   | 9 | Brand settings — `/admin/settings/broadcasts/brand` |

   In the same pass: **translation keys no screen uses are removed**, and components that are never
   shown are **wired or deleted** (FR-051). `pnpm check:i18n` after the deletions.
7. `pnpm test:e2e --grep "@a11y" --workers=1` → zero serious or critical findings on all nine
   (SC-013).

### US7 — the safe trial

See § 4 below.

---

## 2. Automated proof

```bash
# unit + contract (fast)
pnpm vitest run tests/unit/broadcasts/domain tests/unit/broadcasts/application tests/unit/broadcast
pnpm vitest run tests/contract/broadcasts

# integration — ALL TWELVE suites this feature creates. Pass FILE PATHS, never "-- <pattern>"
# (that runs the whole ~40-min suite). The last four were missing from this list until
# /speckit.analyze M4, which meant the FR-012a / SC-002 happy path was never run by the gate.
# PER PR (round 3 M1): in PR-1 only three of these files exist — eblast-approval-tenant-isolation,
# eblast-content-parity and audit-event-type-parity. Run those three there; run all twelve in PR-2.
# Naming a path the PR has not created makes the gate unsatisfiable, not merely noisy.
pnpm test:integration tests/integration/broadcasts/eblast-approval-tenant-isolation.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-approval-cross-member-probe.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-immutability-trigger.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-state-machine-edges.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-allowance-bucket.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-erasure-reach.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-content-parity.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-dashboard-pagination.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-approval-happy-path.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-approval-rounds.test.ts
pnpm test:integration tests/integration/broadcasts/eblast-submit-notifies-marketing.test.ts
pnpm test:integration tests/integration/broadcasts/audit-event-type-parity.test.ts

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
| The **byte-identical wrapper snapshot** — with no brand colour, no postal address, no logo on file and no design block in the body, `renderBroadcastHtml` output equals today's byte for byte | PR-1 changes the wrapper every live SweCham send uses. This is now a **spec requirement** (§ Feature flag: "that snapshot test is a merge blocker for the unflagged tool upgrade"), not only a plan amendment. Without it the tool upgrade is an unreviewable change to production email |
| The **`docs/ux-standards.md` § 18.2 container exception** for the two-column compose width, written **in this same change** | FR-050 requires the departure from the form container tier to be recorded, not discovered later |
| The **PR-1 FR-051 pass**: `docs/ux-standards.md` § 15 checklist + the `@a11y` axe suite, zero serious/critical, dead i18n keys removed, unshown components wired or deleted — on the **seven whole screens PR-1 builds** (portal compose, portal benefits E-Blast tab, staff queue, staff compose-on-behalf, template list/new/edit, E-Blast settings, Brand settings) **plus the body view of `/portal/broadcasts/[id]`** | FR-051 names a finite list of nine and requires the pass **in every delivery that builds or changes a screen** (plan Amendment 4); a screen missed here is a screen SweCham tests. PR-2 gates the **stage fields** of `/admin/broadcasts/[id]` — the page itself EXISTS and is live in PR-1 as the approve/reject surface, and ROUND-3 #2 changed its body to the delivered document, so it is in PR-1's pass too; this row used to say it "does not exist yet" — the **sign-off view** of `/portal/broadcasts/[id]`, which PR-2 rebuilds, **and the staff queue again**, which T116–T120 rebuild now that US4 ships in PR-2 (§ 3.2 step 4a). Screens 2 and 4 are each scanned once in both PRs because both PRs change them — the earlier "seven / two" wording listed eight and summed to ten (`/speckit.analyze` M1) |
| SC-011 element parity, with its positive control | The shared sanitiser policy replaces three hand-maintained configs; the parity test is what makes "nothing is stripped" a property rather than a promise |
| `@tiptap/extension-image` re-pinned `^3.22.5` → `3.22.5` | A caret on an editor extension means a patch release can change the serialised HTML the sanitiser and the block parser both key on |
| e2e `@eblast` + `@a11y` green on chromium **and** mobile-safari | The compose layout changes at two breakpoints |
| The live-look items (research V2): 320 px toolbar, empty-preview first paint, deferred-preview layout shift, NVDA on the toolbar, SV chip lengths | They cannot be settled by reading code |

After merge: the chamber logo appears in E-Blast headers automatically for SweCham (the logo is
already on file for invoices — FR-041a), and the footer keeps the current synthetic address line
until step 3.3.

**Unflagged and live the moment PR-1 merges** (ROUND-3 #7). § 3.2 step 3 carries this inventory for
PR-2 and § 3.1 carried none, which made PR-1 look flag-protected when it is the opposite: there is
no `FEATURE_EBLAST_*` flag over any of it. Each line is **code-revert-only** — § 3.5 layer 3 — and
`ALTER TYPE … ADD VALUE` is not reversible even by that.

- **Migration `0304`** plus the **four `audit_event_type` values** it adds
  (`broadcast_test_copy_sent`, `broadcast_brand_settings_changed`, `broadcast_image_uploaded`,
  `broadcast_image_removed`) and the `tenant_broadcast_settings.brand_*` columns.
- **The draft routes' refusal codes narrowed** (U28, both `POST | PUT /api/broadcasts/draft` and
  `/api/admin/broadcasts/draft`): an empty or over-long subject and an over-size body now answer
  **422 with the specific code** (`broadcast_subject_empty`, `broadcast_subject_too_long`,
  `broadcast_body_too_large`) instead of **400 `invalid_body`** — and (F7-4) a custom list with a
  malformed entry or more than 100 entries answers 422 `broadcast_custom_recipient_invalid_format` /
  `broadcast_custom_recipient_too_many`. A client that switched on the
  status alone sees a different number; the F7 contract
  (`specs/010-email-broadcast/contracts/broadcasts-api.md` § 1.1) is annotated, and the staff
  contract row already SPECIFIED 422 — the route had been contradicting it. `invalid_body` is
  kept for a genuinely malformed body and finally has a locale key, so the old path (a refusal
  rendering as "an unexpected error occurred — please try again", which no retry could clear)
  cannot recur.
- **Member inline-image upload now re-encodes through `sharp`** (F2-3): EXIF / GPS / XMP / IPTC /
  ICC are stripped, the SHA-256 and the stored `byte_size` describe the RE-ENCODED bytes, a
  decode / MIME mismatch answers **415**, a decode that exceeds 15 s answers **503**, and the
  input is capped at **4096²** pixels. An image a member could upload yesterday can be refused
  today — that is the point, but it is a behaviour change with no flag over it.
- **`validateBlocks` runs at five call sites**: the three save paths (`save-draft`,
  `create-broadcast-template`, `update-broadcast-template`), `submit-broadcast` and
  `send-test-copy`. It inspects only `data-eb` markers, so a legacy body that has never been
  through the new editor is unaffected; a body that carries a malformed marker is now refused
  where it used to save.
- **The cron `prune-expired-drafts` gained block 2** (the image sweep) and `maxDuration = 300`.
  The route answers **500 when the sweep fails**, even though the draft prune succeeded — a
  partial tick is a failed tick. Its daily 04:30 UTC schedule is unchanged.
- **Discard and prune now write `broadcast_image_removed` audit rows** (one per stamped image, in
  the same transaction as the delete). The draft's own lifecycle stays unaudited.
- **The erasure cascade takes a REQUIRED `imagesRepo` port** and the completion attestation gains
  an `images_marked` field. An erasure certified before this merge did not reach the member's
  uploaded photograph; one certified after does.
- **`broadcast_cross_member_probe` audit payloads carry `operation`** (a bounded literal union —
  `image_upload` is the value the new upload surfaces emit), so a probe row now says which
  surface refused it. Optional, because the pre-F119 emit sites omit it.
- **`proxy-submit` accepts `draftId`**, and three routes are new:
  `POST /api/broadcasts/templates/[id]/started`, `POST | PUT /api/admin/broadcasts/draft` and
  `GET /api/admin/broadcasts/quota`.
- **Brand chrome is read LIVE on every dispatch** (fail-soft, counted by
  `broadcasts_brand_chrome_unavailable_total`), so the footer and header of every send depend on
  the settings row from merge onward — before any operator visits the Brand page.
- **The staff detail page `/admin/broadcasts/[id]` renders the DELIVERED document** (ROUND-3 #2) —
  design blocks and brand, in a sandboxed `<iframe srcdoc>`, instead of the raw sanitised body.
  An approver who has been reading this page will see it change shape on merge.

#### T155 / T156 record — 2026-09-22

The two gate rows above ("the PR-1 FR-051 pass" and "the live-look items") are the ones this block
answers. Walked on `450bbd459` against the maintainer's dev server on :3100 — code read **plus**
the running page, at 320 / 375 / 768 / 1440 px in EN, SV and TH, signed in as `e2e-admin`.
**Nothing here was fixed; every finding is OPEN.** The two approval screens take the same walk in
PR-2 under T086a.

**What could NOT be verified, and why.** The `E2E_MEMBER_EMAIL_EMPTY` persona is rejected at
`/portal/sign-in` with "Email or password is incorrect" against the `dev` Neon branch — the account
is not signable-in there today, so the three member-portal surfaces (`/portal/broadcasts/new`,
`/portal/benefits?tab=broadcasts`, the body view of `/portal/broadcasts/[id]`) were walked **from
code only**. Their live half is still OWED and must be run before the flag-flip; re-seed via
`scripts/seed-e2e-portal-invoices.ts` first. The three toolbar/preview measurements below were taken
on `/admin/broadcasts/new`, which mounts the **same** `TiptapToolbar` and `PreviewPane`, so the
numbers carry over; the portal shell's own page padding does not, and is unmeasured.

##### § 15 walk — PASS / FAIL / N/A per screen

Screens: **PC** portal compose · **PB** portal benefits E-Blast tab · **PD** portal detail body view ·
**SQ** staff queue · **SC** staff compose-on-behalf · **TPL** template list/new/edit ·
**SET** E-Blast settings · **BR** Brand settings. `L` = live-verified, `c` = code-only.

| § 15 item | PC | PB | PD | SQ | SC | TPL | SET | BR |
|---|---|---|---|---|---|---|---|---|
| 320 × 568, no horizontal scroll | c PASS | c PASS | c PASS | **L FAIL** | L PASS | L PASS | L PASS | L PASS |
| 1920 × 1080, no ugly stretch | c PASS | c PASS | c PASS | L PASS | L PASS | L PASS | L PASS | L PASS |
| axe WCAG 2.1 AA | T139 | T139 | T139 | T139 | T139 | T139 | T139 | T139 |
| EN + TH + SV on every string | PASS | PASS | PASS | PASS | PASS | PASS | PASS¹ | PASS |
| Shimmer skeleton on first load | **FAIL** | **FAIL** | **FAIL** | **FAIL** | **FAIL** | **FAIL** | PASS | **FAIL** |
| Empty state designed | N/A | PASS | PASS | PASS² | N/A | PASS | N/A | PASS |
| Error states (field / form / page) | PART | PART | PART | PASS | PASS³ | PASS | PASS | PASS |
| Toast on success | PASS | N/A | PASS | PASS | PASS | PASS | PASS | PASS |
| Confirmation dialog on destructive | PASS | N/A | PASS | PASS | PASS | N/A⁴ | PASS | N/A |
| Auto-focus on the primary input | **FAIL** | N/A | N/A | N/A | **FAIL** | **FAIL** | FAIL | FAIL |
| Enter submits the form | **FAIL** | N/A | N/A | N/A | **FAIL** | PASS | PASS | **FAIL** |
| Escape closes modal / popover | L PASS | PASS | PASS | L PASS | L PASS | PASS | PASS | N/A |
| Focus-visible ring on every control | PASS | PASS | PASS | **PART** | PASS | PASS | PASS | PASS |
| Dark mode renders correctly | PART⁵ | PASS | PASS | PASS | PART⁵ | PASS | PASS | **L PART** |
| SR: landmarks, errors, navigable | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PART |
| `prefers-reduced-motion` honoured | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Session user menu on the shell | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Idle-warning modal | N/A | N/A | N/A | PASS | PASS | PASS | PASS | PASS |

¹ parity is green (`check:i18n`: 5618 keys × 3) but an unmapped server error code prints a raw key
path — see U8. ² works, but hand-rolled rather than the shared `EmptyState` (U12). ³ inherits the
**queue's** error boundary, wrong tier and wrong title (U10). ⁴ no delete UI exists at all (U13).
⁵ one `bg-white`, on the preview `<iframe>` — judged below.

**`prefers-reduced-motion` is the one item that is clean everywhere**: no raw `animate-pulse` /
`animate-spin` anywhere in `src/components/broadcast/**` or either route tree, every spinner is
`motion-safe:`, and `globals.css` neutralises the rest as a second layer. Do not regress it.

**`finalFocus` roll-call** (the repo rule, `resolve-dialog-final-focus.ts`). Ten of twelve pass:
`approve-dialog`, `reject-dialog`, `bulk-approve-confirm-dialog` (all via `useDialogFinalFocus`),
`preview-dialog`, `link-dialog`, `cta-button-dialog`, `image-alt-dialog`, `cancel-broadcast-dialog`.
Two do **not**, and both are the exact failure the helper was written for — the trigger unmounts on
success: **`clear-halt-dialog.tsx:97`** and **`admin-image-allowlist-editor.tsx:208`** (U3, U4).
`compose/template-picker-field.tsx:107` omits it legitimately: its `<Select>` trigger survives.

**The preview iframe's `bg-white` inside a dark shell is the RIGHT call, and should stay.** The
frame shows the delivered email, and every mail client composites that document on a white canvas;
theming it to `bg-card` would make the operator approve something nobody receives. It is content,
not chrome, and § theming's "semantic tokens only" does not reach inside a `sandbox=""` document
preview. Two conditions: it must be **written down** as an exception (today it is an undocumented
literal at `use-preview-html.tsx:251`), and the same reasoning does **not** automatically cover the
brand logo swatch — see U16.

##### T156 — the five live-look items, measured

**1. Toolbar rows at 320 px.** Measured on `/admin/broadcasts/new`, `data-toolbar-control` grouped
by `getBoundingClientRect().top`. Buttons are 44 × 44 px.

| viewport | EN | SV | TH |
|---|---|---|---|
| **320 px** (editor column **207 px**) | 13 controls, **4 rows** — 4 / 4 / 4 / **1** | identical to EN | 12 controls, **3 rows** — 4 / 4 / 4 |
| **375 px** (262 px) | 13, 3 rows — 5 / 5 / 3 | identical | 12, 3 rows — 5 / 5 / 2 |
| **768 px** (607 px) | 13, **2 rows** — 12 / **1** | identical | 12, **1 row** |

**Nothing clips at any width in any locale** — `scrollWidth === clientWidth` on the toolbar and no
page-level horizontal scroll on this surface. The strip is icon-only, so **SV and EN are
byte-identical**; only TH differs, and only because FR-044 drops the italic control, which is also
why TH is the one locale that never orphans a row. The wrap decision (no overflow menu) holds.

Two things the numbers say that the code does not. First, at a 320 px viewport the editor column is
only **207 px** — the page container and the card each take 24 px a side, so 96 px of the 305 px
usable width is padding before the toolbar starts. That is what forces a 4th row. Second, EN and SV
leave **exactly one orphan control** on the last row at both 320 and 768 px (`banner`), which reads
as a mis-wrap rather than a deliberate grouping. Neither is a defect; both are the measured cost the
gate row asked for, and the honest fix is a tighter gap or a 40 px control at `<sm`, not a menu.

**2. Layout shift as the preview settles.** MutationObserver on the pane's frame box,
`/admin/broadcasts/new` at 1440 px, empty → typed → settled:

| state | frame box | section | document height |
|---|---|---|---|
| empty | 420 px | 467 px | 1347 px |
| loading (skeleton) | 420 px | 467 px | 1347 px |
| ready (iframe) | **436 px** | **483 px** | 1347 px |

**empty → loading shifts nothing** — the reservation works, which is the thing the fixed frame was
built for. But **ready is 16 px taller than the reservation**, every time. `preview-pane.tsx:75`
puts `py-2` on the same box that carries `minHeight: PREVIEW_PANE_FRAME_HEIGHT`; with border-box
sizing the 420 px reservation *includes* those 16 px, while the ready state is a 420 px iframe
*plus* them. CLS measured **0.000** and document height never moves, because at ≥ lg the taller
left column drives the grid row and at < lg the pane is last in DOM order — so today the shift is
contained by luck of ordering, not by the construction. Recorded as U7: the moment anything renders
after the pane, the 16 px becomes visible movement. `/portal/broadcasts/[id]` does **not** inherit
it — that page passes `DETAIL_PREVIEW_FRAME_HEIGHT` straight to `PreviewSurface` with no padded
wrapper — but it has a far larger skeleton problem instead (U1).

**3. Preview empty-state first paint.** On a cold load, before a keystroke, the pane paints
**"Your message preview appears here."** — the translated `broadcast.editor.preview.empty` line,
inside a box already reserving its full 420 px. **Never a blank box. PASS**, US3-AS6 satisfied.

**4. NVDA.** *No screen reader was run — this pass is OWED to the maintainer and is not discharged
by what follows.* The accessibility-tree substitute, read live in TH:

- container: `role="toolbar"`, `aria-label="แถบเครื่องมือจัดรูปแบบ"` (translated, not a raw key) — **PASS**
- exactly **one** tab stop: `tabindex=0` on the active control, `-1` on the other eleven — **PASS**
- every control is a real `<button>` with a translated `aria-label`; no icon-only unlabelled control — **PASS**
- the eight toggles carry `aria-pressed`; the one-shot insert (`divider`) and the four dialog
  openers correctly omit it rather than reporting a false `false` — **PASS**
- `aria-haspopup="dialog"` on `link` / `image` / `cta` / `banner` — **PASS**
- `image` and `banner` when no draft is saved: `aria-disabled="true"`, still focusable — **PASS** —
  but the *reason* reaches AT only through a `title` attribute (U6)
- unhandled: `ArrowUp` / `ArrowDown` and `aria-orientation`, on a strip that is demonstrably 3–4
  rows tall at phone width (U15)

**5. SV lengths of the stage chips.** **T120's five stage chips do not exist yet — they are PR-2.**
What `queue-filters.tsx` renders today is the eight `OFFERED_BROADCAST_STATUSES`, derived, matching
the skeleton's reservation. Measured in SV at 1440 px (44 px tall, `min-h-[44px]`):

| chip | SV | px | chars |
|---|---|---|---|
| submitted | Inväntar granskning | **157** | 19 |
| approved | Godkänd | 97 | 7 |
| sending | Skickar | 89 | 7 |
| draft | Utkast | 84 | 6 |
| sent | Skickad | 92 | 7 |
| rejected | Avvisad | 91 | 7 |
| cancelled | Avbruten | 98 | 8 |
| failed_to_dispatch | Misslyckades | 122 | 12 |

Strip total **830 px**; widest chip **157 px**, which at a 305 px usable 320 px viewport is 51 % of
the row and wraps the strip to **5 rows**. The headroom for PR-2 is therefore thin: five more chips
at the SV average of ~104 px add ~520 px, taking the strip past 1350 px and past 8 rows at 320 px.
**This item re-runs in PR-2 under T086a**, against T120's labels, and T086a should treat 157 px as
the budget a new SV stage label must not exceed.

##### Defects found — all OPEN, nothing was fixed

Severity is against the FR-051 gate: **HIGH** blocks the flip, **MEDIUM** is a follow-up, **LOW** is
polish. Paths are repo-relative.

**HIGH**

- **U1 — `/portal/broadcasts/[id]` skeleton is missing an entire card; ~640 px of CLS on every
  load.** `src/app/(member)/portal/broadcasts/[id]/loading.tsx:36-64` draws two cards (fields,
  delivery). `page.tsx:293-308` renders **three** — T141's content card, with a 560 px preview
  frame, is inserted **between** them. The delivery card jumps ~640 px down on settle. The skeleton
  was not updated when T141 landed. This is the single largest layout shift in the feature.
- **U2 — the staff queue has horizontal scroll at 320 px, in all three locales.** Measured:
  `scrollWidth` 565 vs `clientWidth` 305 in **SV (+260 px)**, 477 in **EN (+172 px)**, 337 in
  **TH (+32 px)**. Culprit `src/app/(staff)/admin/broadcasts/page.tsx:331` — a hand-rolled
  `<div className="flex items-center gap-2">` holding two `buttonVariants()` links, and
  `buttonVariants` bakes in `whitespace-nowrap`; no `flex-wrap`, no `flex-col`. `PageHeader` already
  solves this with its `actions` prop and `templates/page.tsx:78-86` uses it correctly — this
  surface bypasses it. **This is § 15 item 1, the first line of the checklist, and the axe suite
  T139 cannot see it: axe has no horizontal-scroll rule.** It is the clearest argument for why T155
  exists beside T139.
- **U3 — `ClearHaltDialog` drops focus to `<body>`.** `src/components/broadcast/admin/clear-halt-dialog.tsx:97`
  has no `finalFocus`; on success `router.refresh()` un-halts the member and
  `halt-state-banner.tsx:86-90` unmounts the trigger.
- **U4 — allowlist Remove confirm drops focus to `<body>`.**
  `src/components/broadcast/admin-image-allowlist-editor.tsx:208` — same class; the row unmounts at
  `:76`. Removing several hostnames means re-Tabbing from the top each time.
- **U5 — italic on Thai, in this feature's own admin chrome.**
  `src/components/broadcast/admin/halt-state-banner.tsx:96` — `className="text-xs italic …"` over a
  TH string. Thai has no italic form and the browser synthesises a slant. FR-044 makes this feature
  drop the italic *control* under `th`; the same feature then slants Thai itself two files away.
- **U6 — the disabled image/banner controls explain themselves only through `title`.**
  `src/components/broadcast/tiptap-toolbar.tsx:352` — `title` is hover-only (no touch, no keyboard)
  and is not a reliable description when an `aria-label` is already present. The visible sentence
  "Save this draft first to enable image uploads." is on the page but is not associated; it wants
  `aria-describedby`. Same class as F7.1a's unimplemented touch tooltip — second recurrence.
- **U19 — no `<form>` on three compose/settings surfaces, so Enter never submits.**
  `compose-form.tsx:484`, `proxy-compose-form.tsx:495` and `brand/brand-settings-form.tsx:159` are
  all `<div>` roots with `type="button"` save buttons. Defensible on a rich-text surface; **not**
  defensible on Brand settings, which is two plain fields and a Save. § 15 item 11.

**MEDIUM**

- **U7 — the preview frame's 420 px reservation is 16 px short of its ready height.**
  `src/components/broadcast/preview-pane.tsx:75` — `py-2` and `minHeight` on the same border-box.
  Contained today only by DOM ordering; see item 2 above.
- **U8 — three dead `try/catch` around `t()` can print a raw key path to the user.**
  `src/components/broadcast/admin/template-form.tsx:155-169`,
  `src/components/broadcast/compose-form.tsx:449-455`,
  `src/components/broadcast/compose-inline-image-uploader.tsx:118-122`, plus a no-fallback variant
  at `admin-image-allowlist-editor.tsx:71-72`. next-intl **does not throw** on a missing key — it
  returns the key path — so the `catch` is unreachable and an unmapped server code renders
  `admin.broadcasts.templates.errors.<code>` verbatim into a `role="alert"` and a toast. The repo
  already knows this: `compose-form.tsx:399-401` says so in a comment. The correct form is `t.has()`,
  as `benefits/_components/broadcasts-panel.tsx:332` uses.
- **U9 — the queue is capped at 50 rows with no reachable pagination.**
  `src/app/(staff)/admin/broadcasts/page.tsx:156` `pageSize: 50`, `:161` reads a `cursor` param —
  and **no component ever emits one**; the only reference is `queue-filters.tsx:168`, which deletes
  it. Rows 51+ are reachable only by hand-editing the URL. Worse, the truncation note (`:371`) is
  gated on `isDefaultView` (`:316`), so a *filtered* view that truncates says nothing at all.
- **U10 — `/admin/broadcasts/new` has no `error.tsx`** and inherits the queue's
  (`src/app/(staff)/admin/broadcasts/error.tsx:30`), which renders `TableContainer` and the title
  "E-Blast review queue" for a compose failure — wrong container tier and a title naming another page.
- **U11 — `/portal/broadcasts/new/error.tsx:24` uses `FormContainer` (42 rem)** while `page.tsx:282`
  and `loading.tsx:26` use `DetailContainer` (72 rem) — a guaranteed width jump on error, and
  `loading.tsx:17` carries a comment asserting the three match.
- **U12 — skeleton drift, six files.** Beyond U1: `/portal/broadcasts/new/loading.tsx` under-reserves
  the quota card by ~110 px (`:34-40` vs the real 4-counter grid) and the toolbar by ~50–110 px
  (`:75` `h-9` vs an 11–13 control wrap); `/admin/broadcasts/loading.tsx` reserves a **desktop
  table** with no `hidden md:block` while the real surface below `md` is `QueueCardList`, and
  reserves nothing for the four banners that can render; `/admin/broadcasts/new/loading.tsx:20-42`
  reserves one full-width card against a real two-column grid; `templates/loading.tsx:26` draws a
  button row the page does not have and omits the filter pills; `settings/broadcasts/brand/loading.tsx`
  omits the two lines that render precisely in the *first-visit* state (`colour.defaultHint`,
  `address.missing`). Several of these files carry docblocks claiming the layout matches.
- **U13 — templates ship no delete/archive UI at all** (`templates/page.tsx:5-7`); the route exists.
  § 15 item 9 is N/A only because the action is absent.
- **U14 — status filter chips have no pill-level focus ring.**
  `src/components/broadcast/admin/queue-filters.tsx:272,294` — the 44 px `<label>` carries
  `has-[:checked]:` styling but no `has-[:focus-visible]:`; the ring lands on the 16 px checkbox,
  one-seventh the target.
- **U16 — `bg-white` on the brand logo preview, undocumented, and a glare patch in dark mode.**
  `src/components/broadcast/brand/brand-settings-form.tsx:293`. Measured in dark mode: a 91 × 64 px
  `rgb(255,255,255)` box on a `lab(7.8 …)` card. The intent (a transparent PNG needs a white backing
  to be judged as the recipient sees it) is legitimate and is the **same** argument that justifies
  the preview iframe — but unlike the iframe it is a small chrome-scale patch, and neither is
  written down. Give both one shared `--email-canvas` token and a comment, or accept both explicitly
  in `docs/ux-standards.md`.
- **U17 — Brand Save disables below AA with nothing linking the reason to the button.**
  `brand-settings-form.tsx:103` → `:311`; the contrast readout is ~200 px away in another card with
  no `aria-describedby`. A keyboard user hears "Save, dimmed" and nothing else (WCAG 3.3.2).
- **U18 — Brand has no unsaved-changes guard** while both compose surfaces ship
  `useComposeDirtyGuard` — verified live: leaving compose fires `beforeunload`, leaving Brand does not.

**LOW**

- **U15 — the toolbar handles no `ArrowUp`/`ArrowDown` and sets no `aria-orientation`**
  (`tiptap-toolbar.tsx:303-326`, `:336`) on a strip measured at 3–4 rows below `sm`.
- **U20 — `QuotaDisplay` is inserted above the whole proxy form on member selection**
  (`proxy-compose-form.tsx:502-507`), pushing ~180 px of form down out from under the cursor.
- **U21 — the two destructive confirms disagree on styling**: `clear-halt-dialog.tsx:132` uses the
  default `AlertDialogAction` variant, `admin-image-allowlist-editor.tsx:224` passes
  `variant="destructive"`. (Clear-halt has the stronger *gate* — a normalised typed-match.)
- **U22 — queue empty state and the allowlist table each bypass a shared primitive**
  (`queue-table.tsx:76-87` vs `shell/empty-state.tsx`; `admin-image-allowlist-editor.tsx:142` vs
  `ui/table.tsx`) — design-system drift the templates surface was migrated away from in T147.
- **U23 — `/portal/broadcasts/[id]/not-found.tsx:44` and `:47` print the same string twice**,
  heading and body, against § 3.1 empty-state anatomy and § 14.
- **U24 — preview `error` is a dead end** (`use-preview-html.tsx:231-239`): no retry, and the hook
  only refetches when the body changes, so a transient 500 leaves the pane broken until the member
  types. The 429 `paused` state self-heals; `error` does not. `recipient-count.tsx:232` and
  `quota-display.tsx:144` both offer Retry.
- **U25 — a client quota refetch can erase correct server-rendered numbers**
  (`quota-display.tsx:73-117` fetches on mount and `setSnap(null)` on any non-2xx, discarding the
  `initial` prop `broadcasts-panel.tsx:285` passed it).
- **U26 — raw JS error text toasted untranslated** (`compose-form.tsx:415-417`): a network failure
  surfaces "Failed to fetch" in EN on a TH or SV interface.

##### Status after F3 — 2026-09-22

**CLOSED** (fix + test in the same change, each test RED before the fix): **U1** (the skeleton
renders the third card and reserves `DETAIL_PREVIEW_FRAME_HEIGHT`, now a shared constant in
`src/components/broadcast/preview-frame-heights.ts`) · **U2** (the queue header goes through
`PageHeader`'s `actions` slot; the e2e case is WRITTEN but **NOT RUN** — no dev server was
available and this session does not start one, so the 320 px measurement is still OWED) · **U3**
· **U4** (both via the new `useSurvivingTargetFinalFocus`; the survivors are the banner heading and
the allowlist table) · **U5** (+ a source scan with a positive control, `no-italic-thai.test.ts`)
· **U6** · **U7** · **U8** (all four sites, `t.has()`) · **U10** · **U11** · **U16** · **U17** ·
**U18** · **U19** (Brand only — the two compose surfaces keep their `<div>` roots).

Also closed here, from the security round rather than § 15: `createBroadcastTemplate` and
`updateBroadcastTemplate` now run `validateBlocks(parseBlockMarkers(sanitised))` above the first
write and both template routes answer through `designBlockErrorResponse`, so
`broadcasts-route-helpers.ts:99`'s "refused 422 at every save" is literally true. Four
design-block keys added to `admin.broadcasts.templates.errors` in EN + TH + SV.

**STILL OPEN**, unchanged and deliberately not touched: **U9** (queue pagination) · **U12**
(skeleton drift on the six files outside this record's PR-1 screens) · **U13** (no template
delete UI) · **U14** (chip focus ring) · **U15** (toolbar Arrow Up/Down + `aria-orientation`) ·
**U20**–**U26**.

Two measurement debts remain from the record above and are NOT discharged by this round: the three
member-portal surfaces were walked from code only (the `E2E_MEMBER_EMAIL_EMPTY` persona does not
sign in on the `dev` branch), and no screen reader was run.

##### Portal live walk — 2026-09-22 (closes the OWED item)

This block discharges the **first** of those two debts. The three member-portal surfaces —
`/portal/broadcasts/new` (**PC**), `/portal/benefits?tab=broadcasts` (**PB**) and
`/portal/broadcasts/[id]` (**PD**) — were walked against the maintainer's running dev server on
:3100 at 320 / 375 / 768 / 1440 / 1920 px in EN, SV and TH, light and dark, signed in as
`e2e-member-empty@swecham.test`. **Nothing was fixed; every finding below is OPEN.**

**The persona DOES sign in — the earlier claim was a wrong password, not a missing account.**
`.env.local` gives each persona its own secret: the empty member is `E2E_MEMBER_EMAIL_EMPTY` +
**`E2E_MEMBER_PASSWORD_EMPTY`**. The pass above used `E2E_ADMIN_PASSWORD`, was told "Email or
password is incorrect", and recorded that as "the account is not signable-in on the `dev` branch".
It is signable-in, no re-seed was needed, and `scripts/seed-e2e-portal-invoices.ts` was not run.
Anything downstream that treats this persona as unavailable — including the a11y-e2e caveat in the
next block — should be read against that correction.

**Tooling note, so the next walk does not lose an hour to it.** Chrome could not be driven here:
`resize_window` reports success and changes nothing while the window is maximised, and the
same-origin iframe fallback is refused because the app sends `frame-ancestors`, so the framed
document comes back cross-origin and every measurement throws `SecurityError`. The walk was done
through the Playwright MCP tools, whose `setViewportSize` is exact. The colour maths needed a
**positive control**: this repo's computed colours are `lab()` / `oklch()`, a naive `rgb()` regex
parses none of them, and the first contrast sweep returned a clean "0 low-contrast nodes" purely
because it had resolved nothing. Every scan below re-resolves colour through a 1×1 canvas and
asserts `lab(50 0 0) → rgb(119,119,119)` before it reports.

###### § 15 walk — the three portal screens, now live

`L` = live-verified this round · `c` = still code-only · carried rows keep the earlier verdict.

| § 15 item | PC | PB | PD |
|---|---|---|---|
| 320 × 568, no horizontal scroll | **L PASS** | **L PASS** | **L PASS** |
| 1920 × 1080, no ugly stretch | **L PASS**¹ | **L PASS**¹ | c PASS¹ |
| axe WCAG 2.1 AA | T139 | T139 | T139 |
| EN + TH + SV on every string | L PASS² | L PASS² | **L PASS** |
| Shimmer skeleton on first load | FAIL³ | FAIL³ | **L PASS** |
| Empty state designed | N/A | c PASS⁴ | PASS |
| Error states (field / form / page) | **L FAIL** | c PART | c PART |
| Toast on success | c PASS⁵ | N/A | c PASS |
| Confirmation dialog on destructive | c PASS | N/A | **L PASS**⁶ |
| Auto-focus on the primary input | **L FAIL** | N/A | N/A |
| Enter submits the form | **L FAIL**⁷ | N/A | N/A |
| Escape closes modal / popover | L PASS | PASS | **L PASS** |
| Focus-visible ring on every control | L PASS | **L PASS**⁸ | L PASS |
| Dark mode renders correctly | **L PASS** | **L PASS** | **L PASS** |
| SR: landmarks, errors, navigable | **L PART** | **L PART** | **L PASS** |
| `prefers-reduced-motion` honoured | c PASS | c PASS | c PASS |
| Session user menu on the shell | L PASS | L PASS | L PASS |
| Idle-warning modal | N/A | N/A | N/A |

¹ the layout container caps at **1152 px**, so nothing stretches; PD was measured at 1440 and 320,
not at 1920. ² parity is green and no raw key path rendered on any of the three, in any locale —
but the Thai quota card prints two calendars, U30. ³ unchanged: this is **U12** skeleton drift on
`/portal/broadcasts/new/loading.tsx`, which is still on the STILL OPEN list; the page-level skeleton
was not re-caught live. ⁴ not reachable with this persona — it has one broadcast, so the table
renders. ⁵ only the *error* toast was exercised (U28); the success path was not, because the
persona's 2026 quota is fully reserved. ⁶ `role="alertdialog"`, labelled + described, initial focus
on the **safe** button, ESC closes, focus returns to the trigger — all four verified; see U35 for
the one caveat. ⁷ **U19 stands** — there is no `<form>` in `main` on PC, by the earlier round's
deliberate choice for a rich-text surface. ⁸ the history table's scroll wrapper is
`tabindex="0"` + `role="region"` + `aria-label` + a focus ring, so the shared `TableContainer`
primitive does the right thing here.

**Dark mode is now clean on all three, which upgrades the earlier `PART⁵`.** A full-page sweep for
opaque near-white boxes ≥ 24 × 16 px returns **exactly one** element per surface — the preview
`<iframe>` itself, the documented exception. No chrome-scale white patch anywhere. The
`.skip-to-content` bar reads as white in dark mode and was checked before being reported: it is
`background: var(--foreground); color: var(--background)` at `globals.css:634-635`, a deliberate
token-driven inversion that flips with the theme. **Not a defect — do not "fix" it.**

**Contrast, measured, all three surfaces × both themes: zero failures.** `muted-foreground` is
**5.66:1** light and **7.66:1** dark; the 12 px destructive quota line is **6.69:1**; the quota
progress fill against its track is **6.14:1** (SC 1.4.11 needs 3:1). **Zero** interactive elements
anywhere on the three surfaces use `muted-foreground` as their only signal. **No italic on Thai** on
any of the three, in any state.

###### The toolbar row count in the PORTAL shell — the specific gap this walk was called for

Measured on `/portal/broadcasts/new` (not `/admin`), `data-toolbar-control` grouped by
`getBoundingClientRect().top`. Buttons are 44 × 44 px at every width.

| viewport | editor column | EN | SV | TH |
|---|---|---|---|---|
| **320 px** (305 usable) | **207 px** | 13 controls, **4 rows** — 4 / 4 / 4 / **1** | identical to EN | 12, **3 rows** — 4 / 4 / 4 |
| **375 px** (360) | **262 px** | 13, 3 rows — 5 / 5 / 3 | identical | 12, 3 rows — 5 / 5 / 2 |
| **768 px** (753) | **655 px** | 13, **1 row** | identical | 12, **1 row** |
| **1920 px** (capped 1152) | **430 px** | 13, **2 rows** — 8 / **5** | — | 12, 2 rows — 8 / 4 |

**Nothing clips at any width in any locale** — `scrollWidth === clientWidth` on the toolbar every
time — and **page-level horizontal scroll is 0** at 320, 375 and 768 in all three locales.

**The carry-over was right at two widths out of three, and wrong at the third.** At 320 and 375 the
portal reproduces the admin numbers *exactly* — 207 px and 262 px editor column, the same 4 / 4 / 4
/ 1 wrap, the same lone `banner` orphan, the same TH-drops-italic 3-row shape. At **768 px the two
shells diverge**: admin gives the editor **607 px** and needs **2 rows (12 / 1)**, the portal gives
it **655 px** and the whole strip fits in **one row**. The portal is the better surface at tablet
width, and the earlier record's "the numbers carry over, the portal shell's padding is unmeasured"
is now settled: they carry at phone widths, they do not at 768.

**The row count is worst at the WIDEST viewport, which nothing predicted.** From 1152 px up the
layout container stops growing while the preview pane keeps its share, so the editor column freezes
at **430 px** — narrower than it is at a 768 px viewport — and the strip wraps back to **2 rows**.
A member on a 1920 px monitor sees more toolbar rows than one on an iPad. Recorded as U33.

###### The preview pane settles with zero movement — U7 is closed on this surface

MutationObserver on the pane, `/portal/broadcasts/new` at 1440 px, cold load → typed → settled:

| state | reserving box | padded outer | section | document height |
|---|---|---|---|---|
| empty (`Your message preview appears here.`) | **420 px** | 436 px | 483 px | 1723 px |
| loading (shimmer, `Loading preview…`) | **420 px** | 436 px | 483 px | 1723 px |
| ready (`<iframe>`) | **420 px** | 436 px | 483 px | 1723 px |

**Every number is identical across all three states.** F3's fix — moving `py-2` to an outer box at
`preview-pane.tsx:86` so the 420 px reservation and the 16 px padding are no longer the same
border-box — holds: the ready frame no longer exceeds the reservation, and nothing below the pane
can move regardless of DOM order. The 436 → 436 → 436 outer is the proof the padding is now outside
the reserving box rather than inside it.

**Empty-state first paint: PASS, and verified one layer deeper than a screenshot.** The
server-rendered HTML for a cold `/portal/broadcasts/new` already contains the translated line
*"Your message preview appears here."*, the `preview-pane-frame-reservation` node and its
`min-height:420px`, and **no** raw `broadcast.editor.preview.empty` key path. The first paint, before
a byte of JS runs, is the translated sentence inside the full-height box. **Never a blank box.**
US3-AS6 satisfied.

###### The detail page's three-card skeleton matches the settled page — U1 is closed

Captured across a client-side navigation from PB into PD (which is what renders `loading.tsx`), at
1440 px:

| card | skeleton — height / top | settled — height / top |
|---|---|---|
| fields | 208 / 396 | 204 / 396 |
| content (560 px preview frame) | 644 / 628 | 646 / 624 |
| **delivery breakdown** | 192 / **1296** | 203 / **1294** |
| document height | 1512 | 1581 |

**Three cards reserved, three cards rendered.** The delivery card's top moves **2 px** on settle,
against the ~640 px jump this record opened with. Document height grows 69 px, all of it below the
last card. `DETAIL_PREVIEW_FRAME_HEIGHT` is shared between `loading.tsx:70` and `page.tsx:256`, and
it shows.

The rest of PD checks out live: the body renders in `<iframe title="Email preview" sandbox=""
srcdoc=… loading="lazy">` — `sandbox=""` is the maximally restrictive form, no `allow-*` token — and
in TH the title is translated (`ตัวอย่างอีเมล`). The subject is a real `<h2>` inside
`data-slot="card-header"`, not a styled `<div>`. Dates render BE (`22 ก.ย. 2569 20:57`). No page
horizontal scroll at 320 px, where the shell's fixed bottom tab bar (53 px) is cleared by `main`'s
`pb-[calc(var(--bottom-tab-height)…)]` = 56 px — the overlap visible in a full-page screenshot is a
stitching artefact of `position: fixed`, not a real collision.

###### Defects found this round — U27–U37, all OPEN, nothing was fixed

Severity is against the FR-051 gate, as above: **HIGH** blocks the flip, **MEDIUM** is a follow-up,
**LOW** is polish.

**HIGH**

- **U27 — the unsaved-changes guard misses the way members actually leave the page.**
  `src/components/broadcast/compose/use-compose-dirty-guard.ts:60` arms `useBeforeUnloadGuard` and
  nothing else, so the guard covers close / reload / external navigation and **not** an in-app
  `<Link>`. Verified both halves live: a `page.goto` away from a dirty form **was blocked** by the
  browser's own dialog, and clicking **Dashboard** in the member shell header with the same dirty
  body navigated instantly, silently, and lost the draft. The shell puts four header links directly
  above the form and five fixed bottom-tab links directly below it, so the unguarded path is the
  near one. This is US6-AS9 / FR-045, and the "compose has a dirty guard, Brand does not" framing in
  U18 obscured that what compose has only covers one of the two exits.
- **U28 — a validation refusal on `Save as draft` is reported to the member as an internal error.**
  Live: body typed, subject empty, `Save as draft` → `POST /api/broadcasts/draft` **400** →
  toast **"An unexpected error occurred. Please try again."** Retrying can never succeed. The chain:
  `src/app/api/broadcasts/draft/route.ts:69` and `:77` answer with code `invalid_body`;
  `portal.broadcasts.compose.errors` has **no `invalid_body` key in en, th or sv**; so
  `compose-form.tsx:453-454`'s `tErr.has(key)` is false and it falls to `internal_error`. The
  *correct* copy already exists and is unreachable — `broadcast_subject_empty` and
  `broadcast_subject_too_long` are present in all three locales but are only ever emitted by
  `src/app/api/broadcasts/submit/route.ts:223,251`, and the submit button is disabled in exactly the
  state that would produce them. Second layer: `onSaveDraft` never consults `ERROR_CODE_FIELD`
  (`compose-form.tsx:91-107`), so even the right code would not set `aria-invalid`, focus the field
  or render an inline message — measured `aria-invalid: null` on `#broadcast-subject` throughout.
  Note this is **not** a repeat of U8: `t.has()` is working correctly; the key it is asked about
  genuinely does not exist.

**MEDIUM**

- **U29 — `Submit for review` is disabled with nothing anywhere saying why.**
  `src/components/broadcast/submit-button.tsx:57-58` renders a hard `disabled` with no
  `aria-describedby` and no `title`; the verdict comes from `compose-form.tsx:278-279`. Measured with
  a body typed and the subject empty: the button is inert and the page produces **no** `role="alert"`,
  **no** `role="status"`, **no** toast and no mark on the subject field. A keyboard or SR member
  hears "Submit for review, button, dimmed" and has no route to the reason. WCAG 3.3.2 — and the
  **second recurrence of U17**, which was closed on Brand settings in F3 while this instance shipped
  untouched. The pattern to copy is two files away: `benefits/_components/broadcasts-panel.tsx:271`
  puts the reason on its own disabled Compose button and keeps it focusable with `aria-disabled`
  rather than `disabled`. (It puts the reason in the accessible *name* rather than a description,
  which passes SC 2.5.3 because the visible label is a prefix — `aria-describedby` would be the
  cleaner form for both.)
- **U30 — one Thai card prints the same quota year in two calendars, 544 years apart.**
  `quota-display.tsx:132`, `:133` and `:178`, plus `broadcasts-panel.tsx:271`, interpolate `{year}`
  as a **raw CE integer**, while `broadcasts-panel.tsx:164-166` formats `{date}` through
  `dateOnlyFormatter` and correctly yields BE. Measured live on PB in `th`: the line
  *"โควตา E-Blast ของปี **2026** ถูกใช้หมดแล้ว"* renders directly above
  *"รีเซ็ตโควตา 1 มกราคม **2570**"*, with the history table's ส่งเมื่อ column reading
  *"22 ก.ย. **2569**"* a few pixels lower — three calendars on one screen. The card header
  (`โควตา E-Blast (2026)`) and the disabled-button tooltip carry the CE year too. Same class as the
  F9 US2 audit-log dual-year finding. Storage is untouched and correct; this is display only.
- **U31 — the member's broadcast history `<table>` has no accessible name.** No `<caption>`, no
  `aria-label`, no `aria-labelledby`; only the wrapping `role="region"` is named "My broadcasts", so
  a SR user listing tables on the page finds an anonymous one. SC 1.3.1, and the same class as the
  F7.1a US1 missing-caption blocker. Cheap fix: a visually-hidden `<caption>` reusing the key the
  region already uses.
- **U32 — the preview header renders an empty `<h2>`-level heading on every cold load.**
  `src/components/broadcast/preview-pane.tsx:68-70` — `{subject.length > 0 ? subject : ' '}` puts a
  single space inside an `<h3>`, measured at `textContent.length === 1` and **0 px tall**. It is
  present before the first keystroke and returns whenever the subject is cleared. axe's
  `empty-heading` sits on the best-practice tag, so the AA-scoped T139 run cannot see it. Render the
  heading conditionally, or reserve the row with a non-heading element.

**LOW**

- **U33 — the toolbar wraps to 2 rows at ≥ 1152 px but fits in 1 row at 768 px.** The container caps
  at 1152 px while the preview pane keeps its column, freezing the editor at 430 px — see the table
  above. Not a defect in any checklist sense; recorded because it is the opposite of what a
  "responsive" reading of the earlier admin-only numbers would predict, and because it makes 768 px,
  not desktop, the width at which this toolbar looks designed.
- **U34 — the ClamAV health probe 404s forever, once on mount and then every 30 s.**
  `src/components/broadcast/clamav-unreachable-banner.tsx:34` polls
  `/api/internal/clamav/health`; **no such route exists under `src/app/api/`** — the component's own
  docblock says the endpoint is out of scope and `:42-44` deliberately treats 404 as "no signal", so
  the *UI* is correct and no false banner appears. The cost is that every open compose tab (member
  and staff) emits a console error every 30 s — measured 3 on first paint — which makes "zero console
  errors" useless as a smoke signal on this surface and buries anything real. Either ship the route
  or stop polling until it exists.
- **U35 — the cancel-broadcast confirm has no typed-match while its own copy says the act is
  final.** The dialog body reads "Once cancelled it cannot be re-sent" / *"เมื่อยกเลิกแล้วจะไม่สามารถส่งซ้ำได้"*.
  Everything else about it is right (see footnote ⁶). The inconsistency is that
  `clear-halt-dialog.tsx:132` gates a *less* final, staff-side action behind a normalised typed-match
  while the member's irreversible one is a single click. Pick one rule.
- **U36 — the marketing-consent banner puts an `<h2>` above the page `<h1>` and owns the first three
  tab stops**, on all three surfaces walked here and on `/portal` besides. The outline reads
  h2 → h1 → h2 …, which axe permits (a level decrease is legal) but which no outline reader expects,
  and a keyboard member passes "Read the privacy policy / I acknowledge / Remind me later" before
  reaching the Subject field on every single visit until they acknowledge.
- **U37 — the member history table does not collapse to cards below `md`.** `min-w-[640px]` inside
  the shared `overflow-x-auto` container: at a 320 px viewport the table is **729 px** wide in a
  **209 px** box, so Status / Audience / Submitted / Sent are reachable only by swiping a nested
  region. § 15 item 1 still PASSES — there is no *page* scroll — and the region is named and
  keyboard-reachable, so this is a density decision rather than a violation. It is recorded because
  the **admin** queue has `QueueCardList` below `md` and the member surface, which is the one most
  likely to be read on a phone, does not.

###### Still not verifiable

- **NVDA — the screen-reader pass remains OWED to the maintainer and is NOT discharged by anything
  above.** What this round adds is only more accessibility-tree evidence (names, roles, live
  regions, focus order, `aria-disabled` on the PB compose button, focus return from the PD dialog).
  It is not a screen-reader run and must not be quoted as one.
- **axe was not run in this walk** — the § 15 `axe WCAG 2.1 AA` row still points at T139. U31 and
  U32 are the two findings most likely to move a future axe run, and U32 will not, because
  `empty-heading` is outside the AA tag set.
- **PD was not measured at 1920 px** (320 and 1440 only).
- Two dev-server artefacts, checked and deliberately **not** recorded as defects: the very first
  navigation to `/portal/benefits?tab=broadcasts` returned **HTTP 500** with an empty body and no
  error boundary, and did not reproduce on reload or on any of the six later visits (Turbopack cold
  compile); and one locale switch on that same route left the page in the previous locale until a
  hard reload, which also did not reproduce on a second attempt. Both are noted so a future walk
  that sees them once does not spend the afternoon on them — but if either becomes repeatable on a
  warm server, it is a real finding.

###### Status after U27–U32 — 2026-09-22

**CLOSED** (each test RED before the fix; no commits): **U27** (the unsaved-changes guard is now
`<UnsavedChangesGuard>` — `beforeunload` AND a capture-phase in-app `<a>` interception with a
confirmation dialog — rendered by member compose, staff compose-on-behalf and Brand settings) ·
**U28** (both draft routes answer `broadcast_subject_empty` / `broadcast_subject_too_long` /
`broadcast_body_too_large` instead of `invalid_body`, which now has a key in all three locales,
and the member form maps a draft refusal through `ERROR_CODE_FIELD`) · **U29** (a dimmed Submit
carries `aria-describedby`; on BOTH compose forms, because `compose-parity.test.tsx` refuses a
member-only feature) · **U30** (`formatCalendarYear` — every year on the quota surface now
renders in the locale’s own calendar; storage untouched) · **U31** (a visually-hidden
`<caption>`) · **U32** (the empty `<h3>` is not rendered).

**STILL OPEN**, untouched by that round: **U33** · **U34** · **U35** · **U36** · **U37** — and
the two measurement debts above (NVDA, and axe on these three screens) remain OWED.

##### a11y e2e — the command, the result, and what a green run does NOT prove

```bash
pnpm test:e2e tests/e2e/broadcasts/eblast-a11y.spec.ts --workers=1
```

`--workers=1` is mandatory (the default of 3 hangs the maintainer's workstation).

| date | result |
| --- | --- |
| 2026-09-18 | **29 passed / 1 documented skip** |
| 2026-09-22 | the **U2** case (queue header at 320 px) — the measurement OWED above — **passed** |
| 2026-09-22 (final tree `4b4a3f03f`, all three projects) | **26 passed / 1 documented skip / 6 failed — all six on `mobile-safari`, all staff screens, message `Captured 1 client-side pageerror(s); first: Type error`.** Re-run of exactly those cases with the fixture's NARROW opt-out `E2E_PAGEERROR_IGNORE_PATTERN=flushComponentPerformance` (the WebKit rendering of the Next.js 16 `next dev` component-performance profiler error — dev-only, stripped from prod builds; documented in `tests/e2e/fixtures.ts`): **7 passed**. A non-matching error would still have failed, so the six are the known dev-server artefact, not an application error. Re-check on the next Next.js upgrade; a prod build never emits it. |

**Read a green run with this caveat.** Several cases in this spec SELF-SKIP when an environment
variable is absent, and Playwright reports a skip as a non-failure:

- `E2E_MEMBER_EMAIL_EMPTY` — the member-portal persona (`e2e-member` is LAPSED by the F8 fixture,
  so the empty persona is the one these specs use). Unset ⇒ every member-portal case skips.
- `E2E_ADMIN_EMAIL` — the staff persona. Unset ⇒ every `/admin/broadcasts/**` case skips.

So "29 passed" is only 29 surfaces actually scanned **if both variables were set for that run**.
Before quoting a run as coverage, confirm the variables were present and read the skip count —
a missing variable is not a pass, it is a scan that never happened (`feedback: skip is not pass`).

### 3.2 PR-2 — the approval round, the dashboard and the trial (ships DARK)

**There is no PR-3.** The maintainer merged the former PR-3 (US4 dashboard + US7 trial) into PR-2 on
2026-09-18 (`plan.md` Amendment 8), so the stages, their labels, their metrics, the dashboard that
reports them, the runbook and the EN + TH UAT walkthrough all land in one PR — which is what makes
step 5's flip safe to take immediately after this merge.

1. Merge → prod auto-migrates **`0305`** on deploy (`vercel-build`); `0304` already applied with
   PR-1, so this deploy adds only the `0305` DDL. Run
   `pnpm db:verify:prod` and the `pg_proc` checks from § 0 against prod, read-only.
2. **Do not set `FEATURE_EBLAST_MEMBER_APPROVAL` yet.** Setting the env var is the deploy and the
   flip in one action.
3. Unflagged and live the moment PR-2 merges — none of the rollback layers in § 3.5 undoes these
   by a flag flip; each is **code-revert-only**, the same class as 108's Rollback-matrix row C and
   F114 § 3's "unflagged on merge" list:
   - the five `broadcast_status` values, the fourteen `audit_event_type` values (four landed with
     `0304` in PR-1, ten land here) and the five
     `notification_type` values (`ADD VALUE` is irreversible — not even a revert undoes these);
   - the two amended trigger functions (a reversal is a new migration);
   - `proposed_send_at` now recorded at submit for **every** E-Blast, and the backfill of rows
     currently in `submitted`;
   - the widened allowance bucket and cancel cascade — they read the same set, which currently
     contains no rows in the new stages, so behaviour is unchanged until the flag is on;
   - `stage_entered_at` stamped on every status change;
   - **T120's stage-vocabulary relabel**: `approved` reads **"Scheduled"** in **both** live
     namespaces — `admin.broadcasts.queue.status` and `portal.broadcasts.list.status` — so every
     staff and member reader sees the new word on merge, before any flag. Code-revert-only;
   - **T117's seven new queue columns** (Stage, Whose turn, Time in stage, Round, Proposed,
     Confirmed, Last activity) and the `ageBadge` re-based on `stage_entered_at` — the live queue
     changes shape for every staff user on merge. Code-revert-only;
   - **T141a's portal detail fields** (`stage`, `whoseTurn`, `round`, `proposedSendAt`,
     `confirmedSendAt`, `expiresAt`, and the "latest **sent** version while awaiting" body rule) on
     `GET /api/broadcasts/[id]` and `/portal/broadcasts/[id]` — members see the widened detail on
     merge. Code-revert-only.

   **Not on this list, deliberately: the staff "new submission" email.** `eblast_submitted_marketing`
   is enqueued from the moment PR-2 merges, but the outbox drainer **skips the five new
   notification types while the flag is off** (T152a, plan Amendment 7), so nothing is delivered
   until step 5. The rows wait and drain on the first tick after the flip — which is what makes
   FR-034's "behave as today" hold for an unflagged action.
4. **Update the record of processing (RoPA)** before the flag goes on — `docs/compliance/processing-records.md`.
   Spec § Personal data names what it must say, so the entry is not free-form:
   - the new purpose — "review and member sign-off of E-Blast content; accountable version history";
   - **the new fields, by name**: E-Blast **versions**, marketing **notes**, decision **reasons**,
     **decisions** (who decided, when), and staff/template **uploaded images**;
   - **the staff recipients** of hand-off emails — the tenant's `marketing`-role users, with the
     admins as the fallback when there is none (FR-021a);
   - the **chamber postal address** now stored in brand settings and printed in every E-Blast footer;
   - the new export category (`broadcast-versions.json`);
   - the erasure reach — versions, notes, reasons, decisions, images **and the notifications about
     the E-Blast** — with images unreferenced by any E-Blast or template deleted **on the next
     daily sweep tick, 200 rows per arm per tenant** (ROUND-3 #15 — "within 24 hours" is a ceiling
     nothing enforces, and the RoPA entry already states the batch bound);
   - the retention note that a **sent** outbox row keeps the recipient's address frozen at enqueue
     under the existing outbox retention.

   This is a **precondition** of step 5, not a follow-up.
4a. **Pre-merge gate, PR-2 (a)**: the FR-051 pass on the **three screens PR-2 builds or rebuilds** —
   `/admin/broadcasts/[id]` (new here), the **sign-off view** of `/portal/broadcasts/[id]`
   (rebuilt here), and the **staff queue** `/admin/broadcasts` with its filter bar, table,
   table-client and card list, which **T116–T120 rebuild** now that US4 ships in this PR
   (Amendment 8) — `docs/ux-standards.md` § 15 checklist **and** the `@a11y` axe scan at 320 px,
   zero serious or critical (task T086a). "Two" here predated the fold-in and disagreed with T086a
   and plan Amendment 4, which both name three (round 4 M3). Same gate PR-1 applied to its screens
   (plan Amendment 4); a screen takes the pass in every PR that changes it, and PR-1's queue pass
   was taken on the pre-rebuild shape.
4b. **Pre-merge gate, PR-2 (b) — the one that makes this a dark ship**: `FEATURE_EBLAST_MEMBER_APPROVAL`
   is read by the code before PR-2 merges. `tests/contract/broadcasts/eblast-flag-matrix.test.ts`
   (T149/T150) must be green in **both** states, and with the variable **absent** from the
   environment `POST /api/admin/broadcasts/[id]/version` must answer **404** (T152). The flag gate
   was originally scheduled in PR-3, which would have put the approval round live in prod for every
   `broadcasts.write` holder the moment PR-2 deployed — steps 2 and 5 below protect nothing if no
   code reads the variable, and hiding the button is not a gate (`/speckit.analyze` C1, plan
   Amendment 7). **Do not merge PR-2 without this.**
5. Set `FEATURE_EBLAST_MEMBER_APPROVAL=true` in Vercel only when ready to redeploy immediately and
   only after step 4 — and note that the dashboard (T116–T122), the five stage labels (T120), the
   runbook (T161) and the EN + TH UAT walkthrough (T153) are all in **this** PR, so the flip no
   longer lands in a window where marketing can start a round it cannot see, read or trial
   (round 3 M2). From that moment "Start formatted version" is offered on submitted E-Blasts —
   **including the ones already sitting in "Awaiting marketing review" when the flag went on**. They
   gain the new actions like any other row and nothing distinguishes them (spec § Feature flag);
   there is no migration, no backfill and no "legacy" marking.
6. **First-round observation**: run one real E-Blast through format → send → approve → confirm →
   sent. Confirm the marketing email arrived, the member email arrived in their language, the stage
   chips and the nav badge read correctly, and
   `SELECT subject = (SELECT subject FROM broadcast_versions WHERE id = b.approved_version_id)
    FROM broadcasts b WHERE b.broadcast_id = …` is `true`. Record it in `reviews/cutover.md`.

### 3.3 Brand settings (operator, any time after PR-1)

The page sits under the staff **Settings** area beside the existing E-Blast settings page, and is
**invisible** — nav entry, Settings-index card and page alike — to anyone without
`settings.broadcasts`, `marketing` included (FR-041b). On `/admin/settings/broadcasts/brand` (admin
or super-admin): set the chamber's primary colour (refused if white text on it is below WCAG AA
4.5:1; used in **email only**, never in the portal UI) and the postal address (**free text, up to
300 characters, line breaks allowed**). Until the address is set, the footer shows the chamber name
only and the page flags it missing. The logo is read-only here; changing it stays on
`/admin/settings/invoicing`, super-admin only, because it prints on issued tax documents — and where
a `marketing` user meets the "no logo on file" hint, the copy tells them to **ask an administrator**
rather than linking to a page they cannot open. Brand chrome is applied **live** at send time and in
every preview, so changing it never voids a pending or given approval (FR-041c).

### 3.4 Flag matrix

| | `FEATURE_F7_BROADCASTS` off | F7 on, `FEATURE_EBLAST_MEMBER_APPROVAL` off | both on |
|---|---|---|---|
| Every E-Blast route and page | 503 `feature_disabled` (proxy) | live | live |
| Writing tool, preview, design blocks, images, brand page, screen fixes | off with F7 | **live** | live |
| "Start formatted version" on a **newly submitted** E-Blast | off | **404 / hidden** — the one gated edge | offered |
| "Start next version" on a row in **Changes requested / Member approved / Scheduled** (round ≥ 1) | off | **available** — the gate is edge-wide, not route-wide, so an in-flight E-Blast stays completable (FR-034, round 3 H1) | available |
| Member approve / request changes / withdraw approval | off | **available for rows already in a new stage** (FR-034) | available |
| Confirm schedule | off | available | available |
| New stage chips on the queue | off | shown only if rows exist in them | shown |
| Nav waiting count | off | hidden unless rows exist | shown |
| Reminders / day-23 warning / day-30 expiry | off | run for rows already awaiting | run |
| The **five hand-off emails** (`eblast_*`) | off | **enqueued, not delivered** — the drainer skips these five `notification_type` values, so nothing reaches marketing or the member; rows wait and drain on the first tick after the flip (T152a, round 4 H2) | delivered |
| The **"new submission → marketing"** email specifically | off | **nobody is emailed on submit — exactly as today** (FR-034); the row is written from the moment PR-2 merges | marketing is emailed |
| Today's approve / reject flow | off | **byte-identical to before** (SC-006) | unchanged |
| Rows already in **Awaiting marketing review** when the flag is switched on | off | — | they **gain the new actions like any other row**; nothing distinguishes them (spec § Feature flag) |

### 3.5 Rollback matrix (FR-034)

| Layer | Action | In-flight rows | Time |
|---|---|---|---|
| 1 — platform flag off | remove `FEATURE_EBLAST_MEMBER_APPROVAL` in Vercel + redeploy | kept; no **new** E-Blast can enter the round; rows already in a new stage stay completable and cancellable, and the reminder/expiry clock keeps running so nothing sits forever. **Hand-off emails stop being delivered** — the drainer skips the five types again and the rows queue up, so a re-flip resumes them rather than losing them (round 4 H2) | one deploy |
| 2 — code revert of PR-2 | revert the PR | rows in a new stage become unreachable by the application until the code returns — **cancel them first** (`/admin/broadcasts` → Cancel), because the enum values and the triggers stay | one deploy |
| 3 — code revert of PR-1 | revert the PR | the wrapper returns to today's and the staff detail page returns to the raw-body view; brand columns and `broadcast_images` rows are orphaned but harmless. **What does NOT come back**: the pre-`sharp` upload path (already-uploaded images stay re-encoded — the originals were never stored), the image sweep (stamped rows stop being reclaimed and their bytes stay in Blob until the code returns), the erasure cascade's image reach (an erasure run after the revert will NOT stamp images again) and the four enum values. The full inventory is § 3.1's "Unflagged and live" list; every line of it is undone by this layer and by nothing else | one deploy |

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

**Three configured alerts** (`docs/observability.md` § 28, task T160) — these page or warn on their
own:

- `broadcasts_awaiting_member_oldest_age_seconds` — **warning at 7 days**, **page at 14**. Both sit
  inside the 30-day expiry clock and ahead of the day-23 warning to the member, so a stuck E-Blast
  is noticed before either automatic step fires.
- `broadcasts_no_marketing_recipient_total > 0` — **page**. Any non-zero value means a hand-off
  notified nobody.

**Three first-week observations** (watched by hand; not alerts — they have no threshold and page
nobody):

- `email_dispatch_failed` audit rows whose `notification_type` starts `eblast_` — in particular
  `no_template_handler`, which would mean a notification type shipped without its dispatcher arm and
  has been retrying silently for up to 16 hours.
- `broadcasts_marketing_turn_count` versus the nav badge — a divergence means the gauge and the live
  count are reading different predicates.
- The first week's `broadcast_schedule_confirmed` rows with `differs: true` — if marketing is
  routinely overriding the member's proposal, FR-018's "call out the difference" copy is doing real
  work and the member's expectations may need managing.
