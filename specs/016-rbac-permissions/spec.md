# Feature Specification: RBAC Permissions — Super Admin + Marketing + Permission Bundles (Phase 1)

**Feature Branch**: `016-rbac-permissions`
**Created**: 2026-08-10
**Status**: Implementing
**Input**: User description: "อยากได้ role base เพิ่ม: Super Admin, Marketing และปรับปรุง admin" — expanded through a brainstorming session + three multi-agent design-review rounds into `docs/superpowers/specs/2026-08-10-rbac-permission-system-design.md` (v2 rev 3, **the authoritative design companion to this spec** — section references below (`design § N`) point there).

## Overview *(context, non-normative)*

Chamber-OS today has exactly three roles (`admin`, `manager`, `member`) with a
hardcoded policy table, and most staff pages rely on "is signed in to the staff
portal" alone. TSCC's real organisation needs more: the principal(s) must hold
capabilities day-to-day staff must not (user management, tax settings, GDPR
erasure, audit), and a marketing person must operate E-Blast + events without
seeing money or mutating member data.

This feature introduces **five system roles** backed by a **permission
catalogue + per-role bundles defined in code** (Phase 1 of a two-phase
architecture; Phase 2 — DB-driven custom roles + role editor — is explicitly
deferred), converts every role-string authorization check into a positive
permission check, hardens the staff surfaces that currently fail open, and
makes navigation permission-aware.

The design survived three adversarial review rounds (154 + 24 + 48 findings,
all folded); the architecture is confirmed, and the remaining risk is
execution discipline — which the FRs below encode as testable requirements.

## Clarifications

### Session 2026-08-10 (brainstorming + design reviews)

- Q: Super Admin = platform-level (F13) or tenant-level? → A: **Tenant-level**; F13 stays separate and must use a different key (`platform_admin` reserved).
- Q: Marketing scope? → A: Broadcasts full RW (compose, approve, send — self-approval permitted by design), events RW (excluding attendee-PII erasure and registration relink), members/contacts read-only (no sensitive PII, no export), insights engagement-only.
- Q: What does admin lose? → A: Staff user/role management, invoice/tax settings, GDPR/PDPA erasure + audit read. Admin keeps refund/void/credit-note, operational settings, and member portal-account housekeeping.
- Q: Architecture depth? → A: Originally DB-driven + role editor (approach B phase 2); after the 154-finding review demonstrated no business driver requires runtime-editable permissions and 3 of 5 critical defect classes are unique to the DB variant, the maintainer approved descoping to **Phase 1: code-defined bundles** (approach B phase 1). Phase 2 parked with explicit trigger conditions.
- Q: Manager audit access? → A: Removed (least privilege); recoverable in Phase 2 via a custom auditor role.
- Q: Existing admin accounts at cutover? → A: All human admins promoted to `super_admin` (capability-preserving), by a technically gated migration-only deploy after flag-ON verification; open admin invitations promoted atomically with users; the three system-actor rows excluded.
- Q: Denial presentation? → A: Pages 404 (`notFound()`, non-disclosure convention), API routes 403 — except the F6 event/integration API families, which keep their existing per-role guard behaviour (manager 403+RFC 7807, member/unknown 404).
- Q: Five fold decisions flagged ⚑ in design § 15 (events.relink split; directory.export stays manager; users.member_accounts split; marketing denied on legacy leg; marketing self-approval recorded)? → A: **All confirmed by maintainer 2026-08-10** ("โอเคไปต่อ").

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Super Admin controls staff access; day-to-day admin is safely scoped (Priority: P1)

TSCC's principal signs in as `super_admin`, manages staff accounts and role
assignment from `/admin/users`, and is the only role that can open the audit
log, the erasure surfaces, and invoice/tax settings. Day-to-day admins keep
operating members, money, renewals, broadcasts, and events exactly as today —
but can no longer create staff accounts, change roles, read the audit log, or
alter tax identity. Existing admin accounts are promoted to `super_admin` at
cutover with zero behaviour change; the principal then demotes day-to-day
staff to `admin` from the UI.

**Why this priority**: This is the organisational driver of the whole
feature, and its cutover path (promotion + narrowing) carries the live-prod
risk — it must land first and alone be a viable, valuable release.

**Independent Test**: On a seeded environment with the flag ON and promotion
applied: a `super_admin` can invite staff, change a role, and open
`/admin/audit`; a demoted `admin` account gets 404 on `/admin/users`,
`/admin/audit`, `/admin/settings/invoicing` and the erasure log, while still
issuing an invoice, recording a refund, and editing a member successfully.

