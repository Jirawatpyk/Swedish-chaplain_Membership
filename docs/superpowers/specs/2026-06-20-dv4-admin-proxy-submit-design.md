# DV-4 — Admin "Submit on behalf of member" (proxy-submit) UI — Design

**Date:** 2026-06-20 (rev. 2 — incorporates 4-agent review: architect / spec-compliance / security / QA)
**Feature:** F7 Email Broadcast — admin proxy-submit (Clarifications Q12 + Q16 + Q17, AS9, FR-001/FR-005)
**Branch:** `085-dv4-admin-proxy-submit` (off `main`)
**Scope:** divergence DV-4. Backend route/use-case/i18n shipped; **the admin UI is missing.** This PR = (1) the admin proxy-submit UI, (2) the #18 read-dedup (behavior-preserving), (3) the **admin_proxy quota-cap fairness fix (security T-10)** — bundled, separate commits.

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

## Quota-cap fairness FIX (in scope — security T-10) — own commit

`submit-broadcast.ts:329-330` `if (input.actorRole !== 'admin_proxy')` **bypasses the member quota CAP (precondition b) for admin_proxy**, citing a "Q12 emergency correction" — but **NO such emergency clause exists** in Q12/AS9 ("emergency" in the spec = only the READ_ONLY_MODE global switch). Verified against the authoritative spec, the bypass is a **bug + security gap (threat T-10 admin-proxy abuse)**:
- **Q12 (spec.md:87):** "quota slot is reserved/consumed" + "**quota counts against the member regardless**" + "**preserves quota fairness — the chamber never gets free broadcasts via admin proxy**".
- **AS9 (spec.md:136):** "the quota slot is **reserved against Fogmaker**".
- **security.md CHK005 / T-10:** "admin **cannot bypass any member-side validation (quota**, tier, primary-contact)".

**Fix:** remove the precondition-(b) `actorRole !== 'admin_proxy'` guard so admin_proxy enforces the member's quota cap exactly like self-service. An admin proxy-submitting for an at-cap member now gets `broadcast_quota_blocked` (422). **KEEP the precondition-(d) rate-limit handling** (admin_proxy uses a separate higher-cap key — the intended Ultraplan AD-proxy-rate decision; NOT touched). The spec.md Q12 text is already correct (it says enforce) — only the CODE + its comments are wrong; do NOT change Q12.

**Behavior change (accepted):** admins can no longer push a member OVER their per-year cap via proxy (was an unsupported override). Aligns with Q12/T-10.

**Touch points:** `submit-broadcast.ts` (remove guard at 329-330 + fix the precondition-(b) comment + the header line 13 "admin_proxy bypasses per Q12" → "enforced"); proxy `route.ts` (map `broadcast_quota_blocked` → 422 if not already; fix the header "Quota check is BYPASSED" comment; `reservedQuotaSlot: true` is now genuinely accurate); **flip the 3 tests that assert the bypass** (`proxy-submit-broadcast.test.ts:399` "bypasses quota even at full quota", `:414` "bypasses at over-cap", `submit-broadcast.test.ts:500` "admin_proxy bypass quota check") RED → assert enforce-cap (at-cap admin_proxy → `broadcast_quota_blocked`); add an at-cap proxy **integration** test. **Security-engineer sign-off required (T-10).**

**UI consequence:** the admin compose page MAY surface the proxied member's quota (now real + enforced), but a quota gate is optional — the route is the source of truth. The AS9 happy-path e2e uses a member WITH quota available (so it succeeds); at-cap→blocked is covered by the flipped unit + integration tests, not the happy-path e2e.

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
- No new RBAC role (Q17). No dedicated events/sponsorship UX (post-MVP F7.2). No member self-service compose change (only `buildSegmentPayload` export). (The quota-cap fairness fix IS in scope — see the Quota-cap section.)

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
- **Quota-cap fairness fix** (T-10) is bundled in this PR as its OWN commit (verified direction: the code bypass is the bug; Q12/AS9/CHK005 are authoritative). Needs security-engineer sign-off. The `submit-broadcast.ts` edit only affects the admin_proxy path (self-service already enforces), so blast radius is small — but re-run the full broadcasts unit suite (it has many admin_proxy assertions) to catch any other test that encoded the bypass.
- Member-picker: mirror, don't extract (keep the F6 relink surface untouched).
