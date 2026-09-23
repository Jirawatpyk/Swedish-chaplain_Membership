# Research — 119 E-Blast Two-Sided Approval Workflow, Writing Tool Upgrade & Marketing Dashboard

**Phase 0 output** for `plan.md`. One Decision / Rationale / Alternatives block per unknown. Inputs:
(a) `spec.md` § Clarifications (4 sessions), (b) `exploration-2026-09-18.md` including § D "Panel
carry-forwards", (c) the code as read on **2026-09-18** against `main` at `5f602fd30` — every
`file:line` below was opened during this gate, including the ones the exploration file already
cited. No `NEEDS CLARIFICATION` remains in `plan.md` § Technical Context.

Legend: **D** = decision · **R** = rationale · **A** = alternatives rejected · **P** = panel
carry-forward closed.

---

## R1 — Owning bounded context: `src/modules/broadcasts`

**D**: Versions, member decisions, images, brand settings, the stage model and every new use case
live in `src/modules/broadcasts/**` and are exported through the existing barrel
(`src/modules/broadcasts/index.ts`, 628 lines, 97 exports).
**R**: The aggregate being approved is the existing `broadcasts` row. Every new write is either a
column on that row, a child of it, or a transition through the state machine the module already
owns (`domain/policies/broadcast-status-transitions.ts`, mirrored by the DB trigger). The allowance
accounting (`compute-quota-counter.ts`, `drizzle-broadcasts-repo.ts:370-403`), the erasure scrub
(`:1362-1412`) and the cancel cascade (`:1313-1328`) are all in this module and all have to change
together.
**A**: (1) a new `src/modules/eblast-approval/` — rejected: it would have to reach into the
`broadcasts` repo's `tx`-threading writers through the barrel and re-implement the quota and
erasure guards, which is the ceremony Constitution X forbids without a second consumer. (2)
`src/modules/insights` for the dashboard — rejected: insights is read-model territory; the
dashboard is FR-030's *existing queue*, not a second list.

## R2 — Version storage shape: a child table, with version 0 materialised lazily

