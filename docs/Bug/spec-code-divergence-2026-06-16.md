# Spec ↔ Code Divergence Tracker (surfaced 2026-06-16)

**Source:** the `chamber-os-user-docs` doc-generation workflow (9 agents wrote F1–F9 + member user-guide/UAT against the live code) **and** the `chamber-os-user-docs-review` audit (10 spec-compliance-auditors verified the docs vs code and confirmed/refuted these items). All DV statuses below are **verified against source** unless marked otherwise.

**Status legend:** `verified` = confirmed against source · `refuted` = checked, not real · `open` = needs a product decision · `fixed`

> ⚠️ These are **product / spec divergences**, separate from the docs (the docs were corrected to match real behavior in a follow-up pass). None are confirmed launch-blockers, but each is real cleanup, a UX gap, or a spec that needs reconciling. **HIGH** = a spec feature users may expect that has no UI, or a misleading surface.

---

## A. Spec feature exists in backend but has NO UI (dead i18n key / unwired)

| # | Feature | Divergence | Where (verified) | Recommended action | Sev | Status |
|---|---------|-----------|------------------|--------------------|-----|--------|
| DV-1 | F1 | **Change user role**: API route exists, **no UI** calls it (user-list only Disable/Enable; the role grep-hit was a stale file-header comment). | `api/auth/users/[id]/role/route.ts` vs `user-list-table.tsx` (PendingAction = disable/enable only) | Build the role UI, or mark US2-AS4/US4-AS4 backend-only in spec | MED | verified |
| DV-2 | F2 | **Fee-config edit UI** not shipped — no `/admin/settings/plans`, no fee-config page, no `/api/fee-config`. VAT/reg-fee read-only from F4 `invoice_settings` via `deps.taxPolicy()`. `fee_config_updated` audit retired (migration 0029). | spec FR-016/FR-017/US5 | Confirm Settings→Invoicing is the single source; descope US5 fee-config-UI or build it | LOW | verified |
| DV-3 | F3 | **Bulk "Change plan"** not wired (`bulk-action-bar.tsx` = Archive + Send-invite only). i18n `admin.members.bulk.actions.change_plan` is dead. | `bulk-action-bar.tsx:31` | Remove dead key or wire it | LOW | verified |
| DV-4 | F7 | **"Submit on behalf of member"** (admin proxy): use-case + route + i18n keys exist, **no button/dialog wired**. | `proxy-submit-broadcast.ts` + route exist; 0 component refs to `proxySubmitButton` | Remove dead keys or wire it | LOW | verified |
| DV-5 | F8 | **"Cancel cycle"** + **"Mark renewal as paid offline"** (FR-006/FR-058): use-cases + API routes exist, **no UI control**. 3 stale comments claim otherwise. | `cancel-cycle.ts`/`mark-paid-offline.ts` + routes vs cycle-detail `page.tsx:336-348` (empty actions) | Decide in/out of scope; build or descope | MED | verified |
| **DV-11** | F3 | **"Re-send verification email"** admin button **does not exist** — only the API route + `resendVerificationEmail` use-case. The route docstring falsely claims "the admin UI surfaces a toast". (Docs corrected to API-only.) | `…/resend-verification/route.ts` exists; 0 component/i18n refs | Build the button (FR-012c recovery) or update the route docstring; it is currently unreachable for staff | **HIGH** | verified |
| **DV-12** | F7 | **Cancel broadcast** (FR-004a / Q10 / US6-AS4, "cancellable until approved") has **NO UI** anywhere — member route + admin route + `cancel-broadcast.ts` + i18n `cancelDialog.*` all exist, but `review-actions.tsx` renders only Approve/Reject and the member panel has no cancel control. Same shape as DV-4. | member+admin cancel routes vs `review-actions.tsx` | Wire a Cancel button (member + admin), or document cancel as API-only | **HIGH** | verified |
| **DV-18** | F8 | **"Members without renewal cycle" tray/banner** is specced (spec L182, FR-001 edge-case, SC-007) but **not built** — members lacking `expires_at`/`joined_at` are **silently cron-skipped** (audit `renewal_skipped_no_joined_at`; the `renewal_skipped_no_expiry` label isn't even in en.json), with no admin UI surface. (Docs corrected to the silent-skip+audit behavior.) | `dispatch-one-cycle.ts:263-267` vs spec SC-007 | Build the tray, or descope SC-007 (keep silent-skip + audit) | MED | verified |

## B. UX gap (feature exists but hard to reach)

| # | Feature | Divergence | Where (verified) | Recommended action | Sev | Status |
|---|---------|-----------|------------------|--------------------|-----|--------|
| DV-6 | F6 | **Erase attendee PII** (FR-032a) has **no row action** — Actions column only has Relink. Reachable only via deep-link `…/registrations/{id}/erase`. | `attendee-table.tsx:739-749` (Relink only) | Add an "Erase PII" row action — a PDPA erasure path shouldn't need URL-typing | MED | verified |

## C. Stale / misleading copy (small real bug)

| # | Feature | Divergence | Where (verified) | Recommended action | Sev | Status |
|---|---------|-----------|------------------|--------------------|-----|--------|
| DV-7 | F3 | Inline edit is **single-click** Status toggle, but tooltip copy says **"Double-click"**; Country/Notes inline cells removed but their hint copy lingers. | `members-table.tsx:347-349` + en.json:1357-1366 (dead) | Fix tooltip to single-click; remove dead Country/Notes copy | LOW-MED | verified |
| **DV-15** | F3 | Misleading in-app string: `emailEditNote` ("To change this contact's email, use the portal invitation flow.") + `emailChangeNotSupported` point users to the portal-invite flow, but a linked contact's email is actually changed via the **member Edit form** (the invite flow does NOT change an existing email). | en.json:1297 / :1286 | Fix the in-app strings to point to the member Edit form | MED | verified |
| **DV-16** | F8 | **Stale code comments** in 3 files claim Cancel / Mark-paid-offline / role-disabled items render on cycle-detail / pipeline rows — they don't (root-cause confusion behind DV-5). | `renewals/page.tsx:9`, `pipeline-table.tsx:16`, `lapsed-tab.tsx:14` | Delete/correct the stale comments | LOW | verified |

## D. Code ↔ spec contract mismatch (code does Y, spec mandates X)

| # | Feature | Divergence | Where (verified) | Recommended action | Sev | Status |
|---|---------|-----------|------------------|--------------------|-----|--------|
| **DV-13** | F4 | Draft preview watermark renders the word **"PREVIEW"**, but spec FR-001a / US1-AS5 mandate **"DRAFT / ร่าง — NOT A TAX DOCUMENT"**. (Docs corrected to "PREVIEW".) | `invoice-template.tsx:239` vs spec FR-001a | Either render the mandated DRAFT string, or amend FR-001a/AS5 to "PREVIEW" | MED | open |
| **DV-14** | F5 | Spec SC-008 + US4-AS1 name an **`invoice_credited`** audit event that **doesn't exist** — refund/credit trail emits `credit_note_issued` only (invoice→Credited has no own event). UAT inherited the phantom id (now corrected). | `payments`/`invoicing` audit-ports vs spec.md:177,395 | Implement `invoice_credited`, or amend SC-008/US4-AS1 to `credit_note_issued` | MED | open |
| **DV-17** | F7 | **Broadcast From-name**: `data-model.md:59` intends `<member.display_name> via <tenant.display_name>`, but code sets `fromName = tenantDisplayName` only (`submit-broadcast.ts:563`, `save-draft.ts:124`); dispatch + Resend gateway read it verbatim — no "via member" composition. Recipients see the chamber name only. (Reply-To = member email IS correct.) (Docs corrected to chamber-only.) | `submit-broadcast.ts:563` vs `data-model.md:59` | Implement the composition, or amend data-model.md:59 to chamber-only | MED | open |

## E. Spec text stale (docs + code are correct; spec is the wrong side)

- **F1 / FR-004** — wrong-portal sign-in "MUST be rejected with a helpful message", but code returns the **neutral 401** (`Email or password is incorrect.`) for anti-enumeration (FR-016 / T-03). Docs handle it correctly. → align spec wording.
- **F2 / FR-016 + edge-case** — references `PATCH /api/fee-config` returning `422 currency_code_immutable_in_f2`; that endpoint **doesn't exist** (part of DV-2). **FR-025** still requires a `fee_config_updated` audit that was retired. → update spec.
- **F4 / FR-009 + US4-AS5** — reference `/admin/invoice-settings`; real route is `/admin/settings/invoicing`. → update spec.
- **F6 / FR-022 + US3 + US2-AS5a** — reference `/admin/integrations/eventcreate`; real route is `/admin/settings/integrations/eventcreate` (moved Phase 5). _(was DV-8 — verified)_ → update spec.
- **F2 / FR-011** — prose says "Undelete"; real button is **"Restore"**. _(was DV-9 — verified)_ → update spec.
- **F8 / FR-052** — says the kill-switch dashboard route returns 404 + audit; real = in-page "not yet enabled" **message (200)** (404 only on sub-pages). Docs correct. → update spec.

## F. Dead / orphan i18n keys (cleanup — keeps `check:i18n` meaningful)

- **F3:** `admin.members.bulk.actions.change_plan`; `admin.members.inlineEdit.columnHeaderHint` / `columnHeaderHintTooltip`; `editCountry*` / `editNotes*` family (post 056-members-table-compact).
- **F8:** `admin.renewals.lapsed.viewDetail` (component uses `actions.open`); `admin.renewals.tier_upgrades.actions.escalate.dialog_title` / `.confirm` (Escalate has no dialog).
- **F1:** `auth.resetPassword.errors.tokenUsed` / `auth.invite.errors.tokenUsed` (dead-token pages always render `tokenExpired`).
- **F5 (dead route regex):** `proxy.ts:312` matches a `/admin/invoices/[id]/refund` page route that doesn't exist (refund is a `?refund=1` dialog). Harmless, but implies an unbuilt route.

## G. Refuted (checked — NOT a real divergence)

- **DV-10** ~~F3 admin email-change has no committing UI~~ → **REFUTED.** The committing surface **is the member Edit form** (`member-form.tsx:586-600` → `patchContact` → contacts route runs the FR-012a atomic change for linked contacts). The Edit-CONTACT dialog deliberately blocks it. The doc was corrected and the misleading string is tracked as **DV-15**.

## H. By-design (documented in the user-docs — NOT a bug, for context)

- **F1 / F2** manager denial = **hidden/disabled controls + API re-validate** (audited), not a hard 404 (staff shell admits manager). F2 URL-hop → server `redirect()` to `/admin/plans`. F8 manager "Send reminder" is **clickable → 403 + toast** (API-layer only).
- **Preview-only gates:** a11y / i18n / perf TCs authoritative only on the Vercel preview (see `[[e2e-perf-gates-preview-only]]`).
- **Time-dependent UAT** (lockout 15min, reset-token 1h, invite 7-day, GDPR link ~1h) needs a clock-advance harness / scheduled waits.
- **Single-tenant preview** can't fully exercise cross-tenant-isolation TCs (F2 SC-003, F7 SC-009) — confirm via the mandatory cross-tenant integration test.
- **F4 event no-TIN** issuance: an event-fee invoice whose buyer has no Tax ID is blocked at Issue (`event_no_tin_requires_paid_issue`) and must be recorded as paid (§105). The membership-first guide doesn't cover this event-specific path (low impact).

---

## Summary

| Category | IDs | Count |
|---|---|---|
| Backend-only / no UI | DV-1,2,3,4,5,11,12,18 | 8 (2 HIGH) |
| UX gap | DV-6 | 1 |
| Stale/misleading copy | DV-7,15,16 | 3 |
| Code↔spec contract mismatch | DV-13,14,17 | 3 (open) |
| Spec text stale (docs correct) | §E | 6 |
| Dead/orphan i18n keys | §F | ~4 groups |
| Refuted | DV-10 | 1 |

**None block go-live.** Highest-value follow-ups: **DV-11** (F3 resend-verification unreachable) + **DV-12** (F7 cancel-broadcast no UI) — users may expect these; decide build-vs-document. Then the spec-reconciliation pass (§D, §E) and the dead-key cleanup (§F).
