# PR-2 — US5 withdraw / replace / cap → US4 history (queue, member section, portal history, erasure, export)

Branch `114-member-change-approval` (fresh from `main` `62a9d09bf`, PR-1 = #360 merged). Range
reviewed: `62a9d09bf..bb54c29fa` (four implementation commits: US5 red `46003fd0f`, US5 green
`88c2399c8`, US4 red `1caeafccf`, US4 green `bb54c29fa`). Everything still dark behind
`FEATURE_MEMBER_CHANGE_APPROVAL` (default OFF, ABSENT from Vercel) and the per-tenant switch.

## Gate output at `bb54c29fa` (before round 1)

| Gate | Result |
|---|---|
| `pnpm typecheck` · `pnpm lint` (full) | clean |
| `pnpm vitest run tests/contract/` | 198 files, 2,049 passed, 2 todo |
| unit + contract subset (members · insights · portal · lib) | 3,955 passed |
| `tests/contract/rbac` (baseline +2 rows: the queue + the per-member history = `members.read`; frozen marketing set 51 → 53) | 147/147 |
| integration (live Neon `dev`, by path) | tenant-isolation 6 · erasure-scrub 1 · rate-cap 1 · queue-pagination 3 · erase-member 3 · erase-member-cascade 4 · staff-email-dispatch 6 · submit-atomicity 2 — all green |
| `check:i18n` 5,493 keys · `check:layout` · `check:staff-page-guard` · `check:api-route-guard` · `check:audit-events` · `check:actor-role-truth` · `check:authorization-role-reads` · `check:multi-tenant` | all OK |
| e2e `tests/e2e/change-requests.spec.ts` (US4 + US5 blocks) | WRITTEN, NOT RUN — T066 / T081 / T091 stay partial (needs the dev server with the flag ON) |

## Round 1 — four read-only reviewers (Opus) on `62a9d09bf..bb54c29fa`, 2026-09-12

`pdpa-gdpr-compliance-officer` (P-*), `security-engineer` (SEC-*), `reliability-guardian`
(REL-*), `enterprise-ux-designer` (ux-*) — concurrent, read-only, no subagents. Every finding
was confirmed against the code before it was fixed (108 rule 2: grep the assertion, not the
sentence). One Critical, shared by three lenses (P-1 / SEC-C1 / REL-16): the GDPR export.

### Fixed in this round

| # | Lens | Finding | Fix |
|---|---|---|---|
| 1 | P-1 · SEC-C1 · REL-16 (**Critical**) | GDPR export on behalf of a member (staff, or any requester who is not a linked contact) exported the WHOLE history including every colleague's own-contact proposals — fail-open against FR-029; the job key omitted the requester so two people asking in the same minute shared one file; `listRecentForSubject` / the portal account page listed every requester's jobs; `downloadExport`'s member arm checked only the subject | on-behalf gather → company-level only (`own_contact` dropped, `mixed` stripped, no reason / note) through the members module's own `projectChangeRequestForViewer` (viewer `null`); `exportJobIdempotencyInput` += `requestedBy` (appended only when given — directory keys unchanged); `listRecentForSubject(…, requestedBy?)` + `listMemberDataExports(tenant, member, { requestedBy })` from the account page; the member arm of `authorize()` also requires `job.requestedBy === actorUserId`; README line ×3 |
| 2 | P-2 · SEC-I1 | a non-submitter (portal list, by-id, export) received the reviewer's `decisionReason` / `decisionNote` — FR-014 gives the reason to the submitting person and it may quote their proposed values | `projectChangeRequestForViewer` nulls both for every non-submitter, all scopes; the export reuses it (P-5); negative assertions in the unit + contract + adapter suites |
| 3 | REL-1 | lock-order inversion: erase locked the member row (`FOR UPDATE`) THEN the request rows (scrub); submit / decide lock request rows THEN the member — an erasure racing a submit could deadlock | the scrub is the FIRST statement of the erase tx (request rows → member row, the submit / decide order); the unit seam asserts scrub-before-member-lock |
| 4 | SEC-I2 · REL-2 | with PR-1's interim Upstash cap removed the route had no attempt-level bound: the gate / validation / `countSubmittedSince` path ran at line rate under a rotating key | attempt bucket `f114:submit-attempts:<tenant>:<user>` 60 / 10 min (atomic `check`) before the gate and the body, consumed on every outcome, 429 with the same envelope; the durable cap stays the FR-008 rule; contract pins both |
| 5 | SEC-I3 | the two new by-id 404 arms (portal `…/[id]`, admin `…/members/[id]/change-requests`) answered a foreign / unknown id without the `member_cross_tenant_probe` record every other change-request miss writes (FR-035, Constitution I.4) | `getPortalChangeRequest` audits the miss (`action: 'history_item'`) and counts an in-tenant not-yours as `refused{not_owner}`; the admin route audits a member miss (`action: 'change_request_history'`); the live isolation test asserts the probe row in the probing tenant |
| 6 | REL-3 · P-7 · REL-4 | `member_change_request_rate_limited` carried `member_id` — the 0009 recency trigger bumped `last_activity_at` on a REFUSAL; the payload had no type in `ChangeRequestAuditPayload` | `related_member_id`, typed + `satisfies`; contract row, port docblock, unit / contract / live assertions (`not.toHaveProperty('member_id')`) |
| 7 | REL-5 · REL-6 | the rate-cap live test deleted `UPSTASH_*` from the shared fork's env without restoring it; its "no limiter" proof was an env assertion (proves nothing about the code) | env restored in `afterAll`; a SOURCE assertion on `submit-change-request.ts` with a positive control (`countSubmittedSince(` present; no `auth-deps` import / `rateLimiter.check(`) |
| 8 | REL-7 · REL-8 · REL-9 | pagination test: 1-second spacing never reached the keyset tie-break branch; it measured the repo alone, not the use case's two transactions; no ASC-direction EXPLAIN | 300 rows share one `submitted_at` (≥ 2 tie boundaries asserted); the loop drives `listChangeRequestQueue` (page + `pendingStats`), p95 after warm-up; `it.each` EXPLAIN for DESC and ASC |
| 9 | P-4 | an ERASED address group (`'[erased]'` under an address key) rendered as "(empty)" in the diff table and the staff value display — reads as "the member proposed to clear the address" | both renderers show a string value as text before the address branch; unit test with three erased fields |
| 10 | P-6 · SEC-S2 | the column-coverage guard read a hand-copied constant the adapter never saw | the adapter exports `FIELD_SCRUBBED_COLUMNS` / `REQUEST_SCRUBBED_COLUMNS`; every `.set({…})` is `satisfies Cols<…>` against its own list; the guard imports them (positive control: non-empty) |
| 11 | P-11 · REL-15 | the erasure live oracle never checked the NOTE (the one free-text field the seed writes) nor a re-drive | `not.toContain(NOTE)`, an address group in the seed (jsonb sentinel read-back), a second `eraseMember` → no new closure, `withdrawn_at` unchanged |
| 12 | ux-C1 | the member chip fell back to the raw uuid on an empty page | resolved from `memberRepo.findById` (company name; "a member that could not be found" on a miss; a fault throws) |
| 13 | ux-C2 · REL-11 | the 200 withdraw path did not refresh the server tree — `/portal/edit`'s form + hint kept describing a withdrawn request | `router.refresh()` on 200 (and 404); the banner test asserts it |
| 14 | ux-C3 | the banner hand-rolled `finalFocus` (trigger, else `#main-content`) — Base UI does not focus the landmark it is handed (the 2026-09-10 e2e finding) | `useDialogFinalFocus(triggerRef, undefined, closedViaSuccessRef)` — the shell's own rule |
| 15 | ux-I1 · I2 · I3 · I4 · I5 · I6 · I8 · I9 · I10 · I11 | table caption; row-link `aria-label` "Review the request from {company}"; `submitter` kept as a hidden input + a chip whose "show all" keeps the other filters; loading skeleton in the page's shape (filter bar + 7-column rows); `[id]/error.tsx` with `DetailContainer`; the outcome select only on `state=decided` and never counted as a filter otherwise; the pending summary on the default view only; section failure `role="status"` + `InlineAlert tone="destructive"`; row links `h-9`; TH term unified to "คำขอแก้ไขข้อมูล" (12 sites) | as listed |
| 16 | UX cheap · S13 | orphan `queue.rowMeta` ×3 removed; distinct `tableCaption` / `reviewFor` / `viewFor` keys; native selects carry the focus ring; the summary is not muted; `partially_approved` badge `outline`; `flex-wrap` on the section header; the skeleton drops `aria-busy` (already `aria-hidden`); a 503 on withdraw has its own copy (`withdraw.readOnly` ×3, tested) | as listed |
| 17 | REL-12 · REL-13 | the queue page's deep-link path called `changeRequestRepo.listQueue` directly (Presentation → port, no Complexity-Tracking line); `fail()` was `never` on the arrow only, so three `ok ? value : fallback` branches rendered an empty page if anyone ever made it return | the deep link goes through `listChangeRequestQueue`; `fail` is typed `never` on the binding and the fallbacks are gone |
| 18 | REL-14 · SEC-S4 · S7 · S8 · P-8 (S9) | docblocks: the keyset's millisecond resolution + the backfill rule (port); the outbox-cancel rationale said the member address is "re-read at dispatch" (it is frozen at enqueue); the dialog's "initialFocus on Cancel" comment; `refused` metric "before any write"; the 0300 index comment named a consumer that "will" exist | rewritten (the migration edit is comment-only; `run-migrations.ts` compares journal timestamps, not content) |
| 19 | SEC-S1 · SEC-S3 · P-3 · P-9 · P-10 | contract / quickstart / RoPA wording: "mint a new key after a 429" (the record is reserved before the refusal); `scope` reaches a non-submitter (intended, stated); README wording; RoPA gains the export category + the sent-outbox retention note | `contracts/portal-change-requests-api.md`, `quickstart.md` § 1 US5 + § 3, `gdprExport.readme.files.changeRequests` ×3. P-9 ("a duplicated quickstart line"): re-read at HEAD, no duplicated line found — nothing applied |

### Not taken (with the reason)

| Lens | Finding | Why not |
|---|---|---|
| ux-I7 | no "any state" view (pending AND the rest) | `state` is contract-defined as an exclusive filter with a `pending` default (contracts/admin-change-requests-api.md); FR-027's "pending first" is the ordering inside one list. A spec change, not a fix |
| REL-10 | a failed `audit.record` on the `rate_limited` path is log-only (no counter) | same class as PR-1's forged trail (`auditForged`) — a cross-cutting "audit write failed" metric is one change for every best-effort audit site, tracked for the F114 observability task (T106) rather than one arm here |
| REL-17 | `withdrawChangeRequest` emits no metric; the two OTel spans in contracts § 4 are not in the code | withdraw has no row in the § 4 metric table (not a contract violation); the spans are T106 (Phase 9) |
| S11 · S14 | indentation / wording nits in test docblocks | cosmetic; left to avoid churn in files this round already rewrote |

## Round 2 — `whole-branch-reviewer` (fable) seam pass on `62a9d09bf..a44d9bf81`, 2026-09-12

Verdict: MERGEABLE WITH FIXES (no BLOCKER). Five findings, all confirmed against the code
before the fix; the two seams are exactly the kind a single-surface lens cannot see — both are
consequences of round 1's REL-1 reorder.

| # | Sev | Finding | Fix |
|---|---|---|---|
| 1 | HIGH | the REL-1 fix moved the scrub first, but its id read was a plain SELECT and its FIRST write hit `member_change_request_fields`; the request rows were locked only by statement 2. `decideInTx` locks the request row first (`readOne(…, true)`) and writes the field rows LAST — a new AB-BA with decide on (field rows ↔ request row); the unit seam asserted mock call order, not the lock graph | the id read is `SELECT … FOR UPDATE`: the request rows are the scrub's first lock, before any field row; erase / submit / decide now all serialise on the request row. Reasoned from the statement sequences (not reproduced live); comments rewritten in the adapter + the erase tx |
| 2 | MEDIUM | after the reorder an in-flight submit that waited on the member lock resumed after the erase committed and inserted a pending request with live PII: submit's in-tx re-check read only `status === 'archived'`, and an erasure keeps `status`, stamping `erased_at` only (decide already reads `findErasedAtByIdInTx`) | submit reads `erased_at` on the same tx after the FOR UPDATE re-read and refuses as `member_archived` (the member is gone either way; the contact's session is revoked by the erasure); deps `Pick` widened; unit test pins order + zero writes; the replace contract's double carries the method |
| 3 | MEDIUM | quickstart's "PR-2, unflagged" list omitted the three round-1 changes to the LIVE F9 export surface (member download arm, account-page listing, job key) — a member can no longer download an admin's on-behalf archive, flag OFF or not | listed with the rollback consequence (a code revert) |
| 4 | MEDIUM | the `GdprArchiveSource` port docblock said an on-behalf request exports the WHOLE history — the adapter and its test do the opposite (round 1 C1); the next implementer would re-open the Critical | docblock states the adapter's rule |
| 5 | LOW | the queue page's REL-12 comment claimed "like every other read here" while the ux-C1 member chip reads `memberRepo.findById` directly (the member-page idiom) | comment corrected |

