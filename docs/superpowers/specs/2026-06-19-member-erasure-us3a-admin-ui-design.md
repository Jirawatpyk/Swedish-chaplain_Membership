# COMP-1 US3-A — Admin Erase-member Route + UI (Design)

**Status:** Design approved 2026-06-19. Sub-project **A** of COMP-1 US3 (the final phase). Complements the master design `docs/superpowers/specs/2026-06-16-member-erasure-design.md` — read that for the `eraseMember` core (US1), the per-module cascades (US2a-c), and the reconciler (US2d), all of which are SHIPPED on `main`.

## Purpose

`eraseMember` (GDPR Art.17 / Thai PDPA §33 right-to-erasure) is fully built and reviewed, but it has **no human trigger** — today it is callable only by the US2d reconciler cron and the test suite. US3-A adds the **admin-facing route + UI** so a chamber admin (acting on a verified data-subject request) can initiate an erasure. This is the missing primary entry point that makes the whole erasure feature usable.

This is a **single-member, admin-only** trigger. Bulk erasure, the DPO erasure-evidence list (US3-D), the 10-year tax-redaction cron (US3-B), sub-processor propagation (US3-C), and the RoPA/runbook docs (US3-E) are separate US3 sub-projects — out of scope here.

## Approach

**Reuse the existing member-ARCHIVE pattern wholesale** — there is no materially-different alternative worth weighing; the archive flow (route + confirmation dialog + RBAC + idempotency + state banner) is the established, reviewed pattern for a single-member destructive admin action, and consistency is the goal. US3-A adapts it for the ways erasure differs from archive: erasure is **permanent** (no undelete), its reason is a fixed **enum** (not free text), it requires an **Art.12 identity attestation**, and it sets `erased_at` (status unchanged) rather than `status='archived'`.

### Decisions (from the brainstorm)

1. **Art.12 identity verification → an in-dialog attestation checkbox, recorded in the audit.** Identity verification itself is the admin's out-of-band responsibility (per the runbook); the UI captures a **required** attestation ("I confirm the data subject's identity was verified per Art.12 / PDPA §30") that is persisted into the `member_erasure_requested` audit as an accountability record. No in-app identity-proof system (YAGNI for a chamber admin tool).
2. **Type-to-confirm friction (member number).** Because erasure is irreversible (anonymise-in-place is permanent), the destructive button stays disabled until the admin types the member's number (e.g. `SCCM-0042`) exactly — mirroring the existing bulk-archive `type-to-confirm` pattern, a step beyond single-archive's plain confirm. Erasure warrants more friction than archive (which is reversible).
3. **Synchronous execution, reusing `buildEraseMemberDeps`.** The route runs `eraseMember` in-request (the scrub tx + post-commit best-effort cascades, same as today). The US2d reconciler is the backstop for any failed cascade (a `cascadesComplete=false` result).

## Architecture & flow

```
admin → /admin/members/[memberId]  → standalone "Erase (GDPR/PDPA)…" destructive-outline button (admin-only; shown incl. on archived members)
   → <EraseMemberDialog>  (type-to-confirm)
   → POST /api/members/[memberId]/erase   body { reason, identityVerified, verificationMethod, note? }   + Idempotency-Key
        1. requireAdminContext(request, { resource: 'members', action: 'write' })   → 401 / 403
        2. parse memberId (uuid) + body (eraseRouteSchema)
        3. idempotency reserve (Idempotency-Key)  — mirror the archive route
        4. eraseMember(memberId, { reason, identityVerified, note },
                        { actorUserId: ctx.current.user.id, requestId: ctx.requestId },
                        buildEraseMemberDeps(tenant))
        5. map result → 200 { memberId, erasedAt, cascadesComplete }  |  errors → status+code
   → on 200: success toast + the member-detail page re-renders <ErasedBanner> (erased_at now set)
```

Every layer copies the archive equivalent (`src/app/api/members/[memberId]/archive/route.ts`, `src/components/members/archive-member-button.tsx`, `src/components/members/archived-banner.tsx`).

## Components

