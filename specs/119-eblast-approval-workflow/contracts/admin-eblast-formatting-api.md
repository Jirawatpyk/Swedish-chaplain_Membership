# Contract — Staff E-Blast formatting, schedule, images and brand API

Routes under `src/app/api/admin/broadcasts/**`. Every route: **Node runtime**,
`requireApiPermission(request, '<key>')` (so `check:api-route-guard` sees it), tenant from the
resolved context, CSRF Origin allow-list + read-only-mode 503 from the proxy, and the F7 master
kill-switch (`src/proxy.ts:43-68`) → 503 `feature_disabled`.

**Permission map** (no new permission key — spec § Roles):

| action | key | roles |
|---|---|---|
| read the queue, a detail, versions, preview | `broadcasts.read` | super_admin, admin, manager, **marketing** |
| start / save / send a formatted version, upload an image, reject, **cancel** | `broadcasts.write` | super_admin, admin, marketing |
| **save the compose-on-behalf draft** (`POST \| PUT …/draft`, T145) | `broadcasts.write` | super_admin, admin, marketing |
| **read the proxied member's allowance** (`GET …/quota?memberId=`, T145) | `broadcasts.read` | super_admin, admin, manager, **marketing** |
| confirm, change or cancel the send time | `broadcasts.send` | super_admin, admin, marketing |
| read / write brand settings | `settings.broadcasts` | super_admin, admin (**not** marketing — `role-bundles.ts:49-64`) |
| **upload / replace / clear the chamber logo** | `settings.invoicing` | **super_admin only** (`permission-catalogue.ts:98`) — no route here touches it |

`manager` holds `broadcasts.read` only, so every write route below answers **403 `permission_denied`**
for a manager and the denial is audited (US4 AS6, read-only on the dashboard and detail).
Concretely (spec § Roles): a `manager` **can** read the queue, a detail, every version, every member
decision and the full history; a `manager` **cannot** format, save or send a version, **send a test
copy**, confirm/change/cancel a schedule, upload an image, or open the Brand page — each of those is
a `broadcasts.write` / `broadcasts.send` / `settings.broadcasts` route.

**Member-side approval is decided by the session, not by the person** (spec § Roles). A human who
holds both a staff account and a portal account of a member company gives the member-side approval
**only** while signed in as that company's portal user: the member routes refuse a staff session
(`requireMemberContext`) and these staff routes refuse a member session, so there is no request in
which one identity can act as the other (FR-013).

**Rate limits**: `POST …/test-copy` is **10 per user per hour** (FR-037, the same bucket as the
member route); `POST …/preview` is 30 per minute per actor. The formatting and schedule routes
(`…/version` POST and PATCH, `…/version/send`, `…/schedule`, `…/images`, `templates/[id]/images`,
`…/brand` PATCH, and — added by T145 — `…/draft` **POST and PUT**) take a **new** per-(tenant, actor)
bucket of **30 requests / 60 seconds**, refused
as `429 broadcast_rate_limit_exceeded` with `retryAfterSeconds`, over the existing
`broadcastsRateLimiter` (`src/modules/broadcasts/infrastructure/rate-limiter.ts:14`) and the
`RECIPIENT_COUNT_RATE_MAX` / `_WINDOW_SECONDS` shape (`src/lib/broadcasts-recipient-count.ts:30-31`),
with an **atomic** check, never peek-then-act. **The two staff routes T081 widens —
`POST …/[id]/reject` and `POST …/[id]/cancel` — take the same 30 / 60 s bucket** (round 4 M6): T081
widens both to `IN_PROGRESS_BROADCAST_STATUSES`, and a state-changing staff route that carries no
bucket at all is the gap this section exists to close, not one it may leave open.
**Built by T026a in PR-1** (`…/brand` PATCH,
`…/images`, `templates/[id]/images`), **T062a in PR-2** (`…/version` POST+PATCH,
`…/version/send`, `…/schedule`) **and T081 in PR-2** (`…/reject`, `…/cancel`, in the same edit that
widens their stage set): the bucket was stated here and in spec
§ Roles but no task built it until round 3 (`/speckit.analyze` round 3 H3).
**"Keep the existing staff buckets" was wrong — checked against `main`
(`/speckit.analyze` M14)**: `approve`, `reject` and `cancel` carry no rate limit at all today, so
there is no staff bucket to keep and every number above is an addition, stated rather than implied.

