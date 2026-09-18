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

**Rate limits (spec § Roles)** — per user, atomic check (never a peek-then-act):

| route | limit | over-limit |
|---|---|---|
| `POST …/[id]/decision` (approve · request changes · withdraw approval) | **60 / minute** — the existing E-Blast action bucket | 429 `rate_limited` + `Retry-After` |
| `POST …/[id]/cancel` (withdraw the E-Blast) | 60 / minute, the same bucket | 429 `rate_limited` |
| `POST /api/broadcasts/test-copy` | **10 / hour** (FR-037) | 429 `rate_limited` |
| `POST /api/broadcasts/preview` | 30 / minute | 429 `rate_limited` |
| `POST /api/broadcasts/inline-image-upload` | unchanged from today | unchanged |

**A lapsed member may still decide** (spec § Edge Cases): reading an E-Blast and deciding on a
pending version are not benefit actions, so none of the routes below checks membership standing. The
existing refusals apply at **send** time, where marketing sees why the E-Blast is blocked, and the
30-day expiry clock keeps running throughout.

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
  ],
  "approvedAsSubmitted": { "at": "…", "by": "organisation" } | null
}
```

- **This IS the history (FR-032)**, and it is its own record — versions plus decisions — distinct
  from the audit trail, which stays a compliance surface and is never read to build this payload.
  The client groups the two arrays into **one ordered list with a heading per round** ("Round 1",
  "Round 2", …), so it can be navigated by keyboard and by screen reader; within a round the version
  comes first and its decision second, and rounds run oldest → newest.
- `approvedAsSubmitted` closes FR-007's history requirement on the no-formatting path: when marketing
  approved the member's own content, `versions` and `decisions` are **empty** (no version row is ever
  written, R2) and this object carries the time and the acting side instead — so the history is never
  blank for an E-Blast that went straight through.
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
200 { "html": "<!doctype html>…", "widthPx": 600 }      // desktop 600, phone 375 (FR-043)
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

- Subject is prefixed with the localised **`[Test]`** marker (FR-037).
- The body goes through the **identical** pipeline as a real send — the same sanitiser policy, the
  same design-block rendering, the same brand header and the same footer — so the test copy, the
  preview and the delivered email are the same artefact (SC-011). Nothing is simplified for a test.
- Changes **no** stage, writes **no** version, consumes **no** allowance (FR-037).
- Sent through the transactional Resend surface, never the Broadcasts surface — a test must not
  enter the marketing suppression list or reputation pool.
- Audit `broadcast_test_copy_sent { broadcast_id | null, recipient_hash, actor_role }` —
  `actor_role` is `member` for a portal user (`check:actor-role-truth`).

| code | when |
|---|---|
| 200 | accepted and sent |
| 400 `invalid_body` | as preview |
| 404 `not_found` | `broadcastId` given and not the caller's |
| 422 `unsafe_content` · `cta_text_length` · `too_many_cta` · `cta_link_scheme` · `banner_alt_required` | the block rules (FR-041) — a test copy is validated exactly like a save |
| 429 `rate_limited` | > **10 / hour** per user (FR-037) |
| 502 `send_failed` | the provider refused; nothing is retried (research R23) |

## `POST /api/broadcasts/[id]/decision` — approve · request changes · withdraw approval

Permission: `requireMemberContext` + owning member. This single route carries all three member
actions of US1/US2 (FR-009, FR-010, FR-015a), because they are one decision about one version and
they race against each other.

```jsonc
// request
{ "versionId": "uuid",
  "decision": "approved" | "changes_requested" | "approval_withdrawn",
  "reason": "The date is wrong." }        // REQUIRED 1–2,000 for the last two; optional note ≤ 500 for the first
