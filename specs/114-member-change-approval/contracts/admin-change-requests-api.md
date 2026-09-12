# Contract — Staff change-request API + tenant setting

Routes under `src/app/api/admin/change-requests/**` and `src/app/api/admin/settings/member-changes`.
Every route: `requireApiPermission` (`src/lib/rbac.ts`) with the key named per route; denial →
403 + `permission_denied` audit (existing). Read-only mode → 503 on the mutating routes (proxy).
Flag OFF → 404 everywhere. Tenant setting OFF does **not** hide the queue (FR-032).

Pages (`requirePagePermission`, `check:staff-page-guard`): `/admin/change-requests` (queue,
`members.read`), `/admin/change-requests/[id]` (review, `members.read`; decision controls rendered
only when `canPerform(role, 'members.write')`), member record tab `/admin/members/[memberId]`
"Change requests" section (`members.read`), `/admin/settings/member-changes` (`members.write`).

---

## `GET /api/admin/change-requests` — queue (FR-027) · `members.read`

Query: `state?=pending|decided|withdrawn` (default `pending`), `outcome?`, `memberId?`,
`submitter?=<userId>` (the staff-email deep link), `from?`, `to?`, `cursor?`, `limit?≤100`.
Default order: pending first by `submitted_at ASC` (oldest waiting on top), else `submitted_at DESC`.

```json
200 { "items": [ { "id", "member": { "id", "companyName", "memberNumber", "status", "archived" }, "submitter": { "displayName", "roleAtSubmission" },
                   "scope", "state", "outcome", "withdrawnReason", "fieldCount": 3, "affectsTaxDocuments": true,
                   "submittedAt", "waitingSeconds": 86400, "overdue": true /* pending > 3 days */, "decidedAt",
                   "decidedBy": { "displayName", "deactivated" } | null } ],
      "nextCursor": string|null, "pendingCount": 4, "oldestPendingAgeSeconds": 259200 }
```

A list row carries display facts ONLY — never a field value and never the staff note (those are
the review payload's). `waitingSeconds` counts to now while pending and to the decision /
withdrawal otherwise; `overdue` is pending-only. `pendingCount` / `oldestPendingAgeSeconds` are
the TENANT's (not the filtered page's) — the dashboard / nav facts (FR-033). `cursor` is opaque
(base64url of the keyset); a malformed cursor, limit or filter value → **400 problem
`invalid_query`**, never page one silently. `from` / `to` are ISO-8601 instants (the page turns
its `YYYY-MM-DD` inputs into Asia/Bangkok day bounds). A repo fault → 500 `M114.admin.queue.<arm>`.

`?submitter=<userId>&state=pending` with exactly one row is what the staff email links to; the page
redirects to `/admin/change-requests/[id]`, or shows "no pending request — decided by X at T" when
none (a colleague decided it before the reviewer opened the email).

## `GET /api/admin/change-requests/[id]` — review payload (FR-019) · `members.read`

```json
200 { "request": StaffChangeRequestView,
      "fields": [ { "key", "target", "seen", "proposed", "current", "changedSinceSubmitted": false, "alreadyCurrent": false,
                    "affectsTaxDocuments": false, "taxHint": "buyer_name"|"buyer_address"|"buyer_contact"|"billing_country"|null,
                    "undecidable": null | "contact_removed", "outcome": null, "appliedAt": null } ],
      "member": { "id", "companyName", "memberNumber", "status", "archived": false, "erasing": false, "hasBillingAddress": true },
      "canDecide": true }
```

`current` is read live; `changedSinceSubmitted = current ≠ seen` (deep-equal for address groups);
`alreadyCurrent = proposed = current` (approve is a recorded no-op, FR-015); `undecidable =
'contact_removed'` when a contact-target row's contact is removed/unlinked (the row is reject-only,
FR-020); `taxHint` names what the flag feeds so the reviewer knows what to check (FR-019).
`canDecide` = state pending ∧ `members.write` ∧ not archived ∧ not erasing.

## `POST /api/admin/change-requests/[id]/decide` (FR-013–FR-018) · `members.write`

```json
{ "decisions": [ { "key": "phone", "outcome": "approved" }, { "key": "description", "outcome": "rejected" } ],
  "reason": string|null, "note": string|null }
```

Rules: `decisions` MUST cover **every** field of the request exactly once (else 422
`decisions_incomplete`); `reason` required (1–1000) iff any `rejected` (422 `reason_required`);
`note` ≤ 1000. Idempotent by `(id, decisions, reason)`: an identical repeat on a decided request →
**200 with the recorded decision** and `"repeated": true` (no second application / audit / email);
a *different* decision on a decided request → **409 `already_decided`** with `{ decidedBy, decidedAt,
outcome }`; withdrawn → 409 `not_pending`; concurrent loser → 409 `already_decided`.

Refusals before any write: member archived → 409 `member_archived`; erasing → 409 `member_erasing`;
approving a row whose contact is removed/unlinked → 422 `contact_removed` naming the key (reject it
instead); approval-time re-validation of an approved field fails → 422 `validation_error` naming the
key (the reviewer may reject that field instead). A withdrawal that commits first → 409 `not_pending`.

Success:

