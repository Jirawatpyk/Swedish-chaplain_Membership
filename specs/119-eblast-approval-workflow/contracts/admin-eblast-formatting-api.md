# Contract — Staff E-Blast formatting, schedule, images and brand API

Routes under `src/app/api/admin/broadcasts/**`. Every route: **Node runtime**,
`requireApiPermission(request, '<key>')` (so `check:api-route-guard` sees it), tenant from the
resolved context, CSRF Origin allow-list + read-only-mode 503 from the proxy, and the F7 master
kill-switch (`src/proxy.ts:43-68`) → 503 `feature_disabled`.

**Permission map** (no new permission key — spec § Roles):

| action | key | roles |
|---|---|---|
| read the queue, a detail, versions, preview | `broadcasts.read` | super_admin, admin, manager, **marketing** |
| start / save / send a formatted version, upload an image, reject | `broadcasts.write` | super_admin, admin, marketing |
| confirm, change or cancel the send time | `broadcasts.send` | super_admin, admin, marketing |
| read / write brand settings | `settings.broadcasts` | super_admin, admin (**not** marketing — `role-bundles.ts:49-64`) |
| **upload / replace / clear the chamber logo** | `settings.invoicing` | **super_admin only** (`permission-catalogue.ts:98`) — no route here touches it |

`manager` holds `broadcasts.read` only, so every write route below answers **403 `permission_denied`**
for a manager and the denial is audited (US4 AS6, read-only on the dashboard and detail).

**Flag rule (research R18)**: `FEATURE_EBLAST_MEMBER_APPROVAL` gates exactly one route —
`POST …/[id]/version` (start a formatted version), the single **entry** into the approval round →
**404** while off. Every other route here stays available so an in-flight E-Blast remains
completable (FR-034).

**Error envelope**: `{ error, message?, stage?, currentUpdatedAt?, retryAfterSeconds?, issues? }`.
Fault arms are named `M119.admin.<route>.<arm>`. No `Idempotency-Key` on the state-changing routes
(research R19).

---

## `POST /api/admin/broadcasts/[id]/version` — start a formatted version (FR-001)

Permission `broadcasts.write`. **Flag-gated** — 404 while `FEATURE_EBLAST_MEMBER_APPROVAL` is off.

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
6. Audit `broadcast_version_started { related_member_id, broadcast_id, version_id, round, actor_role }`.

```jsonc
201 { "stage": "in_design", "version": { "id": "uuid", "versionNo": 1, "subject": "…",
      "bodyHtml": "…", "noteToMember": null, "updatedAt": "…" },
      "memberOriginal": { "id": "uuid", "versionNo": 0, "subject": "…", "bodyHtml": "…" } }
```

| code | when |
|---|---|
| 201 | started (or the existing working copy returned — idempotent) |
| 403 | `permission_denied` (manager, member session) — audited |
| 404 | unknown id / other tenant (audited `broadcast_cross_tenant_probe`), **or the flag is off** |
| 409 `stage_changed` | the broadcast is not in an accepted stage |
| 409 `round_zero` | `approved`/`member_approved` with `current_round = 0` |

## `PATCH /api/admin/broadcasts/[id]/version` — save the working copy

Permission `broadcasts.write`. Stage must be `in_design`.

```jsonc
// request
{ "subject": "…", "bodyHtml": "…", "bodySource": "…", "noteToMember": "…" | null,
  "expectedUpdatedAt": "2026-09-24T09:10:00.000Z" }
```

- **Optimistic concurrency** (FR-033, the "two marketing users" edge case): `expectedUpdatedAt` must
  equal the row's `updated_at` → otherwise **409 `version_changed`** with `currentUpdatedAt` and the
  current content, so the client can show "someone else changed this" rather than overwrite.
- The body passes the **same** content-safety and size rules as a member's (FR-004): the shared
  sanitiser policy, `subject ≤ 200`, `bodyHtml ≤ 200 KB`, the per-tenant image-source allowlist. A
  violation is **422 `unsafe_content`** / `422 validation_error` with `issues`, and the version is
  not saved.
