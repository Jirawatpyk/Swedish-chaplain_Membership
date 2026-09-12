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

## Gate output after rounds 1 + 2

| Gate | Result |
|---|---|
| `pnpm typecheck` · `pnpm lint` (full) · `check:i18n` 5,499 keys · `check:layout` · `check:audit-events` · `check:actor-role-truth` · `check:api-route-guard` | all OK |
| the 17 unit / contract files the round touched | 292 passed |
| whole `tests/contract/` + `tests/unit/{members,insights,app,lib,architecture}` (after round 1) | 558 files, 5,552 passed, 2 todo |
| integration (live Neon `dev`, by path) | rate-cap 2 · erasure-scrub 1 · tenant-isolation 6 · queue-pagination 4 · export-job-repo · account-hub-cross-tenant · erase-member — 34 passed, 0 failed |
| e2e | still NOT RUN (T066 / T081 / T091 partial) |