```json
200 { "request": StaffChangeRequestView /* state decided, outcome derived */, "applied": ["phone"], "rejected": ["description"], "repeated": false }
// the decision is COMMITTED but the joined display names could not be re-read →
200 { "request": { id, state, outcome, decidedAt, … /* bare, no member / submitter names */ }, "applied": […], "rejected": […], "repeated": false, "viewUnavailable": true }
// the decision is COMMITTED but the joined display names could not be re-read →
200 { "request": { id, state, outcome, decidedAt, … /* bare, no member / submitter names */ }, "applied": […], "rejected": […], "repeated": false, "viewUnavailable": true }
// the decision is COMMITTED but the joined display names could not be re-read →
200 { "request": { id, state, outcome, decidedAt, … /* bare, no member / submitter names */ }, "applied": […], "rejected": […], "repeated": false, "viewUnavailable": true }
// the decision is COMMITTED but the joined display names could not be re-read →
200 { "request": { id, state, outcome, decidedAt, … /* bare, no member / submitter names */ }, "applied": […], "rejected": […], "repeated": false, "viewUnavailable": true }
```

Side effects in ONE transaction (`research.md` R4): approved fields applied via
`MemberRepo.updateFieldsInTx` / `ContactRepo.updateInTx`; per-field outcomes + decision columns
written; audit `member_change_request_decided`; outbox `member_change_request_decided_member` for
the submitter. Any failure → nothing persisted, request stays pending, 500 with an `errorId`.

## `GET /api/admin/members/[id]/change-requests` — per-member history (FR-026) · `members.read`

Same item shape as the queue, all states, newest first, `cursor`/`limit ≤ 100`. The segment is
`[id]` (every `/api/admin/members/[id]/*` sibling names it so — Next.js refuses two slug names on
one path). The member must exist in the caller's tenant: another tenant's member is invisible
under RLS → **404 problem `not_found`** (never a 403 that confirms existence), audited
`member_cross_tenant_probe { attempted_member_id, actor_tenant_id, actor_role, action:
'change_request_history' }` with the true actor (Constitution I.4 — the get-member rule); a
malformed id → 404 before any read (not a probe). `M114.admin.member_history.<arm>` on the 500s.
The member record page mounts this as the
"Change requests" section (10 newest, per-field outcomes through the shared diff table, the
reviewer with the "deactivated" marker, the reason as plain text) and links to the queue with
`?memberId=`.

## `PATCH /api/admin/settings/member-changes` (FR-031) · `members.write`

```json
{ "approvalEnabled": true }  →  200 { "approvalEnabled": true, "changedAt": "…" }
```

Upserts `tenant_member_settings.member_change_approval_enabled`; audit
`member_change_approval_setting_changed { previous, next }`; no-op when unchanged (no audit).
`GET` returns `{ "approvalEnabled": boolean, "pendingCount": n }` so the settings card can warn
when switching off with requests pending (they stay decidable — FR-032).

---

## `StaffChangeRequestView`

`ChangeRequestView` (portal contract) plus `submitter: { userId, contactId, displayName, email?,
roleAtSubmission }` (email shown only to `members.pii_sensitive` holders, matching the member page),
`decidedBy: { userId, displayName, deactivated: boolean }` (staff accounts are disabled, never
deleted — the recorded name stays, FR-026), `decisionNote`, `withdrawnReason`,
`replacedByRequestId`, `staffNotifiedAt`.

## Contract tests (`tests/contract/members/admin-change-requests-*.test.ts`)

- RBAC pins per route: manager → 200 on GET, 403 on decide/settings; marketing same; admin +
  super_admin → 200 everywhere; member session → 403. The frozen marketing surface set
  (`role-endpoint-matrix.test.ts`) is 53 with the queue + per-member history routes.
- queue (`admin-change-requests-queue.test.ts`): default pending oldest-first, every filter, the
  overdue flag, keyset paging, 400 on a malformed cursor / limit / filter, the item shape carries
  no value and no note; per-member history (`admin-member-change-requests.test.ts`): all states
  newest-first, the other tenant's member → 404.
- 5,000-row budget (`tests/integration/members/change-requests-queue-pagination.test.ts`, live
  Neon): 50 keyset pages, no gap / duplicate, p95 page latency < `ciScaled(400)` ms after one
  warm-up page, `EXPLAIN` names `member_change_requests_tenant_state_submitted_idx`. The frozen marketing surface set
  (`role-endpoint-matrix.test.ts`) is 53 with the queue + per-member history routes.
- queue (`admin-change-requests-queue.test.ts`): default pending oldest-first, every filter, the
  overdue flag, keyset paging, 400 on a malformed cursor / limit / filter, the item shape carries
  no value and no note; per-member history (`admin-member-change-requests.test.ts`): all states
  newest-first, the other tenant's member → 404.
- 5,000-row budget (`tests/integration/members/change-requests-queue-pagination.test.ts`, live
  Neon): 50 keyset pages, no gap / duplicate, p95 page latency < `ciScaled(400)` ms after one
  warm-up page, `EXPLAIN` names `member_change_requests_tenant_state_submitted_idx`.
- decide: incomplete decisions → 422; rejected without reason → 422; identical repeat → 200
  `repeated`; different repeat → 409; archived → 409; second concurrent → 409.
- settings: unchanged value emits no audit; change emits one with `{previous,next}`.
- flag OFF → 404 on every route; `check:api-route-guard` sees `requireApiPermission` in each file.