Refuted by the pass (recorded so it is not re-raised): attempt bucket vs idempotency (the bucket
runs before key parsing, reserves nothing); every changed arity's consumers updated; every new
read inside `runInTenant`; i18n parity of the added / removed keys; `related_member_id` typed;
erase ↔ submit and erase ↔ contact-crud lock order sound; the sentinel round-trips for address
groups.

### Re-review of the round-2 fixes (same reviewer, commit `c8a6017b1`)

Verdict: MERGEABLE WITH FIXES. Fix #1 confirmed sound (the lock graph after the change: erase =
request rows → field rows → member → contacts; decide = request row → member → contacts → field
rows; submit = pending row → member; withdraw = pending row; contact-crud = member → contacts —
no pair acquires two shared rows in opposite order). Fix #2 confirmed for the interleaving
reported. Fixes #3–#5 match the code. One residual of the same seam, one LOW:

| # | Sev | Finding | Fix (commit after `c8a6017b1`) |
|---|---|---|---|
| 1 | MEDIUM | the scrub's `FOR UPDATE` snapshot is taken BEFORE the member lock, and READ COMMITTED never adds rows INSERTED after a statement started: a submit that held the pending row first (its replace path) commits a NEW request between the snapshot and the erase's member lock; `findErasedAtByIdInTx` does not catch it (the erase has not committed), and nothing in the erase tx rescanned after the member lock — the new row stays pending with live PII on the erased record, its staff email queued after the outbox cancel (ms-scale window; not reproduced live) | `ChangeRequestScrubPort.listRequestIdsInTx` (non-locking, same tx) called right after the member `FOR UPDATE`; any id the scrub did not see → the erase throws (`change_request_race:<n>`), the tx rolls back to `server_error`, the retry / re-drive scrubs the new row too. No new lock, so no new AB-BA. Unit test pins the rescan AFTER the member lock and zero scrubs / no `member_erased` on the race |
| 2 | LOW | an erased member is refused by submit as `member_archived` (403 "archived", metric `refused{archived}`) while decide names `member_erasing` | accepted as is: the contact's session is revoked in the same erase tx, so the message is unreachable in practice; a dedicated metric reason is not worth a new bucket |