### 1. `EraseMemberDialog` (new — `src/components/members/erase-member-dialog.tsx`)
shadcn `AlertDialog`, modelled on `ArchiveMemberButton` (state-reset-on-close, loader, `sonner` toast, idempotency-key generation). Contents (the approved mockup):
- **Title:** "Erase member (permanent)". **Prominent permanence callout** (UX review M3): a destructive visual callout (mirror `archived-banner.tsx`'s `text-destructive` callout treatment, NOT a plain `AlertDialogDescription`) — "This anonymises ALL personal data for `<name> (<member_number>)`. It is permanent and cannot be undone."
- **Reason** — radio: `GDPR Art.17` / `PDPA §33` (→ `gdpr_erasure_request` / `pdpa_deletion_request`).
- **Art.12 attestation** — required checkbox, **plus a required verification-METHOD select** (compliance review H-1 — record *what* was verified, not a bare boolean; e.g. `verified_account_login` / `in_person` / `email_confirmation_loop` / `official_document` — the exact enum settled in the plan) so the audit captures HOW identity was confirmed.
- **Note / reference** — **OPTIONAL** `Textarea` (≤500 chars; the DPO ticket / request reference). **Decided (UX review M3): optional** — the required-and-structured accountability field is `verificationMethod`; the note is a supplementary free-text reference, never gating the destructive button.
- **Type-to-confirm** — text input; the destructive button is gated **iff** a reason is selected **AND** the attestation is checked **AND** the typed value `=== member.memberNumber` (exact, case-sensitive match — reuse the bulk-archive comparison; `member_number` is always non-null — verified `member.ts:144`).
- **Placement (UX review M1 — corrects the earlier "⋯ dropdown" default):** a **standalone `destructive-outline` button** "Erase (GDPR/PDPA)…" in the member-detail action area (mirroring `ArchiveMemberButton`'s standalone destructive-outline trigger, placed alongside/below Archive). **NOT an overflow-menu item** — `ux-standards.md § 19` forbids destructive/irreversible actions inside a page-header "More actions" overflow menu (keyboard-arrow drift + hides a legitimate DPO task). Shown for any **non-erased** member, **including archived ones** (it must NOT be hidden by the `status !== 'archived'` gate that hides Edit/Archive at `page.tsx:738` — UX review M2). Hidden only when `!canWrite` (non-admin) or the member is already erased.

### 2. `POST /api/members/[memberId]/erase` (new — `src/app/api/members/[memberId]/erase/route.ts`)
Copies the archive route structure: RBAC (`requireAdminContext`, admin-only — manager 403, session-missing 401 checked first), uuid param parse, `eraseRouteSchema` body parse, Idempotency-Key reserve (with the 503 Upstash-outage fallback), `eraseMember` call, error→HTTP mapping. Returns `200 { memberId, erasedAt, cascadesComplete }`. A `cascadesComplete:false` is still a 200 (the scrub committed; the reconciler completes the rest) — the response flag drives the UI's "completion pending" messaging.

### 3. `eraseMember` input extension (US1-core — additive, backward-compatible)
`eraseMemberSchema` / `EraseMemberInput` today is `{ reason }`. Add **OPTIONAL** fields to the core schema (so the already-shipped reconciler/cron call-site stays unchanged):
- `identityVerified?: boolean` — the Art.12 attestation.
- `verificationMethod?: <enum>` — HOW identity was verified (compliance review H-1), so the accountability record is not a bare boolean.
- `note?: string | null` — the DPO reference (≤500 chars).
When present, all three are threaded into the existing **`member_erasure_requested`** audit payload (alongside `member_id` + `reason`) as the Art.17 accountability record. **No new audit event type** (the `f3-audit-event-type-count` stays 31).

Enforcement lives at the **admin-route boundary**, not the core: the route's own `eraseRouteSchema` requires `identityVerified === true` (a `false`/absent attestation → `400 invalid_body`, rejected before `eraseMember` is called) and validates `note`. Keeping `identityVerified` optional in the core schema means:
- the shipped US2d reconciler/cron does NOT change (it re-drives an already-attested erasure and, via `eraseMember`'s `alreadyErased` pre-flight, never re-emits `member_erasure_requested` — so the attestation is recorded exactly once, on the originating admin request);
- the attestation requirement is a property of the human entry point, where it belongs — a system re-drive does not re-attest.

**Security re-review required** (touches the US1-core input + the `member_erasure_requested` audit payload on a security-signed surface).

### 4. `ErasedBanner` (new — `src/components/members/erased-banner.tsx`)
Mirrors `ArchivedBanner` but **without an undelete affordance** (erasure is permanent). Renders on the member-detail page when `erased_at IS NOT NULL`: "This member's personal data was erased (GDPR Art.17 / PDPA §33) on `<date>`. Permanent — cannot be undone." When the member's erasure is not yet complete (`member_erased` absent / `cascadesComplete:false` on the just-returned result), the banner appends "completion pending (automated reconciler)". The member-detail page must surface `erased_at` (and, for the banner's pending state, whether the `member_erased` completion proof exists) to the client. Buddhist-era date display follows the project's display-only BE convention (storage stays ISO-UTC).

**Post-erase page-state (UX review S5 — specify, don't leave to the implementer):** when `erased_at IS NOT NULL` the member-detail page renders: the `ErasedBanner` (shown) · the identity fields showing the `[erased]` sentinels (no special styling needed — they are the data now) · the **Edit, Archive/Undelete, Add-contact, and the new Erase actions all HIDDEN** (nothing to act on) · the timeline/audit-derived sections may still render (they are the record of processing) · no toast/CTA implying a reversible state. The plan's first task confirms exactly which sections key off `erased_at` vs `status`.

## Visibility

Erased members are already excluded from the directory and operational reads by the H4 `erased_at IS NULL` sweep (US1 round-2). The detail page resolved by direct URL still loads and shows the `ErasedBanner`. A dedicated "erased members" list for the DPO is **US3-D**, not here.

## Scope boundaries

- **In:** single-member admin-initiated erasure (route + dialog + banner + the `eraseMember` input extension). Available on any **non-erased** member regardless of `status` (active / inactive / archived — erasure is orthogonal to archive).
- **Out:** bulk erasure; the DPO erasure-evidence list (US3-D); the 10y tax-redaction cron (US3-B); sub-processor propagation (US3-C); RoPA/runbook (US3-E); any change to the `eraseMember` cascade behaviour (US1-US2d, shipped).

## Cross-cutting

- **RBAC:** admin-only at the route (`requireAdminContext`) AND the Erase button hidden for non-admin (`canWrite = role === 'admin'`). Manager → 403.
- **Tenant isolation (Principle I):** the route runs under the admin's tenant context; `buildEraseMemberDeps(tenant)` + `eraseMember` already thread `runInTenant`/RLS. No cross-tenant surface added. A cross-tenant route test confirms an admin of tenant A cannot erase a tenant-B member (IDOR guard — the member lookup is tenant-scoped).
- **Idempotency:** Idempotency-Key header (reuse the archive route's reserve/replay/conflict handling) — a double-submit of the dialog does not double-drive.
- **Audit / observability:** `member_erasure_requested` (now with attestation + note) + `member_erased`; structured pino logs (no PII — ids + counts only); reuse the erasure metrics where applicable.
- **i18n:** EN canonical + TH + SV for every new key (dialog copy, banner, toasts) — `check:i18n` parity + verify `t()` resolution (the known MISSING_MESSAGE runtime-crash hazard on key renames).
- **a11y (WCAG 2.1 AA — DO NOT "mirror the archive dialog's a11y"; the reused components have an INCOMPLETE focus story that would propagate — a11y review).** Mirror the CORRECT pattern in `src/components/shell/confirmation-dialog.tsx` instead. Required (must be in the plan, not deferred):
  - **The gated destructive button (highest-value, a11y M1):** do NOT use a native `disabled` button (not focusable/announced by screen readers, so the user can't discover WHY they're blocked). Use `aria-disabled` + `aria-describedby` pointing at a checklist of the still-missing conditions (reason / attestation / typed-match) + a `role=status` live region that announces what remains — the `confirmation-dialog.tsx:90-94` pattern.
  - **Initial focus → Cancel (a11y M2):** set `initialFocus` to the Cancel button explicitly. Do NOT rely on archive's `autoFocus` (a no-op under the Base UI primitive → focus would land on the first radio).
  - **Final focus chain (a11y M3):** on close, focus returns to the standalone Erase button (the trigger); fallback `#main-content` if the trigger unmounts (e.g. the member became erased).
  - **Form semantics (should-address in plan):** the reason `radiogroup` (no duplicate id/aria), the method `select` labelled, the attestation checkbox label+required, the type-to-confirm input labelled with a format hint + a mismatch announcement, the note textarea labelled with an announced char-count.
  - keyboard-operable, focus-trapped, reduced-motion respected; the dense form reflows at 320px (WCAG 1.4.10); the standalone Erase button + any target ≥44px.

## Testing (Test-First)

- **Contract** (`tests/contract/members/erase-route.contract.test.ts`): 401 (no session) / 403 (manager) / 404 (cross-tenant or unknown member) / 400 (missing reason, missing/false `identityVerified`, over-length note) / idempotency replay+conflict / 200 happy path → `eraseMember` called with the right args.
- **Integration** (live Neon): an admin erase end-to-end → `member_erasure_requested` (carrying `identityVerified:true` + `note`) + `member_erased` emitted, `erased_at` set; the `cascadesComplete:false` path returns 200 + leaves the reconciler to finish; a cross-tenant erase attempt is blocked (Principle I integration test — Review-gate blocker).
- **E2E** (Playwright + axe): the dialog gates the destructive button until reason+attestation+typed-number; a successful erase shows the `ErasedBanner`; the member then absent from the directory; `@a11y` + `@i18n` specs.
- **Security checklist sign-off** (PII / erasure surface, ≥2 reviewers): IDOR/tenant-isolation on the new route, the attestation can't be spoofed to bypass accountability, no PII in logs, the US1-core input extension introduces no regression.

## Reuse map

| Need | Reuse |
|---|---|
| Route skeleton (RBAC→parse→idempotency→use-case→error-map) | `src/app/api/members/[memberId]/archive/route.ts` |
| Confirmation dialog (state reset, loader, toast, idempotency-key) | `src/components/members/archive-member-button.tsx` |
| Type-to-confirm exact-match gating | `src/app/(staff)/admin/members/_components/archive-confirm-dialog.tsx` |
| State banner | `src/components/members/archived-banner.tsx` → `ErasedBanner` (no undelete) |
| Admin-only guard | `requireAdminContext` (`src/lib/admin-context.ts`) |
| Use-case + deps | `eraseMember` + `buildEraseMemberDeps` (`@/modules/members`, `members-deps.ts`) |
| Reconciler backstop for partial cascades | US2d `/api/cron/members/reconcile-erasures` (shipped) |

## Constitution check

- **I (tenant isolation, NON-NEG):** route under admin tenant context; tenant-scoped member lookup; cross-tenant integration test = Review-gate blocker. ✓
- **II (Test-First, NON-NEG):** contract/integration/e2e authored before implementation. ✓
- **III (Clean Architecture, NON-NEG):** presentation (route + components) → `eraseMember` application use-case via the barrel; the `EraseMemberInput` extension lives in the use-case; no domain/infra reach-through. ✓
- **Data Privacy & Security (NON-NEG):** the whole feature IS an Art.17/§33 control; attestation + audit + admin-only + IDOR guard. Security checklist sign-off required. ✓
- No deviation requiring a Complexity-Tracking entry.

## Open items folded into the plan (none block)

- Exact placement copy/iconography of the "More actions ⋯" menu item (destructive styling) — settle during implementation against `ux-standards.md`.
- Whether the member-detail page already exposes `erased_at` + the `member_erased`-exists flag to the client, or needs a small loader addition — resolve in the plan's first task.
