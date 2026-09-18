# Contract — Member Portal E-Blast approval API

Routes under `src/app/api/broadcasts/**` (the member surface; `/api/portal/broadcasts/**` holds only
the terms acknowledgement today). Every route: **Node runtime**, `requireMemberContext(request)`
(member role only — a staff session is refused, which is how FR-013 "a staff user MUST NOT give the
member-side approval" is enforced structurally), tenant from the resolved context, CSRF Origin
allow-list and read-only-mode 503 from the proxy, and the F7 master kill-switch
(`matchesF7KillSwitchPath`, `src/proxy.ts:43-68`) → 503 `feature_disabled` when
`FEATURE_F7_BROADCASTS` is off.

**Owning-member rule (FR-013)**: every route resolves the broadcast by `(tenant, id)` inside
`runInTenant` and then requires `broadcasts.requested_by_member_id = <caller's member id>`. A miss on
the id (unknown, or another tenant's — indistinguishable under RLS) answers **404** and is audited
`broadcast_cross_tenant_probe`; a row belonging to **another member of the same tenant** answers
**404** and is audited `broadcast_cross_member_probe`. Never 403 — no existence leak.

**Flag rule (FR-034, research R18)**: `FEATURE_EBLAST_MEMBER_APPROVAL` gates **entry** into the
approval round, which happens on the staff side only. The routes below therefore stay available with
the flag off for a broadcast already in a new stage, so an in-flight E-Blast stays completable. A
broadcast that is not in a stage the route accepts answers **409 `stage_changed`** regardless of the
flag.

**Error envelope (all routes)**:
`{ error: <code>, message?: string, stage?: BroadcastStage, retryAfterSeconds?: number, issues?: ZodIssue[] }`

**No `Idempotency-Key`** on any route here (research R19): the (broadcast id, stage, version id)
triple is the key, a repeat is answered 409 with the recorded decision, and the routes therefore
keep working in CI smoke, which has no Redis.

Every fault arm names itself `M119.portal.<route>.<arm>` in the log (`errorId` taxonomy, no gate).

---

## `GET /api/broadcasts/[id]/versions` — the history both sides see (FR-008, FR-032)

Permission: `requireMemberContext` + owning member.

```jsonc
200 {
  "broadcast": {
    "id": "uuid",
    "stage": "awaiting_member_approval",
    "whoseTurn": "member",
    "round": 2,
    "proposedSendAt": "2026-10-01T03:00:00.000Z" | null,
    "confirmedSendAt": "2026-10-01T03:00:00.000Z" | null,
    "approvedVersionId": "uuid" | null,
    "stageEnteredAt": "2026-09-24T09:12:00.000Z",
    "expiresAt": "2026-10-24T09:12:00.000Z" | null       // stageEnteredAt + 30 d while awaiting (FR-022a)
  },
  "versions": [
    { "id": "uuid", "versionNo": 0, "authoredBy": "member", "subject": "…", "bodyHtml": "…",
      "noteToMember": null, "sentToMemberAt": null, "createdAt": "…" },
    { "id": "uuid", "versionNo": 2, "authoredBy": "organisation", "subject": "…", "bodyHtml": "…",
      "noteToMember": "Moved the date up top.", "sentToMemberAt": "…", "createdAt": "…" }
  ],
  "decisions": [
    { "id": "uuid", "versionId": "uuid", "round": 1, "decision": "changes_requested",
      "reason": "The date is wrong.", "decidedAt": "…", "decidedByMe": true }
  ]
}
```

- `authoredBy` is **`"member"` or `"organisation"`** — the portal never names the staff user
  (the F114 `decidedBy: "organisation"` precedent).
- An **unsent** version (`sent_to_member_at IS NULL`) is never included: the member must not see
  marketing's work in progress (FR-003's read-only point is about editing; this is the read side of
  the same rule).
- `bodyHtml` is the stored, sanitised body. The screen renders it through the **preview** route, not
  inline, so what the member signs off is the real email (FR-008, FR-043).
- Errors: **404 `not_found`** (unknown / other tenant / other member, audited as above);
  **503 `read-only-mode`** never applies (GET).

## `POST /api/broadcasts/preview` — render the real email (FR-043)

Permission: `requireMemberContext`. Renders from the request body, reads only the tenant's brand
settings and logo URL — no broadcast row, so no owning-member check is needed and none is performed.

```jsonc
// request
{ "subject": "Autumn mixer", "bodyHtml": "<p>…</p>", "width": "desktop" | "phone" }
// response
200 { "html": "<!doctype html>…", "widthPx": 600 }
```

Uses the **same** `renderBroadcastHtml` the sender uses, so preview ≠ delivered is a defect, not a
configuration (spec § Edge Cases). The client renders `html` into an `<iframe srcdoc>`.

| code | when |
|---|---|
| 200 | rendered |
| 400 `invalid_body` | missing/oversized fields (`subject` ≤ 200, `bodyHtml` ≤ 200 KB) |
| 429 `rate_limited` | > 30 renders / minute per actor; `Retry-After` + `retryAfterSeconds` |
| 503 `feature_disabled` | F7 master off (proxy) |

No audit event (a render is not a state change). Counted `broadcasts_preview_rendered_total`.

## `POST /api/broadcasts/test-copy` — send myself a copy (FR-037)

Permission: `requireMemberContext`. **The recipient is always the session user's own address**,
resolved server-side; the request body carries no address and a body address is ignored, not
honoured.

```jsonc
// request
{ "subject": "Autumn mixer", "bodyHtml": "<p>…</p>", "broadcastId": "uuid" | null }
// response
200 { "sentTo": "j***@example.com" }     // masked in the response and hashed in the log
```

- Subject is prefixed with the localised `[TEST]` marker; the body is the full wrapper.
- Changes **no** stage, writes **no** version, consumes **no** allowance (FR-037).
- Sent through the transactional Resend surface, never the Broadcasts surface — a test must not
  enter the marketing suppression list or reputation pool.
- Audit `broadcast_test_copy_sent { broadcast_id | null, recipient_hash, actor_role }`.

| code | when |
|---|---|
| 200 | accepted and sent |
| 400 `invalid_body` | as preview |
| 404 `not_found` | `broadcastId` given and not the caller's |
| 429 `rate_limited` | > 5 / hour per actor |
| 502 `send_failed` | the provider refused; nothing is retried (research R23) |

## `POST /api/broadcasts/[id]/decision` — approve · request changes · withdraw approval

Permission: `requireMemberContext` + owning member. This single route carries all three member
actions of US1/US2 (FR-009, FR-010, FR-015a), because they are one decision about one version and
they race against each other.

```jsonc
// request
{ "versionId": "uuid",
  "decision": "approved" | "changes_requested" | "approval_withdrawn",
  "reason": "The date is wrong." }        // REQUIRED for the last two, optional note for the first
```

Server rules:

| rule | result |
|---|---|
| `decision ∈ {changes_requested, approval_withdrawn}` and `reason` missing/blank | **422 `reason_required`** (US2 AS1) |
| `reason` > 2,000 chars | **422 `validation_error`** with `issues` |
| `versionId` is not the broadcast's **latest sent** version | **409 `stale_version`** + the current version in the body — the member was looking at an older round |
| `decision = approved \| changes_requested` while the stage is not `awaiting_member_approval` | **409 `stage_changed`** + current `stage` |
| `decision = approval_withdrawn` while the stage is not `member_approved` **or** `approved` | **409 `stage_changed`** |
| `decision = approval_withdrawn` while the stage is `sending` or later | **409 `sending_started`** — the send completes (spec § Edge Cases) |
| the member is suspended / the plan lapsed | unchanged existing refusal at **send** time, not here — marketing sees why it is blocked (spec § Edge Cases) |

Side effects, all in **one** `runInTenant` with throw-to-rollback:

| decision | transition | writes |
|---|---|---|
| `approved` | `awaiting_member_approval → member_approved` | decision row; `approved_version_id = versionId`; `stage_entered_at`; audit `broadcast_member_approved { broadcast_id (snake_case — member activity), version_id, round, reason_length, actor_role }`; one outbox row **per marketing recipient** (`eblast_member_decided_marketing`) |
| `changes_requested` | `awaiting_member_approval → changes_requested` | decision row; `stage_entered_at`; `member_reminder_stage = 0`; audit `broadcast_member_changes_requested`; outbox per marketing recipient |
| `approval_withdrawn` | `member_approved → changes_requested` **or** `approved → changes_requested` | decision row; `approved_version_id = NULL`; **`scheduled_for = NULL`** (trigger exemption E2 — FR-015a "a confirmed schedule is cancelled"); `stage_entered_at`; audit `broadcast_member_approval_withdrawn { …, cancelled_schedule_at }`; outbox per marketing recipient |

```jsonc
200 { "stage": "member_approved", "whoseTurn": "marketing", "round": 2,
      "decision": { "id": "uuid", "versionId": "uuid", "decision": "approved", "decidedAt": "…" } }
```

Idempotency: a repeat of an identical body after the transition answers **409 `stage_changed`**
carrying the decision already recorded — the correct answer, not a replay (research R19).

## `POST /api/broadcasts/[id]/cancel` — withdraw the whole E-Blast (existing route, widened)

Unchanged contract. The accepted stage set widens from `('submitted','approved')` to
`IN_PROGRESS_BROADCAST_STATUSES` (FR-015: withdrawable at any stage before sending begins), via
`domain/policies/cancel-cutoff-policy.ts:47,49`. The other party is notified
(`eblast_member_decided_marketing` with `decision: 'withdrawn'`). The allowance place is freed
(FR-020) — `cancelled` is in neither the reserved nor the consumed set.

## `GET /api/broadcasts/[id]` — member detail (existing route, widened)

Gains `stage`, `whoseTurn`, `round`, `proposedSendAt`, `confirmedSendAt`, `expiresAt` and — closing
FR-049 — the **subject and body** of the E-Blast (the page renders no body today,
`portal/broadcasts/[id]/page.tsx`). While the broadcast is awaiting the member, the body shown is
the latest **sent** version; otherwise it is the record's own content.

---

## Page contract — `/portal/broadcasts/[id]`

| element | requirement |
|---|---|
| Compare view | latest sent version (rendered through the preview route, in an iframe) **beside** the member's original (FR-008); marketing's note above it; the proposed send time |
| Actions | "Approve", "Request changes" (reason required, `ReasonConfirmationDialog`, destructive tier), "Withdraw approval" (reason required) — each with `finalFocus` back to its trigger |
| Round thread | every version, who sent it ("you" / "the chamber"), when, each decision and its reason, in order (FR-032) |
| Stage banner | `role="status"`; names the stage, whose turn it is, and — while awaiting — when it expires |
| Empty / error / loading | shared components; `error.tsx` added (FR-047); the skeleton matches the real page |
| a11y | axe clean at 320 px; the compare view stacks below `lg`; SC-003 — approve or request changes in under 2 minutes on a phone |
| i18n | `portal.broadcasts.approval.*` in EN (canonical) + TH + SV; no italic on Thai; times in the tenant time zone, BE display-only for `th-TH` |

## Contract tests (`tests/contract/broadcasts/portal-eblast-*.test.ts`)

- **Role pins**: a staff session (`admin`, `marketing`, `manager`) → 403 on every route here
  (`requireMemberContext` refusal) — including `POST …/decision`, which is FR-013's "never
  grantable to a staff role", asserted directly.
- **Owning member**: another member's broadcast → 404 + `broadcast_cross_member_probe`; an unknown
  id → 404 + `broadcast_cross_tenant_probe`; a malformed id → 404, no audit row.
- **Decision**: no reason on `changes_requested` → 422 `reason_required`; no reason on
  `approval_withdrawn` → 422; an old `versionId` → 409 `stale_version`; approve while
  `changes_requested` → 409 `stage_changed`; withdraw while `sending` → 409 `sending_started`;
  approve twice → 409 with the recorded decision.
- **Flag matrix**: with `FEATURE_EBLAST_MEMBER_APPROVAL` **off**, a broadcast already in
  `awaiting_member_approval` can still be approved here (FR-034), and a broadcast in `submitted`
  answers 409 `stage_changed` in both flag states.
- **Versions**: an unsent version is absent from the payload; `authoredBy` is never a staff name.
- **Test copy**: a body-supplied `to` is ignored and the session address is used; the 6th call in an
  hour → 429 with `Retry-After`.
- **Preview**: 30 renders pass, the 31st in the same minute → 429; a 201 KB body → 400.