### Final re-review (same reviewer, commit `b7afc1bcb`)

Verdict: **MERGEABLE**. Every concurrent-submit interleaving is now either rescanned-and-aborted
(a submit that committed before the erase's member lock) or refused by `erased_at` under the
member lock (a submit that waited on it); `insertInTx` has ONE caller and it takes the member
`FOR UPDATE` before the insert, so no row can land between the rescan and the erase's commit.
The rescan takes no lock — the lock graph is unchanged. Every consumer of the scrub port
(one implementer, one caller, two hand-built integration deps on the real adapter, the fake,
the fixture, `members-deps.test.ts`) carries the method. Noted: the race arm answers
`server_error` to the admin (a throw, not a typed refusal); the retry re-drives.

## PR-1's deferred items, closed here (the maintainer's ask, 2026-09-12)

PR-1's ledger (`reviews/pr-1.md` § "Deferred with a written owner") assigned eleven items to
PR-2. Their one-line summaries were re-derived against this branch by `enterprise-ux-designer`
and `thai-tax-compliance-auditor` (Opus, read-only) before closing — each below was found at a
file:line first, never rebuilt from the summary.

| Item | State found | Closure |
|---|---|---|
| T078 erasure scrub + outbox cancel · T087 durable cap + coalescing (the two pre-flip gates) | closed by US4 / US5 | — |
| Whole-branch #10 (`listVisibleToUser` returned a colleague's `mixed` values) | closed by US4 + round 1 C2 | `projectChangeRequestForViewer` |
| Rel M-5 — the profile page and the gate route read the pending row with the `FOR UPDATE` finder (a render queued behind a decide / submit) | OPEN | `ChangeRequestRepo.findPendingBySubmitter` (plain read, own `runInTenant`) for the READ paths; the writers keep `…InTx`. Live proof: the plain read returns while a holder keeps the row `FOR UPDATE`, the locking one queues (positive control) |
| Mig M-2 — unindexed FK columns `decided_by_user_id`, `submitted_by_contact_id`, `replaced_by_request_id` | OPEN | migration `0302` (tenant-first; the two nullable ones partial) + the Drizzle schema + a `verify-schema` canary; applied to dev, read back from `pg_indexes` |
| Mig M-5 — `decideInTx` ran one UPDATE per field row (up to nine round-trips) | OPEN | one `UPDATE … FROM (VALUES …) RETURNING field_key`; a key with no row still rolls the tx back (live case). The raw-SQL param path does not serialise a Date — `applied_at` goes as ISO text with a cast (found on the first live run) |
| Tax M7 — FR-022's live proof covered the billing-address branch only | OPEN | a billing-less member case: the registered-address change is flagged (the registered address IS the buyer address, §86/4(3)) and its approval leaves the issued snapshot byte-identical |
| Tax M6 — no hint that CLEARING the billing address switches the buyer address to the registered one | OPEN, two surfaces | `billingAddressHint` ×3 says so on the portal form; the review page gets a `billing_cleared` tax hint (new `TaxHint` arm + copy ×3, unit case) |
| Tax M8 — primary-ness frozen at submission | CLOSED already (`submitter_role_at_submission` feeds the hint and the subtitle) | — |
| UX M13 queue paging · M14 route-level `error.tsx` | CLOSED by US4 | — |
| UX M12 — one generic sentence for every server 422 rule | OPEN (highest impact) | per-rule copy from the issue's message / code (phone, website scheme, too long, required, country; the generic line only for an unknown rule) — zero new keys; unit test with six issues |
| UX M11 — the four conditionally-required billing lines carried no marker; no "* required" note | OPEN | `required` follows `billTouched` (any billing line filled ⇒ line 1 / city / postal code / country marked + `aria-required`); `requiredNote` ×3 at the top of the form |
| UX M4 — the review loading skeleton was one subtitle line + a badge short of the page; neither admin skeleton was announced | OPEN | header in the page's shape (subtitle + badge + action), the footer's summary + button, both admin skeletons in `PageSkeletonShell` |
| UX M1 — the edit page's tab title said "Edit Profile" while the H1 said "Propose changes" | OPEN | `generateMetadata` resolves the gate (one settings read, never throws; falls back to the immediate title) |
| UX M8 — the member section's list carried an `aria-label` duplicating its `<h2>` (announced three times); the review page's decision table had no heading at all | OPEN, both halves | the `aria-label` + its dead key dropped ×3; the table sits in a `<section>` under a new `<h2>` "Proposed changes" ×3 |
| UX M5 — the queue's two chip links were colour-only inside a non-muted paragraph (WCAG 1.4.1) | OPEN | persistent `underline` (the in-paragraph rule; the privacy link already followed it) |
| UX M17 — six SV strings used an en dash where EN, TH and the rest of `sv.json` use an em dash | OPEN | the six strings |
| UX M9 / M10 — "sections are real fieldsets with legends" | the CODE was right (Cards with a real `<h2>`; no radio / checkbox groups) — the docblock was wrong | docblock corrected; no fieldset conversion |

### Re-review of the PR-1 closures (the same two agents on `22671112b`)

UX: every item CLOSED; two defects on M17 — `withdraw.gone` was missed and the substring
replace hit `renewals…cycle_not_pending` (a string this item did not own) first — both corrected
(the renewals string restored); the billing hint now ends its first clause with a full stop in all
three locales and the TH tail says คุณ like the rest of the namespace. One residual raised and
**deliberately left**: `portal/edit/loading.tsx` still shows the "Edit Profile" title and a 6-field
skeleton in approval mode — a loading skeleton cannot resolve the gate without the settings read
the page itself is about to make; the page's own header replaces it within the same navigation.
Tax: M7 CLOSED (the ordering assumption holds — no `sequence` / `shuffle` in the integration
config; the cleared-billing state is exactly the 0284 composer switch); M6(a) CLOSED; **M6(b)
NEEDS FIX — the `billing_cleared` arm tested `proposed === null`, but a CLEAR never arrives as
`null`: the form always sends the seven-line group ('' → null) and `normaliseAddress` never yields
null, so the arm was dead code and its unit case a frozen fixture.** Fixed: the predicate is
`line1 === null` (the one `resultingHasBillingAddress` and 0284's CHECK use); the unit case now
runs the real wire shape and keeps the literal-null one as a defensive twin.

### Migration re-review (`drizzle-migration-reviewer`, Opus, on `22671112b`)

Verdict: MERGEABLE WITH FIXES — all taken. **M1 / M2 (MEDIUM):** the two FKs to `users(id)` are
SINGLE-column, so their RI check is `WHERE $1 = <column>` — a tenant-first index cannot serve it
(no skip scan before PG 18; one tenant degenerates it anyway), and `submitted_by_user_id` was the
FOURTH such column the first cut missed (its two tenant-first indexes do not serve the RI check
either). `0302` is edited IN PLACE (never run on prod — the 0300 precedent): `(decided_by_user_id,
tenant_id) WHERE NOT NULL` + a plain `(submitted_by_user_id)`; the two composite-FK indexes stay
tenant-first (both columns are equalities in their RI check); the Drizzle schema and the canary
follow, and the canary now also checks the leading column. On dev the old index was dropped and
the two new ones created by hand (the runner records `0302` as applied). A live positive control
`EXPLAIN … WHERE <column> = $1` under `enable_seqscan = off` names the index for both columns —
the name-counting canary cannot see column order (tightened on the reviewer's confirmation:
the plan must show `Index Cond:`, since an index scan with the qual demoted to `Filter` prints
the index name too). The reviewer's one residual on the confirmation: the migrator skips by
`created_at < folderMillis` only (the hash is stored, never compared), so a `preview/*` branch that
ran the first cut would never re-run the file — `0302` now opens with `DROP INDEX IF EXISTS` on
the first cut's index (idempotent across both cuts; a no-op on a fresh database). **L1:** `decideInTx` refuses duplicate keys
before building the VALUES list (defence-in-depth — the use case already refuses them). **L2:**
the no-row live case picks a key the fixture does not propose from `PROPOSABLE_FIELD_KEYS`.
Verified OK by the reviewer: VALUES-batch under RLS FORCE, the two CHECKs per row, the real
rollback path, the casts (live both ways), the journal `when` (global max, +100000), no Drizzle ↔
SQL drift, the lock order incl. the DEFERRABLE self-FK and the partial unique index, and the
rescan — with the DB's own second layer: a new request's RI check takes `FOR KEY SHARE` on the
`members` row the erase holds `FOR UPDATE`, so no submit commits a row after the member lock.

## After PR #366 opened — the CI catch + the filter-bar pattern (2026-09-15)

Five of the six required checks passed on `cdf5a1e95`; **`Unit + contract coverage vs pinned thresholds`
failed**: `erase-member.ts` is pinned 100 / 100 / 100 / 100 in `vitest.config.ts` and the seam re-review's
post-lock rescan (`b7afc1bcb`) added a `!rescan.ok` throw with no test (lines 99.65 %, branches 97.08 %),
plus every `'cause' in error ? … : undefined` narrowing — scrub, closure audit, outbox cancel, rescan —
had only the with-cause side exercised. Nothing local enforces the pins: `pnpm test` and the pre-push hook
run without `--coverage`, so six review rounds and three pushes were green on a file CI would refuse.
Fix is test-only: `erase-member-change-requests.test.ts` now drives each port failure with and without a
cause (`repo.not_found`), measured back to 100 % on all four axes with
`vitest run <suites> --coverage --coverage.include=<file>` — the check to run before pushing a branch
that touches any pinned file. The Vercel preview on the same push also failed
(`BUILD_EXCEEDED_MAXIMUM_TIME`: the build finished in 4 min, "Deploying outputs" hung for 41 min); the
five earlier previews of this branch were READY, Vercel is not a required check, and the next push
redeploys.

The maintainer also flagged the queue's filter dropdowns as the wrong pattern: `page.tsx` rendered a
server `<form method="get">` with two NATIVE `<select>`s — the one admin filter surface not on the shadcn
`Select`. Replaced by `_components/queue-filters.tsx` (client; the `credit-note-filters` / member-page
invoice shape: controls stage locally, Apply patches the URL with `router.replace` + `scroll: false` and
drops the cursor, Clear drops every param; the outcome `Select` exists only while the STAGED state is
`decided` and leaving `decided` resets it). Unit test `change-request-queue-filters.test.tsx` (7 cases,
RED first on the missing module). `enterprise-ux-designer` (Opus, read-only) on the first cut: **NOT
MERGEABLE — B1**: a Base UI `SelectTrigger` is a `<button>`, and `<label for>` names a native `<select>`
but never a button, so both comboboxes had NO accessible name — a regression from the native select — and
no test could see it (the unit stub is a plain button and jsdom's name computation polyfills
`label[for]` → button; axe's `aria-input-field-name` skips buttons). Taken: B1 (`aria-label` on both
triggers + an e2e `toHaveAccessibleName` on the real primitive), H1 (never `disabled` while pending —
a focused button that turns disabled drops focus to `<body>`; `aria-busy` + re-entry guards; Clear parks
focus on Apply before it unmounts), M1 (the loading skeleton reserved 4 controls for a 3-control default
view), M2 (outline / ghost at the default size — `size="sm" className="h-9"` kept sm text), M3 (phone:
buttons fill the row), M4 (`lg:col-start-5` so choosing "Decided" does not shove the buttons), M5
(`hasFilters` reads the URL the way the page's `filtered` does), L1 (keyed on the URL filters — Back /
Forward re-stage), L2, L3, L4. Not taken: H2 (a live region announcing the applied result — no sibling
filter bar does; parked for the PR-3 polish round), L5 (`useId` — single instance, the e2e asserts the
ids). Re-review of those fixes: every item CLOSED but **N1 (HIGH, new)** — the `key` used for L1 remounted
the bar on every Apply / Clear, which destroyed the button the admin had just pressed and dropped focus
to `<body>`, undoing H1; the unit case could not see it because it rendered without the key. Fixed with
React's adjust-state-during-render (`urlKey` / `stagedFor`: the same instance re-stages from the URL,
never a remount); the unit test now swaps the URL under the same instance and asserts the Apply node is
the SAME element and still focused (mutation-checked). Also N2 (`aria-busy` has no styling anywhere in
the app — `aria-busy:opacity-70` gives back the visible "working" dim `disabled` used to), N3 (the e2e
`toHaveAccessibleName` is a smoke check only — Playwright's accname, like jsdom's, honours
`label[for]` → button; the guard is the unit `toHaveAttribute('aria-label', …)`). N4 (a pre-hydration
Enter in a date input submits a bare GET) parked for PR-3. Third pass: **MERGEABLE**; its two LOW
residuals taken too — R1 (the bar echoed a raw `?from=` / `?to=` the page's zod would refuse along with
the whole query; now the same `YYYY-MM-DD` shape gates what is staged and what counts as a filter) and
R2 (the e2e queue case presses Apply and asserts the button keeps focus — the call-site guard a unit
test of the child cannot be).

## PR review — `/pr-review-toolkit:review-pr #366`, five read-only Opus reviewers on `62a9d09bf..069d5872a` (2026-09-15)

code-reviewer · pr-test-analyzer · comment-analyzer · silent-failure-hunter · type-design-analyzer, each
told to read the ledger first and not re-raise closed items. No logic Critical; four Critical findings
were about what the artefacts CLAIM (and one about what the tests can see), and every Important was
taken. **Taken:**

- **Queue page dates (code I1 = silent I-1).** `?from=2026-02-30` matched the shape regex and
  `tenantDayStartUtc` threw — a 500 on a hand-edited URL, against the page's own "a bad filter is a bad
  link" rule and the helper's `MUST validate with isYmd` docblock (the only caller that did not). The
  schema now refines with `isYmd`, validates each filter on its own (`.catch(undefined)` — one bad value
  drops itself, the others stay; the bar, which reads the raw URL, used to disagree with the list), keeps
  the cursor strict (a malformed one is a 404), and takes the day bounds from `env.tenant.timezone`
  instead of a hard-coded Bangkok. The bar's `ymd()` is calendar-valid too (a UTC round-trip, no js-joda
  in the client bundle) and `hasFilters` counts only values the page would keep.
