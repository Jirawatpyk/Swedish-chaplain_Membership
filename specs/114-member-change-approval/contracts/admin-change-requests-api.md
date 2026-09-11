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
200 { "items": [ { "id", "member": { "id", "companyName", "memberNumber", "status" }, "submitter": { "displayName", "roleAtSubmission" },
                   "scope", "state", "outcome", "fieldCount": 3, "affectsTaxDocuments": true,
                   "submittedAt", "waitingSeconds": 86400, "overdue": true /* > 3 days */, "decidedAt", "decidedBy": { "displayName" } } ],
      "nextCursor": string|null, "pendingCount": 4, "oldestPendingAgeSeconds": 259200 }
```

`?submitter=<userId>&state=pending` with exactly one row is what the staff email links to; the page
redirects to `/admin/change-requests/[id]`, or shows "no pending request — decided by X at T" when
none (the coalescing case).

## `GET /api/admin/change-requests/[id]` — review payload (FR-019) · `members.read`

```json
200 { "request": StaffChangeRequestView,
      "fields": [ { "key", "target", "seen", "proposed", "current", "changedSinceSubmitted": false, "affectsTaxDocuments": false,
                    "outcome": null, "appliedAt": null } ],
      "member": { "id", "companyName", "memberNumber", "status", "archived": false, "erasing": false, "hasBillingAddress": true },
      "canDecide": true }
```

`current` is read live; `changedSinceSubmitted = current ≠ seen` (deep-equal for address groups).
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
approval-time re-validation of an approved field fails → 422 `validation_error` naming the key (the
reviewer may reject that field instead).

Success:

```json
200 { "request": StaffChangeRequestView /* state decided, outcome derived */, "applied": ["phone"], "rejected": ["description"], "repeated": false }
```

Side effects in ONE transaction (`research.md` R4): approved fields applied via
`MemberRepo.updateFieldsInTx` / `ContactRepo.updateInTx`; per-field outcomes + decision columns
written; audit `member_change_request_decided`; outbox `member_change_request_decided_member` for
the submitter. Any failure → nothing persisted, request stays pending, 500 with an `errorId`.

## `GET /api/admin/members/[memberId]/change-requests` — per-member history (FR-026) · `members.read`

Same item shape as the queue, all states, newest first, `cursor`/`limit`.

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
`decidedBy: { userId, displayName }`, `decisionNote`, `withdrawnReason`, `replacedByRequestId`,
`staffNotifiedAt`.

## Contract tests (`tests/contract/members/admin-change-requests-*.test.ts`)

- RBAC pins per route: manager → 200 on GET, 403 on decide/settings; marketing same; admin +
  super_admin → 200 everywhere; member session → 403.
- decide: incomplete decisions → 422; rejected without reason → 422; identical repeat → 200
  `repeated`; different repeat → 409; archived → 409; second concurrent → 409.
- settings: unchanged value emits no audit; change emits one with `{previous,next}`.
- flag OFF → 404 on every route; `check:api-route-guard` sees `requireApiPermission` in each file.