```

Server rules:

| rule | result |
|---|---|
| `decision ∈ {changes_requested, approval_withdrawn}` and `reason` missing/blank | **422 `reason_required`** (US2 AS1), announced on the reason field (FR-010) |
| `decision ∈ {changes_requested, approval_withdrawn}` and `reason` > 2,000 chars | **422 `validation_error`** with `issues` (FR-010) |
| `decision = approved` and the optional note > **500** chars | **422 `validation_error`** with `issues` (FR-009) |
| `versionId` is not the broadcast's **latest sent** version | **409 `stale_version`** + the current version in the body — the member was looking at an older round |
| `decision = approved \| changes_requested` while the stage is not `awaiting_member_approval` | **409 `stage_changed`** + current `stage` |
| `decision = approval_withdrawn` while the stage is not `member_approved` **or** `approved` | **409 `stage_changed`** |
| `decision = approval_withdrawn` once **sending has begun** — i.e. the stage is `sending` or later (FR-015: "sending begins" = the hand-over to the delivery provider) | **409 `sending_started`** — the send completes (spec § Edge Cases) |
| the member is suspended / the plan lapsed | **not checked here** — a lapsed member may still decide (spec § Edge Cases); the existing refusal applies at **send** time and marketing sees why it is blocked |
| > 60 decisions per minute for this user | **429 `rate_limited`** + `Retry-After` |

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

The response carries the new `stage` and `whoseTurn` precisely so the page can show the member where
the E-Blast now stands **and a way back to their E-Blast list** without a second fetch (FR-009).

Idempotency: a repeat of an identical body after the transition answers **409 `stage_changed`**
carrying the decision already recorded — the correct answer, not a replay (research R19).

## `POST /api/broadcasts/[id]/cancel` — withdraw the whole E-Blast (existing route, widened)

Unchanged contract. The accepted stage set widens from `('submitted','approved')` to
`IN_PROGRESS_BROADCAST_STATUSES` (FR-015: withdrawable at **any** stage before sending begins), via
`domain/policies/cancel-cutoff-policy.ts:47,49`. **The cut-off is entry into `sending`**: from that
moment the route answers **409 `sending_started`** and the send completes. The other party is
notified (`eblast_member_decided_marketing` with `decision: 'withdrawn'`). The allowance place is
freed (FR-020) — `cancelled` is in neither the reserved nor the consumed set. The client confirms in
a `ReasonConfirmationDialog` before calling (FR-010).

## `POST /api/broadcasts/inline-image-upload` — member image (existing route, **gains ownership**)

Permission: `requireMemberContext`. `multipart/form-data` with `file` and `draftId`. Today `draftId`
is an **unvalidated form string** (`route.ts:76`) although the route's own docstring claims a
draft-ownership check (`route.ts:5`) — there is none in either layer. This feature adds it (FR-040,
US6-AS7):

| rule | result |
|---|---|
| `draftId` resolves to a broadcast of **another member of the same tenant** | **404 `not_found`** + audit `broadcast_cross_member_probe` (US6-AS7) |
| `draftId` unknown, or another tenant's | **404 `not_found`** + audit `broadcast_cross_tenant_probe` |
| the broadcast is **closed** (any terminal status) | **409 `stage_changed`** — no upload against a finished E-Blast |
| the broadcast is the caller's but not a `draft` they own | **404 `not_found`** (no existence leak) |

Otherwise unchanged: ≤ 5 MB, MIME ∈ png/jpeg/webp/gif, SHA-256 dedup, fail-closed ClamAV, per-tenant
source allow-list. Additionally records a `broadcast_images` row
(`owner_kind='broadcast', owner_id=<draftId>`) and audits **`broadcast_image_uploaded`**
`{ owner_kind, owner_id, image_id, byte_size, mime_type, content_hash, actor_role: 'member' }`.
The **description (alt text, 1–125 chars)** is not part of the upload — the editor's insert dialog
collects it before the node can exist, its field is labelled, and an empty value is an **announced**
field error (FR-040).

## `GET /api/broadcasts/[id]` — member detail (existing route, widened)

Gains `stage`, `whoseTurn`, `round`, `proposedSendAt`, `confirmedSendAt`, `expiresAt` and — closing
FR-049 — the **subject and body** of the E-Blast (the page renders no body today,
`portal/broadcasts/[id]/page.tsx`). While the broadcast is awaiting the member, the body shown is
the latest **sent** version; otherwise it is the record's own content.

**This widening lands in two PRs** (plan Amendment 5), because only half of it can be built in PR-1:

| field | PR | why |
|---|---|---|
| `subject`, `body` (from the broadcast record's own content) | **PR-1**, task T141 | FR-049 is a screen-standard fix; it needs no new column and no version row |
| `stage`, `whoseTurn`, `round`, `proposedSendAt`, `confirmedSendAt`, `expiresAt`, and "the body is the latest **sent** version while awaiting the member" | **PR-2**, task T141a | every one of these reads a `0305` column (`proposed_send_at`, `current_round`, `stage_entered_at`), the `broadcast_versions` table, or the Domain `stageOf`/`turnOf` maps (T052) — none of which exists in PR-1 |

A PR-1 implementation of the second row is not merely early, it does not compile: the columns and
the table are created by migration `0305`, which ships with PR-2.

---

## Page contract — `/portal/broadcasts/[id]`

| element | requirement |
|---|---|
| Compare view | latest sent version (rendered through the preview route, in an iframe) **beside** the member's original on wide screens; marketing's note above it; the proposed send time (FR-008) |
| Compare view at phone width | the **formatted version comes first** and the original is reachable **below it on the same page** — a disclosure or a second section, never a link away, never a tab that unmounts the decision controls (FR-008) |
| Actions | "Approve" (optional note ≤ 500 chars, confirmed in a dialog that states **marketing will now confirm the send time** and that **the content cannot change without a new approval** — FR-009), "Request changes" (reason 1–2,000 required, `ReasonConfirmationDialog`, destructive tier), "Withdraw approval" (reason required, confirmed), "Withdraw E-Blast" (reason required, confirmed) — each with `finalFocus` back to its trigger (FR-009, FR-010) |
| After a decision | the page shows the **new stage** and **a way back to the E-Blast list** (FR-009); the stage banner announces the change through its existing `role="status"`, not a new live region |
| Round thread | an **ordered list with a heading per round** — every version, who sent it ("you" / "the chamber"), when, each decision and its reason, oldest first, navigable by keyboard and screen reader (FR-032). For an approve-as-submitted E-Blast the thread shows the single "approved as submitted" entry instead |
| Stage banner | `role="status"`; names the stage, whose turn it is, and — while awaiting — when it expires. The "version ready" email already stated the day 3 / 7 / 23 / 30 timeline (FR-021b); the banner repeats the expiry date |
| Empty / error / loading | shared components; `error.tsx` added (FR-047); the skeleton matches the real page |
| a11y | axe clean at 320 px; SC-003 — approve or request changes in under 2 minutes on a phone; reduced-motion respected on the preview dialog |
| i18n | `portal.broadcasts.approval.*` in EN (canonical) + TH + SV; the italic **control** is hidden on Thai while pasted/template italic content is kept (FR-044); times in the tenant time zone, BE display-only for `th-TH` |

## Contract tests (`tests/contract/broadcasts/portal-eblast-*.test.ts`)

- **Role pins**: a staff session (`admin`, `marketing`, `manager`) → 403 on every route here
  (`requireMemberContext` refusal) — including `POST …/decision`, which is FR-013's "never
  grantable to a staff role", asserted directly.
- **Owning member**: another member's broadcast → 404 + `broadcast_cross_member_probe`; an unknown
  id → 404 + `broadcast_cross_tenant_probe`; a malformed id → 404, no audit row.
- **Decision**: no reason on `changes_requested` → 422 `reason_required`; no reason on
  `approval_withdrawn` → 422; a 2,001-char reason → 422 `validation_error`; a **501-char approval
  note** → 422 `validation_error` while a 500-char one is accepted (FR-009); an old `versionId` →
  409 `stale_version`; approve while `changes_requested` → 409 `stage_changed`; withdraw while
  `sending` → 409 `sending_started`; approve twice → 409 with the recorded decision; a **lapsed**
  member's approve → **200** (deciding is not a benefit action).
- **Flag matrix**: with `FEATURE_EBLAST_MEMBER_APPROVAL` **off**, a broadcast already in
  `awaiting_member_approval` can still be approved here (FR-034), and a broadcast in `submitted`
  answers 409 `stage_changed` in both flag states.
- **Versions**: an unsent version is absent from the payload; `authoredBy` is never a staff name; an
  approve-as-submitted E-Blast returns empty `versions`/`decisions` and a populated
  `approvedAsSubmitted` (FR-007).
- **Test copy**: a body-supplied `to` is ignored and the session address is used; the **11th** call
  in an hour → 429 with `Retry-After` (10/hour, FR-037); the subject carries the `[Test]` prefix;
  four CTA blocks → 422 `too_many_cta`.
- **Preview**: 30 renders pass, the 31st in the same minute → 429; a 201 KB body → 400.
- **Image upload**: another member's draft → 404 + `broadcast_cross_member_probe` (US6-AS7); a
  terminal broadcast → 409; a success writes a `broadcast_images` row and a
  `broadcast_image_uploaded` audit row with `actor_role: 'member'`.
- **Rate limits**: the 61st decision in a minute → 429 with `Retry-After`.