- **Types.** `member_change_request_submitted` / `_decided` payloads carry the `?: never` twin the two
  newer arms had (a spread cannot smuggle the 0009 trigger key); `ChangeRequestListFilter` admits an
  `outcome` only with `state: 'decided'` — the queue route used to apply `?state=pending&outcome=…` and
  answer an empty page while the page dropped it, now both drop it; `mapRefusal` closes its `default`
  with a `never` check (a new refusal arm fails the build instead of becoming an unremembered 500);
  `decidedBy` is an explicit pick on both wire projections; `ExportJobIdempotencyParts` is a union on
  `kind` — the GDPR arm REQUIRES `requestedBy` (round 1's C1 was enforced by a comment), the directory
  arms forbid it; the redundant `as UserId` casts on the page are gone; the billing tax-hint arm reads a
  `BillingAddress`, and an ERASED request (the sentinel string) hints `buyer_address`, never
  `billing_cleared` (the third reader of the sentinel — the two renderers already knew).
- **Silent failures.** The attempt bucket never "failed open": the limiter's fallback is a per-process
  window (the cap holds per serverless instance) — the docblock, contracts and quickstart said the
  opposite; the route now logs `attempt_bucket_fell_back` and `attempts_exhausted` (the one F114
  refusal with no audit row had no log either); the submit route's 500 log carries the repo code (`type`
  alone was always `server_error`) and the two pre-tx reads log their cause; a GDPR requester who is
  not (or no longer) a linked contact logs `M114.gdpr.requester_not_linked` (their own export is then
  narrower than asked — the same scope as staff on behalf, but a different event); the portal profile
  renders a `role=status` "could not load your pending request" alert instead of the page that says "no
  request pending" (three fault arms; the throwing gate resolver has its own errorId); the edit page's
  metadata catch logs.
