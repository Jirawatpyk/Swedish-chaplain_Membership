# DV-4 — Admin "Submit on behalf of member" (proxy-submit) UI — Design

**Date:** 2026-06-20
**Feature:** F7 Email Broadcast — admin proxy-submit (Clarifications Q12 + Q17, AS9, FR-001/FR-005)
**Branch:** `085-dv4-admin-proxy-submit` (off `main`)
**Severity / scope:** divergence DV-4 (tracker `docs/Bug/spec-code-divergence-2026-06-16.md`). Backend fully shipped; **only the admin UI is missing.** Presentation-focused.

## Goal

Give admins a discoverable UI to submit a broadcast **on behalf of a member** (Q12 dual-actor: quota + reply-to against the member, audit records the acting admin). Today the use-case + route + i18n exist but **no button/dialog is wired** (0 component refs to `proxySubmitButton`), so the only way to invoke it is a hand-crafted API call.

## Why this matters (not dead code)

Spec **Q17** designates admin-proxy as the **MVP mechanism for chamber operational broadcasts** (event reminders, partner announcements, chamber news) — deliberately avoiding a new RBAC role. Without the UI, the chamber has no first-class way to send operational E-Blasts. **AS9** + **FR-001/FR-005** explicitly require the "Submit on behalf of `<member>`" surface.

## Approach (decided: Option 1 — admin compose page reusing shared sub-components)

A new admin compose page (`/admin/broadcasts/new`) that renders a **member-picker** + the existing standalone compose sub-components, posting to the **existing** proxy route.

**Rejected alternatives:**
- **Refactor the shared `compose-form.tsx`** to be endpoint/member-parameterized (DRYest) — rejected: edits a heavily-reviewed LIVE member paid surface (error mapping, redirect, quota display); regression risk not worth it for a LOW-priority feature.
- **Lightweight dialog** (per existing `proxySubmitDialog` i18n) — rejected: Tiptap rich-text is cramped in a dialog and it loses the schedule/preview the spec's "standard compose flow" implies.

## Architecture & entry point

- **Entry:** a "Submit on behalf of member" button in the `/admin/broadcasts` queue page header → links to `/admin/broadcasts/new`. Admin-only (hidden for manager/read-only).
- **Page:** `src/app/(staff)/admin/broadcasts/new/page.tsx` — server component, `requireSession('staff')` + admin-role gate (redirect non-admin), mirrors `/portal/broadcasts/new`. Renders the client orchestrator.
- **Submit target:** the existing `POST /api/admin/broadcasts/proxy-submit` (`adminOnlyWriterGuard`, `ProxySubmitBodySchema`).

## Components