**Acceptance Scenarios**:

1. **Given** the evaluator flag is ON and Migration C has run, **When** any pre-existing staff account signs in, **Then** every operation that account could perform before cutover still succeeds (capability preservation, characterization-verified), except the enumerated manager narrowings (design D4).
2. **Given** a `super_admin` on `/admin/users`, **When** they invite a staff user with role `admin` and the invitee redeems, **Then** the new account holds the narrowed admin bundle (no `users.manage`, no `audit.read`, no `settings.invoicing`, no erasure keys).
3. **Given** a plain `admin`, **When** they request `/admin/users` or any of its six staff-target mutating API routes, **Then** the page returns 404 and the APIs 403, and each denial writes a `permission_denied` audit event carrying the actor's real role.
4. **Given** the last active `super_admin`, **When** any actor attempts to demote, disable, delete, or erase that account, **Then** the operation is refused at the application layer and, if raced, by the database trigger (typed error, not a 500).
5. **Given** a plain `admin`, **When** they disable a member's portal account or revoke a member's pending invitation, **Then** the operation succeeds (`users.member_accounts`), while the same operations against a staff-target account are denied.
6. **Given** an unconsumed staff invitation with intended role `admin` issued before cutover, **When** Migration C runs, **Then** the invitation's intended role is promoted together with the user row and the invitee can still redeem successfully.

---

### User Story 2 - Every staff surface requires a positive permission (Priority: P1)

The security core: all ~175 role-string authorization checks (including the
fail-open coercion patterns and the nav/palette role filters) are replaced by
positive permission checks against the code-defined bundles; every staff page
and API route declares the permission it requires; denials are audited for
every role. Behaviour with the flag OFF is byte-identical to today; with the
flag ON it matches the pinned permission matrix.

**Why this priority**: Equal-P1 with US1 because US1 is unsafe without it —
today's deny-list checks silently escalate any fourth role, so the positive
gates must be complete before any new-role account can exist.

**Independent Test**: The characterization suite passes on both flag legs;
the role × endpoint matrix (mechanically complete over all API handlers and
staff pages) passes; `check:staff-page-guard` and the exhaustiveness test
fail the build when a page or handler lacks a declaration.

**Acceptance Scenarios**:

1. **Given** the flag OFF, **When** the full characterization suite runs, **Then** every (surface × role) outcome equals the observed pre-cutover behaviour — including manager still DENIED on the six users routes, both erasure endpoints, the erasure log, and invoice-settings mutations.
2. **Given** the flag ON, **When** the role × endpoint matrix runs, **Then** every outcome matches the § 4.1 catalogue table, including per-target-role rows on the users routes and the F6 per-role override rows.
3. **Given** any role is denied on any gated surface, **When** the denial occurs, **Then** a `permission_denied` audit event is written with `{actor_user_id, real role, permission key, route path (no query), request_id}` and the denial response is served even if the emit fails.
4. **Given** a `(staff)` page or an API route handler with no permission declaration, **When** the static gates run, **Then** the build fails.
5. **Given** a promoted `super_admin` (flag ON, post-C), **When** they open the command palette or the sidebar, **Then** the palette actions are non-empty and the erasure-log nav entry is present.

---

### User Story 3 - Marketing runs E-Blast and events without money/PII exposure (Priority: P2)

A marketing staff account composes, approves, and sends broadcasts, manages
event registrations and CSV imports, browses the member directory read-only,
and sees the engagement side of the dashboard — with no route, API, nav item,
export, or dashboard widget exposing invoices, payments, refunds, renewals
money, sensitive PII, erasure, or settings.

**Why this priority**: The second business driver, deliberately sequenced
after US1/US2 because its safety depends on the positive gates and the
insights split; marketing becomes assignable only when its surfaces are
correct (design D17).

**Independent Test**: Sign in as the seeded marketing persona: full
broadcast compose→approve→send flow succeeds; `/admin/invoices` returns 404
and invoice APIs 403; the dashboard renders engagement widgets only with no
dead links; the registration relink route is denied.

**Acceptance Scenarios**:

1. **Given** a marketing account, **When** they run the full E-Blast flow (compose → approve → send) and manage an event's registrations/CSV import, **Then** every step succeeds.
2. **Given** a marketing account, **When** they request any money surface (invoices, payments, refunds, credit notes, renewals write, finance insights), any erasure surface, `/admin/users`, `/admin/audit`, any settings page, the directory export, or the registration relink route, **Then** the request is denied per the D9 convention and audited.
3. **Given** a marketing account on `/admin`, **Then** the dashboard shows engagement widgets only, in a layout with no empty grid holes and no links to denied surfaces, and the activity feed is PII-redacted.
4. **Given** a marketing account reading a member profile, **Then** date-of-birth and other `members.pii_sensitive` fields are absent from both UI and API responses.