- **Comments / artefacts.** Migration 0302's "idempotent across both cuts" was false both ways — the
  same `when` means a database that ran the first cut never re-runs it, and a re-run would hit 42P07 on
  two names: the file is now `CREATE INDEX IF NOT EXISTS` throughout with its `when` bumped
  (+100000 ms → 1798543500000), re-applied on `dev` (four "already exists, skipping" notices,
  `db:verify` green), so the PR's preview branch heals itself. `tasks.md` T083 recorded the rate-limit
  payload as `member_id` (the key the port type forbids); T074 / quickstart / the T072 row still said
  "GET form"; T075 said `role=alert` for a deliberate `role=status`; the admin contract carried a
  verbatim duplicated block and the quickstart a duplicated line; the listQueue port doc named only the
  DESC keyset predicate; the "opaque cursor so a client cannot craft one" claim; the erase-member
  outbox comment gave the opposite reason from its port; the gate resolver's "one read per request"
  (two per edit render); the filter bar's "only a native select takes a label" (a button is labelable —
  its name simply comes from content). Copy: the queue subtitle no longer says "awaiting a staff
  decision, oldest first" over a decided view; "Submitted until" → "up to and including" (the bound is
  inclusive); the GDPR README says what an on-behalf archive holds; a neutral `columns.actions` header.
