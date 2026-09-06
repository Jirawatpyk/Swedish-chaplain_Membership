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
| 4 | T067/T076 resolver + callers | resolver 16/45 failed (no `all_contacts` leg, email self-exclusion, no `resolve.server_error`, no chunking, `droppedByPreference` semantics); submit 3 new failed; dispatch 3 new + 1 legacy failed | resolver 45/45; the five caller suites 159/159; typecheck 0 | (this cycle) |

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
