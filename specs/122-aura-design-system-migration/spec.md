# Feature Specification: AURA Design-System Migration

**Feature Branch**: `claude/jolly-feynman-8hpoyh` (spec directory `122-aura-design-system-migration`; the session is pinned to this branch, so the usual `nnn-feature-name` branch is not created)  
**Created**: 2026-09-26  
**Status**: Draft  
**Input**: User description: "Move the whole Chamber-OS UI to the AURA design system (aura-react), one module at a time, so the live admin and member portals match the AURA boards on the 'Chamber-OS Portal — Aura' design canvas. Start with the foundation; AURA gaps are fixed in parallel by the AURA maintainer."

## Context — what exists today and what this feature changes

The admin portal (`/admin`) and member portal (`/portal`) are built on a local copy of a generic component kit (48 files under `src/components/ui/`, on Base UI primitives), with a separate toast library, a separate command-palette library, a separate date-picker library, and hand-assembled table screens. Colours, type and spacing live in one hand-maintained global stylesheet.

Over September 2026 the maintainer redesigned every screen — about 300 boards covering desktop (1440 px) and phone (390 px) layouts, empty/error/role states and TH/SV variants — on the **AURA** design system, which the same maintainer owns and publishes (`@jirawatpyk/aura-react` and `@jirawatpyk/aura-tokens`, 5.5.0). The Chamber-OS requirements AURA needed were handed over item by item (the AURA handoff doc, items 1–52); 5.5.0 covers items 1–51, and item 52 (per-row table selection) is open.

This feature replaces the component layer with AURA so the product matches those boards, and ends with one component library, as Constitution Principle VI requires. It changes **presentation only**: no module, database, API, permission or money behaviour changes, and copy changes only where a component swap forces them.

The migration runs **module by module**, one pull request per phase, in the order of the canvas page "Migration plan — AURA". During the migration both libraries coexist; that window is bounded (see FR-004).

## Clarifications

### Session 2026-09-26 (maintainer, before `/speckit.specify`)

- Q: Hybrid end state (AURA only for missing components) or full migration? → A: **Full AURA end state.** Nothing from the old kit remains after the Exit phase.
- Q: Which fonts? → A: **AURA's fonts** (Inter, Noto Sans Thai, Fraunces, JetBrains Mono), served from the app's own origin.
- Q: Toast position — the old top-right, or AURA's options (top or bottom, centred)? → A: **Top, centred.**
- Q: Loading skeletons — keep the shimmer in the UX playbook §2.1, or AURA's pulse? → A: **AURA's pulse**; §2.1 is rewritten.
- Q: How long may both libraries coexist? → A: **At most 10 weeks** after the foundation merges.
- Q: One PR for spec + foundation, or two? → A: **One PR** — spec commits first, then foundation commits.
- Q: Is the system live? → A: **Not yet** (under improvement), which lowers the regression cost; the quality gates still apply in full.

### Session 2026-09-26 (maintainer, after the US0 review)