---

### User Story 4 - Navigation and command palette reflect real permissions (Priority: P3)

Every staff role sees only the nav items, palette actions, and settings
categories its permission set allows; no dead links, no empty landing.

**Why this priority**: UX completion of the model — valuable but the
security holds without it (routes are gated regardless of what nav shows).

**Independent Test**: For each seeded persona, walk the sidebar, palette,
and settings index: every visible entry opens successfully; no denied
surface is listed; `/admin` renders meaningful content for every staff role.

**Acceptance Scenarios**:

1. **Given** each staff role, **When** the sidebar and palette render, **Then** the visible set equals the permitted set (server-derived; no role literals in nav code).
2. **Given** any staff role after sign-in, **Then** `/admin` renders at least one widget (landing invariant, provable from the bundle table).
3. **Given** a manager after cutover, **Then** Users/Audit/settings entries are absent from nav and palette (no dead links).

---

### Edge Cases

- Last-super-admin protection across all four paths (demote, disable, delete, erase) — including the erase path that today has no application-layer count check (design D13).
- The promotion migration merged prematurely: the run-migrations gate assertion fails the build instead of locking staff out (design D7); rollback via `vercel promote` respects the promotion floor.
- Flag OFF after Migration C: promoted accounts degrade to admin semantics; marketing accounts are DENIED (availability cost accepted, runbook-noted) — never granted manager's money-read surface (design D16).
- The SA-orphan window (flag ON before any super_admin exists) is eliminated by the D18 pre-mint step; `seed-bootstrap-admin` refuses only when a super_admin exists.
- In-flight invitations across the promotion (US1 AS-6); expired invitations safely skipped (reissue re-derives the role).
- The three system-actor rows are never promoted; webhook/cron processing is unaffected.
- Unknown/future role value reaching the legacy leg or an audit emitter: denied (no fall-through to admin or empty), audited with the real role string.
- `permission_denied` volume: expected-denial baseline separates intended narrowing from wrong-mapping (design § 11); per-actor aggregation.
- E2E personas post-promotion: the pre-existing admin persona is re-provisioned as a fresh plain admin so admin suites keep exercising the evaluator.
- Last-super-admin ERASE refusal vs erasure rights: the refusal protects staff-account continuity and is NOT a GDPR Art. 17 / PDPA §33 denial — the SA account holder is a staff operator, and a genuine data-subject erasure request against that account is fulfilled by first minting/promoting another super_admin (bootstrap path), then erasing. This rationale is recorded so the refusal is defensible (privacy checklist CHK041).
- Interrupted cutover session: every step boundary in the cutover sequence (PR-2 deployed + flag OFF · pre-mint done · flag ON verified · Migration C applied) is a STABLE resting state — an interruption at any point leaves production safe; the runbook defines the resume procedure per interruption point (operations checklist CHK085).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST define exactly five system roles — `super_admin`, `admin`, `manager`, `marketing`, `member` — as the two new pgEnum values plus the existing three; roles remain single-valued per user (1 user = 1 role).
- **FR-002**: The system MUST define a permission catalogue and per-role bundles as pure data in the auth Domain layer, matching the pinned table in design § 4.1 (40 keys incl. the split keys `invoicing.issue`, `events.relink`, `users.member_accounts`); permission sets are derived synchronously from the role with no database read.

