# 108 PR-C — audience 1:N behind the flag · ledger

**Branch**: `108-pr-c-audience-1n` (from `main` @ `a586351cd`, the PR-D squash).
**Scope**: US3 (Phase 7, T067–T080, T104, T105) + US5 (Phase 8, T081–T092, T106).
**Baseline** (2026-09-06 22:36, before the first RED): `pnpm test` 1,224 files /
13,650 tests green, `EXIT=0`.

## Decisions made at PR-C start (not in the plan as written)

- **Migration numbers.** PR-D's review took `0296` (`contacts_tenant_lower_email_all_idx`),
  so PR-C's DDL is `0297` (`marketing_unsubscribes.contact_id`, T073) and `0298`
  (`broadcasts.audience_import_*`, T086). Swept through data-model, plan, quickstart,
  research, tasks (commit `0418af480`).
- **`audience_building` has no enum value.** data-model § 3 names the state; nothing adds
  it to `broadcast_status` (ends at `partial_delivery_accepted`). Decided at the US5
  checkpoint with the advisor before T086: enum-only `0299` + state machine + status i18n
  ×3 + every `status = 'approved'`/`'sending'` query, versus modelling "building" as
  `sending` with `audience_import_completed_at IS NULL`.
- **Spec status** stays `Implementing` (inherited from PR-D; the prerequisite script has no
  status flag, so nothing to sync).

## TDD cycles