- Q: During the dual-library window, what colour are legacy primary buttons, and what is the end state? → A: Legacy kit primary buttons and `text-primary` links take the **brand accent** (#2E6397 in light) through the token bridge until their module migrates. The end state follows the AURA design: primary buttons in **AURA ink** (#18181B with white text in light; white with ink text in dark), and the brand blue for links, focus rings, selection and info.
- Q: Must every phase run the local end-to-end suites before merge? → A: **No — at checkpoints only**: after US1 (the shared shell), after the money phases (US4, US8), and before US13. e2e has no CI job and a full local run takes over an hour, so per-phase runs would stall a 13-phase migration; each phase relies on its unit/component tests, the required CI checks (integration smoke, coverage) and the canvas comparison instead. A checkpoint failure caused by an earlier phase is fixed in its own PR before the next phase merges.
- Q: What does the US1 checkpoint cover? → A: **The shell specs, not the full suite** (maintainer, 2026-09-26). US1 changes only the shared frame, so its checkpoint ran the 16 shell specs on chromium and WebKit against main, by test title; every failure was either on main too or fixed in the US1 PR. The first full-suite run moves to the checkpoint after US4 and also covers US1.
- Q: Do the staff bar and the portal header stay the same height (spec 004 SC-009, "identical 56px")? → A: **No** (US1, 2026-09-26): the boards draw the staff bar at AppShell's 56px and the portal header at 72px from 1024px (64px below). SC-009 is superseded; each bar keeps a fixed height, so the no-layout-shift intent stands.
- Q: Can US1 remove the old command-palette library? → A: **Not yet** (found at US1, 2026-09-26): besides the two ⌘K palettes it backs the pickers and the kit's combobox (member, event, template and task pickers; the invoice and plan forms). US1 moves both palettes to AURA `Command`; the library leaves with the last of those modules, at the latest US13, and the lint ban goes global then.
- Q: Does the Swedish-flag navy chrome (navy rail and header, yellow stripe) survive on AURA SideNav / AppShell? → A: **No — dropped**; the shell follows the AURA design. The yellow stripe is removed in US0; US1 replaces the staff sidebar and portal header with AppShell / SideNav as designed.

## User Scenarios & Testing *(mandatory)*

Every story below is one phase and one pull request. A story is done when its screens use only AURA components, match their canvas boards, and pass the per-module definition of done (FR-010).

### User Story 0 - Foundation: every screen already speaks AURA's visual language (Priority: P1)

Staff and members open any existing page and see AURA's colours, type, radius and toasts — before a single screen is rebuilt — because the old kit's colour and radius variables are fed from AURA's tokens, AURA's fonts replace the old font, and every toast in the product comes from one AURA toast surface at the top centre of the screen. Developers get the rails for the next phases: the AURA packages, the provider that tells AURA the user's language and calendar, a lint rule that stops migrated code from importing the old kit, test helpers, and the updated UX playbook.

**Why this priority**: every later phase depends on it, and it gives the whole product the new look at once at low risk.

**Independent Test**: open `/admin`, `/portal`, a form and a table in EN, TH and SV, light and dark; trigger a success, an error and a read-only toast; confirm AURA colours/fonts, one toast at top centre, Buddhist-era dates on TH only, and no layout or behaviour change.

**Acceptance Scenarios**:

1. **Given** any existing page, **When** it renders, **Then** its text uses the AURA font families and its surfaces, borders, focus rings, charts and sidebar use AURA's colour tokens, in both light and dark themes.
2. **Given** an action that shows a toast (success, error, warning, read-only), **When** it fires, **Then** one AURA toast appears at the top centre with the same title and description as before, is announced to screen readers, and at most three are visible at once.
3. **Given** a Thai-language session, **When** an AURA component shows a date, **Then** the year is in the Buddhist Era; in EN and SV it is Gregorian; stored values are unchanged.
4. **Given** new or migrated code, **When** it imports the old toast library, AURA's generic date formatter, or (in a migrated path) the old component kit, **Then** the lint gate fails.
5. **Given** the production security policy, **When** pages load, **Then** no font or stylesheet is fetched from a new external origin.

---

### User Story 1 - Shell: one AURA frame around every page (Priority: P1)

Staff get AURA's sidebar navigation, header, user menu, breadcrumb, pagination and command palette; members get AURA's top navigation and phone bottom bar; everyone gets AURA's idle-warning and confirmation dialogs, empty states and skeletons. The page containers keep their current contract, so every page still lays out as before.

**Why this priority**: the frame is on every screen; after it, each module is a local change.

**Independent Test**: navigate every top-level section at 390 and 1280 px as admin, manager and member; open the command palette; trigger the idle warning; compare with the Templates and shell boards.

**Acceptance Scenarios**:

1. **Given** each role, **When** it opens the portal, **Then** it sees exactly the navigation entries its permissions allow (unchanged), in AURA's side or bottom navigation.
2. **Given** the command palette shortcut, **When** pressed, **Then** the AURA palette opens with the same actions and keyboard behaviour as before; the palettes no longer use the old palette library.
3. **Given** the existing page-layout checks and end-to-end selectors, **When** the shell is swapped, **Then** the layout-container contract passes unchanged; selectors that named the old kit's internals (`data-slot="sidebar*"`, cmdk testids, `data-active`) move to roles and names, and the top-bar heights follow the boards (supersedes spec 004 SC-009, see Clarifications).

---

### User Story 2 - Auth pages (Priority: P2)

Sign-in (staff and member), forgot/reset password, invitation acceptance and the related states use AURA text, password and checkbox fields and AURA's form error summary.

**Independent Test**: complete sign-in, a failed sign-in, a password reset and an invitation acceptance in EN/TH/SV at 390 and 1280 px.

**Acceptance Scenarios**:

1. **Given** invalid input, **When** submitted, **Then** the AURA error summary lists each error, links to its field and receives focus; messages are unchanged.
2. **Given** a screen reader, **When** the password visibility toggle is used, **Then** its state is announced.

---

### User Story 3 - Member home, profile and account (Priority: P2)

Members see their dashboard, benefits, company profile, change requests and account settings in AURA cards, stats, status pills, link tabs and sticky action bars.

**Independent Test**: as a member, review the dashboard, edit the profile, submit and withdraw a change request, and change the notification language — compare with the member-portal boards.

**Acceptance Scenarios**:

1. **Given** a form with unsaved changes on a phone, **When** the member scrolls, **Then** the save action stays reachable in an AURA action bar.

---

### User Story 4 - Member invoices and payment (Priority: P2)

Invoice list, invoice detail, receipts, credit notes and the card/PromptPay pay sheet use AURA tables with totals rows, the stepper and a phone sheet at up to 92% of the screen height. Amounts, document numbers, VAT lines and document wording are unchanged.

**Independent Test**: open an unpaid bill, pay it in the test environment, download the receipt, open a credit note — every figure matches the pre-migration screen.

**Acceptance Scenarios**:

1. **Given** any money screen, **When** migrated, **Then** every amount, VAT line, document number and status is identical to before (a financial-integrity review signs this).

---

### User Story 5 - Members administration (Priority: P2)

Members list (server-paged, sorted, filtered), member detail, create/edit, directory, change-request review and bulk actions use AURA's data table in server mode, filter bar and bulk action bar.

**Independent Test**: page, sort, filter and bulk-act on the members list with the same results and URLs as before.

**Acceptance Scenarios**:

1. **Given** a filtered, sorted page of members, **When** the URL is shared, **Then** it reopens the same view (unchanged URL contract).

---

### User Story 6 - Plans (Priority: P3)

Plans list, detail, create wizard, edit and clone use AURA forms, segmented controls and switches.

**Independent Test**: create, edit and clone a plan; the stored plan is identical to one made before the migration.

**Acceptance Scenarios**:

1. **Given** the plan wizard, **When** a step has errors, **Then** the AURA error summary and stepper show them.

---

### User Story 7 - Renewals (Priority: P2)

The renewals pipeline (table and phone card list become one AURA data table), cycle detail, tasks, tier upgrades and schedules.

**Independent Test**: filter the pipeline, open a cycle, record a payment, snooze an at-risk member.

**Acceptance Scenarios**:

1. **Given** a phone, **When** the pipeline renders, **Then** each row stacks as a card from the same table (no second list).

---

### User Story 8 - Invoicing administration (Priority: P2)

Invoice list/detail, tax registers (with sticky totals footer), credit-note, refund, record-payment and void dialogs.

**Independent Test**: issue, pay, credit and void test invoices; register totals and CSV export equal the pre-migration output.

**Acceptance Scenarios**:

1. **Given** a register month, **When** migrated, **Then** row count, totals and the export match exactly (financial-integrity review).

---

### User Story 9 - Events (Priority: P3)

Events list/detail, attendee import (file upload + column mapping), EventCreate integration, erasure pages; date and time pickers in Bangkok time.

**Independent Test**: import an attendee CSV, map columns, open erasure as super admin.

**Acceptance Scenarios**:

1. **Given** a typed date outside the allowed range, **When** entered, **Then** the AURA date field refuses it with a message (no silent clamp).

---

### User Story 10 - Users, audit log, compliance and settings (Priority: P3)

Users list and role changes, audit log, erasure log, and every settings page.

**Independent Test**: invite a user, change a role, filter the audit log, save each settings page.

**Acceptance Scenarios**:

1. **Given** a destructive menu item (e.g. deactivate user), **When** shown, **Then** it uses AURA's danger item and a confirmation dialog.

---

### User Story 11 - Staff dashboard (Priority: P3)

KPI tiles become AURA stats; charts keep their data and chart type, recoloured with AURA's chart palette.

**Independent Test**: every KPI value and chart series equals the pre-migration dashboard for the same data.

**Acceptance Scenarios**:

1. **Given** dark mode, **When** charts render, **Then** every series meets contrast rules against its background.

---

### User Story 12 - E-Blast (Priority: P3)

The review queue (server-paged, stage chips, per-row selection), approval-round detail, formatted-version workspace, schedule dialog, templates, marketing audience, broadcast settings and brand, and the member compose/list/detail/sign-off screens — per the canvas page "E-Blast — two-sided approval (F119)".

**Independent Test**: run one E-Blast through submit → formatted version → member approval → schedule with the feature flag on.

**Acceptance Scenarios**:

1. **Given** the review queue, **When** rows in different stages are shown, **Then** only rows awaiting marketing review can be selected for bulk approval (AURA handoff item 52, or a local selection column until it ships).

---

### User Story 13 - Exit: one component library (Priority: P1)

The old component kit folder, its primitives library, the old toast/palette/date-picker libraries and the table-UI library are removed; the lint rule forbids the old kit everywhere.

**Why this priority**: it closes the Constitution Principle VI exception by its deadline.

**Independent Test**: a search for imports of the old kit returns nothing; the build, all gates and the full end-to-end suite pass.

**Acceptance Scenarios**:

1. **Given** the codebase at Exit, **When** searched, **Then** there are zero imports of the old component kit and the removed libraries are absent from the dependency list.
2. **Given** the date the foundation merged, **When** Exit merges, **Then** no more than 10 weeks have passed (or the exception was renewed through a documented decision).

### Edge Cases

- A page migrated in phase N embeds a component still on the old kit (e.g. a shared dialog): overlays from the two libraries must not stack inside one another; the shared piece migrates with the first module that needs it, or both render with the agreed layer order so focus and scroll lock stay correct.
- An AURA component lacks a behaviour Chamber-OS needs (e.g. item 52): the gap is added to the AURA handoff doc, and the module keeps a small local wrapper, marked for removal, until AURA ships it; the module is not blocked.
- A toast call passes an option AURA does not support (e.g. a promise toast): the toast facade emulates it with loading → success/error; no call site breaks.
- A Thai page shows a year from a component that formats dates itself: it must show the Buddhist Era; a Swedish or English page must not.
- Reduced motion is on: skeletons do not pulse and toasts do not slide.
- A phone at 320 px: no horizontal scroll on any migrated page; tap targets stay at least 44 px.
- Read-only mode (write freeze) or a manager's read-only role: the existing banners and hidden actions behave exactly as before.
- The AURA package publishes a breaking release mid-migration: the exact version pin holds until a dedicated upgrade PR.

## Requirements *(mandatory)*

### Functional Requirements

**Foundation (US0)**

- **FR-001**: The product MUST use the AURA packages at one exact, pinned version, upgraded only in a dedicated change.
- **FR-002**: Every existing page MUST take AURA's colour, radius and font tokens for its surfaces, text, borders, focus rings, charts and navigation, in light and dark, without its layout changing.
- **FR-003**: AURA's fonts MUST be served from the product's own origin; no new external origin may be added to the content-security policy.
- **FR-004**: The period in which both component libraries coexist MUST NOT exceed **10 weeks** from the foundation merge, recorded as a documented exception to Constitution Principle VI; renewing it requires a new documented decision.
- **FR-005**: AURA components MUST receive the user's language (EN/TH/SV), use the Buddhist calendar for Thai and the Gregorian calendar otherwise, render internal links through the app's router, and use a compact density on staff pages and a comfortable density on member pages.
- **FR-006**: All dates the product formats itself MUST keep going through the existing localised formatter; AURA's generic date formatter MUST NOT be used directly.
- **FR-007**: All toasts MUST come from one AURA toast surface at the top centre; every existing toast keeps its title, description, tone and action; at most three are visible; the old toast library is removed in the foundation.
- **FR-008**: A lint gate MUST reject imports of the old toast library and of AURA's generic date formatter everywhere, of the old command-palette library once its last consumer migrates (US1 moves both command palettes; the pickers that also use it move with their modules, at the latest US13), and of the old component kit inside every path already migrated (a list that grows with each phase); a test MUST prove the gate catches each banned import.
- **FR-009**: Loading skeletons MUST use AURA's pulse style from US1 onward; the UX playbook MUST describe AURA as the component library and the pulse as the skeleton standard.

**Every module phase (US1–US12)**

- **FR-010**: A phase is done only when (a) its paths import nothing from the old component kit, (b) its screens match their canvas boards at 390 and 1280 px in light and dark, (c) the layout, i18n, strict-ARIA and date gates pass, (d) its unit/component tests and all required CI checks pass (the end-to-end, accessibility and locale suites run locally only at the checkpoints — the shell specs after US1, the full suite after the money phases US4/US8 and before US13 — not per phase), (e) bundle budgets are re-baselined, and (f) a UX review — and on money screens a financial-integrity review — has signed it.
- **FR-011**: A phase MUST NOT change module logic, stored data, API contracts, permissions, audit events or money figures; logic defects found along the way are fixed in separate pull requests, merged before the phase's UI change.
- **FR-012**: Page containers MUST keep their current contract (props and the attributes the layout gate and end-to-end tests select on) until US13.
- **FR-013**: Every migrated screen MUST meet WCAG 2.1 AA, work at 320 px without horizontal scroll, keep 44 px tap targets, honour reduced motion, and keep EN/TH/SV text parity.
- **FR-014**: Overlays from the two libraries MUST NOT nest; their stacking order MUST follow AURA's layer scale (dialog below menu below toast below tooltip).
- **FR-015**: Tables that page, sort or filter on the server MUST keep their URL contract (shared links reopen the same view).
- **FR-016**: Where AURA lacks a needed behaviour, the gap MUST be logged in the AURA handoff doc and bridged by a local wrapper marked for removal; the wrapper MUST be removed when AURA ships the behaviour, at the latest at US13.

**Exit (US13)**

- **FR-017**: At Exit the old component kit, its primitives library and the old toast, command-palette, date-picker and table-UI libraries MUST be removed, and the lint gate MUST forbid the old kit everywhere.

### Key Entities

- **Design token**: a named colour, radius, font, spacing, density or layer value owned by AURA; Chamber-OS's legacy variables become aliases of these during the migration.
- **Migrated path**: a directory whose screens are on AURA; listed in the lint gate so regressions fail.
- **Canvas board**: the reference design for one screen state and width on the design canvas; the acceptance reference for visual parity.
- **AURA handoff item**: a numbered requirement Chamber-OS raised with AURA (1–52), with a gap, a proposal, acceptance criteria and a Chamber-OS stop-gap.

### Chamber-OS cross-cutting requirements *(mandatory — answer each; "N/A because …" is an answer, a blank is not)*

- **Roles & permissions**: no change. Every role sees exactly the actions and navigation it sees today; the shell phase re-implements the navigation from the same permission evaluator (never from role bundles). No new permission keys.
- **Tenant scope**: N/A because no data, query or repository changes; presentation only. Tenant branding stays in the E-Blast brand settings; the product UI brand colour (#10487A) is a single committed theme.
- **Locales**: all user-facing text stays in EN (canonical) + TH + SV with parity; AURA's built-in labels come in EN/TH/SV and follow the active locale, so TH/SV never fall back to English; Buddhist Era is display-only for Thai (FR-005/FR-006).
- **Personal data**: N/A because no field is collected, stored, displayed differently or sent anywhere new; fonts and styles stay on the product's origin (FR-003), so no new third party receives visitor data.
- **Audit trail**: N/A because no state change is added or altered; UI swaps must not add, drop or rename audit events (FR-011).
- **Money & tax**: not touched in logic; money screens (US4, US8) must show identical figures, statuses and document wording, verified by a financial-integrity review (FR-010f).
- **Feature flag / kill-switch**: none — a presentation swap per module; rollback is reverting that phase's PR. Live on merge of the foundation: AURA tokens/fonts on every page, the AURA toast, the lint gate. The existing E-Blast and member-change flags are unaffected.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After the foundation merges, 100% of pages show AURA's fonts and colour tokens, and every toast in the product appears at the top centre.
- **SC-002**: After each phase, the number of old-kit imports in that phase's paths is zero, and the total across the codebase falls monotonically to zero at Exit.
- **SC-003**: Exit merges within 10 weeks of the foundation merge.
- **SC-004**: No phase changes a stored value, money figure, audit event or API response (verified by the unchanged integration and contract suites).
- **SC-005**: Accessibility scans report zero WCAG 2.1 AA violations on every migrated screen, at 320/390 and 1280 px, light and dark.
- **SC-006**: Every migrated screen matches its canvas board closely enough that a reviewer comparing them side by side finds no unexplained difference (differences are either listed as proposals on the board or fixed).
- **SC-007**: Initial page load does not regress by more than the re-baselined bundle budget per route, and layout shift from the font change stays below 0.1 on `/`, `/portal` and `/admin`.

## Assumptions

- The AURA maintainer is also the Chamber-OS maintainer and fixes AURA gaps in parallel; the handoff doc is the contract between the two.
- AURA 5.5.0 covers handoff items 1–51 (5.6.0 adds 52–56; 5.7.0 adds 57–62; 5.7.1 adds 63; 5.7.2 adds 64; 5.7.3, the pin since US2, adds 65) and exposes the same package entry points as 4.17 (verified on the registry 2026-09-26); no item is open.
- The ~300 canvas boards are the visual reference; where a board is marked "Proposed", the phase may either implement the proposal or keep the current behaviour, and says which in its PR.
- End-to-end tests have no CI job and run locally; each phase links its run log.
- The dashboard's charting library stays; only its colours move to AURA's chart palette.
- The product UI has one brand theme (SweCham #10487A) for now. Per-tenant UI colours belong to the future white-label feature (F12, `docs/saas-architecture.md` § 8); the brand theme is kept in one place so F12 can later supply it per tenant at runtime without touching screens.
- Visual parity (SC-006) is judged by a reviewer comparing screenshots of the running page against its canvas board at 390 and 1280 px, light and dark, attached to the phase's PR; there is no pixel-diff gate, because the boards use sample data.
- Queued logic-bug tasks (void/auto-refund rules; TH/SV wording and bill labels; colleague contact data; E-Blast PDPA) land as their own PRs and are not part of this feature.
- Out of scope: backend, database, API behaviour, permissions, and copy changes beyond what a component swap forces.