**D**: `broadcast_versions` — one row per version: `version_no` (0 = the member's original, 1..n =
marketing's formatted versions), `subject`, `body_html`, `body_source`, `note_to_member`,
`authored_by_user_id`, `created_at`, `updated_at`, `sent_to_member_at`. **Version 0 is written
lazily**, in the same transaction as the `submitted → in_design` transition, by copying
`broadcasts.subject` / `body_html` / `body_source`. At most one unsent version per broadcast
(partial unique index); a version becomes read-only the moment `sent_to_member_at` is set,
enforced by a `broadcast_versions_immutable_after_send_fn` BEFORE UPDATE trigger (FR-003).
**R**: FR-002 requires the member's original **and** every version sent to be kept for the life of
the record — but FR-012a promotes the approved version into `broadcasts.subject` / `body_html`, so
the original would be destroyed if it lived only on the parent row. Materialising v0 at the moment
formatting starts is the latest point at which it is still intact, and it keeps the
approve-as-submitted path (FR-007) at **zero** new rows, so today's flow is byte-for-byte
unchanged when nobody formats.
**A**: (1) a `versions jsonb[]` column on `broadcasts` — rejected: the immutability trigger
(§ R4) would have to exempt it on every transition, destroying the very guarantee FR-012a is
protecting, and per-version read-only (FR-003) becomes an application-only promise. (2)
Materialising v0 at submit for every E-Blast — rejected: it writes a row for the ~majority of
E-Blasts that are never formatted, and it changes the submit transaction on the **unflagged** path.
(3) Keeping the original on the parent and never promoting (the sender reads the approved version
directly) — rejected by FR-012a's own words: "the delivery path MUST NOT read content from any
record that could differ from the approved version"; the dispatcher, the Resend gateway and the
redaction scrub all read `broadcasts.body_html` today, and teaching each of them a second source is
exactly the divergence FR-012a forbids.
**P**: closes the panel's #9/#5 premise together with R4.

## R3 — Member decisions: an append-only child table

**D**: `broadcast_member_decisions` — `version_id`, `round`, `decision ∈
('approved','changes_requested','approval_withdrawn')`, `reason` (required for the last two,
optional note for the first), `decided_by_user_id`, `decided_by_contact_id`, `decided_at`.
Append-only: the repo has no update path and a BEFORE UPDATE / BEFORE DELETE trigger raises.
**R**: SC-002 must be provable from the history "with zero exceptions", and FR-032 requires both
sides to see every version, every piece of feedback and the final approval in order. A mutable
decision row would make that proof rest on the application. Attaching the decision to
`version_id` (not just to the broadcast) is what FR-011 means by "feedback attached to the version
it concerns".
**A**: a `member_decision` column set on the version row — rejected: the withdraw-approval case
(FR-015a) produces a **second** decision about the same version, which a single column cannot hold,
and the history would lose the first.

## R4 — The immutability trigger amendment: exactly two new exemptions (FR-012a)

**D**: `CREATE OR REPLACE FUNCTION public.broadcasts_immutable_after_submit_fn()` in migration
`0305`, starting from the live body at
`drizzle/migrations/0299_broadcasts_audience_import_coherence.sql:90-174` (history
0064 → 0075 → 0124 → 0224 → 0299), with three changes and nothing else:

| # | Change | Shape |
|---|---|---|
| E1 | **Promotion of the member-approved version** | `IF OLD.status = 'member_approved' AND NEW.status = 'approved' THEN content_changed := FALSE;` — releases `subject`, `body_html`, `body_source` on that one edge only |
| E2 | **The marketing-confirmed send time** | `IF OLD.status IN ('member_approved','approved') AND NEW.status IN ('approved','changes_requested','in_design') THEN scheduled_for_changed := FALSE;` — confirm, change, and cancellation on withdrawal-of-approval or a voiding edit. The existing `OLD.status='submitted' AND NEW.status='approved'` exemption is kept verbatim |
| F1 | **New frozen column** | `proposed_send_at` joins the blocklist: it is the member's proposal and must never change after submit (FR-016) |

`segment_type`, `segment_params` and `custom_recipient_emails` stay frozen on **every** transition
(FR-005 — marketing may not change the audience), and `subject`/`body_html`/`body_source` stay
frozen on every transition but E1. The GUC redaction arm (`app.allow_broadcast_redaction`) is a
whitelist-by-omission enumerating 35 forbidden columns; the six new `broadcasts` columns
(`proposed_send_at`, `stage_entered_at`, `current_round`, `approved_version_id`,
`member_reminder_stage`, `member_expiry_notified_at`) are **added to that enumeration**, so the
erasure scrub still cannot move a broadcast through the workflow.
**R**: FR-012a mandates one migration carrying the enum widening, the amendment and the state
machine, and mandates that exactly two further post-submit changes become possible. Detection is on
the `(OLD.status, NEW.status)` pair, which is how the existing exemption already works — no new
mechanism.
**Test (FR-012a's own requirement)**: `tests/integration/broadcasts/eblast-immutability-trigger.test.ts`
attempts, at the DB and outside the application, an `UPDATE broadcasts SET subject = …`,
`SET body_html = …` and `SET scheduled_for = …` on every non-exempt transition **and** on a
no-status-change update in each new stage, and asserts `broadcast_immutable_after_submit` each time;
the two exempt edges are asserted to succeed. It goes RED before the migration is written.
**A**: (1) exempting content whenever `NEW.status = 'approved'` — rejected: that would also open the
existing `submitted → approved` approve-as-submitted edge, where the content must stay the member's
own. (2) dropping the trigger and enforcing immutability in the Application — rejected: it is the
database layer of a defence-in-depth pair and the panel's finding was precisely that the spec must
own its amendment rather than discover it at implement time.
**P**: closes the panel's confirmed #9/#5.

## R5 — Stages, statuses, and why no new stage may sit on `approved`

**D**: five new `broadcast_status` values — `in_design`, `awaiting_member_approval`,
`changes_requested`, `member_approved`, `expired_no_member_response` — and a pure Domain
`stageOf(status)` giving FR-019's stage vocabulary. `Scheduled` maps to the **existing** `approved`
status; no new stage sits on `approved`.
**R**: the dispatcher scans `status = 'approved' AND scheduled_for IS NOT NULL AND scheduled_for <=
now()` (`src/app/api/cron/broadcasts/dispatch-scheduled/route.ts:168-183`, `FOR UPDATE SKIP LOCKED`,
50 per tick, every 5 minutes). Any stage parked on `approved` would be dispatched the moment its
`scheduled_for` passed — including an E-Blast awaiting the member. Putting each waiting stage on
its own status makes "not dispatchable" a property of the row, not of a query predicate somebody
might forget. It is also what closes FR-017's "an E-Blast whose approval was withdrawn MUST NOT be
dispatchable": the withdrawal moves it to `changes_requested`, off the dispatchable status,
**regardless** of whether `scheduled_for` is cleared. (It is cleared as well — belt and braces —
which E2 permits.)
**R (terminal)**: `expired_no_member_response` joins `TERMINAL_BROADCAST_STATUSES`
(`broadcast-status.ts:93-99`), so `cleanup-audiences` reaps its Resend audience and the
`broadcasts_quota_year_only_on_sent` CHECK (`0217:85-88`) keeps `quota_year_consumed` NULL — which
is exactly "the allowance place is freed" (FR-022a).
**A**: (1) one new status plus a `substage` column — rejected: the state machine trigger keys on
`status`, so every guard would have to read two columns and the DB could no longer refuse an
illegal move. (2) modelling the waiting stages as `submitted` with flags — rejected for the same
reason, plus the queue's `status = 'submitted'` SLA badge (`queue-table.tsx:104-121`) and the
approval counter (`drizzle-broadcast-approval-counter.ts:24`) would silently count design rounds as
unreviewed submissions.
**P**: closes the panel's "no new stage on `approved`" carry-forward.

## R6 — State-machine widening and the shadow sweep

**D**: `broadcasts_state_machine_fn()` (live body `drizzle/migrations/0217_f71a_state_machine_partially_sent.sql:37-82`)
is re-created in `0305` with these arms changed/added, and the Domain
`TRANSITIONS` record (`broadcast-status-transitions.ts:35-56`) is widened identically:

| from | added targets |
|---|---|
| `submitted` | `+ in_design` |
| `in_design` | `awaiting_member_approval`, `rejected`, `cancelled` (new arm) |
| `awaiting_member_approval` | `member_approved`, `changes_requested`, `rejected`, `cancelled`, `expired_no_member_response` (new arm) |
| `changes_requested` | `in_design`, `rejected`, `cancelled` (new arm) |
| `member_approved` | `approved`, `changes_requested`, `in_design`, `rejected`, `cancelled` (new arm) |
| `approved` | `+ changes_requested`, `+ in_design` |
| `expired_no_member_response` | ∅ (terminal, new arm) |

The `ELSE → empty targets` fail-closed default (`0217:65-70`) is kept.

**D (shadow sweep)** — widening `BroadcastStatus` is a Domain-union widening, so every exhaustive
map and every hand-listed literal set must be visited. The full list, verified 2026-09-18:

*Compile-time exhaustive (TypeScript will fail the build — good):*

| file:line | what |
|---|---|
| `src/modules/broadcasts/domain/value-objects/broadcast-status.ts:15-27` | `BROADCAST_STATUSES` tuple (10 → 15) |
| `…/broadcast-status.ts:93-99` | `TERMINAL_BROADCAST_STATUSES` (+ `expired_no_member_response`) |
| `…/domain/policies/broadcast-status-transitions.ts:35-56` | `Record<BroadcastStatus, …>` adjacency |
| `…/domain/invariants/one-active-broadcast-state.ts:48-174` | `Record<Broadcast['status'], FieldRule[]>` — keys at 49, 60, 71, 83, 94, 105, 117, 127, 144, 161 |
| `…/domain/broadcast.ts:219-273` | `BroadcastPhase` union |
| `…/domain/broadcast.ts:283-403` | `phaseOf()` switch — no `default`, so a missing arm is a type error, **not** a fail-open `return _exhaustive` |
| `src/components/broadcast/status-badge-mapping.ts:35-67` | `Record<BroadcastStatus, BroadcastBadgeProps>` |
| `src/modules/broadcasts/infrastructure/schema.ts:61-80` | `broadcastStatusEnum` pgEnum |

*Runtime-derived (will NOT break the build — these are the dangerous ones):*

| file:line | what | action |
|---|---|---|
| `src/components/broadcast/admin/queue-filters.tsx:64-69` | `IN_REVIEW_STATUSES` — **hand-listed** `['submitted','approved','sending','draft']` | add the five; otherwise the new stages land under "Closed" |
| `…/queue-filters.tsx:74-75` | `TERMINAL_STATUSES` derived from the above | follows automatically |
| `src/app/(staff)/admin/broadcasts/loading.tsx:65` | skeleton chip count from `OFFERED_BROADCAST_STATUSES.length` | follows automatically (CLS stays near zero) |
| `src/app/(staff)/admin/broadcasts/page.tsx:143-152` and `src/app/api/admin/broadcasts/route.ts:31-48` | status parsing filters against `BROADCAST_STATUSES` | follows automatically |
| `drizzle-broadcasts-repo.ts:384` | quota **reserved** `IN ('submitted','approved')` | → `IN_PROGRESS_BROADCAST_STATUSES` (R7) |
| `drizzle-broadcasts-repo.ts:1322` | `listInFlightOwnedByMember` — the erasure/cancel cascade, the same literal | → the same Domain const |
| `drizzle-broadcasts-repo.ts:394` | quota **consumed** `['sent','partial_delivery_accepted']` | unchanged — expiry frees, it does not consume |
| `drizzle-broadcast-approval-counter.ts:24` | `status = 'submitted'` (the "awaiting approval" count) | becomes the marketing-turn set (FR-023) in PR-2 — T132, the only task that widens it |
| `domain/policies/cancel-cutoff-policy.ts:47,49` | cancellable iff `submitted`/`approved` (+ `sending` with batches) | widen to the in-progress set (FR-015: cancellable at any pre-send stage) |
| `src/app/(staff)/admin/broadcasts/page.tsx:78` and `src/app/api/admin/broadcasts/sla-stats/route.ts:64` | SLA window `('approved','rejected','sending','sent')` | leave — the SLA is "time from submit to a marketing decision"; a design round is not a decision. Recorded so a later pass does not "fix" it by accident |
| `src/app/api/internal/metrics/broadcasts-gauges/route.ts:144,150,167-168,173,191,230` | `queuePending IN ('submitted','approved')`, stuck `sending`, failure-rate window, `approved` overdue, import-stuck | **leave `queuePending` alone** (its alert threshold, `docs/observability.md` § 22.3:1382, is calibrated to it) and add four new gauges instead (R21) |
| `src/app/(staff)/admin/broadcasts/[id]/page.tsx:93,200` · `src/app/(member)/portal/broadcasts/[id]/page.tsx:254` | cancel/approve CTA gating | widen to the in-progress set |
| `src/modules/insights/.../benefit-consumption-aggregate-adapter.ts:84` · `src/modules/renewals/.../drizzle-at-risk-scorer.ts:416` · `…/drizzle-member-renewal-flags-repo.ts:697` | cross-module `['sent','partial_delivery_accepted']` | unchanged — they count *delivered* benefit, which the new stages are not |
| `scripts/reset-broadcast-quota.ts:68-73` · `scripts/inventory-broadcast-outbox.ts:115,126` | operator scripts' in-flight sets | widen — an operator report that hides five stages is worse than no report |

*Tests that pin the enumeration and therefore go RED (this is the gate list):*
`tests/unit/broadcasts/domain/broadcast-state-machine.test.ts:34-44` (literal tuple) and `:49`
(`toHaveLength(10)`), `:68-88` (terminal derivation); `tests/unit/broadcasts/domain/retired-broadcast-status.test.ts:43-131`;
`tests/unit/broadcast/queue-filters-grouping.test.tsx:101-131`;
`tests/unit/broadcasts/components/status-badge-mapping.test.ts:27`;
`tests/integration/broadcasts/state-machine-f71a-transitions.test.ts`.

**R (retired statuses)**: FR-019's stage list omits `partially_sent` and `partial_delivery_accepted`.
They stay in `BROADCAST_STATUSES` and in `RETIRED_BROADCAST_STATUSES` (`:68-71`) so historical rows
still parse and still render a badge; `stageOf` maps them to a `historical` stage that no filter
offers. Nothing new is offered to a human that can only return zero rows — the rule the retired-set
docblock states (`:59-66`).
**A**: deriving the new stage set by string convention (e.g. "anything starting `member_`") —
rejected: the repo's own lesson is that a set derived from a pattern rather than a constant drifts
silently (Finding G; the `OFFERED_BROADCAST_STATUSES` derivation that fixed the skeleton chip
count).
**P**: closes the panel's "FR-019 omits the retired statuses" carry-forward.

## R7 — The allowance bucket and the cancel cascade are ONE Domain constant

**D**: `src/modules/broadcasts/domain/stage/in-progress-statuses.ts` exports
`IN_PROGRESS_BROADCAST_STATUSES = ['submitted','approved','in_design','awaiting_member_approval',
'changes_requested','member_approved'] as const satisfies readonly BroadcastStatus[]`, and **both**
`countMemberQuotaBucketsOnTx` (`drizzle-broadcasts-repo.ts:384`) and `listInFlightOwnedByMember`
(`:1322`) build their SQL `IN (…)` from it.
**R**: the two sites carry the identical literal `('submitted','approved')` today and mean two
things that FR-020 makes definitionally the same: an E-Blast **holds its allowance place for the
whole time it is in progress**, and "in progress" is exactly the set the erasure cascade must
cancel. Deriving both from one constant is the Finding-G pattern the module already uses for
`TERMINAL_BROADCAST_STATUSES` in `listTerminalBroadcastsWithLiveAudience`
(`drizzle-broadcasts-repo.ts:1819-1822`). Missing either site is a silent leak: the quota one lets a
member start extra E-Blasts while one is in design (SC-007), the cascade one leaves a member's
content live after erasure.
**A**: widening the two literals independently — rejected: that is how they came to be two copies in
the first place, and a third copy is coming (the marketing-turn count, R21).
**Integration test**: `eblast-allowance-bucket.test.ts` seeds one member with a broadcast in **each**
in-progress stage and asserts the quota counter refuses the next submit at the plan limit and
releases on `rejected` / `cancelled` / `expired_no_member_response` (SC-007).
**P**: closes the panel's "erasure + cancel set" carry-forward.

## R8 — Proposed vs confirmed send time: `proposed_send_at`, frozen

**D**: `broadcasts.proposed_send_at timestamptz NULL`, written by `submitBroadcast` at the same time
it writes `scheduled_for` (`submit-broadcast.ts:823,852`), and added to the immutability trigger's
frozen set (R4 F1). `scheduled_for` keeps its exact current meaning — the time the dispatcher acts
on — and is now written only by `approveBroadcast` (today) or `confirmSchedule` (the new path).
Backfill: `UPDATE broadcasts SET proposed_send_at = scheduled_for WHERE status = 'submitted'` — only
rows still awaiting a decision still carry an untouched proposal; every other historical row gets
`NULL` and the UI shows "not recorded".
**R**: today the member's proposal IS `scheduled_for`, and `approveBroadcast` overwrites it with the
staff choice (`approve-broadcast.ts:118-119,151`) — which is precisely spec § Context defect 3.
FR-016 requires the proposal to be preserved "as proposed" and visible to both sides throughout.
A separate column is the only way to keep both facts.
**R (minimum lead time)**: `confirmSchedule` re-uses the existing `now + 5 min` floor
(`approve-broadcast.ts:110-116`, `broadcast_schedule_too_soon`), so the "proposed time already
passed" edge case is a refusal with the existing error code, not a new one.
**A**: (1) reading the proposal out of the audit trail — rejected: the audit is not a query surface
and FR-026 puts the proposal on every dashboard row. (2) a `schedule_history` table — rejected:
there is exactly one proposal and one confirmed time; a table for two values is the speculative
abstraction Constitution X names.
**P**: closes the panel's "schedule columns" carry-forward.

## R9 — One sanitiser policy, three consumers (SC-011)

**D**: a new pure, import-free module `src/lib/broadcast-content-policy.ts` exports the single
`makeBroadcastSanitizerConfig({ images: boolean })`. The three configs that exist today are deleted
and replaced by calls to it:

| consumer | today | after |
|---|---|---|
| editor paste | `src/components/broadcast/tiptap-editor.tsx:74-90` — `ALLOWED_ATTR: ['href','src','alt']`, **no `target`/`rel`**; forbids `img` unless `imagesEnabled` | the shared config |
| server submit | `src/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer.ts:46-100` — `ALLOWED_ATTR: ['href','target','rel','src','alt']`, `img` always allowed | the shared config |
| preview | `src/components/broadcast/preview-pane.tsx:24-60` — `ALLOWED_ATTR: ['href','target','rel']`, **`'img'` in `FORBID_TAGS` at :55** | no longer sanitises at all (R11) |

The shared config adds `data-eb` to `ALLOWED_ATTR` (R10). `FORBID_ATTR: ['style']` and the absence
of `class` are kept in all consumers — which is also why text alignment is impossible without a new
dependency and is out of scope per the spec.
**R**: SC-011 demands zero elements stripped or altered between the editor, the preview, the test
copy and the delivered email, "verified by an automated element-by-element comparison, not by eye".
Three hand-maintained configs make that a promise; one shared config makes it a property. The
measured consequences of the divergence today are exactly the audit's findings #2 (uploaded images
invisible in the preview) and the pasted-anchor attribute loss.
**R (location)**: `src/lib` rather than `domain/` because two of the three consumers are client
components; a client file importing `src/modules/broadcasts/domain/**` would be a Presentation →
Domain import (Principle III), and importing through the module barrel risks the server-only
cycle that already bit F8 (`src/modules/invoicing/index.ts:531-538`). `src/lib/email-brand.ts` is
the standing precedent for email/brand policy living in `src/lib`.
**A**: exporting the config from the Domain and letting the client deep-import it — rejected for the
Principle III reason above, even though `tiptap-editor.tsx:32` already deep-imports
`infrastructure/tiptap-image-extension-config` (a pre-existing deviation this feature does not
widen).
**Test (SC-011)**: `tests/integration/broadcasts/eblast-content-parity.test.ts` takes one document
containing **every** offered construct, runs it through the editor config, the server sanitiser, the
preview render and the send-time render, and asserts the element+attribute multiset is identical at
each stage. A positive control asserts the comparison fails when a tag is removed from one config —
a check that cannot tell "nothing stripped" from "not looking" is not a check.

### R9a — Toolbar surface, paste handling and the link dialog (FR-038, FR-044)

**D**: the toolbar offers exactly the constructs the shared policy keeps: **headings H2 and H3 only**
(the subject is the email's title, so H1 is never offered and is not in the allow-list), quote,
divider, bulleted and numbered lists, bold, underline, link with editable link text, image, CTA
button, banner. **Paste**: content outside the policy is dropped at paste time by the editor's own
config (not silently at submit), and the user is told **once per editing session** in a non-blocking
notice that unsupported formatting was removed — a toast, not a dialog, and not repeated per paste.
**Link dialog**: a URL whose scheme is outside `http`, `https`, `mailto` is refused **in the dialog**
with an inline message; it is never accepted and then stripped later.
**R**: FR-038 requires that nothing a user can produce survives to be removed afterwards — "dropped
at paste time and the user is told once" is the only shape that keeps the editor honest without a
blocking interruption. Refusing the scheme in the dialog rather than at save is the same rule applied
to links; `zod`'s `.url()` accepts `javascript:`, so the allow-list is asserted at the dialog and
again at the sanitiser (the standing `safeExternalHref` rule).
**D (italic, FR-044)**: when the interface locale is Thai the italic **control** is hidden; italic
*content* arriving by paste or from a template is **kept as-is** and is not stripped, because the
policy allows `<em>` for every locale and stripping it would silently damage a Thai member's text
that an English colleague typed. Hiding the control is a locale-scoped UI rule, not a content rule.
**A**: stripping italic from the body for Thai users — rejected: it would make the same document
render differently per viewer locale and break SC-011's element parity.

## R10 — Design blocks: user data through the sanitiser, platform markup generated after it

**D**: two Tiptap custom nodes built on `@tiptap/core` (already an exact-pinned dependency — no new
package):

| block | editor node | serialised into `body_html` | degradation (FR-042) |
|---|---|---|---|
| call-to-action button | `ctaButton` (attrs: `href`; text is the node's content) | `<a data-eb="cta" href="https://…">Read more</a>` | a plain link |
| full-width banner | `bannerImage` (attrs: `src`, `alt`) | `<img data-eb="banner" src="…" alt="…">` | a plain image |

**D (block limits, FR-041)** — enforced in Domain, checked at every save and again at send-to-member
(FR-004), and surfaced as named 422 codes in `contracts/`:

| rule | limit | refusal |
|---|---|---|
| CTA text | 1–60 characters | `cta_text_length` |
| CTA link | scheme on the allow-list (`http`, `https`, `mailto`); host on the tenant allow-list when the scheme is http(s) | `cta_link_scheme` / the existing image/link source refusal |
| CTA count | at most **3** per message | `too_many_cta` |
| banner image | the FR-040 image rules (≤ 5 MB, png/jpeg/webp/gif, ClamAV-clean, allow-listed host) **plus** a required description of 1–125 characters | `banner_alt_required` / the existing image codes |
| banner placement | anywhere in the body — it is an ordinary block, not a header slot — and rendered at the full **600 px** email width | — |
| CTA appearance | brand colour, platform-owned padding and radius; **button text wraps at phone width and never overflows** | — |

The user supplies only `href`, the button text, `src` and `alt`; nothing else is expressible,
because those are the only attributes the shared config allows.

The stored `body_html` therefore stays **ordinary, sanitisable HTML** and passes the same
`dompurifySanitizer.sanitize` every body passes. The platform's appearance markup — the bgcolor
table cell for the button, the 600 px-wide image cell for the banner — is produced by
`applyDesignBlocks(sanitisedHtml, brand)` **inside `renderBroadcastHtml`, after sanitisation**, and
is never fed back through DOMPurify.
**R**: the panel's carry-forward is explicit — "never route block markup through
`dompurifySanitizer.sanitize`; render blocks from structured data at send time". This design
satisfies it while keeping one body column, one sanitiser and one degradation story: the
pre-transform markup *is* the fallback, so an email client that cannot render the table still shows
the link the user typed. It also keeps FR-041's guarantee mechanically: the user supplies `href`,
text, `src` and `alt` and nothing else, because those are the only attributes the shared config
allows.
**R (unknown marker values)**: DOMPurify cannot constrain attribute *values*, so a pasted
`data-eb="anything"` survives sanitisation. `applyDesignBlocks` transforms only the exact values
`cta` and `banner`; any other value is left as the plain element. Unknown ⇒ no block ⇒ fail-safe by
construction, with no `default: return _exhaustive` anywhere near it.
**R (transform implementation)**: a bounded, attribute-order-independent matcher in Domain
(`domain/design-blocks/block-markers.ts`) — no HTML parser, no jsdom import, no new dependency. It
matches `<a …data-eb="cta"…>` / `<img …data-eb="banner"…>` tag bodies and extracts `href`/`src`/
`alt` independently of attribute order (DOMPurify preserves source order, and a paste can supply any
order). A `fast-check` (dev dep, already present from F4) property test round-trips
serialise → sanitise → transform for random attribute orders and hostile text.
**A**: (1) a parallel `body_blocks jsonb` column alongside `body_html` — rejected: two sources of
truth for one message, and the redaction scrub, the size CHECK
(`broadcasts_body_html_size`, `schema.ts:284-287`) and the parity test would each need a second
arm. (2) allowing `style` or `class` through the sanitiser so the editor can render the real button
inline — rejected: `FORBID_ATTR: ['style']` is the content-safety rule the spec restates, and it is
what makes "no user styling" true rather than aspirational.

## R10a — `@tiptap/extension-image` is re-pinned to an exact version (a pin, not a dependency)

**D**: change `@tiptap/extension-image` in `package.json:85` from `^3.22.5` to exact `3.22.5`,
matching the other four Tiptap packages (`@tiptap/{core,pm,react,starter-kit}`), and refresh
`pnpm-lock.yaml` (T002).

**R**: R9 makes one sanitiser policy the single source of truth for what survives a send, and R10
makes the design-block parser key on the exact serialised HTML the editor emits (`<a data-eb="cta">`,
`<img data-eb="banner">`). A caret lets a patch release change that serialisation — attribute order,
a wrapper element, a self-closing form — at which point SC-011's element parity fails, or worse,
passes while the block silently renders as a plain element. The blast radius is live outgoing email
in an unflagged PR.

**Constitution X**: this is **not** a new dependency and needs no Complexity Tracking entry — the
package is already installed and already used by the editor; only its range narrows. Recorded here
because the decision was made at `/speckit.checklist` time and lived only in `quickstart.md` § 3.1,
which left the reasoning outside the decisions record (`/speckit.analyze` L5).

**A**: leave the caret and rely on the parity test to catch a bad release — rejected: the parity
test runs on our branches, not on a transitive bump in someone else's, and by the time it goes red
the release is already in the lockfile of whoever ran `pnpm install` first.

## R11 — Preview: rendered by the send-time wrapper, over a route, into an iframe

**D**: `POST /api/broadcasts/preview` (member, `requireMemberContext`) and
`POST /api/admin/broadcasts/preview` (staff, `requireApiPermission('broadcasts.read')`), both thin
wrappers over one Application use case `renderBroadcastPreview`, which calls the **same**
`renderBroadcastHtml` the sender calls (`infrastructure/resend/email-template.ts:128`) with the
tenant's brand settings and logo URL. The returned full HTML document is rendered into an
`<iframe srcdoc>` — inline in the compose page (debounced ~400 ms on the deferred body, with a
proper empty state when the message is empty — a translated line such as "Your message preview
appears here", never a blank box) and full-size in a Preview dialog offering **desktop 600 px** and
**phone 375 px** widths, returning focus to the trigger on close and respecting
`prefers-reduced-motion` on the dialog's open/close transition (FR-043). The same component is
reused on the member's compare screen.
**R**: FR-043 requires "the complete email as a recipient receives it — header, body, footer with
unsubscribe", and the spec's edge case makes a preview/delivered difference a **defect**. The only
way to make that structurally true is to render from the same function. The wrapper is a full
document with a `<body>` background — `dangerouslySetInnerHTML` into the page (today's
`preview-pane.tsx:115`) cannot host it and would leak the email's styles into the app; an iframe
with `srcdoc` (no `src`, so no network, and sandboxed) is the isolation boundary.
**R (transport)**: a route handler, not a Server Action — the repo has zero `'use server'`
directives (F1 research § 4.1), and route handlers inherit the proxy's CSRF Origin allow-list, the
read-only-mode 503 and the RBAC denial audit. Two routes rather than one dual-guard route because
`/api/broadcasts/recipient-count` and `/api/admin/broadcasts/recipient-count` are the existing
precedent for exactly this member/staff pair, and `check:api-route-guard` expects one guard shape
per route.
**R (cost)**: the preview renders from the request body (subject + body HTML the client already
holds) plus two cached tenant reads; no broadcast row is read, so it is a pure render at
p95 < 400 ms. A per-actor bucket (30 / minute) keeps it from becoming a render amplifier.
**A**: (1) keeping the client-side sanitise-and-inject preview and merely aligning its config —
rejected: it would still show the bare body, not the header/footer/unsubscribe FR-043 names, and the
design blocks are generated server-side. (2) rendering the wrapper in a React Server Component —
rejected: the compose form is a client component and the preview must update as the user types.

## R12 — The chamber logo in the email header: read the public URL of the logo already on file

**D**: a new READ-only barrel export `getTenantLogoPublicUrl(tenantCtx): Promise<string | null>` on
`src/modules/invoicing/index.ts`, implemented over the existing `BlobStoragePort` by resolving the
public URL of `tenant_invoice_settings.logo_blob_key`
(`src/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings.ts:79`), with the same
50-entry FIFO positive cache and 60 s negative cache as `loadTenantLogo`
(`src/modules/invoicing/application/lib/load-tenant-logo.ts:57-75`). Broadcasts consumes it through
`TenantLogoUrlPort`, wired in `src/lib/broadcast-brand-deps.ts`. Fail-soft: `null` ⇒ the header
renders the chamber name exactly as today (FR-041a).
**R**: the blob is **already public**. `vercel-blob-adapter.ts:59-76` uploads logos with
`access: 'public'` with the comment "the tenant invoice PDF template embeds them and Vercel Blob
doesn't support auth on image fetch"; unguessability comes from the UUID in the key
(`upload-tenant-logo.ts:158`, `buildLogoBlobPrefix` at `src/lib/logo-blob-key.ts:21-23`). So there
is **no second copy to make and nothing to refresh** — exactly one artefact, set once on its
existing page, used in both places, which is FR-041b's requirement in one sentence. The exploration
file's "private blob read as bytes" is true of how F4 *consumes* it (`downloadBytes` for PDF
embedding), not of how it is *stored*; re-verified this gate.
**R (no write path)**: the export is read-only and the Brand page has no logo control at all; a
contract test asserts that no route reachable with `settings.broadcasts` alone writes
`logo_blob_key` (FR-041b's own requirement). `settings.invoicing` is `superAdminOnly` with
`sensitive: 'money'` (`permission-catalogue.ts:98`) and stays that way.
**A**: (1) a broadcasts-owned public copy refreshed when the invoice logo changes, reusing the
`insights` pattern (`public-logo-blob-adapter.ts`, which is an independent `directory-logos/…`
namespace and does **not** copy from invoicing) — rejected: it introduces a second artefact, a
refresh hook across a module boundary, and a drift window in which the email shows last month's
logo. (2) an app route proxying the bytes (`GET /api/public/brand/logo`) — rejected: it puts a
serverless function in every recipient's image fetch for an asset already on a CDN. (3) storing
`logo_public_url` as a new column populated on upload — rejected **for now**: it is cheaper at read
time but leaves SweCham's existing logo unpublished until someone re-uploads it, and a SQL backfill
cannot synthesise the URL. Recorded as a follow-up if the `head()` resolution ever shows up in a
latency budget.
**V1**: confirm before tasks that `BlobStoragePort` can expose `resolvePublicUrl(key)` over
`@vercel/blob`'s `head()` without widening the invoicing barrel's client-bundle surface (the
`sharp`/`server-only` lesson at `src/modules/invoicing/index.ts:531-538`).

## R13 — Brand settings: colour + address on `tenant_broadcast_settings`, contrast checked in Domain

**D**: four columns on the existing `tenant_broadcast_settings`
(`src/modules/broadcasts/infrastructure/schema.ts:887-907`, PK `tenant_id`, created in migration
0131, RLS + FORCE added by `0166_f71a_rls_policies.sql:71-76`):
`brand_primary_color text NULL CHECK (~ '^#[0-9a-fA-F]{6}$')`, `brand_postal_address text NULL
CHECK (char_length <= 300)` (FR-041c — free text, **line breaks allowed**, so the CHECK bounds the
length and nothing else), `brand_updated_at`, `brand_updated_by_user_id`. Page
`/admin/settings/broadcasts/brand`, `requirePagePermission('settings.broadcasts')` (admin +
super_admin — `permission-catalogue.ts:100`, `role-bundles.ts:66-72`); API
`GET|PATCH /api/admin/broadcasts/brand` with `requireApiPermission('settings.broadcasts')`. Every
write audited `broadcast_brand_settings_changed { previous, next }` — values, not text the member
wrote, so this payload legitimately carries them.
**D (contrast)**: a new pure Domain module `domain/brand/contrast.ts` implementing the WCAG 2.1
relative-luminance and contrast-ratio formulas (~30 lines, no dependency). A colour whose contrast
with `#ffffff` is below **4.5:1** is refused with the computed ratio in the message; the previous
colour (or the platform default `EMAIL_BRAND_PRIMARY = '#10487a'`, `src/lib/email-brand.ts:20`)
stays in force (FR-041b + the "brand colour too light" edge case). The same helper drives a live
preview swatch on the form, so the refusal is never a surprise.
**R**: there is **no** contrast helper and no colour library anywhere in `src/` today — the only
hits are prose, including the hand-maintained comment at `email-brand.ts:7` asserting ≈9.4:1 for the
current navy. Adding `culori`/`chroma-js` for two formulas would need a Constitution X
justification; the formulas are short, exact and testable, so the arithmetic is written here.
**R (table choice)**: `tenant_broadcast_settings` already exists, is keyed on `tenant_id`, already
has RLS + FORCE, and its own docblock anticipates "future enhancements would add columns here". It
is **not** in `scripts/check-multi-tenant-ready.ts` `SCOPED_TABLES:77-80`; this feature adds it
along with the three new tables, because it now carries tenant-authored content.
**D (brand chrome is live, never frozen — FR-041c)**: no version, and no `broadcasts` row, ever
stores a copy of the logo URL, the colour or the address. `renderBroadcastHtml` reads the brand
settings at the moment it renders, so **every preview and the send itself use the current brand**,
and a brand change while versions are pending or approved voids nothing (FR-012's "brand chrome is
not content"). That is also why the Brand page needs no coordination with the approval flow. The
brand **colour is used in email only** — never in the portal or admin UI, which keeps the platform
theme tenant-independent and keeps a low-contrast-but-legal colour out of the application chrome.
**D (page placement and visibility — FR-041b)**: the page lives under the staff **Settings** area
beside the existing E-Blast settings page, not under `/admin/broadcasts`. A user without
`settings.broadcasts` — including `marketing` — does not see the nav entry, the Settings-index card
or the page (`requirePagePermission` 403/redirect), so the surface is invisible rather than disabled.
**A**: (1) a new `tenant_brand_settings` table — rejected: two nullable columns do not justify a
table. (2) putting the colour on `tenant_invoice_settings` next to the logo — rejected: that table
is super-admin-only and money-sensitive; FR-041b's whole point is that colour and address are
admin-writable while the logo is not. (3) freezing the brand into each version at send-to-member —
rejected by FR-041c in as many words, and it would make a logo fix require a new approval round.
**P**: the panel's "`marketing` cannot open a `settings.broadcasts` page" carry-forward is closed by
copy, not by permission: the "no logo on file" hint on the compose/preview surfaces tells a user who
cannot fix it to **ask an administrator**, and links to the Brand page **only** for a user who holds
`settings.broadcasts`. No new permission key (spec § Roles).

## R14 — Notifications: five types, ids only, rendered at send time

**D**: `notification_type` += `eblast_submitted_marketing`, `eblast_member_decided_marketing`,
`eblast_version_sent_member`, `eblast_schedule_confirmed_member`, `eblast_approval_lifecycle`; each
gets a `case` arm in `buildPayload` (`src/app/api/cron/outbox-dispatch/route.ts:194`). `context_data`
carries `{ tenantId, broadcastId, versionId?, round?, decision?, kind?, recipientUserId? }` — **ids
and discriminators only**; the arm reads the broadcast, the version and the decision through
`runInTenant(asTenantContext(row.tenantId), …)` at send time and renders there, returning the
existing `PayloadMiss` shapes (`request_gone` / `recipient_gone`) when the row is gone.
**R**: the F114 arms (`route.ts:415-542`) are the live precedent and the reason is the same: the
erasure scrub of the version/decision rows (R17) must also blank anything a not-yet-sent email would
show, and a **sent** outbox row (retained 90 days by `outbox-purge`) must hold no subject, body,
note or reason. Reading at send time is what makes both true without a second cancel matcher.
**R (why a dispatcher arm is not optional)**: the `default:` arm returns `null`
(`route.ts:543-544`), which sets `lastError = 'no_template_handler'` and retries on the
60 s/5 m/30 m/3 h/12 h ladder until `attempts >= 5` — so a notification type enqueued without an arm
is a **silent ~16-hour outage**, not a loud failure. A contract test asserts every value in the
`notification_type` enum has an arm.
**R (recipient locale)**: the dispatcher reads `row.locale` (`route.ts:191`); there is no per-user
locale lookup. Member-facing rows carry the member contact's `preferred_language` (FR-024); staff
rows carry the platform default, because `users` has no locale column (the F114 finding at
`src/lib/members-change-request-deps.ts:83`).
**A**: one notification type with an `event` discriminator for all six hand-offs — rejected: the
dispatcher switches on `notification_type`, so one type means one arm with six bodies and a
`default` inside it; splitting by audience keeps each arm's render obvious and each retry
independently observable.

## R15 — "Marketing" as a recipient is derived from the evaluator, never from a role literal

**D**: `src/lib/broadcast-marketing-deps.ts` exports `marketingRoles()` =
`ROLES.filter(r => hasPermission(r, 'broadcasts.write'))` **minus** the admin tiers
(`admin`, `super_admin`), and `makeMarketingDirectory(): MarketingDirectoryPort` whose
`listRecipients()` calls the existing `listActiveUsersByRole`
(`src/modules/auth/infrastructure/db/active-users-by-role-repo.ts:24-31`). When that set is empty,
it falls back to the roles holding `broadcasts.write` **including** the admin tiers — which is
FR-021a's "notify the tenant's admins instead" expressed as a derivation rather than a literal.
**R**: the panel carry-forward and the F114 precedent (`specs/114-member-change-approval/plan.md:42`,
implemented at `members-change-request-deps.ts:67-69`). A literal `role = 'marketing'` string would
silently stop matching the day a bundle changes; `hasPermission` is the only correct oracle, because
`ROLE_BUNDLES.super_admin` deliberately omits `superAdminOnly` keys and the evaluator answers by an
early return (`evaluator.ts:80`) — reading the bundle gives the wrong answer (the standing
"`ROLE_BUNDLES` is not the whole model" rule).
**R (MTA+STD)**: `users` has no `tenant_id` and no RLS (F1's deliberate exception, Constitution I's
own carve-out), so "in the tenant" is vacuous on a single-tenant deployment; the read uses the
global `db` exactly as F114's does, and F10's `user_tenants` is where it becomes tenant-scoped. The
port shape already carries `locale` so a future `users.preferred_locale` needs no port change.
**A**: a per-tenant "marketing mailbox" setting — rejected by spec § Assumptions (not in scope this
round).

## R16 — Reminders, expiry and the image sweep ride an existing cron

**D**: no new cron job. `/api/cron/broadcasts/prune-expired-drafts` (`vercel.json:14`, `30 4 * * *`
UTC = 11:30 Asia/Bangkok) gains a **second, independently transacted block** with its own
`SET LOCAL statement_timeout`, its own try/catch, its own `approvalLifecycleOk` field in the
response body, and a 500 only at the end — so a fault in either half cannot drop the other. The
block does three things in order: (1) delete the blobs of images marked `deleted_at` whose content
hash has no live reference (R17); (2) send day-3 and day-7 reminders and the day-23 expiry warning;
(3) close at day 30 as `expired_no_member_response`. Route keeps `export const GET = POST` (native
Vercel Cron invokes GET).
**R**: `vercel.json` carries **37** of the Pro plan's 40 jobs (counted this gate). The F114
precedent (`research.md` § V2, superseded by the round-3 review) established the shape — a second block
in an existing tick with its own transaction and its own OK flag, never a new slot and never a
shared try/catch. The route's own subject is already the *lifetime* of an E-Blast draft, and
FR-022a's 30-day expiry was chosen (spec § Clarifications) to align with that same 30-day draft
lifetime, so the two belong on the same clock. The route name is kept: renaming touches
`vercel.json`, the runbook and the alert rules for no observable gain (Principle X).
**D (scope — FR-022a)**: reminders, the day-23 warning and the day-30 expiry apply **only while the
status is `awaiting_member_approval`**. Once the member has approved (`member_approved`) or marketing
has confirmed a schedule (`approved`), **no expiry can occur** — the scan's `WHERE` clause and the
partial index `broadcasts_awaiting_member_idx` both name that one status, and
`awaiting_member_approval` is the only `from` state with an `expired_no_member_response` target in
the DB state machine, so the rule is enforced twice.
**D (clock and idempotency)**: the clock runs from `stage_entered_at` while the row is in
`awaiting_member_approval` — which is by construction "the moment the latest version was sent to
them" (FR-022a), because entering that stage *is* sending a version. `broadcasts.member_reminder_stage
smallint NOT NULL DEFAULT 0` records what has been sent (0 none → 1 day-3 → 2 day-7 → 3 day-23
warning) and is reset to 0 on every entry into `awaiting_member_approval`, so a new round restarts
the clock and "exactly one reminder per threshold" (US5 AS2) holds across rounds. A daily tick gives
±24 h precision, which AS2's own wording ("when the reminder check runs") accepts.
**A**: (1) a new daily `/api/cron/broadcasts/approval-lifecycle` job (38/40) — rejected: the Pro
ceiling is the binding constraint and three free slots is not a budget to spend on a job that fits
an existing tick. (2) folding into the 5-minute gauges tick — rejected: these are *writes* and
emails; a 5-minute cadence would multiply the blast radius of a bug by 288.

## R17 — Erasure and export reach: versions, decisions, notes, reasons, images

**D**: a `BroadcastApprovalScrubPort` call joins the **same atomic erasure transaction** that
already calls `scrubContentForMemberInTx` (`drizzle-broadcasts-repo.ts:1362-1412`): every
`broadcast_versions` row of the member's broadcasts has `subject`, `body_html`, `body_source` and
`note_to_member` replaced with `[redacted]`; every `broadcast_member_decisions.reason` likewise;
every `broadcast_images` row of those broadcasts is stamped `deleted_at`. Row counts, rounds,
decisions and timestamps survive (the accountability record). The **blob bytes** are deleted (a)
best-effort immediately after the transaction commits and (b) durably by the daily sweep (R16),
under a **last-reference rule**: a blob is deleted only when no live `broadcast_images` row shares
its `content_hash`, because the upload path dedupes by hash
(`upload-inline-image.ts:138-165`) and two members can legitimately share one blob.
**D (notifications are in the reach)**: spec § Personal data names "every notification about the
E-Blast". Because every `eblast_*` outbox row carries **ids only** and the dispatcher renders at send
time (R14), an unsent row is blanked by the very same scrub — it re-reads redacted rows. A **sent**
row holds the recipient address and no content, and is removed by the existing 90-day `outbox-purge`;
the erasure transaction additionally cancels the pending rows for the erased member's broadcasts so
no post-erasure email is rendered from a `[redacted]` version. This is stated so the DSAR/erasure
task list names the outbox, not only the two child tables.
**D (the last-reference rule spans both owner kinds)**: a blob is deleted only when **no** live
`broadcast_images` row of **either** `owner_kind` — no E-Blast and no template — shares its
`content_hash`. The reference is removed from the content immediately; the bytes go **on the next
daily sweep tick (200 rows per arm per tenant)** after becoming unreferenced (spec § Personal data).
**R**: spec § Personal data requires erasure and export to reach "every stored version, every
feedback/note text and every image uploaded for the E-Blast, not only the current content", and
"images of a withdrawn, rejected or erased E-Blast must not remain reachable". The panel's
carry-forward is that today's COMP-1 scrub redacts the *reference*, not the *bytes*, and that
`ImageStoragePort` (`application/ports/image-storage-port.ts:43-73`) has **no delete method** at all
— inline-image blobs are never reclaimed. The port is widened with `delete`; four sibling adapters
already call `@vercel/blob`'s `del` (`invoicing/.../vercel-blob-adapter.ts:115`,
`insights/.../public-logo-blob-adapter.ts:27`, `insights/.../private-blob-adapter.ts:52`,
`events/.../vercel-blob-error-csv-store.ts:132`), so the shape is established.
**R (why not delete inside the tx)**: a blob delete is an external side effect that cannot roll back;
marking in the tx and deleting after keeps the transaction pure and makes the deletion retryable.
The ≤24 h backstop window is stated in the runbook; the immediate post-commit attempt means the
normal case is seconds.
**D (cancel cascade)**: `listInFlightOwnedByMember` widens to `IN_PROGRESS_BROADCAST_STATUSES` (R7),
so an erasure at "Awaiting member approval" cancels rather than leaving a live row.
`scrubContentForMemberInTx` itself needs no status predicate — it has none today (`:1408` is an
idempotency guard, not a filter) and therefore already covers the new stages.
**D (export)**: the member DSAR archive gains a `broadcast-versions.json` section scoped to the
requesting member's own E-Blasts, with the same `[redacted]` sentinels an erased record shows.
**Integration test**: `eblast-erasure-reach.test.ts` seeds a member with an E-Blast **at "Awaiting
member approval"** with two versions, one changes-requested decision and two images, runs
`eraseMember`, and asserts: no non-sentinel value in either child table, the broadcast cancelled,
every image row stamped, and a second run changes nothing.
**P**: closes the panel's "image lifecycle" and "erasure + cancel set" carry-forwards.

## R18 — What the feature flag gates: entry, not exit

**D**: `FEATURE_EBLAST_MEMBER_APPROVAL` (zod boolean in `src/lib/env.ts`, default `false`, listed in
`.env.example` for `check:env-example`), composed with the F7 master as
`isEblastMemberApprovalEnabled() = env.features.f7Broadcasts && env.features.eblastMemberApproval`
in `infrastructure/feature-flags.ts` (the 2-layer version of the existing 3-layer `isF71aUs*Enabled`
pattern). The gate applies to:

| surface | flag OFF |
|---|---|
| `POST /api/admin/broadcasts/[id]/version` **from `submitted`** — the `submitted → in_design` edge, the **only entry** into the round | **404** |
| the same `POST` from `changes_requested` / `member_approved` / `approved` (round ≥ 1) — re-opening a working copy on a row already in the round | **201 — available.** The gate is on the **edge**, not the route: FR-034 requires an in-flight E-Blast to stay **completable**, and this write is the only way to complete one the member sent back. A route-wide 404 would dead-end every `changes_requested` row (`/speckit.analyze` round 3 H1) |
| "Start formatted version" control on the staff detail page | hidden |
| the new stage chips on the queue | offered **only if** the tenant has ≥ 1 row in a new stage |
| the marketing waiting-count in the nav (FR-023) | hidden **unless rows exist in a new stage** — the same "flag ON **or** rows exist" rule as the chips, so an in-flight row is never invisible to the people who must act on it (contracts `dashboard-and-notifications.md` § 1.3; round 3 M9) |
| `PATCH`/`send`/member decision/`schedule` routes for a row **already** in a new stage | **available** |
| reminders, the day-23 warning and the day-30 expiry for rows already in a new stage | **run** |
| everything else (writing tool, preview, blocks, brand page, images, screen fixes) | live — not governed by the flag (spec § Feature flag) |

**R**: FR-034 requires that with the flag off, E-Blasts already in a new stage "MUST remain
completable or cancellable and MUST NOT be sent without the required member approval". A pure
404-everywhere dark ship (the 108 / 114 pattern) would strand exactly those rows — the member could
not approve and marketing could not confirm, so the only exit would be cancel, which loses the
work. Gating the single entry **edge** is both narrower and sufficient: with the flag off no E-Blast can
*become* a member-approval E-Blast, and today's `submitted → approved | rejected | cancelled` flow
is untouched (SC-006). **"Edge" is literal and the distinction is load-bearing**: the gate reads the
status of the row **after** the `FOR UPDATE` re-read and refuses only `submitted`. Gating the route
instead — which is how T152 and the admin contract first read — would strand exactly the rows R18
exists to protect, since `changes_requested → in_design` runs through the same handler
(`/speckit.analyze` round 3 H1).
**R (chip rule)**: offering a stage chip that can only return zero rows "reads as *it never
happened* rather than *this can no longer happen*" — the module's own rule for
`RETIRED_BROADCAST_STATUSES` (`broadcast-status.ts:59-66`). Deriving the offered set from
"flag ON **or** rows exist" respects it in both directions.
**R (kill switch)**: every new API path must be added to `matchesF7KillSwitchPath`
(`src/proxy.ts:43-68`) or it stays writable while F7 itself is dark — the bug-#15 precedent. The new
`/api/broadcasts/**` and `/api/admin/broadcasts/**` paths are covered by the existing prefixes; the
Brand page at `/admin/settings/broadcasts/brand` is **not** (the predicate covers
`/admin/broadcasts`, not `/admin/settings/**`), so it gates in-page on `env.features.f7Broadcasts`
exactly as `/admin/settings/broadcasts/page.tsx:41` already does with `isF71aUs2Enabled()`.
**A**: a per-tenant setting like F114's — rejected by spec § Assumptions ("single switch"; marketing
chooses per E-Blast whether to format or approve as submitted).

## R19 — Concurrency, idempotency and "exactly one action wins"

**D**: every state change is ONE `runInTenant`: re-read the broadcast `FOR UPDATE`, re-check the
stage, write, transition, audit and enqueue on the same `tx`, with **throw-to-rollback** — never
`return err()` inside the callback, which would COMMIT. Version saves carry an
`expectedUpdatedAt`; a mismatch is **409 `version_changed`** ("someone else changed this", FR-033
and the "two marketing users" edge case). Member-vs-marketing races (FR-033, the "act at the same
moment" edge case) are resolved by the row lock plus the stage re-check: the loser gets **409
`stage_changed`** carrying the current stage. **No `Idempotency-Key` is introduced on any of these
routes**: the (broadcast id, stage, version id) triple *is* the key — a repeated approve on a row no
longer in `awaiting_member_approval` answers 409 with the recorded decision, which is the correct
answer, not a replay.
**R**: the DB state-machine trigger is the last line (it raises
`broadcast_invalid_state_transition`), the row lock is the practical one. Avoiding
`Idempotency-Key` also avoids the whole reservation class — the repo's standing rule that a
reservation left unwritten burns the key, and the fact that CI smoke has no Redis so
`Idempotency-Key` routes answer 503 there. The one place a key would help (test copy) is a harmless
duplicate, so it gets a rate bucket instead.
**D (voiding an approval)**: marketing editing content after member approval is not an update to
the approved version; it is a transition `member_approved → in_design` (or `approved → in_design`)
that voids the approval, clears `approved_version_id`, cancels the confirmed time (trigger exemption
E2) and emits `broadcast_member_approval_voided`. The Application additionally requires
`current_round >= 1` on the `approved → in_design` edge, so an approve-as-submitted E-Blast cannot
be dragged into a design round it never had. There is therefore **no** path by which
marketing-edited content is sent without the member having approved that exact version (spec's own
edge case, SC-002).

## R20 — Testing strategy (Constitution II)

- **Contract** (`tests/contract/broadcasts/**`): every new route × role (`member`, `manager`,
  `marketing`, `admin`, `super_admin`) × flag state; the 404/403/409/422/429 envelopes; the
  brand-cannot-write-the-logo assertion (FR-041b); one arm per new `notification_type`; the
  member-route owning-member check.
- **Integration** (live Neon dev branch — pass **file paths**, never `-- <pattern>`): the **twelve**
  suites named in `plan.md` § Project Structure (this line read "eight" while that list carried
  twelve — `/speckit.analyze` round 3 L1). T165 runs them **per PR**: the three PR-1 creates
  (`eblast-approval-tenant-isolation`, `eblast-content-parity`, `audit-event-type-parity`) in PR-1,
  all twelve in PR-2 — naming a path the PR has not created makes the gate unsatisfiable (round 3 M1). Cross-tenant isolation on all three new tables in
  both directions is the Constitution I.3 Review-Gate blocker.
- **Unit**: Domain 100% line (stage map, turn map, transitions, in-progress set, design-block
  serialiser/renderer, contrast helper, reminder/expiry policy, version + decision invariants);
  Application 80% line + branch with **100% branch** pinned in `vitest.config.ts` on the six
  security-critical use cases — `startFormattedVersion`, `sendVersionToMember`,
  `recordMemberDecision`, `confirmSchedule`, `promoteApprovedVersion` and `setBrandSettings`
  (member-approval semantics, PII writes and RBAC) — which live in **five files**:
  `start-formatted-version.ts`, `send-version-to-member.ts`, `record-member-decision.ts`,
  `confirm-schedule.ts` (**`promoteApprovedVersion` is the promotion arm inside it, not its own
  module** — an earlier draft of this line pinned a `promote-approved-version.ts` that does not
  exist, and a pin naming a missing path is silently satisfied, so the file stops being measured)
  and `set-brand-settings.ts`. **Each pin lands in the PR that creates its file** — `set-brand-settings.ts`
  is PR-1's, the other four are PR-2's (`/speckit.analyze` H6). A pinned file is measured with
  `pnpm vitest run <suites> --coverage --coverage.include=<file>` before pushing — a green
  `pnpm test` is not the CI coverage job.
- **e2e** (local only, `--workers=1`, ≤ 10-minute foreground chunks): submit → format → request
  changes → re-format → approve → confirm → sent, as member and as marketing; axe at 320 px on every
  new surface; TH + SV smoke on the new stage chips. Personas: `e2e-member-empty` (the `e2e-member`
  persona is LAPSED by the F8 fixture).
- **Test doubles**: `tests/helpers/eblast-approval-fakes.ts` stubs **every** method of every new
  port — an unstubbed port method is an unexercised branch, and a stale stub after an arity change
  fails silently.
- Each user story's first task is its RED acceptance test, and RED is observed, not assumed.

## R21 — Dashboard: extend the existing queue, do not build a second list

**D**: FR-030 is taken literally. `/admin/broadcasts` stays the one list and gains: per-stage counts
on the existing chip strip (which already derives from `OFFERED_BROADCAST_STATUSES`,
`queue-filters.tsx:40-75`, so the five new stages appear with no hand-listing beyond
`IN_REVIEW_STATUSES`); three columns — **Whose turn** (`turnOf`), **Time in stage** (the existing
`ageBadge` struct from `queue-table.tsx:110-121`, re-based on `stage_entered_at` instead of
`submittedAt` and applied to every waiting stage rather than only `submitted`), and **Round**
(`current_round`); proposed and confirmed send times on the row; an **Upcoming sends** filter preset
(`?status=approved&sort=scheduled_for`) listing in send-time order; and delivery counts on sent
rows from the existing `broadcast_deliveries` aggregate. The shared table primitive, the mobile
card list, the fixed-bottom bulk bar, the single permanently-mounted `role="status"` announcer
(`queue-table-client.tsx:439-447`) and `finalFocus` on every dialog are preserved.
**D (stalled)**: FR-027 — marketing-held stages flag at the existing 48 h review target
(`SLA_RED_HOURS`, `queue-table.tsx:98`), member-held at the 3-day reminder threshold. Both read
`stage_entered_at`, so the thresholds are one comparison, not a per-stage table.
**D (metrics)**: four new gauges emitted from the **existing** broadcasts half of
`/api/internal/metrics/broadcasts-gauges` (no new cron, no new transaction — same module, same
half): `broadcasts_awaiting_member_approval_count`, `broadcasts_awaiting_member_oldest_age_seconds`,
`broadcasts_changes_requested_count`, `broadcasts_marketing_turn_count`, each labelled `tenant`,
zero-filled over the tick's existing `observed` tenant set (counts report 0, never their last
value). `broadcasts_queue_pending` is **left alone** — its alert threshold
(`docs/observability.md` § 22.3, line 1382) is calibrated to `('submitted','approved')` and
silently widening it would move an alert nobody re-tuned.
**D (FR-023 in-app count)**: the nav badge counts the marketing-turn set, computed by the same
Domain predicate as the gauge, as a live indexed `count(*)` at render (the F114 `NeedsAttentionList`
precedent — a plain DB count, not the cron snapshot, so it is correct immediately).
**A**: a separate `/admin/broadcasts/dashboard` page — rejected by FR-030 in as many words ("not a
second, parallel list"), and it would fork the filters, the bulk bar and the announcer.
**FR-036**: the dashboard shows recipient **counts** only and links to the 108 Marketing audience
page for who they are — no contact-level data is added to any query here.

## R22 — Staff and template images: ownership recorded, not assumed

**D**: a new `broadcast_images` table records every uploaded image with `owner_kind ∈
('broadcast','template')`, `owner_id`, `content_hash`, `blob_url`, `mime_type`, `byte_size`,
`uploaded_by_user_id`, `deleted_at`. Three routes write it:
`POST /api/broadcasts/inline-image-upload` (member — **gains** a real draft-ownership check),
`POST /api/admin/broadcasts/[id]/images` (staff, `broadcasts.write`, refused unless the broadcast is
in `in_design`), `POST /api/admin/broadcasts/templates/[id]/images` (staff, `broadcasts.write`,
FR-046a). All three share `uploadInlineImage`, so the 5 MB cap, the png/jpeg/webp/gif MIME list, the
SHA-256 dedup, the fail-closed ClamAV scan and the per-tenant source-allowlist auto-seed
(`upload-inline-image.ts:87-267`) apply identically to a staff image (FR-040).
**R**: three things need the record. (a) The edge case "a staff user adds an image to another
member's E-Blast: allowed only on the E-Blast they are formatting" is an ownership rule, and today
the member route's `draftId` is an **unvalidated form string** (`route.ts:76`) despite the
docstring at `route.ts:5` claiming a draft-ownership check — the check does not exist in either
layer. (b) Erasure must reach the bytes (R17), which needs to know which bytes. (c) Nothing reclaims
inline-image blobs today, so every abandoned upload leaks. A derived approach — scanning every
version's and template's HTML for `<img src>` — was considered and rejected: it cannot see an image
uploaded and never saved, and it cannot enforce ownership at upload time, which is before the HTML
exists.
**D (alt text, FR-040)**: the description is **1–125 characters, any language**, collected by the
editor's insert dialog before the node can exist — so it is never an upload field. The field is
labelled, and an empty description is an announced field error, not a silent disabled button. The
description is carried into the sent email as the `alt` attribute the shared config allows.
**D (upload refusals, FR-040)**: an upload is refused for a **closed** E-Blast (any terminal status),
for **another member's** E-Blast, and — for a member — for a **draft they do not own**. The member
route `POST /api/broadcasts/inline-image-upload` gains that ownership check, which it has never had
(`route.ts:76` takes `draftId` as an unvalidated form string while `route.ts:5` claims otherwise);
a same-tenant miss answers 404 and emits the existing `broadcast_cross_member_probe` (US6-AS7).
**D (templates)**: a template's images are tied to the template; starting an E-Blast from a template
carries them **by reference** (the existing snapshot copies the HTML, so the `src` URLs come along)
and a later edit or delete of the template does not change E-Blasts already started from it —
today's snapshot semantics, unchanged (`snapshot-template-to-draft.ts`). The last-reference rule
(R17) is what makes deleting a template image safe while a member's draft still points at it: the
draft's own `broadcast_images` row keeps the hash alive. Blocks and links that arrive from a template
are **ordinary content in the member's draft**: the member may edit or delete them like anything
else, and **authorship is not tracked per block** (FR-046a) — there is no per-block provenance field
and no "from template" badge, because the draft's content is the member's from the moment it is
snapshotted.
**A**: a `broadcast_id` column on nothing at all, with ownership enforced only by the route's status
check — rejected: it satisfies (a) and neither (b) nor (c).

## R23 — Test copy: synchronous, non-durable, to the requester only

**D**: `POST /api/broadcasts/test-copy` (member) and `POST /api/admin/broadcasts/test-copy` (staff)
render the same wrapper as the preview and send **one** email to the **session user's own address**,
resolved server-side and never taken from the request body. Both surfaces exist because both members
and staff use the same tool (FR-037). The subject is prefixed with the localised **`[Test]`** marker,
and the body goes through the **identical** content-safety and rendering pipeline as a real send —
the same sanitiser policy, the same `applyDesignBlocks`, the same brand header and the same footer —
so a test copy that differs from the delivered email is a defect, not a configuration. It changes no
stage, writes no version, consumes no allowance, and creates no outbox row: a `TestCopyMailerPort`
sends it through the transactional Resend client synchronously so the result is reported to the user
in-band. Rate limit **10 per user per hour** (FR-037, spec § Roles); audit
`broadcast_test_copy_sent { broadcast_id?, version_id?, recipient_hash }`.
**R**: FR-037. The outbox exists to make *system-initiated* mail durable; a test copy has no
durability requirement (the user will simply press the button again) and routing it through the
outbox would either put the full rendered body into `context_data` — content the erasure scrub
cannot reach — or require a read-at-send path for a draft that may not exist by then. It also must
not touch the Resend **Broadcasts** surface at all: that surface has its own suppression list and
reputation pool, and a test send must never enter it.
**V4 — RESOLVED (2026-09-18, maintainer)**: the shared transactional sender is
`emailSender` (`EmailSender`), exported from
`src/modules/auth/infrastructure/email/resend-client.ts:148` and already imported by the outbox
dispatcher at `src/app/api/cron/outbox-dispatch/route.ts:54` — it is a module-level singleton, not
dispatcher-internal, so it is reusable outside it. `TestCopyMailerPort` is implemented by a
broadcasts Infrastructure adapter over that sender (the port keeps Application free of the Resend
type), sends **synchronously** so the result is reported in-band, and is rate-limited 10 per user
per hour. **The sixth `notification_type` fallback is withdrawn — it is not built**, so the test
copy creates no outbox row, adds no **`notification_type`** value, and `notification_type` stays at
+5 in `0305`. That is what the migration split needs: the test copy ships in **PR-1**, whose
migration `0304` carries no `notification_type` change at all, so a sixth value would have had no
migration to live in. **It is not true that PR-1 ships the test copy with no enum change of any
kind** — `0304` does add the `audit_event_type` value `broadcast_test_copy_sent` (R24, data-model
§ 7.2, T019), because FR-037's send must be auditable. The claim is about `notification_type`
only (`/speckit.analyze` M10).

## R24 — Audit events: fourteen, in the DB-only list, with the `broadcast_` prefix

**D**: fourteen new values — `broadcast_version_started`, `broadcast_version_sent_to_member`,
`broadcast_member_approved`, `broadcast_member_changes_requested`,
`broadcast_member_approval_withdrawn`, `broadcast_member_approval_voided`,
`broadcast_schedule_confirmed`, `broadcast_approval_reminder_sent`,
`broadcast_approval_expiry_warned`, `broadcast_approval_expired`, `broadcast_test_copy_sent`,
`broadcast_brand_settings_changed`, **`broadcast_image_uploaded`** and
**`broadcast_image_removed`**. Rejection and withdrawal from a new stage reuse the existing
`broadcast_rejected` / `broadcast_cancelled`.
**R (why the two image values are new)**: spec § Audit trail names "image uploaded / removed" as
auditable. The existing `broadcast_image_*` values are **refusals and configuration**
(`broadcast_image_too_large`, `broadcast_image_unsafe`, `broadcast_image_allowlist_updated`,
`audit-port.ts:136-138`) — there is no success or removal event today, so an uploaded image leaves no
trace and an erased one leaves no record of its removal. Verified against the tuple this gate; an
earlier draft of this research said "reuse the existing `broadcast_image_*`", which was wrong.
`broadcast_image_uploaded` is emitted by all three upload routes (member, staff E-Blast, template)
with `{ owner_kind, owner_id, image_id, byte_size, mime_type, content_hash }`;
`broadcast_image_removed` is emitted when a row is stamped `deleted_at` (erasure, withdrawal,
rejection) with `{ owner_kind, owner_id, image_id, blob_deleted: bool }` — never the blob URL. (As built: sweep rows also carry `blob_disposition`, F7-1 — see `data-model.md` `deleted_at`.)
**D (the five places, F7 flavour)**: (1) `F7_AUDIT_EVENT_TYPES` in
`src/modules/broadcasts/application/ports/audit-port.ts:50-178` — **55 → 69**, and the static
assert at `:234` (`extends 55`) updated in the same edit; (2) `DB_ONLY_AUDIT_EVENT_TYPES` in
`src/modules/auth/infrastructure/db/schema.ts:522-678` — every `broadcast_*` value lives there, not
in the `auditEventTypeEnum` tuple; (3) the migration's `ALTER TYPE "audit_event_type" ADD VALUE
IF NOT EXISTS '…'`, **one statement per line** (the 0246 pattern); (4) `audit.eventType.<name>`
labels in EN/TH/SV (`en.json` "audit" opens at 6594) with Thai script, asserted by
`audit-event-label-coverage.test.ts:107`; (5) `scripts/lib/enum-migration-guard.ts`
`REQUIRED_ENUM_VALUES.audit_event_type` — plus, new here, `broadcast_status` (×5) and
`notification_type` (×5), because a silently-no-op `ADD VALUE` would 500 **every** hand-off in prod
instead of failing the deploy.
**R**: `tests/integration/broadcasts/audit-event-type-parity.test.ts:28` scopes on the
`broadcast_` prefix, so keeping the prefix (including on the brand-settings event, which is a tenant
setting rather than a broadcast) is what keeps the TS tuple ↔ `pg_enum` parity check meaningful.
`tests/unit/broadcasts/application/audit-event-type-emission.test.ts:102` requires every tuple value
to have a real emit site, so none of the fourteen may be added ahead of its emitter.
**D (payloads)**: ids, the round, the decision discriminator, `reason_length` and — for
`broadcast_schedule_confirmed` — `proposed_send_at` / `confirmed_send_at` / `differs: bool`.
**Never** the subject, body, note or reason text. `actorRole` is the session role, `?? null`, never
a literal (`check:actor-role-truth`): that resolves to **`member`** for a portal user's decision,
upload or test copy, to the staff session role for a marketing/admin action, and to **`system`** for
the reminder, warning, expiry and image-sweep rows the cron writes. The member-side events carry
snake_case `member_id` so the
0009 `last_activity_at` trigger fires (it reads only that key); the staff-side and cron-side events
carry `related_member_id` so a staff or system action does not refresh the member's recency.

---

## Carried to `/speckit.tasks` as verify-before-task items

- **V1** — `BlobStoragePort.resolvePublicUrl(key)` over `@vercel/blob`'s `head()`: confirm it can be
  added and exported from the invoicing barrel without dragging a Node-only dependency into a client
  bundle (the `sharp` / `server-only` note at `src/modules/invoicing/index.ts:531-538`). If it
  cannot, fall back to R12's rejected alternative (3) with an operator re-upload step.
- **V2** — the toolbar's shape is **decided, not open**: FR-048 requires it to **wrap onto further
  rows at 320 px**, with **no overflow menu** (hiding a control behind a menu is what the requirement
  forbids), arrow keys plus **Home/End** between controls, and a visible focus state. The live look on
  the running dev server therefore confirms the **row count** and that nothing clips — it does not
  choose between wrap and overflow. Measure it together with the first paint of the empty preview,
  the layout shift as the deferred preview settles, NVDA on the changed toolbar, and SV string
  lengths on the five new stage chips, which FR-025 requires to fit their chips in all three locales
  (SV runs up to +28 %) (exploration § C).
- **V3** — confirm the outbox dispatcher can take a tenant `tx` for the read-at-send of
  `broadcast_versions` / `broadcast_member_decisions` the way the two F114 arms do
  (`outbox-dispatch/route.ts:415-542` build a `TenantContext` from `row.tenantId` after a slug-shape
  guard and let each repo open its own `runInTenant`).
- **V4** — **RESOLVED, no task action needed**: the test copy goes through `emailSender`
  (`src/modules/auth/infrastructure/email/resend-client.ts:148`, already used by
  `outbox-dispatch/route.ts:54`) behind `TestCopyMailerPort`. No sixth `notification_type`. See R23.
- **V5** — re-read `drizzle/migrations/meta/_journal.json` immediately before writing `0304`: today
  the tail is `idx: 304` / `when: 1798543600000` / `0303_member_change_requests_reason_partial_ck`,
  so `0304` is `idx: 305` / `1798543700000` and `0305` is `idx: 306` / `1798543800000` — but a
  parallel branch landing a migration first means renumbering, and a duplicate `when` makes
  `db:migrate` a silent no-op that still prints "✓ applied".