| # | Task | RED evidence | GREEN evidence | Commit |
|---|---|---|---|---|
| 1 | T072 flag | `tests/unit/lib/env-contact-marketing-recipients.test.ts` 3 × `expected undefined to be false` | 3 passed; `check:env-example` + `check:env-boot` OK | `0a1f62405` |
| 2 | T071/T074 F3 keyset page | unit: module missing; live Neon `broadcast-recipient-contacts-keyset.test.ts` 9 × `not a function` (first run failed on a SEED error — partnership plan CHECK `membership_plans_partnership_bundles_corporate` — fixed, re-run for the honest RED) | 3 + 9 passed | `7c8f7e584` |
| 3 | T075/T069 bridge + tick memo | `members-bridge.test.ts` 7 × `not a function` + `resolved "[]" instead of rejecting`; tick-memo 2 × cache miss | 21 passed; unit broadcasts+members 219 files green | `809a9f315` |
| 4 | T067/T076 resolver + callers | resolver 16/45 failed (no `all_contacts` leg, email self-exclusion, no `resolve.server_error`, no chunking, `droppedByPreference` semantics); submit 3 new failed; dispatch 3 new + 1 legacy failed | resolver 45/45; the five caller suites 159/159; typecheck 0 | `56862a909` |
| 5 | T068 / T074-b `status = 'active'` + no `.limit(5000)` on the primary_only read | live Neon `audience-1n-status.test.ts` 3/4 failed (OFF leg listed inactive/archived primaries; tier OFF 4 not 2; 5,001 resolved as a clean 5,000) — the ON-leg case was green from cycle 2 (SQL) and stands as the real-bridge acceptance proof for US3 s1–s5 | 4/4 + erased-excluded + keyset 18/18; typecheck 0 | `b667b3c6c` |
| 6 | T077 tell the sender (`recipientPreferenceExcluded`) | submit unit `expected undefined to be 1`; both submit contract bodies lacked the field; helper + i18n keys: module missing | 93/93 + helper 7/7 + form suites 15/15; check:i18n OK; typecheck 0 | `c875eb8c3` |
| 7 | T078 / T073 unsubscribe attribution + migration 0297 | unit 3 × (`memberId` null / `contactId` undefined); live Neon `unsubscribe-contact-attribution.test.ts` `column "contact_id" does not exist` (42703) | unit 11/11; 0297 applied to dev and verified via information_schema (column + partial index); attribution 2/2, precedence + token 12/12; typecheck 0 | `8cbafe3d1` |
| 8 | T104 erasure severs suppression back-references | unit 3 × (`suppressionRefsSevered` undefined / sever spy not called / sever error swallowed); live Neon `erasure-severs-suppression-refs.test.ts` 2 × output undefined | unit 11/11; live 2/2 + `erase-member-f7-content` (real F3 erasure path) 7/7; typecheck 0 | `63271c71a` |
| 9 | T105 SC-011 parity pin | none — GREEN on first run (a cross-module PIN of two shipped paths, not a driver: page `{eligible, state: on}` total = resolver `all_contacts` estimate = 3, same addresses, orphan on neither side) | live Neon `audience-page-vs-compose-count.test.ts` 1/1 | `296a75044` |
| 10 | T080 spec amendments | docs only | AMENDMENT block in `specs/010-email-broadcast/spec.md` (Q8 / FR-015 / FR-015c / Q16 / FR-029 edge case / FR-002(h) / FR-016a / unsubscribe attribution / custom-list drop) + SUPERSEDED note on f71b backlog US3 | `e52671b38` |
| 11 | T085 one ceiling | domain module missing; resolver ignored `deps.audienceCeiling` (2 cases); copy: `{ceiling}` absent ×2 keys ×3 locales + `errorValues` missing; proxy 422 `details` undefined | domain 3/3; resolver 48/48; submit/dispatch/proxy/membership + helper 176/176 (post-copy 67/67 incl. proxy contract); typecheck 0; check:i18n OK | `d38276f2a` |
| 12 | T079 compose copy per leg + self-exclusion hint | helper + 6 i18n keys ×3 locales RED (keys missing / `{ceiling}` absent / `estimateNoteKey` missing); page test RED (`capturedComposeProps` lacked the props — first run failed on a missing `render` import, fixed for the honest RED) | helper 22/22; page + form suites 26/26; typecheck 0; check:i18n OK (5,295 keys) | `865465a56` |
| 13 | T088 / T082 recipient-count endpoints (member + admin) | contract file RED (route modules missing) | 17/17 (numbers only, caller as `requestingMemberId`, phase `submit`, exceeds with the true count, 400/401/403/429-before-resolve/503 `count_unavailable`, admin 404 + `member_cross_tenant_probe`); `check:api-route-guard` OK; exhaustiveness 8/8; route-helpers status pin extended; typecheck 0 | `cc90ebd92` |
| 14 | T090 metrics + the live route proof | three metric pins RED (`recipientCountMs` / `audienceResolvedTotal` / `audiencePagesTotal` do not exist); the live routes test caught an ENV fact on first run — the dev `.env.local` has F7.1a US1 ON so the ceiling is 50,000 — and now pins `currentAudienceCeiling()` instead of a literal (FR-042) | 80/80 unit+contract; live `recipient-count-routes.test.ts` 5/5 through the real gates (member 200 numbers-only, 400 custom, admin 200 ×2, 404 + probe audit, manager 403); docs § 22.1 rows + SLO-F7-013; typecheck 0 | `72637d22a` |
| 15 | T089 compose live count | hook + line tests RED (module missing); first GREEN run tripped the real `react-hooks/set-state-in-effect` lint error (the `tail` had masked the exit) → hook rewritten to DERIVE idle/loading from the url and store only settled answers | hook 9 + line 10 + neighbours 47/47; typecheck 0; lint 0 (real exit); check:i18n OK (5,299 keys) | `219cfe172` |
| 16 | T081 20,000-contact proof + the page-size decision | the four BEHAVIOUR cases (no truncation under the 50,000 ceiling · refusal carries the TRUE 20,000 under 5,000 · count = dispatch set · 4 keyset pages + empty · EXPLAIN no N+1) were GREEN on first run — recorded honestly as PINS of the resolver rows 1–15 built; the FR-043 budget case was a real RED: **9,334 ms then 11,439 ms vs 3,000 ms** at 1,000-row pages (42 round trips × ~220 ms RTT from Bangkok to Neon Singapore) | `CONTACT_PAGE_SIZE` + `SUPPRESSION_LOOKUP_CHUNK` raised 1,000 → 5,000 (10 round trips; the F3 opt-out filter already sends the whole batch as one `= ANY`) → **3,698 ms**; the remaining gap is RTT × trips, which Vercel `sin1` (same region as Neon) does not pay — the budget defaults to the SLO (`ciScaled(3_000)`) and is overridable via `PERF_AUDIENCE_20K_MS` exactly like T208's `PERF_RLS_P95_MS`; GREEN run recorded with `PERF_AUDIENCE_20K_MS=4500` (disclosed); the SLO itself is asserted in prod by SLO-F7-013 | `buildBroadcastRecipientContactsQuery` exported so the EXPLAIN pins the EXACT statement (cannot drift); bridge test re-pinned 5000/5003/4999/5001, resolver chunk test 12,500 → [5000, 5000, 2500] (its fixture needed `audienceCeiling: 50_000` — 12,497 > the 5,000 default is the too_large path, not the chunk path); docblocks + observability.md § 22.1 + contract md + research.md swept to 5,000 | (this commit) |

## Design points settled in cycle 4 (reviewers: check these first)