> **AMENDMENT (108 PR-D, 2026-09-06).** The catalogue is **42 keys**: 40 pinned
> here, `broadcasts.clear_halt` (018, split out of `broadcasts.write`), and
> `contacts.marketing` (108 FR-030 — "manage contact marketing audience",
> `sensitive: pii`, granted to admin, super_admin and marketing; manager sees
> the state read-only per 108 FR-034; the marketing bundle is therefore 10
> keys, admin 36). `contacts.marketing` confers NO other contact edit — every
> `contacts.write` surface stays denied to marketing (108 US4 AS6, pinned in
> the role × endpoint matrix). `contacts.read` — "unenforced vocabulary" since
> the 016 post-ship review — gains its first ENFORCED surface, the Marketing
> audience page (`/admin/marketing/audience`, 108 FR-035); revoking it hides
> that page and its ⌘K entry but not the contacts on a member's own page,
> which still ride `members.read`. Still ADD-only: no key was renamed or
> repurposed; `payments.read` remains unenforced.
- **FR-003**: `super_admin` MUST bypass the evaluator (always allowed); `superAdminOnly` keys MUST be refused by the evaluator for every other role regardless of bundle content; a Domain test MUST prove no bundle contains a `superAdminOnly` key.
- **FR-004**: Every `(staff)` page MUST call a page-level positive permission gate (denial → 404) and every staff API route a route-level gate (denial → 403), with the F6 route families keeping their existing per-role guard semantics (design D9); page/route coverage MUST be enforced mechanically by static gates that fail the build.
- **FR-005**: All four call-site pattern classes (raw role comparisons, escalate/demote ternaries, `as`-casts, exhaustive if-chains with default-deny arms) AND the nav/palette role-filter machinery MUST be converted in the same cutover PR, behaviour-preservingly under the flag (design § 6.1).
- **FR-006**: Every denial MUST emit a `permission_denied` audit event with the pinned payload, fail-open, for every role; audit emitters MUST record the actor's real role (no coercion of unknown roles).
- **FR-007**: The cutover MUST ship behind `FEATURE_RBAC_V2` with the design § 6.2 window semantics: flag OFF is byte-identical to observed pre-cutover behaviour (per-call-site-class shim, anti-circularity rule), the code default flips ON in PR 4, and the legacy leg + env read are deleted in PR 5.
- **FR-008**: Promotion of existing admins MUST follow design D7/D18: pre-mint first `super_admin` → verify flag ON → migration-only deploy promoting human admins + open admin invitations atomically, excluding the three system actors; the promotion migration MUST be technically prevented (build-failing assertion) from applying while the flag is not ON.
- **FR-009**: The last-super-admin invariant MUST be enforced at both layers: application pre-flight in change-role, disable-user, AND erase-user; database trigger rewritten to the transitional UNION population (PR 2) and strict population (PR 5), preserving ERRCODE 23514 + the `'last-admin-protection'` message substring + the 0004 return-row contract.
- **FR-010**: `/admin/users` MUST be retrofitted per design § 7.1: the PAGE itself gated by `users.manage` (SA-only — a plain admin gets 404 per US1-AS3, and performs its `users.member_accounts` member-target operations through the existing members-surface UI, which calls the member-target API routes); `users.manage` (SA-only) for staff-target operations, `users.member_accounts` (admin + SA) for member-target operations, role picker (marketing appearing only in PR 4), member-account lifecycle preserved, every dialog passing an explicit `finalFocus`, and the last-super-admin refusal surfacing as a localized inline error (EN/TH/SV keys) — never an unhandled 500. The role picker follows the existing dialog standards (ux-standards § 6.2/§ 7): initial focus on the safe action, Tab order follows visual order, Escape closes WITHOUT applying the role change, an explicit Confirm applies it; the keyboard E2E additionally asserts Escape-discard.
- **FR-011**: `/admin/audit` MUST be gated behind `audit.read` with viewer redaction keyed to the permission decision on the ON leg (super_admin sees the unredacted projection) and today's projection preserved on the OFF leg; the activity feed redaction re-keys to `insights.activity_unredacted`.
- **FR-012**: The F9 dashboard MUST split into engagement vs finance parts (separately cacheable snapshot loaders + widget→permission map) such that a marketing account receives no finance figures and no degenerate layout. The split loaders retain the existing dashboard skeleton-shimmer loading behaviour (ux-standards § 2.1–2.2): each visible widget renders its shimmer placeholder while its part loads, and a role never sees skeletons for widgets its permissions exclude.
- **FR-013**: Sensitive-PII fields (date-of-birth class) MUST move to `members.pii_sensitive`; erasure endpoints MUST carry their explicit `superAdminOnly` erasure permissions.
- **FR-014**: Navigation, command palette, and the settings index MUST render from declared per-item permissions (PR 4), with the PR-2 sweep keeping the interim data-driven filters behaviour-preserving (three `roles:` arrays widened to include `super_admin`).
- **FR-015**: Role display names MUST exist in EN/TH/SV; changed surfaces MUST pass the a11y (WCAG 2.1 AA) and i18n sweeps; the keyboard-focus E2E assertion applies to the retrofitted users page. Role display names and picker/nav/settings-index labels MUST NOT render italic in TH (faux-oblique distorts tone marks) and MUST accommodate TH/SV length variance per Constitution § V (no truncation, no broken wrapping) in the role picker, sidebar, and settings index.
- **FR-016**: Observability MUST include the `rbac.permission_denied_total{role, permission}` counter, the expected-denial baseline alert, and the `rbac-v2-cutover` runbook covering pre-mint, verification, promotion, promotion floor, per-window rollback, and env-var lifecycle.
- **FR-017**: Migrations MUST follow the repo discipline codified in design § 5: `IF NOT EXISTS` enum DDL, `REQUIRED_ENUM_VALUES` extensions, journal `when` > global max, no literal BEGIN/COMMIT, roleEnum tuple widened with Migration A.
- **FR-018**: The ROPA/privacy documentation MUST be updated for the new processing activity (staff role administration) and marketing's member-data read access.