**Flag rule (research R18)**: `FEATURE_EBLAST_MEMBER_APPROVAL` gates exactly one **edge**, not a
route — `submitted → in_design`, the single **entry** into the approval round. `POST …/[id]/version`
answers **404** while off **only when the re-read row is `submitted`**; the same POST from
`changes_requested`, `member_approved` or `approved` (round ≥ 1) answers 201 in both flag states,
because re-opening a working copy is the only way an in-flight E-Blast can be **completed** and
FR-034 requires it to stay completable, not merely cancellable. An earlier draft of this rule gated
the whole route and would have dead-ended every row the member had sent back
(`/speckit.analyze` round 3 H1). Every other route here stays available for the same reason (FR-034). **The gate ships in the same PR as the route** (task T152, plan Amendment 7):
PR-2 creates `POST …/[id]/version` in T062, and merging it without T152 puts the approval round live
in production for every `broadcasts.write` holder — hiding the button on the detail page is not a
gate, and "merge without setting the env var" protects nothing if no code reads the variable
(`/speckit.analyze` C1).

**Error envelope**: `{ error, message?, stage?, currentUpdatedAt?, retryAfterSeconds?, issues? }`.
Fault arms are named `M119.admin.<route>.<arm>`. No `Idempotency-Key` on the state-changing routes
(research R19).

**Audit payloads**: each route below names the event it emits; the **field list for every event is
in `dashboard-and-notifications.md` § 2**, which is the single source of truth. Where a payload is
spelled out here it is a quotation of that table, not a second definition — restating field lists in
two files is how four events drifted apart (`/speckit.analyze` M6). Note especially the **member
key** column there: `member_id` (snake_case) for member-actor events, `related_member_id` for staff
and system events; the 0009 `last_activity_at` trigger reads only the former.

---

## `POST /api/admin/broadcasts/[id]/version` — start a formatted version (FR-001)

Permission `broadcasts.write`. **Flag-gated on the `submitted` arm only** — 404 while
`FEATURE_EBLAST_MEMBER_APPROVAL` is off **and** the re-read row is `submitted`; the three other
accepted stages below are unaffected by the flag (round 3 H1).

Accepted stages: `submitted`, `changes_requested`, and — voiding an approval — `member_approved` or
`approved` **when `current_round >= 1`** (spec § Edge Cases "Marketing edits after the member
approved"; the round guard stops an approve-as-submitted E-Blast being dragged into a design round
it never had).

In one `runInTenant`, with throw-to-rollback:

