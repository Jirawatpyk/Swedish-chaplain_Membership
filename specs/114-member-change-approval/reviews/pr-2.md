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

## Gate output at the branch head `39e5fcbb6` (after the PR-1 closures + their re-reviews)

| Gate | Result |
|---|---|
| `pnpm typecheck` · `pnpm lint` (full) · `check:i18n` 5,501 keys · `check:layout` · `check:staff-page-guard` · `pnpm db:verify` (dev, incl. the 0302 canary) | all OK |
| `pnpm test` (the whole Vitest suite, tree `29e7c9ecb`; the last commit changed one SQL file + one live test + the ledger) | 1,272 files, 14,360 passed, 2 todo |
| integration (live Neon `dev`, by path) | tax-immutability 2 · repo 14 (incl. the plain-read lock proof, the single-UPDATE no-row rollback, the two EXPLAIN controls) · decide-rollback · submit-atomicity · concurrency — all green |
| e2e `tests/e2e/change-requests.spec.ts` on the maintainer's dev server (flag ON), `--workers=1` | before the closures: chromium 13 passed / 2 skipped (persona) / 1 flaky (US3 dismiss — dev-mode first-hit route compile; retry passed), mobile-chrome 14 / 2 skipped; after `22671112b`: chromium 14 passed / 2 skipped, no flake |
| re-reviews of the closures | UX, tax, migration: all CLOSED / MERGEABLE (`29e7c9ecb`, `39e5fcbb6`) |

## Gate output after rounds 1 + 2 (branch head `b7afc1bcb`)

| Gate | Result |
|---|---|
| `pnpm typecheck` · `pnpm lint` (full) · `check:i18n` 5,499 keys · `check:layout` · `check:staff-page-guard` (50) · `check:api-route-guard` (123) · `check:audit-events` · `check:actor-role-truth` (0 fabricated) · `check:multi-tenant` (28) · `check:fixme` · `check:dates` | all OK |
| whole `tests/contract/` + `tests/unit/{members,insights,app,lib,architecture}` (after round 1, `a44d9bf81`) | 558 files, 5,552 passed, 2 todo |
| `tests/contract/{portal,members,insights}` + `tests/unit/{members,insights}` (after round 2, `c8a6017b1`) | 264 files, 2,489 passed, 1 todo |
| erase unit suites after the rescan (`b7afc1bcb`) | 87 passed |
| integration (live Neon `dev`, by path) | after round 1: rate-cap 2 · erasure-scrub 1 · tenant-isolation 6 · queue-pagination 4 · export-job-repo · account-hub-cross-tenant · erase-member — 34 passed; after round 2: erasure-scrub · submit-atomicity · concurrency · erase-member — 8 passed; after the rescan: erasure-scrub · erase-member · erase-member-cascade — 8 passed |
| e2e | still NOT RUN (T066 / T081 / T091 partial — the dev server env needs the flag) |
