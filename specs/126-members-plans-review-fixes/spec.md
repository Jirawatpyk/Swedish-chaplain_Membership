# 126 — Members + plans review fixes

**Size**: M (members + plans application code, two repos, one route contract change, a decision; no migration, no UI, no flag).
**Status**: built on `126-members-plans-review-fixes`, 24 Oct 2026.
**Source**: `/code-review` of `src/modules/members` + `src/modules/plans` (24 Oct 2026), 10 findings. The maintainer chose: fix all 10 with TDD; move plans audit into the write tx (#7, D-026); delete bulk `change_plan` rather than rebuild it (#1/#3).

## Summary

Closes the integrity and audit gaps the review found in plan assignment, bulk member actions and plan mutations. No new surface: one route answer changes (cancel scheduled plan change, `audit_failed` → 500), and two existing routes return new 4xx codes.

## Done when

1. **#1 + #3** — `POST /api/members/bulk` rejects `action: 'change_plan'` as `invalid_body`. The arm was a second copy of `changePlan` with none of its rules (soft-deleted plan, advisory lock, policy gates, F8 audit + listeners, billing remediation) and was unreachable anyway (a UUID schema for slug plan ids; no UI button).
2. **#2** — bulk `archive` revokes every linked portal user's sessions (one `user_sessions_revoked` audit each) and soft-consumes their invitations in the batch tx, then cancels each member's in-flight broadcasts and renewal cycle after the commit — the single `archiveMember` cascade. Bulk `unarchive` (the Undo) restores a renewal cycle after its commit, as the single undelete does.
3. **#4** — `changePlan` refuses an archived member (`member_archived` → 409 `state.cannot_change_plan_archived`), on the pre-tx read and on the FOR UPDATE re-read.
4. **#5** — `changePlan` checks the primary contact's age against `maxMemberAge`, and both `changePlan` and `createMember` check the plan's `memberTypeScope` against the member's `legalEntityType` (`individual` = individual; every other code, `sole_proprietor` included, = company; `null` skips). Both are bypassable by an override reason and answer 422 (`age_warning` / `member_type_warning`), which the existing forms already route to the override dialog.
5. **#6** — `updatePlan` on a soft-deleted plan returns `not_found` and changes nothing; the repo UPDATE (and its defence-in-depth SELECT) skip deleted rows.
6. **#7** — every plans mutation writes its audit row in the same tx as the state change; an audit failure leaves the row unchanged (create, clone, update, activate, soft-delete, undelete, schedule, cancel). The cancel route answers a retryable 500 on `audit_failed`; `X-Audit-Backfill-Required` and its counter are gone.
7. **#8** — `createMember` takes the plan soft-delete advisory lock and re-reads the plan's deletion state as the first statements of its tx; a plan soft-deleted after the pre-tx snapshot returns `plan_not_found` and no member row.
8. **#9** — leaving a partnership bundle (partnership → corporate) needs `confirm_bundle_change` and records `plan_bundle_changed`, like entering one.
9. **#10** — the plan-change listener catch, and the archive cascades, log `err: errKind(e)`.

## Out of scope

- F8 `accept-tier-upgrade` still emits its F2 audit after its own tx (D-026 follow-up).
- New copy for `member_type_warning` — the override dialog shows its generic "outside the plan limits" line.