### Key Entities

- **Role**: one of five enum values; stored on `users.role` and `invitations.intended_role` (shared pgEnum); identity-level concept (portal mapping, audit stamping) as well as the input to permission derivation.
- **Permission key**: dot-separated `<module>.<action>` string in the code catalogue, with `superAdminOnly` / `sensitive` flags; meaningful only because a call site checks it.
- **Role bundle**: the pinned per-role set of permission keys (design § 4.1 table) — the single source of authorization truth in Phase 1.
- **PermissionSet**: the derived, in-memory set for the acting role; never persisted.
- **`permission_denied` audit event**: new audit_event_type value with pinned payload; 5-year retention class (default).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of `(staff)` pages and staff API route handlers carry a positive permission declaration, verified mechanically (static gate + exhaustiveness test) — currently 17 pages have none.
- **SC-002**: At flag-ON + promotion, zero behaviour change for existing accounts outside the enumerated D4 narrowings, proven by the characterization suite passing on both legs (observed-behaviour expected values).
- **SC-003**: Zero possible path to zero active super_admins: all four removal paths refuse at two layers, integration-proven on live Neon, including the erase path.
- **SC-004**: A marketing persona reaches 0 money/PII/compliance surfaces across the full role × endpoint matrix and E2E walk; the full E-Blast and event flows complete successfully.
- **SC-005**: 100% of permission denials produce an audit event with the actor's real role (contract-tested per role); the denial metric distinguishes expected-narrowing pairs from unexpected ones. Audit emit is fail-open per FR-006: a failed emit still serves the denial — the denial-audit contract test's emit-failure case (denial served, event absent) is a PASS of this criterion, not a violation.
- **SC-006**: The cutover sequence (PR 2 deploy → pre-mint → flag ON → Migration C) completes on production with zero staff-lockout minutes; a premature promotion merge fails the build rather than deploying.
- **SC-007**: Domain layer 100% line coverage; evaluator/bundles + the flag-reading helpers at 100% branch; the helpers file is absent from every coverage-exclude list.

## Assumptions

- SweCham/TSCC remains single-tenant-deployed throughout Phase 1; the global `users.role` column is acceptable until F10 `user_tenants` lands (design D1).
- The five system bundles are stable enough that bundle changes are rare (> Phase-2 trigger threshold: ~1/month sustained would re-open Phase 2).
- Marketing headcount is small; losing marketing access during an emergency flag-OFF window is acceptable (design D16, maintainer-confirmed).
- The existing E2E persona/env-var infrastructure (`E2E_*` accounts in `.env.local`) is the vehicle for the new personas; the dev Neon branch receives Migration C in coordination with PR-3 E2E changes.
- Design doc v2 rev 3 is the authoritative technical companion; where this spec and the design doc diverge, the divergence is a defect to be resolved at the `/speckit.plan` gate, not silently.
- No DPIA is required for this feature (privacy checklist CHK035): marketing's member-read access is a NEW INTERNAL ACCESS ROLE over existing data — no new data category, no new processing purpose, no new third-party transfer, no automated decision-making. The assessment note is recorded in the FR-018 ROPA update; if a future change adds any of those triggers, the DPIA question re-opens.
- Marketing's broadcast surfaces (recipient segments, review queue, delivery views) disclose exactly the member fields F7 already shows broadcast operators today — this feature adds NO new PII projection to any F7 surface, and the marketing rows of the role × endpoint matrix assert this (privacy checklist CHK039).
- Phase 1 concentrates erasure / erasure-log / audit surfaces on `super_admin`; PDPA/GDPR access-and-erasure fulfilment therefore assumes an available super_admin. SC-003 (zero path to zero SAs) plus the `seed-bootstrap-admin` recovery path guarantee an SA can always be (re)established at runtime, so data-subject requests remain fulfillable without code changes (privacy checklist CHK042, design § 12 SoD residual).