1. `SELECT … FOR UPDATE` the broadcast; re-check the stage.
2. If no `version_no = 0` row exists, **materialise it** from `broadcasts.subject` / `body_html` /
   `body_source` (research R2 — this is the last moment the member's original is intact).
3. Insert or return the working copy (`sent_to_member_at IS NULL`), seeded from the latest sent
   version, or from v0 on round 1.
4. Transition to `in_design`; stamp `stage_entered_at`.
5. When coming from `member_approved` / `approved`: clear `approved_version_id`, clear
   `scheduled_for` (trigger exemption E2), and emit `broadcast_member_approval_voided`.
6. Audit `broadcast_version_started { related_member_id, broadcast_id, version_id, round, from_stage, actor_role }`
   — quoted from `dashboard-and-notifications.md` § 2; `from_stage` was missing here while the table
   and T056 carried it (`/speckit.analyze` round 4 M5).

```jsonc
201 { "stage": "in_design", "version": { "id": "uuid", "versionNo": 1, "subject": "…",
      "bodyHtml": "…", "noteToMember": null, "updatedAt": "…" },
      "memberOriginal": { "id": "uuid", "versionNo": 0, "subject": "…", "bodyHtml": "…" } }
```

| code | when |
|---|---|
| 201 | started (or the existing working copy returned — idempotent) |
| 403 | `permission_denied` (manager, member session) — audited |
| 404 | unknown id / other tenant (audited `broadcast_cross_tenant_probe`), **or the flag is off and the row is `submitted`** |
| 409 `stage_changed` | the broadcast is not in an accepted stage |
| 409 `round_zero` | `approved`/`member_approved` with `current_round = 0` |

## `PATCH /api/admin/broadcasts/[id]/version` — save the working copy

Permission `broadcasts.write`. Stage must be `in_design`.

```jsonc
// request
{ "subject": "…", "bodyHtml": "…", "bodySource": "…", "noteToMember": "…" | null,
  "expectedUpdatedAt": "2026-09-24T09:10:00.000Z" }
```

- **Order of checks** (T166 S-INFO): PATCH consumes the staff write bucket BEFORE reading the body; a
  malformed body still answers 400 but spends one call, and an exhausted bucket answers 429 without
  parsing up to 2 MB.
- **Optimistic concurrency** (FR-033, the "two marketing users" edge case): `expectedUpdatedAt` must
  equal the row's `updated_at` → otherwise **409 `version_changed`** with `currentUpdatedAt` and the
  current content, so the client can show "someone else changed this" rather than overwrite. There is
  exactly **one** working copy per E-Blast at a time (the `broadcast_versions_one_unsent_idx` partial
  unique index), so a second marketing user edits the same row and loses the race here (FR-001).
- The body passes the **same** content-safety and size rules as a member's, **at every save and again
  when the version is sent to the member** (FR-004): the shared sanitiser policy, `subject ≤ 200`
  characters, `bodyHtml ≤ 200 KB` **including the design-block markup**, image ≤ 5 MB, the per-tenant
  image-source allowlist. A violation is **422** and the version is **not saved**:

| code | rule |
|---|---|
| `unsafe_content` | the sanitiser removed something — the body is refused, not silently cleaned |
| `validation_error` | `subject > 200`, `bodyHtml > 200 KB`, or **`noteToMember > 1,000` characters** (with `issues`) — the note bound is FR-006's and is enforced in the route's zod schema, so an over-long note is a 422 and never the `broadcast_versions.note_to_member` CHECK, which would surface as a 500 (`/speckit.analyze` M11) |
| `cta_text_length` | CTA button text outside 1–60 characters (FR-041) |
| `too_many_cta` | more than 3 CTA buttons in the message (FR-041) |
| `cta_link_scheme` | a link whose scheme is outside `http` / `https` / `mailto` (FR-038/FR-041) |
| `banner_alt_required` | a banner or inline image without a 1–125-character description (FR-040) |
| `image_source_not_allowlisted` | an image whose host is not on the tenant allow-list — the body names **which image** (spec § Edge Cases) |

- No audit event (a save is not a hand-off); counted `broadcasts_version_saved_total`, which is
  registered in `dashboard-and-notifications.md` § 4.2 and in `src/lib/metrics.ts` (T122) — it was
  previously named only here, so it would have shipped unregistered (`/speckit.analyze` M2).

```jsonc
200 { "version": { "id": "uuid", "versionNo": 1, "updatedAt": "…" }, "unsafeImageSources": [] }
```

## `POST /api/admin/broadcasts/[id]/version/send` — send the version to the member (FR-003)

Permission `broadcasts.write`. Stage must be `in_design`; a working copy must exist and must pass the
content rules **again** at this moment (FR-004 — "cannot be sent to the member until it passes"),
including the allow-list re-check below.

**Preconditions checked here, not assumed:**

| precondition | refusal |
|---|---|
| the owning member company has **at least one active portal user** to notify | **409 `no_portal_user`** — a proxy-submitted E-Blast whose member has no portal account cannot be sent for approval. The staff detail page shows a standing warning, and the only paths left are "Approve as submitted" (FR-007) or inviting a portal user first (spec § Edge Cases) |
| **every image in the body still resolves to an allow-listed host** — re-evaluated now, because a host may have been removed from the tenant allow-list since the version was saved | **422 `image_source_not_allowlisted`**, body carrying `{ images: [{ src, host, reason }] }` so marketing is told **which image and why**; the version stays editable and can be sent once the image is replaced (spec § Edge Cases) |

**Re-sending the same content is allowed** (FR-011): when marketing disagrees with a change request
it may send a version whose subject and body are byte-identical to the previous round, with a note
explaining why. There is no "nothing changed" refusal — it is a new version, a new round, and the
alternative FR-011 offers is rejecting the E-Blast with a reason (FR-015).

One `runInTenant`: stamp `sent_to_member_at` (the version becomes read-only — DB trigger
`broadcast_versions_immutable_after_send_fn`), `current_round = version_no`, transition to
`awaiting_member_approval`, stamp `stage_entered_at`, reset `member_reminder_stage = 0` and
`member_expiry_notified_at = NULL`, audit
`broadcast_version_sent_to_member { related_member_id, broadcast_id, version_id, round, note_length, notified, actor_role }`
(quoted from `dashboard-and-notifications.md` § 2; the `notified: bool` field was missing here while
the table and T059 carried it — `/speckit.analyze` round 4 M5),
enqueue one `eblast_version_sent_member` outbox row to the member's contact in their preferred
language (FR-024).

```jsonc
200 { "stage": "awaiting_member_approval", "whoseTurn": "member", "round": 2,
      "expiresAt": "2026-10-24T09:12:00.000Z" }
```

| code | when |
|---|---|
| 409 `stage_changed` · `no_working_copy` · `content_unsafe` · **`no_portal_user`** | as above |
| 422 `validation_error` · the block codes · **`image_source_not_allowlisted`** | subject/body limits, FR-041 block rules, a de-allow-listed image |

`current_round` is incremented **here and only here** — a round is a version sent to the member
(FR-026), so a withdrawn approval does not start one.

After this, `PATCH …/version` answers **409 `stage_changed`** — marketing can no longer edit that
version (US1 AS2).

## `GET /api/admin/broadcasts/[id]/version` — the working copy + the full thread

Permission `broadcasts.read` (so a manager can read it). Returns the member's original, every
version with its author and send time, every member decision with its reason, the working copy if
any, and `updatedAt` for the concurrency token. This is the staff side of FR-032 — a record of
**versions and decisions**, distinct from the audit trail, which is never read to build it; the
member's feedback is attached to the version it concerns (FR-011). On the approve-as-submitted path
(FR-007) there are no version rows at all, and the response instead carries
`approvedAsSubmitted: { at, byUserId, byUserName }` — the history then records "approved as
submitted" with the staff user and the time, which is what FR-007 requires.

## `POST /api/admin/broadcasts/[id]/schedule` — confirm, change or cancel the send time (FR-017)

Permission `broadcasts.send`.

```jsonc
// request — one of
{ "mode": "keep_proposal" }
{ "mode": "schedule", "scheduledFor": "2026-10-01T03:00:00.000Z" }
{ "mode": "send_now" }
{ "mode": "cancel" }
```

| from stage | mode | effect |
|---|---|---|
| `member_approved` | `keep_proposal` \| `schedule` \| `send_now` | **promotes the approved version** into `broadcasts.subject`/`body_html`/`body_source` (trigger exemption E1 — FR-012a a), sets `scheduled_for` (E2), transitions `member_approved → approved` |
| `approved` | `schedule` \| `send_now` | changes `scheduled_for` (E2); stage stays Scheduled |
| `approved` | `cancel` | clears `scheduled_for` and transitions `approved → changes_requested`, so the row leaves the dispatchable status (FR-017 "MUST NOT be dispatchable") |

Rules:

- `scheduledFor` must be ≥ `now + 5 min` — the existing floor (`approve-broadcast.ts:110-116`),
  refused **422 `broadcast_schedule_too_soon`**. This is also the "proposed time already passed"
  edge case: `keep_proposal` with a past proposal is refused with the same code and the client
  falls back to picking a time.
- `keep_proposal` requires `proposed_send_at IS NOT NULL` → else **409 `no_proposal`**.
- **Promotion re-checks the images**: before the approved version is copied into the sending record,
  every image in it must still resolve to an allow-listed host. A host removed from the allow-list
  since approval refuses the promotion with **422 `image_source_not_allowlisted`** naming the image;
  the E-Blast stays at Member approved until marketing replaces it and the member approves the new
  version (spec § Edge Cases — "cannot be sent to the member **or promoted** until the image is
  replaced").
- Confirming, changing or cancelling the send time is **not a content change** and therefore **never
  voids the member's approval** (FR-012); `approved_version_id` is untouched by every mode but
  `cancel`, which clears only `scheduled_for` and moves the row off the dispatchable status.
- Audit `broadcast_schedule_confirmed { related_member_id, broadcast_id, version_id,
  proposed_send_at, confirmed_send_at, differs: bool, mode, actor_role }`.
- Enqueue one `eblast_schedule_confirmed_member` outbox row; the rendered email calls out the
  difference explicitly when `differs` (FR-018).

```jsonc
200 { "stage": "approved", "confirmedSendAt": "…", "proposedSendAt": "…", "differs": true }
```

**FR-012a proof**: the promotion is the *only* write of `subject`/`body_html` after submit, it
happens on the *only* edge the trigger exempts, and it copies from `approved_version_id` — the row
the member approved. The delivery path is untouched and still reads `broadcasts.body_html`
(`dispatch-scheduled/route.ts:168-183` → the Resend gateway), so "the content that is sent is
exactly the version the member approved" (FR-012, SC-002) holds without teaching the sender a
second source.

## `POST /api/admin/broadcasts/[id]/reject` and `…/cancel` (existing routes, widened)

Both routes name **`broadcasts.write`** through `requireApiPermission`. That is a change for
`…/cancel`, which named no permission key anywhere in this contract — a state-changing staff route
with no declared guard is exactly what `check:api-route-guard` exists to catch, and it must be
named, not inferred (`/speckit.analyze` M8; task T081).

Contracts otherwise unchanged. The accepted stage set widens to `IN_PROGRESS_BROADCAST_STATUSES` (FR-015 —
marketing may reject with a reason at any stage before **sending begins**, i.e. before entry into
`sending`; from `sending` onward the route answers **409 `sending_started`** and the send completes),
and the member notification gains the stage it was rejected from. Reuses the existing
`broadcast_rejected` / `broadcast_cancelled` audit events and the existing
`broadcast_rejected_notification` / `broadcast_cancelled_notification` outbox types. Rejecting is
also FR-011's alternative when marketing disagrees with a change request and will not send another
version.

**Both gain the staff write bucket** — 30 requests / 60 seconds per (tenant, actor), atomic check,
refused `429 broadcast_rate_limit_exceeded` with `retryAfterSeconds`, exactly as the formatting
routes above. Neither carries one today (`/speckit.analyze` M14), and widening their accepted stage
set without one leaves the only two unbucketed state-changing staff routes in the feature
(round 4 M6). Built by **T081** itself, in the same edit that widens the stage set.

## `POST /api/admin/broadcasts/[id]/images` — staff image on the E-Blast being formatted (FR-040)

Permission `broadcasts.write`. `multipart/form-data` with `file`. The broadcast must belong to the
caller's tenant, and the **accepted stage set widens across the two PRs** (`/speckit.analyze` H1,
plan Amendment 6):

| PR | accepted stages | what it serves | refusal outside the set |
|---|---|---|---|
| **PR-1** (`0304`, task T106) | `draft`, `submitted` | the staff **compose-on-behalf** draft — the half of US3-AS3 PR-1 can honestly satisfy | 409 `stage_changed` |
| **PR-2** (`0305`, task T106a) | `draft`, `submitted`, **`in_design`** | marketing illustrating the formatted version — the other half of US3-AS3 | 409 `stage_changed` |

`in_design` is a `broadcast_status` value migration `0305` introduces, so a PR-1 route gated on it
could only ever answer 409 and its success path could never go green. A **sent** version is
read-only (FR-003), so `awaiting_member_approval` and everything after it stay refused in both PRs.
Together with the tenant check this is the "a staff user adds an image to another member's E-Blast:
allowed only on the E-Blast they are formatting" edge case, enforced at the route rather than
assumed.

Shares `uploadInlineImage` with the member route, so identical rules apply: ≤ 5 MB
(`upload-inline-image.ts:38`), MIME ∈ png/jpeg/webp/gif, SHA-256 dedup, **fail-closed ClamAV scan**
before storing, per-tenant source-allowlist auto-seed. Additionally records a `broadcast_images` row
with `owner_kind='broadcast', owner_id=<id>`.

```jsonc
201 { "blobUrl": "https://…", "allowlistedHostname": "…", "contentHash": "…", "imageId": "uuid" }
```

| code | when |
|---|---|
| 404 `not_found` | another tenant's broadcast (audited `broadcast_cross_tenant_probe`) |
| 409 `stage_changed` | not `in_design` — which also covers a **closed** E-Blast (any terminal status): no upload against a finished E-Blast (FR-040) |
| 413 `too_large` | > 5 MB (route pre-check at 5.5 MB) |
| 415 `invalid_mime` | outside the MIME list |
| 422 `unsafe` | ClamAV verdict not clean (infected, error **or** timeout — fail-closed) |
| 503 `storage_unavailable` | blob error |

Audits **`broadcast_image_uploaded`**
`{ related_member_id, owner_kind: 'broadcast', owner_id, image_id, byte_size, mime_type, content_hash, actor_role }`
on success (a new audit value — see `dashboard-and-notifications.md` § 2); a row stamped
`deleted_at` by erasure, withdrawal or rejection audits **`broadcast_image_removed`**.

**Alt text (FR-040)** is *not* part of the upload: the editor requires a **1–125-character**
description before the image node can be inserted, its field is labelled, an empty value is an
**announced** field error, and the description is carried into the sent email as the `alt`
attribute the shared sanitiser policy allows. A rejected upload leaves the user's text untouched
(spec § Edge Cases).

## `POST /api/admin/broadcasts/templates/[id]/images` — template image (FR-046a)

Permission `broadcasts.write`. Identical rules; records `owner_kind='template', owner_id=<template
id>`. The template must exist in the tenant and not be soft-deleted. Starting an E-Blast from a
template carries the images **by reference** (the existing snapshot copies the HTML, so the `src`
URLs come along) and a later template edit or delete does not change E-Blasts already started from
it — today's snapshot semantics. The last-reference rule (data-model § 4) is what keeps a member's
draft working after the template image is removed. **Blocks and links that arrive from a template
are the member's own content** from that moment: editable and deletable like anything else, with no
per-block authorship recorded and no "from template" marking anywhere in the payload (FR-046a).

## `POST | PUT /api/admin/broadcasts/draft` — the staff compose-on-behalf draft (FR-039)

Permission **`broadcasts.write`** on both verbs — **not** `proxy-submit`'s `broadcasts.send`: saving a
draft is not sending, so the key that gates sending must not gate it, and a `manager` is refused on
both. Added by **T145** (plan Amendment 7): the staff image route above is specified against "the
staff **compose-on-behalf** draft", and FR-039 asks for draft save/resume on that screen, but nothing
in PR-1 could mint a staff-owned `draft` — `proxy-submit` creates a **`submitted`** row and
`/api/broadcasts/draft` is `requireMemberContext`-gated. This route is the missing half; it is thin
by construction, wrapping the **existing** `saveDraft` use case, which already takes a `memberId` and
`actorRole: 'admin_proxy'`.

```jsonc
// request — the member route's body plus the member being acted for
{ "memberId": "uuid",            // REQUIRED; the draft belongs to this member
  "draftId": "uuid",             // omit on POST; REQUIRED on PUT
  "subject": "…", "bodyHtml": "…", "bodySource": "…",
  "segmentType": "all_members" | "tier" | "event_attendees_last_90d" | "custom",
  "segmentParams": {…} | null, "customRecipientEmails": ["…"] | null,
  "scheduledFor": "2026-10-01T03:00:00.000Z" | null }
```

The response envelope is the member route's, field for field
(`src/lib/broadcasts-draft-response.ts` — shared, so the two cannot drift):
`{ broadcastId, status, createdAt, updatedAt, subject, segmentType, segmentParams,
customRecipientEmails, scheduledFor }`.

| code | when |
|---|---|
| 201 | POST created the draft |
| 200 | PUT updated it |
| 400 `invalid_body` | malformed body, a non-uuid `memberId`, or a PUT with no `draftId` |
| 403 | `permission_denied` (manager, member session) — audited |
| 404 `broadcast_member_not_found` | no such member in the caller's tenant — the id is echoed, never which ids exist |
| 409 `broadcast_member_erased` | the member is GDPR-Art.17 / PDPA-§33 erased: a staff draft must not stamp a scrubbed company name on a fresh row the erase cascade already ran past (the `proxy-submit` rule, same read) |
| 409 `broadcast_immutable_after_submit` | the named draft is past `draft` — exactly the member route's refusal |
| 422 | the member route's content rules — an **empty** subject (`broadcast_subject_empty`), subject > 200 (`broadcast_subject_too_long`), body > 200 KB (`broadcast_body_too_large`), unsafe HTML, member without a primary contact email. F119 U28: the route used to answer these 400 `invalid_body`, contradicting this row and rendering as "an unexpected error occurred" because `invalid_body` had no locale key; it now emits the codes the locales already carry, the same ones `submit` emits |
| 429 `broadcast_rate_limit_exceeded` | the staff write bucket, with `retryAfterSeconds` |

**Rate bucket**: the **same** staff 30 requests / 60 seconds per (tenant, actor) as the formatting and
image routes (`staffWriteRateKey`), consumed with an atomic check **above** the member read and the
save — a refused call reads nothing and stores nothing.

**Ownership on PUT**: scoped by `saveDraft`'s own guards to a `draft` row **of the named member**, so
a staff user may resume a draft another staff user started for that member (staff act for the
chamber) while a row past `draft` answers 409. Whose staff hand typed it is not a thing the route
decides.

**Submit in place**: `POST /api/admin/broadcasts/proxy-submit` accepts an optional `draftId` (uuid)
naming this staff draft; `proxySubmitBroadcast` threads it into the same delegate the member's
`POST /api/broadcasts/submit` uses, so the row is **updated + transitioned** rather than duplicated.
The delegate's per-member ownership check applies: a `draftId` of another member → 404
`broadcast_not_found`; a row past `draft` → the delegate's status refusal. Omitted → a fresh row,
exactly as before F119.

**Audit**: the **existing** `broadcast_drafted` event `saveDraft` already emits on create, carrying
`actorRole: 'admin_proxy'` and the staff user as `actorUserId`. **No new audit event type** — an edit
of an existing draft emits nothing, as on the member side (FR-004). Note the payload's member key is
camelCase `memberId`, which the 0009 `last_activity_at` trigger does **not** read: a staff draft
therefore does not move the member's recency, the same posture as the staff image upload above.

Read-only mode and the F7 master kill-switch behave as on every sibling admin broadcast route
(enforced upstream in `src/proxy.ts`).

## `GET /api/admin/broadcasts/quota?memberId=<uuid>` — the proxied member's allowance (FR-039)

Permission **`broadcasts.read`**, so a `manager` may read it: an allowance is a read, and the
read-only role reads. Added by **T145** alongside the draft route. `GET /api/broadcasts/quota`
resolves the member from the **session**, which no staff user can satisfy for someone else; this
route reuses the same `computeQuotaCounter` with the member taken from the query.

The response is the member route's envelope, field for field (shared through
`quotaResponseBody`), so the `QuotaDisplay` component renders it with only an endpoint changed:

```jsonc
200 { "planId": "uuid", "planCode": "premium_corporate", "planName": "Premium Corporate",
      "eblastPerYear": 6, "quotaYear": 2026, "used": 2, "reserved": 1, "remaining": 3, "cap": 6,
      "nextResetAt": "2026-12-31T17:00:00.000Z", "tenantTimezone": "Asia/Bangkok" }
```

| code | when |
|---|---|
| 400 `invalid_query` | `memberId` missing or not a uuid — refused before the use case runs |
| 403 | `permission_denied` (member session) — audited |
| 404 `broadcast_member_not_found` | no such member in the caller's tenant (the member route's code, so on-call is not sent looking for a missing broadcast) |

No write, therefore **no write bucket** and **no audit event** — reading an allowance is not a state
change.

## `POST /api/admin/broadcasts/preview` and `POST /api/admin/broadcasts/test-copy`

Permission `broadcasts.read` (preview) and `broadcasts.write` (test copy — so a `manager` gets 403).
Bodies, responses, limits and audit events are identical to the member routes in
[`portal-eblast-approval-api.md`](./portal-eblast-approval-api.md); the staff/member pair mirrors the
existing `/api/broadcasts/recipient-count` ↔ `/api/admin/broadcasts/recipient-count` precedent. The
test copy still goes **only** to the session user's own address — a staff user cannot send a test to
the member — carries the `[Test]` subject prefix, runs the **identical** pipeline including design
blocks, the brand header and the footer, and is capped at **10 per user per hour** (FR-037). The
preview renders desktop **600 px** and phone **375 px** (FR-043).