- **Tests (pr-test-analyzer).** The FR-029 list path had no assertion that could fail at either layer
  (the live seed was all `mixed`, so `every(scope !== 'own_contact')` was vacuously true; the fake
  pre-filtered, so the use case's fail-closed filter was a no-op) — a real `own_contact` seed with a
  positive control, and a leaky double for the use case; a live lock proof for the scrub's
  `FOR UPDATE`; `pendingStats` asserted across tenants (it relies on RLS alone); the F114 events
  asserted to reach `member_timeline_v` (the #336 class); the exact idempotency strings; the
  change-request truncation; the `decideInTx` duplicate-key guard; the erased-sentinel tax hint; the
  pagination docblock's "three boundaries" / "the page query" corrected; the 0302 RI positive control
  reframed or made to model the RI check.

**Not taken (with the reason):** the by-id probe audit has no attempt bound (the house pattern —
`getMember` does the same; PR-3 polish with the metric split `attempt_throttled` vs the durable cap,
silent S-2); the banner reads only the status of a 404, not its body (the flag-flip race, silent S-4);
`DELETE …/current` has no bucket (silent S-5); the account hub's export list still degrades to empty
on a read fault (F9's contract, silent S-6); the status badge's flat props (types I3 — a display
fallback the DB CHECK makes unreachable) and the `GdprChangeRequestEntry` / `actor_role` string typing
(types S4 / S6); `useId` on the bar; the EXPLAIN control on the real joined query (docblock corrected;
the real-query EXPLAIN is PR-3 with T119's revisit); the `repoErrorCause` helper (S8).

### The fourth push — the queue p95 budget inside the pre-push folder run

The push carrying the review closure was refused by its own gate: the 5,000-row pagination suite's
p95 measured 1,315 ms (budget 400) inside the members folder run — 108 files in ONE long-lived fork
(`singleFork`), so the client-side timer carries that process's retained state and GC on top of
whatever shares the Neon compute — while the same walk alone measures ~300 ms a page (14.7 s for 50
pages, re-run right after).
The third push had passed the same assertion by luck. `tests/helpers/ci-latency.ts` already states the
rule: a per-query budget "should take its threshold from an env var the workflow sets, or not run in
the sweep at all". So `.husky/pre-push` now runs a module folder with `INTEGRATION_FOLDER_RUN=1`, and
the suite asserts the p95 only when it runs alone (or when `QUEUE_PAGE_P95_BUDGET_MS` is set) — in a
folder run it REPORTS the p95 and still asserts the walk, the order, no gap / duplicate and the EXPLAIN
control. Both modes proven: `QUEUE_PAGE_P95_BUDGET_MS=1` under the folder flag fails (312 ms > 1), the
folder flag alone reports and passes.

### code-simplifier pass (the maintainer's "รันเลย", Opus, source only)

Seventeen source files, no test edited, behaviour kept — `repoErrorCause(RepoError)` for the eight
`'cause' in error` narrowings this branch added; the diff table renders `ProposedValueDisplay` instead
of its byte-identical inline copy; `pickDecidedBy`, `filterParams(drop?)`, `SCOPE_PARAMS` +
`stagedState` / `stagedOutcome`, `BILLING_GROUP_FIELDS` shared by the schema and `billTouched`,
`parseCursor`; the port-typed `tx` in the two adapters (four casts gone) and three `as UserId` casts
on the GDPR requester; nested ternaries → named rules with `void _exhaustive` (`waitedUntil`,
`statusMessage`), so a fourth state is a compile error. Left on purpose: the badge's fail-soft `else`,
the POST success-shape ternary, JSX conditional chains. Gates after the pass: typecheck 0, full lint,
unit + contract 410 files / 3,952 tests, integration by path (erasure-scrub, repo, rate-cap), e2e US4 +
US5 on chromium 6 passed / 1 skipped (persona).

## Gate output at the branch head `39e5fcbb6` (after the PR-1 closures + their re-reviews)

| Gate | Result |
|---|---|
| `pnpm typecheck` · `pnpm lint` (full) · `check:i18n` 5,501 keys · `check:layout` · `check:staff-page-guard` · `pnpm db:verify` (dev, incl. the 0302 canary) | all OK |
| `pnpm test` (the whole Vitest suite, tree `29e7c9ecb`; the last commit changed one SQL file + one live test + the ledger) | 1,272 files, 14,360 passed, 2 todo |
| integration (live Neon `dev`, by path) | tax-immutability 2 · repo 14 (incl. the plain-read lock proof, the single-UPDATE no-row rollback, the two EXPLAIN controls) · decide-rollback · submit-atomicity · concurrency — all green |
| e2e `tests/e2e/change-requests.spec.ts` on the maintainer's dev server (flag ON), `--workers=1` | before the closures: chromium 13 passed / 2 skipped (persona) / 1 flaky (US3 dismiss — dev-mode first-hit route compile; retry passed), mobile-chrome 14 / 2 skipped; after `22671112b`: chromium 14 passed / 2 skipped, no flake |
| re-reviews of the closures | UX, tax, migration: all CLOSED / MERGEABLE (`29e7c9ecb`, `39e5fcbb6`) |
| pre-push gates on the push (static + `tests/unit/architecture` + the insights AND members integration folders) | two catches, both test fidelity: (1) the F9 GDPR archive oracle pinned the file list without `change-requests.json` (`52f656ea9`); (2) the 5,000-row pagination suite seeded three tables and never ANALYZEd them — with 0302's indexes present the planner, believing every table held one row, picked a different tenant-leading index and sorted all 5,000 rows a page, and joined members / contacts as a materialised 200 × 200 cross product (688 ms a page, measured with EXPLAIN ANALYZE). The suite now ANALYZEs the three tables after seeding (the steady state production has); 50 pages walk in 15.6 s. Third push green |

## Gate output after rounds 1 + 2 (branch head `b7afc1bcb`)

| Gate | Result |
|---|---|
| `pnpm typecheck` · `pnpm lint` (full) · `check:i18n` 5,499 keys · `check:layout` · `check:staff-page-guard` (50) · `check:api-route-guard` (123) · `check:audit-events` · `check:actor-role-truth` (0 fabricated) · `check:multi-tenant` (28) · `check:fixme` · `check:dates` | all OK |
| whole `tests/contract/` + `tests/unit/{members,insights,app,lib,architecture}` (after round 1, `a44d9bf81`) | 558 files, 5,552 passed, 2 todo |
| `tests/contract/{portal,members,insights}` + `tests/unit/{members,insights}` (after round 2, `c8a6017b1`) | 264 files, 2,489 passed, 1 todo |
| erase unit suites after the rescan (`b7afc1bcb`) | 87 passed |
| integration (live Neon `dev`, by path) | after round 1: rate-cap 2 · erasure-scrub 1 · tenant-isolation 6 · queue-pagination 4 · export-job-repo · account-hub-cross-tenant · erase-member — 34 passed; after round 2: erasure-scrub · submit-atomicity · concurrency · erase-member — 8 passed; after the rescan: erasure-scrub · erase-member · erase-member-cascade — 8 passed |
| e2e | still NOT RUN (T066 / T081 / T091 partial — the dev server env needs the flag) |

## PR-3 polish — the items parked in PR-2 (2026-09-15)

Each item TDD'd on the branch after US6 (`467f7e7d9`): the RED evidence is the failing run named
per bullet; the coordinator runs e2e.

- **S-2 the by-id probe audit has no attempt bound + the metric split.** `GET …/[id]` and
  `POST …/[id]/acknowledge` now consume a per-actor PROBE bucket (10 / 10 min per tenant + user,
  `f114:history-item-attempts:…` / `f114:acknowledge-attempts:…`) after the member context (and
  READ_ONLY_MODE on the write), before the id is parsed — so the `member_cross_tenant_probe` row a
  miss writes into the append-only trail is bounded; `ChangeRequestRefusedReason` gains
  `attempt_throttled` (the limiter refused before any read) and the submit route's bucket now
  counts that instead of `rate_limited`, which is the DURABLE cap's reason alone. The three
  routes share `src/lib/change-request-attempt-bucket.ts` (`refuseWhenAttemptsExhausted` — the
  caller passes its own `M114.<route>` prefix, so T107's "names itself" rule holds; no shared
  literal). RED: `change-requests-history.test.ts` + `change-requests-acknowledge.test.ts` (the
  11th call → 429 + `Retry-After`, no audit row, nothing stamped, metric `attempt_throttled`;
  the bucket consumed on a hit too) and the submit test's reason assertion — 4 failed, then green
  (9 files / 100 tests across the portal contract suites + the error-id guard). Docs: § 14.1 /
  § 27.1 reason lists, `contracts/portal-change-requests-api.md` (the two 429s, the probe bucket,
  the test map). Decision the ledger did not settle: the probe size is 10, not the submit
  route's 60 — no UI calls `GET …/[id]`, the decision banner posts one acknowledge per dismiss,
  and 10 is the figure the durable cap already uses per day.
- **S-4 the banner reads the 404 body.** `pending-request-banner.tsx`: `no_pending_request` →
  the "gone" message + refresh (unchanged); any other 404 (`not_found` — the platform flag turned
  off between render and click) or an unreadable body → `hidden`: renders nothing, refreshes,
  logs nothing (nothing failed). RED: two cases in `pending-request-banner-withdraw.test.tsx`
  (rendered "gone" for the flag-off body) → green (9 cases).
- **S-5 `DELETE …/current` has no attempt bucket.** The submit route's bucket
  (60 / 10 min, `f114:withdraw-attempts:…`) after READ_ONLY_MODE, before the use case. RED:
  `change-requests-withdraw.test.ts` (exhausted → 429, the row still pending, no audit row,
  `attempt_throttled`; READ_ONLY_MODE answers before the bucket is consumed) → green.
- **S-6 the account hub's export list degrades to empty on a read fault.**
  `src/app/(member)/portal/account/page.tsx`: `exportsReadFailed` renders a
  `role=status` destructive `InlineAlert` (`dataExport.loadFailed`, EN + TH + SV) in place of the
  panel, logged `logger.error` `errorId: M114.portal.account.exports_read_failed` (was a warn
  with no id — the profile page's `ownRequestReadFailed` pattern). RED: the RSC case in
  `tests/unit/app/portal/account-hub.test.tsx` (no alert, the empty state rendered) → green.
- **Types I3 the status badge's flat props.** `change-request-status-badge.tsx` takes one
  `ChangeRequestStatus` union (`pending` · `decided` + outcome · `withdrawn` + reason) built by
  `changeRequestStatusOf(row)` at the three call sites (queue, member section, portal history);
  the fail-soft arm (a decided row with no outcome — unreachable under the DB CHECK) stays and
  renders the pending badge; both switches close with `void _exhaustive`. Typecheck is the test,
  plus the new `change-request-status-badge.test.tsx` (4 cases, RED on the missing export).
- **Types S4 / S6 the GDPR entry + `actor_role` typing.** `GdprChangeRequestEntry` /
  `GdprChangeRequestFieldEntry` (`insights/application/ports/gdpr-archive-source.ts`) carry the
  members Domain unions (`ChangeRequestScope` / `State` / `Outcome`, `WithdrawnReason`,
  `ProposableFieldKey`, `ProposedFieldTarget`, `ProposedValue`, `FieldOutcome`) through the
  members barrel — the adapter's serialiser is unchanged and its exact-JSON assertions still pass
  (byte-identical output). `actor_role` on the five F114 audit payloads and every use-case
  `actorRole` input is the closed `Role` union (`| null` on the probe and the setting flip;
  `| 'system'` on the withdrawn payload alone — the erasure closure's system identity, which no
  session holds), so a fabricated role is now a compile error, not only a `check:actor-role-truth`
  finding. Typecheck swept 9 test helpers whose `'admin'` / `'member'` literals had widened to
  `string` (`as const`).
- **`useId` on the queue filter bar (L5).** `queue-filters.tsx` mints its four control ids with
  `useId()`; `tests/e2e/change-requests.spec.ts` finds the triggers by accessible name instead
  of `#cr-filter-*`. RED: the unit case asserting no `#cr-filter-state` and a `label[for]`
  pointing at each control.
- **H2 the live region after Apply.** The bar takes `resultCount` + `hasMore` from the page and
  renders ONE `role="status"` / `aria-live="polite"` line (`filters.resultCount` ICU plural /
  `resultCountMore`, EN + TH + SV) that updates in place on every Apply — the same element across
  navigations, so the announcement never steals focus. RED: the unit case (no status region) →
  green, incl. the same-element + focus-kept assertion.
- **N4 pre-hydration Enter.** The bar is a real `<form method="get" action="/admin/change-requests">`:
  the date inputs are named, and hidden `state` / `outcome` / `memberId` / `submitter` inputs
  mirror exactly what `apply()` writes (no state on the pending default, an outcome only under
  `decided`, never the cursor); the client `onSubmit` still prevents default and runs `apply()`.
  RED: the unit case builds `FormData` from the form and asserts it equals the `router.replace`
  query. The one documented difference: a native submit sends an empty `from=` / `to=` for a
  blank date, which the page's zod drops on its own (`.catch(undefined)`) — same view, and the
  next client Apply writes the canonical URL.
- **L5** is the `useId` item above (the ledger's "L5 (`useId` — single instance…)") — closed
  with it.
- **The real-query EXPLAIN.** `drizzle-change-request-repo.ts` exports `queueListQuery(tx,
  filter, page)` — the SAME builder `listQueue` → `runList` executes (the predicate moved into
  `queueWhere`, the statement into `listQuery`; no second read path).
  `change-requests-queue-pagination.test.ts` runs `EXPLAIN` on it for the decided history and the
  pending default over the 5,000-row seed: driven by
  `member_change_requests_tenant_state_submitted_idx`, no seq scan on the request table, no Sort
  node, and the `members` / `contacts` joins present in the plan (this is the joined statement,
  not the single-table proxy). Run alone by path: 6 passed, the p95 asserted under
  `ciScaled(400)` (50 pages in 14.1 s). Also re-run by path after the use-case changes:
  `change-requests-rate-cap`, `-repo`, `-decide-rollback`, `-submit-atomicity`.

## PR-3 US6 UX review (enterprise-ux-designer, 2026-09-15)

On the US6 UI (`467f7e7d9`): 14 findings, 13 taken, 1 recorded. Each behaviour change was TDD'd —
the RED run is quoted per item; copy-only items ride `pnpm check:i18n`.

- **H1 — the confirm button overflowed at 320 px** (`max-w-xs` popup, `whitespace-nowrap`
  button, a 41-char sentence). TAKEN, copy: `confirm.confirm` → "Switch off ({count})" /
  "ปิดการอนุมัติ ({count})" / "Stäng av ({count})"; the consequence sentence stays in
  `confirm.body` (FR-034's "state what will happen"). RED: `Unable to find … role "button" and
  name "Switch off (3)"`.
- **H2 — the pending note vanished in exactly the FR-032 state; no link to the queue.** TAKEN:
  rendered whenever `pendingCount > 0`, copy branched on the setting (`pending.on` /
  `pending.off` — ICU plural EN/SV, TH `{count}` only; `offWarning` removed), the count is a
  `next/link` to `/admin/change-requests` through `t.rich` with a `<link>` tag, persistent
  `underline` (the M5 in-paragraph rule; the alert's `text-info` kept, never muted). RED: `Unable
  to find … role "note"` (OFF state) and `… role "link" and name "3 requests"` (ON state); absent
  at 0 asserted in both states.
- **M1 — `id` landed on the aria-hidden `<input>`, not the `role="switch"` element.** TAKEN AS
  RE-READ against the primitive (the maintainer's call after the first closure dropped the
  `htmlFor` and lost the pointer path): Base UI's `useLabelableId` puts the caller `id` on its
  hidden `<input type=checkbox>` ON PURPOSE — that is the `<label for>` activation target, so a
  click on the label text toggles the switch through the native checkbox change. The AT name
  comes from `aria-labelledby` → the visible `<Label>` (the house idiom of
  `renewal-reminders-toggle.tsx`), so the finding's real risk — a name that depends on `for`
  reaching an aria-hidden control — never applied. Final shape: `<Label id htmlFor className="mb-0">`
  + `Switch id aria-labelledby aria-describedby`. Test: the switch is named through
  `aria-labelledby`, the label's `for` target IS an `<input>`, and `fireEvent.click(label)` sends
  `PATCH { approvalEnabled: true }` (the pointer path proven, not assumed).
- **M2 — past ~30 days the dashboard showed a date, not an age** (`formatRelativeTime`'s
  absolute-date fallback, inside the FR-037 window). TAKEN: whole days from `oldestAgeSeconds`
  (`Math.floor(/ 86_400)`) into `needsAttention.changeRequests` = "Change requests waiting (oldest
  {days, plural, =0 {today} one {# day} other {# days}})" ×3; the relative-time helper is no
  longer on this path. RED: `to contain 'Change requests waiting (oldest 45 days)'` (the old path
  rendered a calendar date), plus "today" / "1 day". The dashboard test now formats through
  next-intl's `createTranslator` (real ICU, missing key throws) instead of a regex stand-in.
- **M3 — double announcement on success** (toast + `role="status"` line). TAKEN: the state line
  is a plain `<p>` — the role dropped rather than `aria-live="off"`, because a `<p>` has no live
  semantics to switch off and an explicit "off" reads as intent to announce elsewhere; the toast
  is the one announcement. RED: `expected <p role="status" …> to be null`; green asserts
  `toast.success` called exactly once and no `status` region before or after.
- **M4 — the loading skeleton under-reserved the description.** TAKEN: a fourth description
  line in `loading.tsx` (the SV copy wraps to four). No test (skeleton geometry); `check:layout`
  green.
- **M5 — generic read-only copy.** TAKEN: `admin.settings.memberChanges.errors.readOnly` ×3
  ("The system is in read-only mode — the setting was not changed." / TH / SV) replaces the
  platform `errors.readOnlyMode` on the 503 arm. RED: the 503 case (`toHaveTextContent` on the
  new key); green also asserts the platform copy is NOT rendered.
- **L1 — badge noun.** TAKEN: `nav.staff.changeRequestsBadge` → "pending" / "รายการรอการพิจารณา"
  (classifier after the numeral) / "väntande" — plain strings, the ICU plural dropped. RED:
  `Unable to find … role "link" and name "Change requests 3 pending"`.
- **L2 — no `error.tsx`.** TAKEN: `admin/settings/member-changes/error.tsx` in the
  `FormContainer` shape (mirrors `admin/change-requests/error.tsx`: `errors.generic` /
  `errors.errorId` / `buttons.retry`, the page's own title + subtitle). No test; `check:layout`
  green (136 page/loading files, pairs consistent — `error.tsx` is outside the pair set).
- **L3 — no pending signal in the icon rail.** TAKEN: the tooltip is
  `nav.staff.badgeTooltip` = "{title} ({count})" ×3 when a badge is present, the title alone
  otherwise. RED: the `data-tooltip` assertion (the sidebar stub now forwards `tooltip`).
- **L4 — the badge is resolved in the staff layout, which Next keeps across client navigations,
  so the count can lag until a hard reload.** NOT TAKEN, accepted for PR-3: the dashboard item is
  fresh per page render and the queue page itself shows the live count; a `router.refresh()`
  after a decision is the PR-4 follow-up if staff notice it.
- **L5 — `count > 0 && oldestAgeSeconds === null` rendered "(oldest )".** TAKEN with the M2
  reshape: `needsAttention.changeRequestsNoAge` = "Change requests waiting" ×3 when the age is
  null. RED: `to contain 'Change requests waiting<'` + `not.toContain('(oldest')`.
- **L6 — copy.** TAKEN: SV `confirm.cancel` "Behåll godkännandet på"; TH bare "คำขอ" →
  "คำขอแก้ไขข้อมูล" in `description`, `confirm.body` and the new `pending.*` (the old
  `offWarning` / `confirm.confirm` occurrences are gone with H1/H2).
- **L7 — double gap under the switch label.** TAKEN: the `<Label>` gets `mb-0`, so the
  `grid gap-1` is the only gap.

Untouched by design: `tasks.md` (T112's round is still to come); the tasks' "done" notes still
describe the pre-review shape (`offWarning`, "oldest 3 days ago", `errors.readOnlyMode`) — this
section is the record.

Gates at this tree (foreground, 2026-09-15): `pnpm typecheck` exit 0 · full `pnpm lint` exit 0 · `pnpm check:i18n` OK (5530 keys × 3) · `pnpm check:layout` OK (136 files, pairs consistent) · `pnpm check:strict-aria` OK (0 across 632 TSX) · `pnpm vitest run tests/unit/nav/ tests/unit/app/admin/ tests/unit/members/presentation/ tests/unit/components/ tests/unit/architecture/` 256 files / 2432 tests passed (258 s). One earlier run of the same folders, taken while typecheck + lint ran concurrently, timed out `broadcasts-barrel.test.ts` at 30 s (a source scan; 740 ms alone) — contention, not code; the idle re-run above is the evidence.

**Verdict**: MERGEABLE on the US6 UX axis — the two HIGH items and every MEDIUM/LOW except L4
(recorded, PR-4) are closed with RED→GREEN evidence.