- No audit event (a save is not a hand-off); counted `broadcasts_version_saved_total`.

```jsonc
200 { "version": { "id": "uuid", "versionNo": 1, "updatedAt": "…" }, "unsafeImageSources": [] }
```

## `POST /api/admin/broadcasts/[id]/version/send` — send the version to the member (FR-003)

Permission `broadcasts.write`. Stage must be `in_design`; a working copy must exist and must pass the
content rules **again** at this moment (FR-004 — "cannot be sent to the member until it passes").

One `runInTenant`: stamp `sent_to_member_at` (the version becomes read-only — DB trigger
`broadcast_versions_immutable_after_send_fn`), `current_round = version_no`, transition to
`awaiting_member_approval`, stamp `stage_entered_at`, reset `member_reminder_stage = 0` and
`member_expiry_notified_at = NULL`, audit
`broadcast_version_sent_to_member { related_member_id, broadcast_id, version_id, round, note_length, actor_role }`,
enqueue one `eblast_version_sent_member` outbox row to the member's contact in their preferred
language (FR-024).

```jsonc
200 { "stage": "awaiting_member_approval", "whoseTurn": "member", "round": 2,
      "expiresAt": "2026-10-24T09:12:00.000Z" }
```

| code | when |
|---|---|
| 409 `stage_changed` · `no_working_copy` · `content_unsafe` | as above |
| 422 `validation_error` | subject/body limits |

After this, `PATCH …/version` answers **409 `stage_changed`** — marketing can no longer edit that
version (US1 AS2).

## `GET /api/admin/broadcasts/[id]/version` — the working copy + the full thread

Permission `broadcasts.read` (so a manager can read it). Returns the member's original, every
version with its author and send time, every member decision with its reason, the working copy if
any, and `updatedAt` for the concurrency token. This is the staff side of FR-032; the member's
feedback is attached to the version it concerns (FR-011).

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

Unchanged contracts. The accepted stage set widens to `IN_PROGRESS_BROADCAST_STATUSES` (FR-015 —
marketing may reject with a reason at any pre-send stage), and the member notification gains the
stage it was rejected from. Reuses the existing `broadcast_rejected` / `broadcast_cancelled` audit
events and the existing `broadcast_rejected_notification` / `broadcast_cancelled_notification`
outbox types.

## `POST /api/admin/broadcasts/[id]/images` — staff image on the E-Blast being formatted (FR-040)

Permission `broadcasts.write`. `multipart/form-data` with `file`. **Stage must be `in_design`** and
the broadcast must belong to the caller's tenant — which is the "a staff user adds an image to
another member's E-Blast: allowed only on the E-Blast they are formatting" edge case, enforced at
the route rather than assumed.

Shares `uploadInlineImage` with the member route, so identical rules apply: ≤ 5 MB
(`upload-inline-image.ts:38`), MIME ∈ png/jpeg/webp/gif, SHA-256 dedup, **fail-closed ClamAV scan**
before storing, per-tenant source-allowlist auto-seed. Additionally records a `broadcast_images` row
with `owner_kind='broadcast', owner_id=<id>`.

```jsonc
201 { "blobUrl": "https://…", "allowlistedHostname": "…", "contentHash": "…", "imageId": "uuid" }
```

| code | when |
|---|---|
| 409 `stage_changed` | not `in_design` |
| 413 `too_large` | > 5 MB (route pre-check at 5.5 MB) |
| 415 `invalid_mime` | outside the MIME list |
| 422 `unsafe` | ClamAV verdict not clean (infected, error **or** timeout — fail-closed) |
| 503 `storage_unavailable` | blob error |

**Alt text (FR-040)** is *not* part of the upload: the editor requires a description before the
image node can be inserted, and the description is carried into the sent email as the `alt`
attribute the shared sanitiser policy allows. A rejected upload leaves the user's text untouched
(spec § Edge Cases).

## `POST /api/admin/broadcasts/templates/[id]/images` — template image (FR-046a)