**The brand read is deliberately asymmetric** (ROUND-3 #10). A dispatch and the audience tick go
through `_load-brand-chrome.ts`, which degrades to **no chrome** and increments
`broadcasts_brand_chrome_unavailable_total{tenant,surface}` — a queued send must not be lost over a
logo.
The preview and the test copy call the port **directly**, so a brand-read fault **fails the request**
and the operator sees an error instead of an unbranded email. That is the intent, not an oversight:
these two surfaces exist to SHOW what will be sent, and a test copy that quietly arrives unbranded
teaches the operator the brand is fine at the one moment they could have caught that it is not.

## `GET | PATCH /api/admin/broadcasts/brand` — chamber brand settings (FR-041b/c)

Permission `settings.broadcasts` on **both** verbs.

```jsonc
// GET 200
{ "primaryColor": "#10487a" | null,
  "postalAddress": "349 Sukhumvit Rd…" | null,
  "addressMissing": true,
  "logo": { "url": "https://…" | null, "source": "invoice_settings",
            "manageHref": "/admin/settings/invoicing" | null },   // href only for settings.invoicing holders
  "defaults": { "primaryColor": "#10487a" },
  "updatedAt": "…" | null }
```

```jsonc
// PATCH request — at least one key
{ "primaryColor": "#0b5f3a" | null, "postalAddress": "…" | null }
```

| code | when |
|---|---|
| 200 | saved; audit `broadcast_brand_settings_changed { previous: {…}, next: {…}, actor_role }` |
| 403 | `permission_denied` — **including `marketing`**, which does not hold `settings.broadcasts` |
| 422 `colour_contrast` | white text on the colour is below WCAG AA 4.5:1; the body carries `{ ratio: 3.1, required: 4.5 }` and **the previous colour stays in force** (spec § Edge Cases) |
| 422 `validation_error` | not `#RRGGBB`; address > **300** chars (FR-041c — free text, line breaks allowed, length is the only bound) |

**A brand change voids nothing.** Logo, colour and address are **not content** (FR-012): they are
applied live at send time and in every preview (FR-041c), so a `PATCH` here leaves every pending and
approved version — and `approved_version_id` — untouched, and never moves a stage. The colour is used
**in email only**, never in the portal or admin UI.

**The logo is read-only here.** `GET` returns its URL, resolved through the invoicing module's
`getTenantLogoPublicUrl` (research R12), and a link to the page that owns it; `PATCH` accepts **no**
logo key and there is no upload control on the page. FR-041b's contract test —
`tests/contract/broadcasts/brand-cannot-write-invoice-logo.test.ts` — enumerates every route
reachable with `settings.broadcasts` alone and asserts none of them writes
`tenant_invoice_settings.logo_blob_key`, with a positive control that fails if a write path is
added.

---

## Page contracts

### `/admin/broadcasts/[id]` — the formatting and review surface

| element | requirement |
|---|---|
| Stage header | stage, whose turn (Marketing / Member / "—"), time in stage, round, proposed vs confirmed send time |
| Actions | "Approve as submitted" and "Reject" (today, unchanged — FR-007) plus "Start formatted version" (flag-gated), "Send to member", "Confirm schedule" |
| Warnings | a standing notice when the member company has **no portal user** (only "Approve as submitted" or inviting a user is possible — 409 `no_portal_user`), and when an image's host has left the allow-list, naming the image |
| Editor | the same writing tool the member uses (FR-039), with the member's original beside it, read-only. Toolbar: H2/H3 only, quote, divider, lists, bold, underline, link, image, CTA, banner; wraps at 320 px with **no overflow menu**; arrow keys + **Home/End**; a visible focus state (FR-038, FR-048) |
| Compose width | the editor and the 600 px preview side by side ≥ lg, stacked below — a departure from the form container tier, recorded as an exception in `docs/ux-standards.md` § 18.2 **in the same change** (FR-050) |
| Version thread | an **ordered list with a heading per round** — author, note, decision and reason, oldest first, navigable by keyboard and screen reader (FR-032). Its own record, not the audit trail |
| Preview | inline (real email, translated empty-state line) + Preview dialog at **desktop 600 px / phone 375 px**, `finalFocus`, reduced-motion respected (FR-043) |
| Sections | shadcn `Card`, replacing the bare `rounded-md border` blocks at `:114,158` |
| Manager | read-only — every action control absent, not merely disabled (`manager-readonly-banner` already exists); no format, no test copy, no schedule, no Brand link |
| Error/loading | `error.tsx` added; the skeleton matches the real page |

### `/admin/settings/broadcasts/brand` — the Brand page (FR-041b)

The page lives **under the staff Settings area, beside the existing E-Blast settings page**
(FR-041b) — not under `/admin/broadcasts`. `requirePagePermission('settings.broadcasts')`, so a user
without that permission, **`marketing` included**, does not see the nav entry, the Settings-index
card or the page: the surface is invisible, not disabled. Where a user who cannot fix it meets the
"no logo on file" state — on compose, on the preview, in the header hint — the copy tells them to
**ask an administrator**, and links to this page only for a `settings.broadcasts` holder.
In-page gate on `env.features.f7Broadcasts` (the
proxy kill-switch predicate covers `/admin/broadcasts`, **not** `/admin/settings/**` — research
R18). Shows the logo as a read-only preview with its source and a link only a `settings.invoicing`
holder sees; a colour field with a live contrast readout and a disabled Save while the ratio is
below 4.5:1; a multi-line address field (≤ 300 characters, line breaks allowed) flagged when empty.
Registered in **three** places — `src/config/nav.ts`
Settings section, the `CATEGORIES` array in `src/app/(staff)/admin/settings/page.tsx`, and the i18n
namespace `admin.settings.index.categories.eblastBrand.*` — because the nav guard key must equal the
page's `requirePagePermission` key and both files' docblocks record past incidents of one being
forgotten.

## Contract tests (`tests/contract/broadcasts/admin-eblast-*.test.ts`)

- **RBAC pins per route × role**: `manager` → 403 on every write route **including test copy**
  (audited `permission_denied`) and 200 on every read route including `GET …/version`;
  `marketing` → 200 on format/send/schedule/images, **403 on brand**; `member` session → 403
  everywhere, including for a person who also holds a portal account of the owning member (the
  session decides, spec § Roles).
- **Flag matrix**: `POST …/[id]/version` **on a `submitted` broadcast** → 404 with the flag off, 201
  with it on; the **same POST on `changes_requested` → 201 in both states** (and on
  `member_approved`/`approved` with `current_round >= 1` → 201, with `current_round = 0` → 409
  `round_zero` in both states); every other route behaves identically in both states, and a broadcast
  already in `in_design` can still be saved, sent, decided and scheduled with the flag off (FR-034).
- **Concurrency**: two `PATCH`es with the same `expectedUpdatedAt` → the second is
  409 `version_changed`; `PATCH` after `send` → 409 `stage_changed`.
- **Schedule**: `keep_proposal` with a past proposal → 422 `broadcast_schedule_too_soon`;
  `keep_proposal` with no proposal → 409 `no_proposal`; the audit row carries
  `differs: true` when the confirmed time is not the proposal.
- **Promotion**: after `mode: send_now` from `member_approved`, `broadcasts.subject` and
  `body_html` equal the approved version byte-for-byte, and a subsequent direct `UPDATE` of them is
  still refused by the trigger.
- **Images**: staff upload on a `submitted` broadcast → 409; on a **closed** broadcast → 409; on
  another tenant's → 404 + probe audit; an infected file → 422 with nothing stored; a
  `broadcast_images` row **and** a `broadcast_image_uploaded` audit row are written on success.
- **Send preconditions**: a member company with no active portal user → 409 `no_portal_user` and no
  stage change; an image whose host was removed from the allow-list after the save → 422
  `image_source_not_allowlisted` naming that image, with the version still editable; the same check
  refuses the **promotion** on `POST …/schedule` from `member_approved`.
- **Block rules**: 61-character CTA text → 422 `cta_text_length`; a fourth CTA → 422 `too_many_cta`;
  `javascript:` in a CTA link → 422 `cta_link_scheme`; a banner without a description → 422
  `banner_alt_required`; a 126-character description → 422; all four are refused at `PATCH …/version`
  **and** again at `…/version/send` (FR-004).
- **Re-send unchanged content**: sending a version byte-identical to the previous round succeeds and
  becomes round N+1 (FR-011).
- **Audience is not marketing's to change (FR-005)**: a `PATCH …/version` and a `POST …/version/send`
  carrying `segmentType` / `segmentParams` / `customRecipientEmails` leave
  `broadcasts.segment_type`, `segment_params` and `custom_recipient_emails` **unchanged** — the
  fields are not in the accepted body and the DB trigger refuses them on every post-`draft`
  transition. Asserted directly, because "the schema has no field for it" is a property of today's
  zod schema, not a guarantee.
- **Approval is not voided by**: a brand `PATCH`, a schedule `PATCH` in any mode but `cancel`, or a
  `note_to_member`-only change — `approved_version_id` is unchanged in each (FR-012).
- **Brand**: `#f5f5f5` → 422 `colour_contrast` with the computed ratio and the stored colour
  unchanged; a 301-character address → 422; a 300-character address with line breaks → 200; the
  FR-041b logo-write assertion with its positive control.
