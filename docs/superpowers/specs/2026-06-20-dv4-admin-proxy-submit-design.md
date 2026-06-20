# DV-4 — Admin "Submit on behalf of member" (proxy-submit) UI — Design

**Date:** 2026-06-20 (rev. 2 — incorporates 4-agent review: architect / spec-compliance / security / QA)
**Feature:** F7 Email Broadcast — admin proxy-submit (Clarifications Q12 + Q16 + Q17, AS9, FR-001/FR-005)
**Branch:** `085-dv4-admin-proxy-submit` (off `main`)
**Scope:** divergence DV-4. Backend fully shipped; **only the admin UI is missing.** Presentation-focused + one behavior-preserving backend read-dedup (#18).

## Goal

Give admins a discoverable UI to submit a broadcast **on behalf of a member** (Q12 dual-actor). Today the use-case + route + i18n exist but no button/UI is wired, so it's only invokable via a hand-crafted API call.

## Why it matters (not dead code)

Spec **Q17** designates admin-proxy as the **MVP mechanism for chamber operational broadcasts** (event reminders, partner announcements, chamber news) — deliberately no new RBAC role. **AS9** + **FR-001/FR-005** require the "Submit on behalf of `<member>`" surface.

## Approach (decided: Option 1 — admin compose page reusing shared sub-components)

New admin compose page `/admin/broadcasts/new` rendering a **member-picker** + the existing standalone compose sub-components, POSTing to the **existing** proxy route. The live member self-service `compose-form.tsx` is **not** refactored (rejected: regression risk on a paid surface). A dialog is rejected (Tiptap cramped; loses preview/schedule).

## Architecture & entry point

- **Entry:** "Submit on behalf of member" button in the `/admin/broadcasts` queue header → `/admin/broadcasts/new`. Admin-only (hidden for manager).
- **Page:** `src/app/(staff)/admin/broadcasts/new/page.tsx` — server component, `requireSession('staff')` + admin-role gate (redirect non-admin), mirrors `/portal/broadcasts/new`.
- **Submit target:** existing `POST /api/admin/broadcasts/proxy-submit` (`adminOnlyWriterGuard`, `ProxySubmitBodySchema`).

## Components

**New:**
- `src/app/(staff)/admin/broadcasts/new/page.tsx` — server: auth + admin gate + render `<ProxyComposeForm>`.
- `src/components/broadcast/admin/proxy-compose-form.tsx` — client orchestrator (thin). Owns its OWN submit handler + its OWN error code→field map (does NOT import `compose-form.tsx` internals — that file stays frozen). Composes the reused sub-components + the member-picker; POSTs to the proxy route; on 200 → toast + redirect to the broadcast detail.
- `src/components/broadcast/admin/member-picker.tsx` — **MIRROR** (not extract) the cmdk search-by-company block from `relink-registration-dialog.tsx` (the `useDeferredValue` + `fetchSeqRef` + `AbortController` + `SearchResponseSchema` pattern, ~lines 194-270), stripped to emit `{ memberId, companyName }`. Shared seam is the **endpoint** (`/api/admin/members/search`), NOT the React component — do NOT refactor the F6 relink surface (2 consumers < rule-of-three).
- Entry button on the admin queue header.

**Reuse (unchanged):** `TiptapEditor` (via `tiptap-loader`), `SegmentPicker`, `CustomListInput`, `SchedulePicker`, `PreviewPane`, `SubmitButton`. Export the pure module-level `buildSegmentPayload` from `compose-form.tsx` (only change to that file).

**Component inventory — explicitly DROPPED from the portal compose (do NOT port):**
- `QuotaDisplay` / quota-remaining badge — admin_proxy bypasses the quota cap (see Quota note); a blocking quota badge would be wrong/misleading.
- save-draft (no admin draft-on-behalf endpoint — see FR-001 scope cut).
- template picker / `?template=` pre-population, the `cap === 0` redirect.
- Keep: the `beforeunload` dirty-guard (good UX), the inline-image flag follows the member parity (default off unless trivially inherited).

## Data flow + #18 read-dedup

1. Admin picks a member → `requestedByMemberId` + `companyName` captured client-side.
2. Compose subject + Tiptap body + segment (+ optional schedule) + live preview.
3. Submit → `POST /api/admin/broadcasts/proxy-submit` `{ requestedByMemberId, subject, bodyHtml, bodySource, segment, scheduledFor }`.
4. Route: `adminOnlyWriterGuard` → `drizzleMemberRepo.findById(requestedByMemberId)` (the SURVIVING read — supplies `companyName` for `from_name = "<member> via <tenant>"`, DV-17) → `proxySubmitBroadcast`.
5. **#18 dedup (the ONLY backend edit) — behavior-preserving, do EXACTLY this:**
   - Today: route `findById` (full row) **and** use-case `memberExistsInTenant` (existence probe) = two tenant-scoped reads of the same row.
   - Fix: route passes the resolved existence into the use-case (e.g. mutate `ProxySubmitBroadcastInput` to a discriminated `{ proxiedMember: { exists: true; displayName } } | { exists: false }`, or add explicit `proxiedMemberExists: boolean` derived from `memberLookup.ok`); use-case SKIPS its own `memberExistsInTenant` call but KEEPS its `if (!exists) → broadcast_member_not_found` rejection.
   - **Preserve the contract exactly:** member-not-found → **404** `broadcast_member_not_found` (NOT 422); infra throw on `findById` → route try/catch → **500** `server_error`. The not-found gate must still fire BEFORE persistence (no cross-tenant member slips through).
   - **Mutate `ProxySubmitBroadcastInput` FIELDS only — do NOT add/remove a `src/modules/broadcasts/index.ts` barrel export** (COMP-1 disjointness; the type is already exported, changing its shape doesn't touch the barrel line).
   - Make a not-found unrepresentable-with-a-name (discriminated input) so "exists but blank companyName" can't be constructed.
6. Success → toast + redirect to the broadcast detail (admin). Quota **consumed/attributed to the member**; audit `broadcast_submitted` `actor_role='admin_proxy'` with both ids (unchanged).

## Quota behavior (important — pre-existing divergence, flagged not fixed)

`submit-broadcast.ts:330` **bypasses the member quota CAP for `actor_role='admin_proxy'`** (Q12 "emergency correction" path). Net: the broadcast row is attributed to the member (`requested_by_member_id`) and quota is **consumed/derived** against that member (no free chamber broadcasts in accounting), BUT the per-year **cap is NOT enforced** for admin-initiated sends — an admin can push a member over their cap.

- This **diverges from Q12's literal "quota fairness / never gets free broadcasts" wording** and the route's `reservedQuotaSlot: true` envelope reads misleadingly. **This is a PRE-EXISTING F7 backend↔spec divergence, OUT OF DV-4 SCOPE** (DV-4 is presentation + the #18 read-dedup). Tracked as a separate divergence to reconcile (update Q12 text to document the deliberate admin override, OR treat as a bug) — NOT in this PR.
- **DV-4's obligation:** the admin UI must be HONEST — no blocking quota badge, no "X of Y left" gate that implies over-cap is blocked (it isn't). The e2e must NOT assert quota movement.

## Self-exclusion (Q16)

Backend correctly auto-excludes the **proxied member** (not the admin) from member-based segments (`submit-broadcast.ts:519` passes the proxied member's primary email to the resolver). UI obligations:
- Add an **admin-proxy** self-exclusion microcopy: "**{company} won't receive their own broadcast** — their primary contact email is excluded from member-based segments." (NOT the member-self "You won't receive…" copy, which is wrong in admin context.) en + th + sv.
- **Live recipient count:** the reused compose sub-components deliberately do NOT compute a live count (parity with self-service). **Accepted as parity** (documented here, not silent); estimated-count is server-side at submit. No live count in the admin page either.

## RBAC / errors / a11y

- **RBAC:** page admin-only gate + route `adminOnlyWriterGuard`. `canAccess('broadcast','write')` → **manager → 403, member → 403** (both 403 — `policies.ts` returns false for non-admin on `broadcast:write`; there is NO 404-for-member on this route). Defense-in-depth.
- **Errors:** the admin orchestrator defines its OWN code→field map (copy the relevant subset, don't import compose-form's private `ERROR_CODE_FIELD`): `broadcast_member_not_found` (404) → focus member-picker; subject/body/segment codes → respective fields; `segment.emails`/custom cap (route caps custom ≤100) → focus SegmentPicker. The proxy route returns the `{ error: { code, message, details } }` envelope (not the member route's shape) — map accordingly.
- **a11y:** member-picker labelled + keyboard-navigable (mirror relink's sr-only status); reused sub-components carry WCAG 2.1 AA; submit disabled while pending.

## i18n (parity required: en + th + sv)

- **Reuse existing:** `admin.broadcasts.proxySubmitButton` + `admin.broadcasts.proxySubmitDialog.*` (title/description/memberLabel/memberPlaceholder/subjectLabel/bodyLabel/segmentLabel/confirm/cancel). Keep the keys (the `Dialog` namespace name is fine for a page).
- **Note (acknowledged):** the reused sub-components render `portal.broadcasts.compose.*` strings inside the admin page — acceptable (generic copy); a reviewer should not flag the cross-namespace read.
- **NET-NEW keys to add (en+th+sv):** admin-proxy self-exclusion microcopy; `broadcast_member_not_found` inline error; success/redirect toast; any schedule/preview label not already present. `check:i18n` is parity-only — every new key in all 3 locales or it crashes at runtime.

## Scope cuts (explicit)

- **FR-001 draft-on-behalf DEFERRED.** FR-001 also permits an admin to create a *draft* on behalf of a member; DV-4 ships **submit-on-behalf only** (the Q12 "send this for me" path). Draft-on-behalf needs a separate admin draft route + is low-value (admin proxying usually has the full content) — deferred, NOT silently dropped.
- No new RBAC role (Q17). No dedicated events/sponsorship UX (post-MVP F7.2). No member self-service compose change (only `buildSegmentPayload` export). No quota-cap fix (pre-existing divergence, separate ticket).

## Testing (TDD)

- **Unit (jsdom-safe):** member-picker render + selection (mock `/api/admin/members/search`; verify it's a bare cmdk combobox, not inside a Base-UI dialog — if dialog-wrapped, its open becomes e2e); `buildSegmentPayload` pin test (newly exported); reused validation predicates. Harness pattern: real `NextIntlClientProvider` + real `en.json` + mock sonner/next-navigation/fetch + real timers (per `cancel-broadcast-dialog.test.tsx`).
- **E2E (AS9) — full happy path (decided), `--workers=1`:** `signInAsAdmin` → `/admin/broadcasts/new` → pick member → fill subject+body+segment → **submit** → assert success toast + redirect to the broadcast detail. **Assert the AS9 dual-actor outcome via a DB read in teardown** (authoritative): the row's `requested_by_member_id` = picked member + `actor_role='admin_proxy'` (optionally the `broadcast_submitted` audit payload carrying both ids). Do NOT prove AS9 only via the detail UI label. **Do NOT assert quota movement** (proxy bypasses the cap; quota is row-derived). **Teardown (`afterAll`):** delete the created broadcast row(s) for the proxied member — mirror `wipeE2EMemberBroadcasts()` (`tests/e2e/helpers/broadcasts-seed.ts:366`); there is NO separate "reset quota" step (quota = row count). Proxy-submit creates a `submitted` row but does NOT dispatch → no real email. **Skip on 503** (`FEATURE_F7_BROADCASTS=false`, ship-dark) like `broadcast-compose-and-submit.spec.ts`. `clearE2ERateLimits()` in `beforeAll`; re-run (don't sleep) on Upstash quota. Use the e2e-member (seed helpers resolve it) — never a real chamber member (PII).
- **E2E (RBAC):** admin-only button hidden for manager + a manager-403 API probe on the proxy route (mirror relink's `FR-035 manager → 403`); add a member-403 probe too (both 403).
- **Contract (must stay GREEN after #18):** `tests/contract/broadcasts/post-admin-broadcasts-proxy-submit.contract.test.ts` — 404 `broadcast_member_not_found`, 500 `submit.server_error` (infra throw), 500 thrown, **DV-17 companyName resolution** (route keeps `findById`). `tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts` — false→404, throw→500 (update fixtures to the new input signature but KEEP the assertions). **Add a throw-path test** for the new shape (memory: mock-only tests miss throw paths).
- **Integration (Principle-I Review-gate blocker — #18 touches `src/modules/broadcasts`):** cross-tenant proxy integration test on live Neon — admin of tenant A proxy-submits with a tenant-B memberId → 404 `broadcast_member_not_found` + NO broadcast row inserted (proves the RLS-scoped existence gate still fires; mock-only hides RLS bypass).
- Halt-flag (admin can't bypass member halt, R3-NEW-1) + empty-segment-blocked are already at **contract** level — confirm they stay green; no e2e re-proof needed.

## Risks / notes

- **#18 touches `src/modules/broadcasts`** → pre-push runs the broadcasts integration suite, whose `audit-event-type-parity` test is RED from COMP-1's unmerged `broadcast_content_redacted` enum on shared Neon (external drift). Push with `SKIP_INTEGRATION_PREPUSH=1` + run the proxy-submit + cross-tenant integration tests manually (mirror PR #106).
- **COMP-1 disjointness:** member-erasure does not touch the admin broadcasts compose surface or the proxy route; avoid touching `src/modules/broadcasts/index.ts` (mutate `ProxySubmitBroadcastInput` fields only).
- **Quota-cap bypass divergence** (above) — flagged for a separate ticket; DV-4 only keeps the UI honest.
- Member-picker: mirror, don't extract (keep the F6 relink surface untouched).