Permission `broadcasts.write`. Identical rules; records `owner_kind='template', owner_id=<template
id>`. The template must exist in the tenant and not be soft-deleted. Starting an E-Blast from a
template carries the images **by reference** (the existing snapshot copies the HTML, so the `src`
URLs come along) and a later template edit or delete does not change E-Blasts already started from
it — today's snapshot semantics. The last-reference rule (data-model § 4) is what keeps a member's
draft working after the template image is removed.

## `POST /api/admin/broadcasts/preview` and `POST /api/admin/broadcasts/test-copy`

Permission `broadcasts.read` (preview) and `broadcasts.write` (test copy). Bodies, responses, limits
and audit events are identical to the member routes in
[`portal-eblast-approval-api.md`](./portal-eblast-approval-api.md); the staff/member pair mirrors the
existing `/api/broadcasts/recipient-count` ↔ `/api/admin/broadcasts/recipient-count` precedent. The
test copy still goes **only** to the session user's own address — a staff user cannot send a test to
the member (FR-037).

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
| 422 `validation_error` | not `#RRGGBB`; address > 500 chars |

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
| Stage header | stage, whose turn, time in stage, round, proposed vs confirmed send time |
| Actions | "Approve as submitted" and "Reject" (today, unchanged — FR-007) plus "Start formatted version" (flag-gated), "Send to member", "Confirm schedule" |
| Editor | the same writing tool the member uses (FR-039), with the member's original beside it, read-only |
| Version thread | every round, author, note, decision and reason, in order (FR-032) |
| Preview | inline (real email, empty state) + Preview dialog at desktop/phone, `finalFocus` |
| Sections | shadcn `Card`, replacing the bare `rounded-md border` blocks at `:114,158` |
| Manager | read-only — every action control absent, not merely disabled (`manager-readonly-banner` already exists) |
| Error/loading | `error.tsx` added; the skeleton matches the real page |

### `/admin/settings/broadcasts/brand` — the Brand page (FR-041b)

`requirePagePermission('settings.broadcasts')`; in-page gate on `env.features.f7Broadcasts` (the
proxy kill-switch predicate covers `/admin/broadcasts`, **not** `/admin/settings/**` — research
R18). Shows the logo as a read-only preview with its source and a link only a `settings.invoicing`
holder sees; a colour field with a live contrast readout and a disabled Save while the ratio is
below 4.5:1; an address field flagged when empty. Registered in **three** places — `src/config/nav.ts`
Settings section, the `CATEGORIES` array in `src/app/(staff)/admin/settings/page.tsx`, and the i18n
namespace `admin.settings.index.categories.eblastBrand.*` — because the nav guard key must equal the
page's `requirePagePermission` key and both files' docblocks record past incidents of one being
forgotten.

## Contract tests (`tests/contract/broadcasts/admin-eblast-*.test.ts`)

- **RBAC pins per route × role**: `manager` → 403 on every write route (audited `permission_denied`);
  `marketing` → 200 on format/send/schedule/images, **403 on brand**; `member` session → 403
  everywhere.
- **Flag matrix**: `POST …/[id]/version` → 404 with the flag off, 201 with it on; every other route
  behaves identically in both states, and a broadcast already in `in_design` can still be saved,
  sent, decided and scheduled with the flag off (FR-034).
- **Concurrency**: two `PATCH`es with the same `expectedUpdatedAt` → the second is
  409 `version_changed`; `PATCH` after `send` → 409 `stage_changed`.
- **Schedule**: `keep_proposal` with a past proposal → 422 `broadcast_schedule_too_soon`;
  `keep_proposal` with no proposal → 409 `no_proposal`; the audit row carries
  `differs: true` when the confirmed time is not the proposal.
- **Promotion**: after `mode: send_now` from `member_approved`, `broadcasts.subject` and
  `body_html` equal the approved version byte-for-byte, and a subsequent direct `UPDATE` of them is
  still refused by the trigger.
- **Images**: staff upload on a `submitted` broadcast → 409; on another tenant's → 404 + probe
  audit; an infected file → 422 with nothing stored; a `broadcast_images` row is written on success.
- **Brand**: `#f5f5f5` → 422 `colour_contrast` with the computed ratio and the stored colour
  unchanged; the FR-041b logo-write assertion with its positive control.