**New:**
- `src/app/(staff)/admin/broadcasts/new/page.tsx` — server: auth + admin gate + shell + render `<ProxyComposeForm>`.
- `src/components/broadcast/admin/proxy-compose-form.tsx` — client orchestrator (thin): member-picker + the reused sub-components + react-hook-form glue + submit handler → proxy route → redirect to the broadcast detail on 200.
- `src/components/broadcast/admin/member-picker.tsx` — cmdk member search by company name → `/api/admin/members/search` (reuse the pattern from `relink-registration-dialog`'s picker; extract a shared picker if the relink one is cleanly liftable, else mirror it). Emits `{ memberId, companyName }`.
- Entry button on the admin queue page header.

**Reuse (unchanged):** `TiptapEditor` (via `tiptap-loader`), `SegmentPicker`, `SchedulePicker`, `PreviewPane`, `SubmitButton`, `CustomListInput`. Export the module-level `buildSegmentPayload` from `compose-form.tsx` for shared segment-payload construction (it is pure).

## Data flow + #18 fold-in

1. Admin picks a member → `requestedByMemberId` + `companyName` captured client-side.
2. Compose subject + Tiptap body + segment (+ optional schedule) + live preview.
3. Submit → `POST /api/admin/broadcasts/proxy-submit` `{ requestedByMemberId, subject, bodyHtml, bodySource, segment, scheduledFor }`.
4. Route: `adminOnlyWriterGuard` → `findById(requestedByMemberId)` (for `companyName` → `from_name = "<member> via <tenant>"`) → `proxySubmitBroadcast`.
5. **#18 (deferred finding) fold-in:** the route already does `drizzleMemberRepo.findById` (existence + companyName); `proxySubmitBroadcast` independently re-checks `membersBridge.memberExistsInTenant` — two reads of the same row. Fix: have the route pass the already-loaded member's existence into the use-case (or skip the redundant probe when the route resolved the member), so proxy-submit reads `members` once. Preserve the not-found → 422/`broadcast_member_not_found` behavior + the infra-throw → 500 distinction.
6. Success → toast + redirect to the broadcast detail (admin view), mirroring the member self-service redirect. Quota counts against the member; audit `broadcast_submitted` `actor_role='admin_proxy'` with both ids (unchanged backend behavior).

## RBAC / errors / i18n / a11y

- **RBAC:** page admin-only gate + route `adminOnlyWriterGuard` (manager → 403, member → 404). Defense-in-depth.
- **Errors:** reuse the `ERROR_CODE_FIELD` map from `compose-form.tsx` where codes match; add `broadcast_member_not_found` → focus the member-picker. Use an admin error namespace (`admin.broadcasts.*`).
- **i18n:** the `admin.broadcasts.proxySubmitDialog` + `proxySubmitButton` keys already exist (title/description/memberLabel/memberPlaceholder/subjectLabel/bodyLabel/segmentLabel/confirm/cancel). Reuse them (renaming the namespace from `Dialog` is optional — keep the keys, they read fine for a page). Add only any missing label (e.g. schedule/preview/member-not-found) — must add to en/th/sv (parity).
- **a11y:** member-picker labelled + keyboard-navigable; the reused sub-components carry their existing WCAG 2.1 AA behavior; submit disabled while pending.

## Testing (TDD)

- **Unit (jsdom-safe):** member-picker render + selection (mock the search endpoint); the compose-form validation predicates that are reused; `buildSegmentPayload` (if newly exported, a pin test). The full Tiptap/dialog interaction is e2e (jsdom Base UI hang).
- **E2E (AS9) — full happy path (decided):** admin opens `/admin/broadcasts/new` → picks a member → fills subject + body + segment → **submits** → assert success toast + redirect to the broadcast detail, and the persisted row carries `requested_by_member_id` = the picked member + `actor_role='admin_proxy'` (the AS9 dual-actor outcome). `afterAll` teardown deletes the created broadcast row(s) for the proxied member + resets that member's consumed quota (mirror the existing broadcasts-submit e2e seed/teardown; global-setup quota reset where available). PLUS: admin-only button visibility (hidden for manager) + a manager-403 API probe on the proxy route. Use `--workers=1`.
- **Contract:** the proxy-submit route already has tests; add/extend i18n coverage for the page/button keys. Keep the route's existing contract tests green after the #18 change.

## Out of scope / YAGNI

- No new RBAC role (Q17 explicitly). No dedicated events/sponsorship UX (that's post-MVP F7.2).
- No change to member self-service compose (`compose-form.tsx` untouched — only `buildSegmentPayload` exported).
- No backend/route/migration changes except the #18 read-dedup (behavior-preserving).
- Secondary-contact recipients, >5k pagination, etc. — unchanged (out of F7 MVP).

## Risks / notes

- **Member-picker reuse:** if the relink picker isn't cleanly liftable, mirror it rather than force a refactor (keep the relink surface untouched).
- **#18 change touches `src/modules/broadcasts`** → pre-push runs the broadcasts integration suite, whose `audit-event-type-parity` test is RED from COMP-1's unmerged `broadcast_content_redacted` enum on shared Neon (external drift). Push will need `SKIP_INTEGRATION_PREPUSH=1` + run the affected broadcasts integration tests manually (the proxy-submit happy-path integration test), exactly as the module-cleanup PR #106 did.
- **COMP-1 overlap:** member-erasure does not touch the admin broadcasts compose surface or the proxy route; the only shared file risk is `src/modules/broadcasts/index.ts` if the #18 fix needs a barrel change — avoid touching it (reuse existing exports), mirroring the DV-6 caveat.