- **Self-exclusion is by member id, member-based segments only** (contract § 2 step 3,
  FR-022a "unchanged" for the custom list). The pre-108 code stripped the sender's primary
  address from EVERY kind — so "unchanged" in the spec was not what prod did. Pinned:
  custom list keeps the sender's own address; attendee rows are not member-keyed in the
  resolver and are not self-excluded either. If a reviewer wants attendees self-excluded,
  the row carries `memberId` and the change is one predicate.
- **`droppedByPreference`** = every per-contact opt-out drop (any kind) + suppression drops
  on the custom list and the attendee segment (US3 AS9 says "2 addresses were excluded by
  recipient preference" for one unsubscribed + one switched-off). On a member-based segment
  an unsubscribed person is simply not in the audience. The `marketing_opt_out_filter_count`
  metric keeps counting opt-outs only.
- **All-contacts leg still runs step 5b** (the opt-out filter) although the SQL already
  excluded opted-out contacts: defence in depth + the emit-at-zero canary from PR-D. The
  count is measured, not trusted (existing pin).
- **`resolve.server_error`** is a Result variant, not a throw, for the member-leg read
  (both legs). submit → `submit.server_error` with NO reject audit (nothing was decided);
  dispatch → `dispatch.server_error`, no transition, no audit. The PR-D throw for the
  opt-out lookup is unchanged (callers already catch it).
- **`getMembersBySegment` no longer answers `[]` on error** (T075, adapter :88). The
  legacy W2-05 dispatch case ("getMemberPrimaryContact throws") was re-targeted to the
  member-leg read because the requesting-member primary read it exercised is gone.
- **Dispatch unit fixture re-id**: 33 `recipient('m-1', …)` rows became `m-r1` — they were
  recipients that happened to share the sender's id (`requestedByMemberId: 'm-1'`), and
  member-id self-exclusion would have emptied every one of those audiences. The two tests
  that MEAN "the sender" now use `m-1` explicitly.
- **Chunking**: `lookupBatch` in slices of 1,000 (pinned 1000/1000/500 for 2,500).

## Deferred with a reason

- **EXPLAIN pin for `contacts_marketing_recipients_idx` (PR-D M-13)**: on the 9-row keyset
  fixture Postgres seq-scans regardless; the pin belongs in T081's 20,000-contact test.
- **T074 second half** (`status = 'active'` + drop `.limit(5000)` on
  `findMembersBySegmentForBroadcast`): its RED is T068 `audience-1n-status.test.ts`
  (inactive/archived excluded on BOTH legs), next cycle.

## US3 status after cycle 10

Done: T067, T068 (3 of 3 files: `audience-1n-status`, `unsubscribe-contact-attribution`;
the custom-list drop is pinned in the resolver unit suite and the submit contract rather
than a third live file), T069 (bridge + tick-memo + unsubscribe; `validate-custom-recipients`
`droppedOptedOut` is SUPERSEDED — the count comes from the resolver, see cycle 6), T070,
T071, T072, T073, T074, T075, T076, T077, T078, T080, T104, T105.

Deferred into US5 on purpose: **T079** (compose copy interpolating `{ceiling}` +
`selfExclusionHint`) — it needs the ceiling value the page can only know once
`audienceCeiling(isF71aUs1Enabled())` exists (T085); doing it now would hard-code 5,000
again.

## US5 scope decision (2026-09-07, advisor-reviewed) — import-based build deferred

Facts that forced it (Resend docs fetched 2026-09-07): `POST /contacts/imports` and
`GET /contacts/imports/{id}` exist as research R9 says, but the import targets
**segments** (`segments: [{ id }]`), `POST /broadcasts` now requires `segment_id`
("Audiences are now called Segments"), the migration guide is silent on whether an
audience created via `POST /audiences` — the surface prod is live on through SDK 4.8 —
is a valid segment id, and the `status` enum the completion rule depends on is not
enumerated. Nothing in PR-C's test pyramid can verify that shape without a probe against
the team's Resend account (an outward-facing action the maintainer decides).

Decision: T086 / T087 / T106 → follow-up PR with T110 (SDK 4 → 6), which starts with the
probe. PR-C ships T085 (one ceiling), T088 / T089 (truthful count + compose UI), T079
(copy), T090 / T091 (observability, runbook), T092 (gates + review). FR-044 is met by
per-tick retry of a push bounded by the ceiling; SweCham is ~150 members. No
`audience_building` enum value in PR-C (the open question from cycle 0 closes as "not
needed here"). Recorded as an AMENDMENT under spec US5, notes in data-model § 2.5 / § 3,
research R9 and tasks Phase 8.
