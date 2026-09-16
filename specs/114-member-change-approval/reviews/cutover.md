# F114 cutover record (T114) — started 2026-09-16

Order per `quickstart.md` § 3: `db:verify:prod` → RoPA entry (FR-040 precondition) → platform flag
(a redeploy is what makes it live) → the tenant switch on `/admin/settings/member-changes` → observe
the first real submission. Rollback layers in `quickstart.md` § 3 (setting → flag → revert).

| Step | When (Asia/Bangkok) | Who | Evidence |
|---|---|---|---|
| Merge PR-3 #367 → `main` `76b6e3189`; production deploy `success` (no migration in PR-3) | 2026-09-16 11:28 → 11:33 | maintainer + Claude | `gh pr view 367`, GitHub deployment 6473831206 |
| `pnpm db:verify:prod` | 2026-09-16 12:13 | Claude (read-only) | "✓ All 15 canaries present — schema in sync", incl. `member_change_requests` UNIQUE + composite FKs (0300), FK-column indexes (0302), the seven enum values (0301), `tenant_member_settings.member_change_approval_enabled` (0300) |
| `FEATURE_MEMBER_CHANGE_APPROVAL=true` set in Vercel + **Redeploy** of the current production build | 2026-09-16 ~12:13 | maintainer | Vercel `dpl_2rQiBJZamK6ugJJZ3o3xRMFz2tQg` (`action: redeploy` of `dpl_8THZYVRNTXoAis3zvPUj54NHNWCq`, commit `49bd02406`) |
| Flag observed LIVE on production | 2026-09-16 12:18:25 | Claude (unauthenticated probes) | `GET /api/portal/change-requests/gate` 404 → **401** (the route now reaches its session gate); `GET /api/admin/settings/member-changes` **401**; `/admin/settings/member-changes` renders (200 via the sign-in redirect) |
| RoPA entry updated — `docs/compliance/processing-records.md` § "F114 — Member Change Requests" (purpose, lawful basis, the staff-notification disclosure, the `change-requests.json` Art. 15/20 category, the COMP-1 outbox retention note, TOMs, DSR procedures) | 2026-09-16 12:37 | maintainer (via Claude) | PR #369 `fef374f48`; "Last reviewed" moved to 2026-09-16 — FR-040 precondition met BEFORE the switch |
| Tenant setting ON — `/admin/settings/member-changes` (audited `member_change_approval_setting_changed { previous: false, next: true }`) | 2026-09-16 12:39 | maintainer's admin session (the switch clicked through Claude-in-Chrome on the maintainer's instruction) | the card read "Approval is on — new member changes wait for a staff decision"; the audit row on `/admin/audit?eventType=member_change_approval_setting_changed`: **1 event**, `2026-09-16T05:39:23.480Z`, summary "member change approval off → on", details `previous: false`, `next: true`, `actor_role: super_admin`, actor `52b58065-…` |
| First real submission observed: staff email arrives, the queue lists it, the dashboard row + nav badge show 1, `members_change_requests_pending_count{tenant=swecham}` = 1 on the next tick | _pending_ | maintainer | record request id (no values), the email's arrival time, the tick body (`membersPendingTotal: 1`) |

From 12:39 the approval path is LIVE for SweCham: a member's edit to a Group B field on `/portal/edit`
becomes a change request; the immediate F3 path is narrowed to Group A (FR-001). Before that instant the
portal behaved exactly as before the feature (the flag only unlocked the routes and surfaces — FR-031
"flag first, then setting"). The first-submission row above is filled when a real member submits;
until then the queue, the dashboard row and the nav badge stay empty (count 0 — verified on `/admin`
right after the flip).

Watch after the flip (`quickstart.md` § 4): `members_change_request_oldest_age_seconds` — warning at
7 d, page at 14 d; `email_dispatch_failed` audit rows with a `member_change_request_*` type.
