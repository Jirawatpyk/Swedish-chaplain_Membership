# Tasks: AURA Design-System Migration

**Input**: `specs/122-aura-design-system-migration/` (spec.md, plan.md, research.md, contracts/, data-model.md, quickstart.md)

**Tests**: MANDATORY (Principle II). Each behaviour below names the test that must go RED first. The feature is presentation-only, with no tenant-scoped data, so there is no cross-tenant probe.

**Organization**:
- US0 (Foundation) ships in this PR and is detailed task by task.
- US1–US13 are one PR each. Each gets its own task breakdown in this file when it starts; each is one line here until then.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [x] T001 [US0] Add `@jirawatpyk/aura-react@5.5.0` and `@jirawatpyk/aura-tokens@5.5.0` (bumped to 5.6.0 on 2026-09-26 when handoff items 52–56 shipped, to 5.7.0 – 5.7.2 in US1 when 57–64 shipped, to 5.7.3 in US2 when 65 shipped, to 5.8.0 in US3 when 66–69 shipped, and to 5.9.0 then 5.10.0 in US4 when 70–71 and 72–74 shipped) as exact pins in `package.json` and `pnpm-lock.yaml`. Remove `react-day-picker`, delete `src/components/ui/calendar.tsx` and `src/components/ui/scroll-area.tsx` (0 importers), and confirm `pnpm typecheck` and `pnpm test` are green.
- [x] T002 [US0] Generate the brand theme with `npx aura-theme --brand "#10487A" --out src/styles/aura-theme.css`. The CLI must exit 0 (all contrast checks pass). Commit the output, with a header comment naming the regenerate command.

---

## Phase 2: User Story 0 — Foundation (Priority: P1) 🎯 this PR

**Goal**:
- Every page takes AURA tokens and fonts.
- All toasts come from one AURA surface at the top centre.
- The rails exist for the phases after this one: the provider, the lint ratchet, the test helpers and the docs.

**Independent Test**: `quickstart.md` §§ 1–5.

### Toasts — behaviour: one facade; every existing toast keeps title, description, tone, action (FR-007)

- [x] T003 [US0] RED: write `tests/unit/lib/toast-facade.test.ts` per `contracts/toast-facade.md`, covering forwarding, id return, `error` as the danger tone, `closeButton` dropped, `dismiss`, and in-place `id` reuse. It fails because `src/lib/toast.ts` does not exist.
- [x] T004 [US0] Add `src/lib/toast.ts` (the contract type), backed by `sonner` in commit A. T003 goes GREEN, except the AURA-specific tone assertion, which stays pending until T007.
- [x] T005 [US0] Codemod the 115 `src/` files from `import { toast } from 'sonner'` to `from '@/lib/toast'`, and the 111 tests from `vi.mock('sonner', …)` to `vi.mock('@/lib/toast', …)`. Fix the compile errors the narrower type exposes.
  - The only rich description is in `src/components/invoices/use-supersede-warning-toast.tsx`. It becomes text plus one action (research R4): one failed bill → "Open SC-…" via the router; several → "Open invoices", filtered to them. Its test is updated first (RED), then the hook.
  - `pnpm test` is green. This is commit A: a pure rename plus the one hook.
- [x] T006 [P] [US0] Add `tests/helpers/aura.ts` (`expectToast`, `pickSelect`, `checkBox`, `openMenu`). Make Vitest setup fail on `[aura]` dev warnings (`tests/setup*.ts`).
- [x] T007 [US0] Commit B: re-implement `src/lib/toast.ts` on AURA `toast`. Mount AURA `<Toaster position="top" />` inside AuraBridge (T010), remove `<Toaster>` from `src/app/layout.tsx:123`, delete `src/components/ui/sonner.tsx`, and uninstall `sonner`. T003 is fully GREEN and `pnpm test` is green.

### Provider — behaviour: AURA gets locale, calendar (BE for th only), time zone, router link and density (FR-005)

- [x] T008 [US0] RED: write `tests/unit/providers/aura-bridge.test.tsx` per `contracts/aura-bridge.md`:
  - `th` gives `buddhist`; `en` and `sv` give `gregory`.
  - The tenant time zone and the `next/link` component reach AURA.
  - The Toaster renders once (added with commit B, T007).
  - A nested density provider keeps the language, calendar, time zone and link.
- [x] ~~T009~~ Dropped: AURA 5.5 ships its built-in labels in EN/TH/SV and picks them by `locale`, so no `aura.*` namespace is needed (research R5).
- [x] T010 [US0] Add `src/components/providers/aura-bridge.tsx` and mount it in `src/app/layout.tsx` inside `ThemeProvider`, passing `locale` and the tenant `timeZone`. Add the nested density providers in `src/app/(staff)/admin/layout.tsx` (compact) and `src/app/(member)/portal/layout.tsx` (comfortable). T008 is GREEN.

### Tokens and fonts — behaviour: every page uses AURA's fonts and colour and radius tokens, in light and dark, with the layout unchanged and no new origin (FR-002, FR-003)

- [x] T011 [US0] RED: write `tests/unit/styles/aura-foundation-css.test.ts`, which parses `src/app/globals.css` and asserts:
  - the layer-order statement is first
  - the AURA imports are present, in the order in `contracts/css-layers.md`
  - every token-bridge variable in the contract table is assigned a `var(--aura-…)`
  - `--font-sans`, `--font-heading` and `--font-mono` name the AURA families
  - no `fonts.googleapis`/`gstatic` URL appears anywhere in `src/`

  It fails today.
- [x] T012 [US0] Edit `src/app/globals.css`:
  - the layer order and imports (`contracts/css-layers.md`)
  - font stacks in `@theme inline`
  - the token bridge in `:root` and `.dark`

  Layout, type and table vars stay. The shimmer CSS stays until US1.

  Then edit `src/app/layout.tsx`: remove Geist `next/font` and the font classes. T011 is GREEN.
- [x] T013 [US0] Map kit overlay z-index to AURA tokens in the kit wrappers:
  - popovers, selects, dropdowns and tooltips → `var(--aura-z-menu)`
  - dialogs and sheets → `var(--aura-z-dialog)`

  The files are `src/components/ui/{popover,select,dropdown-menu,tooltip,combobox,dialog,alert-dialog,sheet}.tsx`. Add a unit assertion in the T011 test file that each wrapper uses the token.
- [ ] T014 [US0] Run `pnpm build`. Verify the woff2 files are emitted in `.next/static/media`. If Turbopack does not rewrite the package `url()`, fall back to `next/font/local` (research R7). Re-baseline `scripts/check-bundle-budgets.ts` with `ceil(kb/10)*10+100` and record the before/after numbers in the PR.

### Lint ratchet — behaviour: banned imports fail the lint gate; migrated paths cannot import the old kit (FR-008)

- [x] T015 [US0] RED: write `tests/unit/architecture/ui-import-ratchet.test.ts` per `contracts/lint-ratchet.md`. It uses ESLint `lintText` on fixtures:
  - `sonner` fails
  - AURA root `formatDate`/`useFormatDate` fail
  - `@/components/ui/button` inside a `MIGRATED_PATHS` fixture fails
  - the same import outside the list passes (control)
- [x] T016 [US0] Add `eslint.ui-ratchet.mjs` (`uiRatchet(paths)`) and spread `uiRatchet(MIGRATED_PATHS)` with `MIGRATED_PATHS = []` at the end of `eslint.config.mjs`; `cmdk` is an error everywhere but its host `ui/command.tsx` until US1. T015 is GREEN and `pnpm lint` is clean.

### Docs — behaviour: the playbook names AURA as the component library and pulse as the skeleton standard (FR-009)

- [x] T017 [P] [US0] Update `docs/ux-standards.md`:
  - §1.1: component library → AURA. Note the old kit is Base UI, not Radix, until US13.
  - §1.2/§1.3: tokens and type → AURA.
  - §1.7: theming via next-themes `.dark`, which AURA reads.
  - §2.1: pulse replaces shimmer from US1.
  - §12.3: date display stays on `format-date-localised`.
  - §16: AURA component checklist.
  - §17: review gate adds canvas parity plus the lint ratchet.
- [x] T018 [P] [US0] Add `docs/aura-adoption.md`: layer order, token bridge, brand-theme regeneration, toast facade, ratchet workflow (how a phase adds to `MIGRATED_PATHS`), per-module definition of done (FR-010), and the handoff-doc process with open items 52 and 53. Add a banner to `docs/design-system-audit.md` pointing to it.
- [x] T019 [P] [US0] Update `CLAUDE.md`:
  - The UI stack line becomes "AURA (`@jirawatpyk/aura-react` 5.5.0) replacing shadcn/Base UI module by module — spec 122; sonner removed".
  - Fix "Radix primitives" to Base UI.
  - Fix "`pnpm typecheck` is in NO gate" to "typecheck runs in CI quality-gates; run it locally before committing".
  - Add an Active Technologies line for 122.

### Verification (US0 exit)

- [ ] T020 [US0] Run the full gates:
  - `pnpm lint && pnpm typecheck && pnpm test:coverage`
  - `pnpm check:i18n && pnpm check:layout && pnpm check:dates && pnpm check:strict-aria`
  - `pnpm build && pnpm check:bundle-budgets`
  - `pnpm vitest run tests/contract/`
- [x] T021 [US0] e2e (local, 2026-09-26, head `8cb043276`, the maintainer's machine): the toast-touching specs plus `@a11y`/`@i18n` subset. Findings: `event-fee-as-paid` 320px sv reflow +3px (caused by this PR's font change: the attendee picker's name column lacked `min-w-0`, so the "Icke-medlem" badge overflowed) → fixed with `min-w-0`, verified locally 9/9 on chromium; `tier-aware-reminder-cron` fails on main too (stale menuitem locator since #279, not this PR); `eventcreate-a11y` WebKit-only "Load failed" under investigation, chromium 13/13 pass. The full suite is not run per phase (spec Clarifications: e2e at checkpoints only).
- [ ] T022 [US0] Visual pass: screenshots of `/admin`, `/admin/members`, one admin form, `/portal` and `/portal/invoices` in EN/TH/SV, light/dark, at 390/1280. CLS < 0.1 on `/`, `/portal` and `/admin`. Then an enterprise-ux-designer review, a mobile-a11y review and a whole-branch review. Open a draft PR and subscribe to it.

**Checkpoint**: US0 merged. The 10-week clock for FR-004 starts at the merge date; record it in `docs/aura-adoption.md`.

---

## Phase 3: User Story 1 — Shell (Priority: P1) — PR 2

Goal: every page sits in the AURA frame of the canvas boards (`Admin-members`, `Admin-members-tablet`, `Admin-members-mobile`, `Admin-command`, the portal `Main` boards). Logic is unchanged (FR-011): the same nav entries per permission, the same badges, the same palette results.

- [x] T101 [US1] Page titles (`.text-h1`) use AURA's display face (Fraunces), as on every board; h2–h4 stay on the text face. RED: `aura-foundation-css.test.ts` › page titles.
- [x] T102 [US1] Preview harness `src/app/test-fixtures/aura-shell/page.tsx` (behind `ALLOW_TEST_ROUTES`, like `button-matrix`): the staff and member shells with fixture data, no session or DB, so they can be screenshot at 390/1280, light/dark, and compared with the boards. RED: none (a fixture page); verified by the screenshots in the PR.
- [x] T103 [US1] Staff navigation is AURA `SideNav` inside `AppShell`: the same permission-filtered entries and badges (a badge stays part of the link's name: "Change requests 3 pending"), the active entry carries `aria-current="page"`, Settings is one collapsible group that opens on a settings route (board proposal, implemented), the rail state persists in the `sidebar_state` cookie, and below 1024px the nav opens in AURA's drawer. RED: `tests/unit/components/layout/staff-nav.test.tsx`.
- [x] T104 [US1] Staff top bar: breadcrumb, a search button that opens the palette (⌘K still works), language, colour scheme and account menu, per `topbar()` on the boards. RED: `tests/unit/components/layout/staff-top-bar.test.tsx`. Below 640px the colour-scheme choice moves into the account menu (the mobile board has no room for the button).
- [x] T105 [US1] Member frame: header with brand, pill nav (desktop), language, colour scheme, account; AURA `BottomNav` below 1024px with the same five tabs; the E-Blast acknowledgement banner stays outside the skip target. RED: `tests/unit/app/portal-layout-shell.test.tsx` and `tests/unit/components/layout/member-bottom-tabs.test.tsx` (updated to AURA's bar and spacer); `member-nav.test.tsx` passes unchanged.
- [x] T106 [US1] Both ⌘K palettes use AURA `Command` (server-searched results, `filter={false}`, `loading`), with the same groups, results and destinations. `cmdk` stays installed for the pickers and `ui/combobox` until their modules migrate, and is removed with the last of them (at the latest US13). RED: `tests/unit/components/command-palette/*.test.tsx`.
- [x] T107 [US1] Confirmation and idle-warning dialogs use AURA `Dialog role="alertdialog"` with the same props and focus behaviour (Cancel first; a caller's required field first when named; the idle dialog starts on "Stay signed in"). RED: `confirmation-dialog.test.tsx` › focus, `idle-warning-dialog.test.tsx`. The reason + typed-phrase dialog (`reason-confirmation-dialog.tsx`, `typed-phrase-field.tsx`) is F119-reviewed E-Blast/F114 behaviour with many focus and live-region rules; it moves with its callers (US5 / US12), listed in `NOT_YET_ON_AURA`.
- [x] T108 [US1] EmptyState, the page skeletons, Breadcrumb and TablePagination render AURA components behind their current props and `data-slot`s; `.skeleton-shimmer` becomes AURA's pulse (FR-009). RED: `breadcrumb-nav.test.tsx`, `table-pagination.test.tsx`, `empty-state.test.tsx` (updated), `aura-foundation-css.test.ts` › pulse; `page-skeletons.test.tsx` passes unchanged (the skeletons keep their markup and take the pulse from CSS).
- [x] T109 [US1] `src/components/layout`, `src/components/shell`, `src/components/command-palette` and `src/components/auth/idle-warning-dialog.tsx` join `MIGRATED_PATHS` (with `NOT_YET_ON_AURA` for the reason dialog); e2e selectors that named old-kit internals (`data-slot="sidebar*"`, `breadcrumb*`) move to roles and names. RED: `ui-import-ratchet.test.ts`.
- [x] T110 [US1] Exit: gates, board screenshots in the PR, enterprise-ux-designer review, then the **e2e checkpoint** on the maintainer's machine: the 16 shell specs on chromium + WebKit, compared with main by test title (full suite moved to the US4 checkpoint — spec Clarifications, 2026-09-26). Build + bundle budgets re-baselined (renewals admin routes, dual-library window).

## Phase 4: User Story 2 — Auth pages (Priority: P2) — PR 3

Goal: the eight auth surfaces match the canvas boards (`Sign-in`, `Admin-sign-in`, `Auth-forgot`, `Auth-reset`, `Auth-invite`, `Auth-verify`, `Auth-revert`, `Auth-expired`, and their `-mobile` boards): a mesh brand panel beside the form from 1024px, the brand above the form on a phone, AURA fields and buttons. Logic is unchanged (FR-011): the same endpoints, validation rules, messages, redirects and rate-limit handling.

- [x] T201 [US2] Auth frame: one layout for every `(auth-public)` page. From 1024px a two-column grid: the brand panel (`aura-surface aura-mesh aura-grain`, mesh from the brand blue to `#ffe27a`, the tenant brand, "Thai-Swedish Chamber of Commerce" in the display face, and the portal label) beside a 400px form column; below 1024px the brand links above the form, no mesh. Language and colour-scheme controls stay top right. A server component using AURA classes only. RED: `tests/unit/components/auth/auth-frame.test.tsx`.
- [x] T202 [US2] Sign-in (staff and member): AURA `TextField` (email) and `PasswordField` (the show/hide state is announced), "Forgot your password?" beside the password label, AURA `Button` with `loading`; a server rejection shows in an AURA `Alert` that describes the email field (FR-016 stays generic); the security-update banner is an AURA `Alert`. RED: `tests/unit/auth/sign-in-form-errors.test.tsx` (updated); `sign-in-form-i18n.test.tsx` and the POST-method guard `auth-forms-post-method.test.tsx` pass unchanged. _Done: `sign-in-form-i18n.test.tsx` changed four assertions — each message now shows twice (field + summary), so they count two (and zero for the raw-Zod check). After the mobile-a11y review, "Forgot your password?" sits under the password field, not beside its label: beside the label it was a 20px target flush against the input and came after the field in tab order._
- [x] T203 [US2] Every auth form with more than one field shows AURA `FormErrorSummary` after a failed submit: it lists each error, links to its field and takes focus (`focusKey` = submit count); the per-field errors stay on the fields (AS1). RED: one summary test per form family (sign-in, reset/change password, invite). _Done: sign-in, reset, invite and change-password each have a summary test; server field errors (weak/breached, wrong current, same password) land in the summary too, which takes focus._
- [x] T204 [US2] Forgot password and reset password on AURA fields; the strength meter keeps its rules and announcements and takes AURA tokens; the expired-link state follows `Auth-expired`. RED: `tests/unit/auth/forgot-password-form-ux.test.tsx` (updated), new `tests/unit/components/auth/reset-password-form.test.tsx`; `password-strength-component.test.tsx` passes unchanged. _Done: `password-strength-component.test.tsx` swapped its legacy colour class for the AURA token and gained a filled/empty segment count per level; the rules and announcements are unchanged. The expired state is `AuthLinkInvalid` with the existing copy._
- [x] T205 [US2] Invitation acceptance (name, password, confirm, consent checkbox) on AURA fields and `Checkbox`; the expired-invitation state follows `Auth-expired`. RED: new `tests/unit/components/auth/invite-redeem-form.test.tsx`. _Done: the form never had a consent checkbox and `Auth-invite` draws none, so none was added (a new field would be a logic change)._
- [x] T206 [US2] Email verification and email-change revert (their success and error states) on AURA `Button`, `Alert` and card markup. RED: new `tests/unit/components/auth/email-verification-form.test.tsx`, `email-change-revert-form.test.tsx` (updated). _Done: RED `email-verification-form.test.tsx` (new) and `email-change-revert-form.test.tsx` (updated)._
- [x] T207 [US2] Change password (staff and member account pages) on AURA fields; the account pages around it stay for US3 / US10. RED: `tests/unit/auth/change-password-form-*.test.tsx` (updated). _Done: RED `change-password-form-aura.test.tsx`; `change-password-form-i18n.test.tsx` counts the message twice (field + summary). The route skeleton follows the AURA field heights._
- [x] T208 [US2] `src/components/auth/*-form.tsx`, `password-strength.tsx`, `security-update-banner.tsx` and `src/app/(auth-public)/**` join `MIGRATED_PATHS`; auth e2e selectors that named old-kit internals move to roles and names. RED: `ui-import-ratchet.test.ts`. _Done: no auth e2e selector named old-kit internals (`#signin-error`, `input#email` / `#password` and role + text filters still match; the AURA show/hide toggle is `type="button"`), so no e2e file changed. The user-admin screens in `src/components/auth` stay off the list until US10._
- [x] T209 [US2] Exit: gates, build + bundle budgets, board screenshots (390 / 1280, light / dark, EN / TH / SV), enterprise-ux-designer and mobile-a11y-ux-reviewer passes, whole-branch review. No e2e checkpoint for this phase (next: after US4). _Done: full unit + contract suite (1551 files / 17598 tests), lint, typecheck, static gates, production build and bundle budgets (all within ceilings, none changed). Board comparison in the PR. enterprise-ux-designer, mobile-a11y-ux-reviewer and whole-branch-reviewer passes; their findings are fixed, and one AURA gap became handoff #65 (FormErrorSummary refocus while typing); AURA shipped it in 5.7.3 and the local `useSubmittedErrors` bridge is gone._

## Phase 5: User Story 3 — Member home, profile and account (Priority: P2) — PR 4

Goal: the member dashboard, benefits, company profile, directory listing, profile edit and change requests, account hub, colleague invite and activity timeline match their canvas boards (`Main`, `Home-mobile`, `Benefits`, `Portal-profile`, `Portal-profile-states`, `Portal-edit`, `Portal-change-requests`, `Portal-account`, `Portal-contacts-invite`, `Portal-directory`, `Portal-timeline`, and their `-mobile` boards) in AURA cards, stats, status pills, tabs and sticky action bars. Logic is unchanged (FR-011). Components these pages share with staff screens (benefit usage card, data export panel, copy button, change-request status badge and diff table, timeline) move here, so the staff member-detail tabs render them in AURA from this PR on. The E-Blast panel on the benefits page stays for US12.

- [x] T301 [US3] Dashboard: the stat tiles are AURA `Stat` cards (keeping `data-testid="stat-card"` and `data-variant`, which the suspension e2e reads), the renewal banner an AURA `Alert` with its pay action, recent invoices and recent activity AURA cards with hairline rows, the marketing acknowledgement banner AURA, and the loading state AURA skeletons of the same shape. RED: `tests/unit/components/portal/dashboard/stat-card.test.tsx` and `dashboard-stat-sections.test.tsx` (updated).
- [x] T302 [US3] Benefits: AURA `Tabs` for Benefits / Broadcasts (still `aria-selected`, still `?tab=`), the benefit usage card on AURA `Card`, `Progress` and `Badge` (shared with the staff benefits tab), its skeleton. RED: `benefits-tabs.test.tsx`, `benefit-usage-card.test.tsx` (updated).
- [x] T303 [US3] Company profile and directory listing: AURA cards per section, `StatusPill` for the membership state, `Badge` for contact tags, AURA `Switch` for the marketing toggle, the pending-request and decision banners as AURA `Alert`s with their actions, an icon copy button; the directory form on AURA fields with an `ActionBar`. RED: `portal-profile-body.test.tsx`, `portal-marketing-toggle.test.tsx`, `pending-request-banner-withdraw.test.tsx`, `directory-visibility-form-contact.test.tsx` (updated).
- [x] T304 [US3] Profile edit and change-request forms on AURA `TextField` / `Textarea`, `FormErrorSummary` after a failed submit, and an AURA `ActionBar` holding the submit that reads "Unsaved changes" while the form is dirty, so the save stays reachable while scrolling on a phone (AS1). RED: `portal-edit-server-error.test.tsx`, `portal-change-request-form*.test.tsx` (updated) plus one ActionBar test.
- [x] T305 [US3] Change-request history: AURA `StatusPill` for each decision, the diff on AURA `Table` markup, AURA empty state; the staff change-request screens take the same pill and table. RED: `change-request-status-badge.test.tsx`, `change-request-diff-erased.test.tsx` (updated).
- [x] T306 [US3] Account hub: AURA cards per section, the language forms on AURA `RadioGroup` with an `ActionBar`, the renewal-reminders switch (embedded from US7's folder) on AURA `Switch`, the data export panel on AURA `Table` / `Badge` / `Button` (shared with the staff member page). RED: `account-hub.test.tsx`, `contact-language-form.test.tsx` (updated).
- [x] T307 [US3] Invite a colleague on AURA fields and `Select`, `FormErrorSummary` and an `ActionBar`. RED: `invite-colleague-form.test.tsx` (updated).
- [x] T308 [US3] Activity timeline: filters on AURA `FilterBar` / `Select` / `TextField`, the stream and its load-more on AURA `Button`, AURA skeleton; shared with the staff member timeline. RED: `timeline-preview-section.test.tsx` plus a timeline-filters test.
- [x] T309 [US3] Portal not-found page on AURA `Button`; every US3 path joins `MIGRATED_PATHS`; e2e selectors that named old-kit internals move to roles and names. RED: `ui-import-ratchet.test.ts`. _Done: 31 globs join `MIGRATED_PATHS` (32 with T310's preview route); the benefits page's E-Blast tab (`broadcasts-panel`, `broadcast-history-card-list`) goes on `NOT_YET_ON_AURA` for US12. `RelativeTime` is a utility, not a kit component, so it moved from `src/components/ui` to `src/components/shell` (importers and test mocks follow). No US3 e2e selector named old-kit internals (test ids, `combobox` / `option`, `switch`, `tab` roles and field labels still match), so no e2e file changed. `docs/aura-adoption.md` and `CLAUDE.md` list handoff #66–#69 as open._
- [x] T310 [US3] Exit: gates, build + bundle budgets, board screenshots (390 / 1280, light / dark, EN / TH / SV) through a no-DB preview route, enterprise-ux-designer and mobile-a11y-ux-reviewer passes, whole-branch review. No e2e checkpoint for this phase (next: after US4). _Done: the Neon dev database is unreachable from the cloud container (TCP 5432 blocked), so the screens were shot through `src/app/test-fixtures/aura-portal` (guarded by `ALLOW_TEST_ROUTES`), which renders the real US3 components on fixture data. Reviews: enterprise-ux "ship with follow-ups", mobile-a11y 3 MEDIUM / 6 LOW, whole-branch "MERGEABLE" with 1 MEDIUM. Fixed: a re-save after a refused directory save left focus on `<body>` (the stale error summary re-focused, then unmounted); the stat-card next step is AURA's primary button; the timeline selects have visible labels; the data-export table loses its second border and its download is the icon alone below `sm`; Request export is secondary; the account page's two language ActionBars are named after their forms; the diff table's inline labels are `sm:hidden` (not read twice beside the column headers); the directory switch card drops its duplicate title; `scroll-padding` keeps a focused field clear of the shell bar and a viewport ActionBar. Kept as is: expired exports stay danger and partially approved stays warning (parity with the old kit); the directory counter's `aria-live` is pre-existing (FR-011). AURA 5.8.0 then shipped handoff #66–#69, so the pin moved to 5.8.0 in this PR: server pages import `Card`, `Badge`, `StatusPill`, `Alert` and `buttonClass` from `@jirawatpyk/aura-react/server`, the diff table uses `Table stackBelow="sm"`, `aura-markup.tsx` and its comparison test are deleted, and `tests/unit/architecture/aura-server-imports.test.ts` keeps server files off the root barrel. After the maintainer compared the screens with the boards, the timeline got the board's layout (Today / This month / month groups, a caption, rows of title · detail over actor · time with an outline source badge, and Source plus "More filters" on phones; four new strings in EN/TH/SV) and the data-export list got StatusPills with icons (expired is neutral, as the board draws it), a borderless list, and the date under the pill on phones. The board's per-row references (document number, event name, payment channel, a person's name on non-audit rows) are not in `member_timeline_v`, so they wait for a data change outside this UI PR._
- [x] T311 [US3] Board parity pass (Clarifications, Session 2026-09-27): every US1 / US2 / US3 screen compared with its board at 390 and 1440 through the preview routes, and fixed. _Done: shared tokens (h1 26/32px, hero 30/36px, title line-height 1.2, the 1200px portal column, page padding on the boards' steps); portal forms end with plain buttons in the card (full width, primary on top below 640px) and the propose-changes form warns before the page is left with unsaved input; profile, change-request history and account render through `renderPortalProfileView` / `renderChangeRequestHistoryView` / `renderPortalAccountView`, so the preview route shows the pages' own markup; invite, directory and timeline follow their boards (back link, 720px invite column, the directory's Listing card with the preview beside it and a Country combobox that still stores ISO-2, AURA DatePickers in the timeline filters); board copy in EN/TH/SV, reviewed by i18n-translation-reviewer. Kept as coded, because the board contradicts the product: the data export does not include colleagues' contact details (notice wording and tone, #432); the directory can hide the organisation name; the contact email toggle names the address; the three directory contact hints; "We reply within 30 days" (no such commitment exists); "Password resets" in the personal-language hint (a reset email follows the page it is requested from); the invite page's list of what a colleague can do (narrowed to what holds in every mode). Waiting on data the UI does not have (class D follow-ups): per-row timeline references (document number, event name, E-Blast subject, payment channel, change-request field names, bill vs invoice), the withdrawn date on the history card, the home renewal alert and reserved E-Blasts, benefit detail lines, the "View events" target, the tenant privacy-notice URL on every surface, and the header's first-name display. Activity raw audit labels are pre-existing on main (FR-014) and tracked separately._

## Phase 6: User Story 4 — Member invoices and payment (Priority: P2) — PR 5

Goal: the member invoice list, invoice detail, credit note and the card / PromptPay pay sheet match their boards (`Invoices`, `Invoice-paid`, `Portal-invoice-mobile` EN/TH/SV, `Portal-credit-note`, `Pay-card`, `Pay-promptpay`, `Pay-qr-expired`, `Pay-3ds`, `Pay-processing`, `Pay-success`, `Pay-failed`, `Pay-failed-permanent`, and their `-mobile` boards) in AURA. Every amount, VAT line, document number, status and document wording is unchanged (AS-1, FR-010f); Stripe Elements is untouched (Principle IV). Decisions: spec Clarifications, Session 2026-09-27 (US4 start). The full local e2e suite runs at the end of this phase (checkpoint).

- [x] T401 [US4] Invoice status on AURA `StatusPill` (Paid ready · Issued progress · Overdue blocked · Void and Partially credited neutral), same labels. RED: the status-badge test.
- [x] T402 [US4] Invoice list: the membership-invoice alert on top (US3's section, same access gating), an AURA semantic `Table` with the board's columns (mono number, receipt, status pill, dates, total right-aligned, download actions) from 1024 px, and the AURA phone cards below it (the seven columns scroll sideways under 1024 px, so there is no per-column hiding); server pagination and URL params unchanged; the shared `InvoiceFilters` (also `/admin/invoices`) on AURA's FilterBar / Select / Popover with the same URL contract; AURA skeleton. RED: `portal-invoice-card-list`, `invoice-filters-props`, a list-page test.
- [x] T403 [US4] Invoice detail: back link, "Invoice" + mono number (bill first) + pill + subtitle, secondary download / resend buttons, every notice an AURA `Alert` (test ids kept), one Details card (facts grid, lines table — a list below 640 px — and the unchanged totals), a sticky amount-due / Pay now bar on phones, the online-payment-disabled card, related credit notes, not-found and loading on AURA. RED: `portal-invoice-detail-download-number` (updated) plus a detail-layout test.
- [x] T404 [US4] Credit note page as its board: back link, mono number + status badge + subtitle, Download PDF, a Details card (issue date, original receipt + bill link, the credit / VAT / total list) and a Reason card; the shared original-receipt badge (staff credit notes too) on AURA. The board's "Receipt … is reduced by …" alert and contact line were added in the board-parity pass (spec Clarifications, 2026-09-28). RED: `credit-note-original-receipt` (updated) plus a page test.
- [x] T405 [US4] Pay sheet shell on an AURA `Drawer` (right, 480 px, full screen below 640 px): "Pay invoice" + mono number, `IconButton` close; `pay-sheet-content` / `pay-sheet-close`, `?pay=1`, lazy body, hard-cap prompt, cancel-on-close and focus return kept; Pay now on AURA. RED: `pay-sheet.test.tsx`, `pay-sheet-cancel-on-close.test.tsx`, `pay-now-button` (updated).
- [x] T406 [US4] Pay sheet panels: amount-due band, method `Tabs` (`role="tab"`, same ids), card region and skeleton, card submit, PromptPay QR panel, processing / 3DS status, success, failure `Alert` + retry, security footer; the polite announcer kept. RED: the panel tests under `tests/unit/components/payments/` (updated).
- [x] T407 [US4] e2e selectors that named old-kit internals (`pay-sheet-viewport.spec.ts`: `[data-slot="sheet-header"]`, `.overflow-y-auto`) move to AURA's drawer parts (`.aura-drawer__head`, `.aura-drawer__body`); the full-height assertion stays.
- [x] T408 [US4] Every US4 path joins `MIGRATED_PATHS`; preview views for the list, detail (issued / paid / void), credit note and pay states on `src/app/test-fixtures/aura-portal`. RED: `ui-import-ratchet.test.ts`.
- [x] T409 [US4] Strings only where a swap or a board forces them (board wording per spec Clarifications, 2026-09-28), in EN/TH/SV; document and money wording untouched; i18n-translation-reviewer on any change.
- [x] T410 [US4] (queued task, rides this PR as its own commit) `/admin/members` header actions wrap on phones: Swedish scrolled 10 px sideways at 360 / 390 px. RED: `members-page-header-actions.test.tsx`; e2e in `members-table-overflow.spec.ts`.
- [x] T412 [US4] AURA 5.9.0 ships handoff #70–#71: the pin moves to 5.9.0 in this PR. The pay sheet uses `Drawer` `data-testid` / `closeLabel` / `closeProps` (`markDrawer` deleted) and `Tabs` `keepMounted` / `activation="manual"` / `tabProps` (`MethodTablist` deleted; the boards' segmented look is `.pay-method-tabs` in `globals.css`). 5.9's 6.0 dev notices are cleared without changing output: TH / SV locale packs in `AuraBridge`, and `registerIcons(allIcons)` once per registry (`AuraBridge`, `@/lib/aura-server-icons`, `tests/setup.ts`). RED: the existing pay-sheet and method-tabs tests stay green on the native components. Then 5.10.0 ships Addendum 10 (#72–#74), found in this adoption: the tabs use `variant="segmented" fullWidth` (`.pay-method-tabs` deleted), and the card menu's "Email me a copy" is disabled with the reason "Just sent" during the cooldown (RED: `portal-invoice-card-menu`). #74 needed no change: the pill measures 4.6:1 in light mode on the pay sheet.
- [x] T413 [US4] (maintainer, after the board comparison) The shared invoice filters: below 1024 px the search takes its own row and the filters share the next one evenly. The phone invoice card: one labelled download (invoice unpaid, receipt paid) plus a "⋯" menu with the other document and "Email me a copy" (spec Clarifications, 2026-09-28). RED: `invoice-filters-props` (row layout), `portal-invoice-card-list` (option C), `portal-invoice-card-menu`.
- [x] T411 [US4] Exit: gates, build + bundle budgets, board screenshots (390 / 1440, light / dark, EN / TH / SV) through the preview route, financial-integrity, enterprise-ux, mobile-a11y, PCI SAQ-A and whole-branch reviews, then the **full e2e checkpoint** on the maintainer's machine, compared with main by test title. Done 2026-09-28: R12 (chromium) found two drawer tests measuring mid-animation, fixed; R13 found the Total overflowing at 200% text, fixed with a rem container query; R14 (`b65b1ce79` vs `9293bddcb`, chromium / mobile-chrome / mobile-safari, plus the five real-Stripe `payment-a11y` tests) has no branch-only failure (the one mobile-safari row is a WebKit "Load failed" flake at the same 1/3 rate on both refs).

## Phase 7a: User Story 5 — Members list, directory and change requests (Priority: P2) — PR 6 (US5a)

Goal: the members list, the member directory and the change-request queue and review match their boards (`Admin-members`, `-tablet`, `-mobile`, `Admin-state-members-{empty,filtered,error,manager}`, `Admin-directory*`, `Admin-change-requests*`, `Admin-change-request*`) with the same URLs, data and actions (spec US5 AS-1; Clarifications, Session 2026-09-28 US5 start). Member detail, timeline, benefits, the forms and the member dialogs are US5b.

- [x] T501 [US5] Spec Clarifications for US5 (two PRs, detail strip + section links, row menu, kept features) and these tasks.
- [x] T502 [US5] Members table on AURA `DataTable` (`manual`, no built-in pager): the board's columns (Member No. and Engagement sortable with the same `sort` / `order` URL, Company as the row link, contact / plan / last activity hidden below `lg`), the inline status edit kept, phone cards below 640 px, admin-only selection with archived rows not selectable, Shift-click range and Ctrl / ⌘+A kept, and a "⋯" menu with "Open member" and (with members.write) "Edit member". RED: the `members-table-*` tests on grid roles, and a row-menu test.
- [x] T503 [US5] Members filters on AURA `FilterBar`: search (same debounce), Status, Plan and risk-band selects, the needs-invite chip, active-filter chips with "Clear filters", the result count; the URL contract unchanged. The empty, no-match and could-not-load states use AURA `EmptyState`. RED: `directory-filters-search-focus`, `filter-chips`, `needs-invite-chip`.
- [x] T504 [US5] Bulk bar on AURA `ActionBar` right after the table (count, Clear, "Select all N matching", the same five actions, cap and toasts); the archive confirmation on AURA `Dialog` (`alertdialog`, typed phrase above 5 members); progress on AURA `Progress`. RED: the `bulk-action-bar-*` tests.
- [x] T505 [US5] Members page shell: header buttons, the manager read-only notice as an AURA `Alert`, AURA skeleton loading, the body in `renderMembersListView` for the preview route; the T410 wrap fix kept.
- [x] T506 [US5] Directory on AURA: `DataTable` with `TablePagination`, `FilterBar` with "Listed only", export buttons, recent exports with `StatusPill`; the `q` / `listed` / `page` URL and the page clamp unchanged. RED: the directory component tests.
- [x] T507 [US5] Change-request queue on AURA: a static AURA `Table` (no sort or selection; cards below 640 px) with the keyset "Next page" link, the GET filter form on AURA `Select` / `DatePicker` (`Asia/Bangkok`); test ids kept. RED: `change-request-queue-filters` without the old-kit select mock.
- [x] T508 [US5] Change-request review on AURA: `StatusPill` state, `Alert` notice, summary `Card`, AURA `Checkbox` per field, the confirm dialog's reason and note on AURA `Textarea`; test ids kept. RED: the `change-request-review-client-*` tests.
- [x] T509 [US5] Every US5a path joins `MIGRATED_PATHS` (RED: `ui-import-ratchet.test.ts`); the e2e locators that named the old table, checkbox or toolbar move to roles; preview views on a new `src/app/test-fixtures/aura-admin` route.
- [x] T510 [US5] Exit: strings only where a swap or a board forces them (EN / TH / SV, i18n review), gates, build + bundle budgets, board screenshots (390 / 820 / 1440, light / dark, EN / TH / SV), enterprise-ux, mobile-a11y, PDPA and whole-branch reviews. Not an e2e checkpoint phase; the touched members / directory / change-request specs run once on the maintainer's machine because their locators change.
- [x] T511 [US5] Parity cleanup of US1–US4 (follow-up to US5a, the board-parity rule): every reach into AURA's internal classes is an AURA prop, kept as app content (`AURA app content:`) or a labelled stand-in (`stand-in until AURA #NN`, handoff #86–#100, Addendum 15); board-pixel sizes on AURA components go back to AURA's defaults (maintainer, 29 Sep); raw px text moves to AURA's type-scale classes. RED: `aura-internal-class-ratchet.test.ts` (every `MIGRATED_PATHS` glob + `globals.css`, open items only, CRLF-safe, positive controls) and `aura-parity-cleanup.test.tsx`.
- [x] T512 [US5] Adopt AURA 5.14–5.16 (handoff #85–#100 shipped): each `stand-in until AURA #NN` from T511 becomes AURA's own prop — EmptyState `headingLevel={false}`, Card `header` / `flushBelow`, Tabs `fullWidth="below-lg"`, FilterBar `controlsLayout` / `stackBelow`, Breadcrumb `itemProps`, SideNav `collapseToggle="row"` / action rows / `chevron`, AppShell `contentPadding={false}`, Table `stackStyle="cards"`, DataTable `rangeSelect`, Checkbox `hitArea`, `touchHeight`. Two gaps found went to AURA (Addendum 18) and shipped in 5.17.0 (with #109's Select fix from 5.16.1), so the pin is 5.17.0 and no stand-in is left: `StatCard` / `StatSkeleton` are AURA's `Stat` (`status`, `linkArea="label"`, `loading`), the reserved E-Blasts bar is `Progress` with `valueText`. RED: the ratchet with #85–#100, then #110–#111, closed in `docs/aura-adoption.md`.

## Phase 7b: User Story 5 — Member detail, timeline, benefits and their dialogs (Priority: P2) — PR 7 (US5b-1)

Goal: the member detail page, its timeline and benefits pages, and every dialog or banner opened from the detail page match their boards (`Admin-member-detail`, `-timeline`, `-benefits`, each with `-mobile`) with the same data and actions (Clarifications, Sessions 2026-09-28 US5 start and 2026-09-29 US5b start). The forms and their dialogs are US5b-2 (T570).

- [x] T551 [US5] Spec Clarifications for US5b (two PRs, Outstanding from the existing read, the combobox plan, kept features, the invoice row menu) and these tasks.
- [x] T552 [US5] The figures strip: Outstanding (issued invoices only, up to 100, hidden without invoice read), membership expiry, primary contact, engagement (F9 only), in its own Suspense; the renewal and engagement reads shared with the renewal card through one cached loader. RED: a strip test per cell and gate, and the loader summing issued invoices only.
- [x] T553 [US5] The detail page shell: the board's header (status pill, member number, auto-invoice badge, actions; Erase and Archive stay visible buttons on phones per ux-standards § 19, Edit first), the sticky "On this page" section links (only the sections present), the two-column overview, one not-found view for the page and its sub-pages, AURA loading and error; the body in `renderMemberDetailView`. RED: section order, header actions per role and state, and the section links.
- [x] T554 [US5] Contacts on AURA: the board's contact rows (primary and portal badges, details grid, Edit plus a "⋯" menu, "Make primary"), the contact form in an AURA `Dialog` (ids kept), the promote and remove confirmations on `ConfirmationDialog`, and the marketing badge and switch (shared with the marketing audience). RED: the contact-block tests on roles, the marketing badge without old-kit classes, and a contact-actions menu test.
- [x] T555 [US5] The archive, erase, restore-primary and renew-lapsed dialogs and the erased, archived and no-primary-contact banners on AURA, behaviour unchanged (the no-primary banner is shared with the admin invoice and credit-note pages). RED: new archive and erase tests, the restore-primary and renew tests on AURA.
- [x] T556 [US5] The member invoices on AURA `DataTable` (the board's columns, stacked on phones) with the status pill, row actions in a "⋯" menu (disabled with the reason for a manager), the filters as a labelled AURA form (search, status, year) with the same URL, and AURA empty states. RED: the actions menu per role, the filters' URL and the Remaining column unchanged.
- [x] T557 [US5] The renewal and health, benefits, change-request, data-export and timeline-preview sections and the page skeleton on AURA.
- [x] T558 [US5] The timeline and benefits pages as their boards (title, back to the member, one section with its heading), with `renderMemberTimelineView` / `renderMemberBenefitsView`. RED: the benefits-page tests on roles and a header test per page.
- [x] T559 [US5] Every US5b-1 path joins `MIGRATED_PATHS` (RED: `ui-import-ratchet.test.ts`, the US5a control moved to the forms); preview views for the member, timeline and benefits; the e2e locators that named the old dialogs, selects and buttons move to roles.
- [ ] T560 [US5] Exit: strings only where a board or a swap forces them (EN / TH / SV, i18n review), gates, build + bundle budgets, board screenshots (390 / 1440, light / dark, EN / TH / SV) and a parity page, enterprise-ux, mobile-a11y, financial-integrity (Outstanding, invoice rows), PDPA and whole-branch reviews, AURA handoff items; the touched member specs run once on the maintainer's machine.
- [x] T561 [US5] AURA 5.14–5.16 ship Addenda 14–16 (#85–#108): the pin moves to 5.16.0 in this PR and the member page drops its own stand-ins (#101–#108). The restore-primary dialog uses `finalFocus` / `onCloseComplete`, the contact form opens from Dialog `trigger`, the erase gate and expired Restore are AURA `Button`s with `aria-disabled`, the contact avatar comes from `/server`, the section links stick at `--aura-shell-bar-height` with `current="location"`, and the invoice cards drop `StartOnCard` and take `--aura-fg-warning`. RED: the invoice-table and section-links tests; the rest are refactors under their existing tests. The #85–#100 stand-ins are left for a follow-up PR (the 5.15 items are opt-in). #109 (every Select painted with the read-only background; its placeholder still passes AA at 4.63:1) is fixed in AURA 5.16.1, which #472 adopts. The members-erase @a11y red was a mid-fade sample, not #109.

## Phase 7c: User Story 5 — Member new / edit forms and their dialogs (Priority: P2) — PR 8 (US5b-2, T570)

Goal: the admin new and edit member forms, the plan-change, bundle-warning, override-reason and soft-duplicate dialogs, and the notification-language card match their boards (`Admin-member-new`, `-edit`, each with `-mobile`, and `Admin-member-plan-change`) with the same fields, validation, submit and API calls (Clarifications, Session 2026-09-30 US5b-2 start).

- [x] T571 [US5] Spec Clarifications for US5b-2 (the combobox amendment, plan options, date fields, the phone action bar, the frame) and these tasks.
- [x] T572 [US5] The new and edit page frames: one 672px column, the required-fields note, Cancel at the top right (a back link on phones), one card per fieldset, AURA loading and error. RED: a page-header test per page (note, Cancel, back link).
- [x] T573 [US5] The form core: AURA `FormErrorSummary` for more than one error (same field ids, focus on submit), the footer as a right-aligned row from 640px and an `ActionBar` on phones, the unsaved-changes guard and server field errors unchanged. RED: the error-summary test on AURA and a footer test.
- [x] T574 [US5] The company and tax-branch sections on AURA fields, with the country on AURA `Combobox` keeping its "Suggested" group (TH, SE). RED: the country-combobox test on groups and a typed search.
- [x] T575 [US5] The membership section: plan, plan year and billing cycle on AURA `Select` (the plan name as the label, the selected plan's fee as the field hint); the registration date on AURA `DatePicker`, read-only text on edit. RED: the plan-fee test and a registration-date test.
- [x] T576 [US5] The address section: province, district and sub-district on AURA `Combobox` with typed values, the Thai name as the second line, the postcode lookup and cascade unchanged; the incomplete-address warning as an AURA alert with its link. RED: the address-section tests on the AURA listbox (lookup fill, typed value kept, cascade clear).
- [x] T577 [US5] The contact fields and secondary contact on AURA fields (ids kept, date of birth on `DatePicker`); on edit, the note that other contacts are managed on the member record. RED: the contact-fields tests.
- [x] T578 [US5] The plan-change confirmation as its board (current and new tiles with the fee, what changes, Cancel first), and the bundle-warning, override-reason and soft-duplicate dialogs on AURA `Dialog`, content and behaviour unchanged. RED: the four dialog tests on AURA.
- [x] T579 [US5] The notification-language card on AURA (`RadioGroup`, "Save preference", saved on its own), the same request. RED: the card test.
- [x] T580 [US5] Every US5b-2 path joins `MIGRATED_PATHS` and the address entries leave `NOT_YET_ON_AURA` (RED: `ui-import-ratchet.test.ts`, its control moved to a path still on the old kit); preview views; the e2e form helpers move to roles; exit gates, build + bundle budgets, board screenshots and a parity page, enterprise-ux, i18n and financial-integrity (plan fee) reviews.

## Phase 8: User Story 6 — Plans (Priority: P3) — PR 9 (US6, T600)

Goal: the plans list, detail, new-plan wizard, edit (current and prior year) and clone pages match their boards (`Admin-plans`, `Admin-state-plans-empty`, `Admin-plan-detail`, `Admin-plan-new`, `Admin-plan-edit`, `Admin-plan-edit-locked`, `Admin-plans-clone`, each with `-mobile`) with the same validation, lock rule, requests and stored plan (Clarifications, Session 2026-09-30 US6 start).

- [x] T601 [US6] Spec Clarifications for US6 (wizard errors, the THB suffix, the locked fields, selects not segmented controls), these tasks, and AURA handoff item 112 (Stepper per-step error status).
- [x] T602 [US6] The plans list: AURA `Table` with the board's columns (not `DataTable`: its rows cannot carry the `data-plan-id` / `data-plan-year` hooks the e2e and the actions menu read) (category `Badge`, fee right-aligned, status `StatusPill`, a "Actions for {name}" menu with the same items), the filter row on AURA fields (same ids and URL sync), cards on phones without the year, the empty state inside the table, the caption with the VAT note. RED: `plans-table-affordances` on AURA.
- [x] T603 [US6] The plan detail: badges beside the title, Edit and a "More actions" menu, the "Annual fee" and "Benefit matrix" cards side by side (stacked on phones, with a back link). RED: `plan-detail-page` and `plan-detail-actions` on AURA.
- [x] T604 [US6] The shared form pieces: the name and description with EN / TH / SV AURA `Tabs` (a missing translation marked), the money field with a "THB" suffix and the same whole-baht parse, the benefit matrix on AURA `Select` / `Switch` / `TextField`, and one locked-field helper. RED: a test per piece.
- [x] T605 [US6] The new-plan wizard: AURA `Stepper`, one card per step, `FormErrorSummary` and field errors, Next held and Save sent back to the first failing step, Cancel / Back / Next (Back and Next pinned on phones); the same `planSchema` and request. RED: `plan-form-wizard` on AURA.
- [x] T606 [US6] The edit page: the "Plan name", "Annual fee" and "Benefit matrix" cards, Cancel / "Save changes" (pinned on phones), and a prior-year plan locked as decided (warning `Alert` with its action, locked fields read-only or disabled with the lock icon and screen-reader text); the same patch. RED: `prior-year-lock-banner`, `plan-edit-form-fee-hint`, `edit-plan-page-current-version` on AURA.
- [x] T607 [US6] The clone page: one card (the count sentence, source and target year, the "Activate cloned plans immediately" switch with its description, the plans-to-copy list), Cancel / "Clone {n} plans" (pinned 1:2 on phones), the confirmation on AURA `Dialog` `role="alertdialog"`; the same preview and request. RED: the `clone-year-client` tests on AURA.
- [x] T608 [US6] Page frames: layout containers kept, header actions as AURA buttons, phone back links, loading on AURA skeletons, errors on `RouteErrorPanel`. RED: `plans-loading-skeletons` on AURA.
- [x] T609 [US6] Every US6 path joins `MIGRATED_PATHS` (RED: a US6 block in `ui-import-ratchet.test.ts`); preview views `plans`, `plans-empty`, `plan`, `plan-new`, `plan-edit`, `plan-edit-locked`, `plans-clone` from the pages' own views; e2e selectors for the stepper, switches and dialogs.
- [x] T610 [US6] Exit gates, build and bundle budgets for the plans routes, board screenshots and a parity page, enterprise-ux, i18n and financial-integrity (fee and VAT display, whole-baht parse) reviews, the PR, and the relay request for the plans e2e.

## Phase 9: User Story 7 — Renewals (Priority: P2) — PRs 10–12 (US7a, US7b, US7c; T700)

Goal: the renewals screens match their boards with the same requests, figures and URL contract. US7 ships as three PRs (Clarifications, Session 2026-09-30 US7 start).

### US7a — the pipeline page (PR 10)

Boards: `Admin-renewals` (+`-mobile`), `Admin-renewals-needs-action`, `Admin-renewal-mark-paid` (+`-mobile`), `Admin-state-renewals-empty`, `Admin-state-renewals-error`.

- [x] T701 [US7] Spec Clarifications for US7: the three PRs, portal renewal in scope, a money phase, one stacking table, and the board facts. Also these tasks.
- [x] T702 [US7] The pipeline table is one AURA table:
  - the board's columns, with "Send reminder" and the ⋯ menu per row;
  - row selection for admins;
  - cards below 640px from the same rows, with no second list;
  - the same sort links, filters and paging.
  - RED: `pipeline-table`, `pipeline-table-selection` and `pipeline-sortable-headers` on AURA, with no `pipeline-card-list`.
  - Done: AURA `DataTable` (`manual`, `stackBelow={640}`). A sortable header navigates to the page's precomputed sort href, as the members list does (US5a). The phone card keeps its checkbox in place of the board's "Select" button. Its row actions take a full-width row at the end of the card through a `globals.css` stand-in until AURA #118.
- [x] T703 [US7] Filters and tabs on AURA: the section tabs with counts, the All / Needs action toggle, the tier filter and the stage chips, with the same links and query parameters.
  - RED: `renewals-section-tabs(-with-counts)`, `urgency-bucket-tabs` and `work-queue-tabs` on AURA.
  - Done:
    - Section tabs and stage chips are AURA link tabs. With a month lens active no chip is current, which a tablist cannot express. The chips keep the scroll position.
    - On phones the board's "Section" and "Urgency" selects stand in for the tabs.
    - The toggle is AURA segmented `Tabs` with the needs-action count; the page now resolves that count beside the pipeline load.
    - The pipeline help moved to the end of the toggle row.
    - The tier filter is an AURA `Select` labelled "Tier".
    - The e2e selectors for the urgency chips change in T710.
- [x] T704 [US7] The money band as four AURA `Stat` tiles, with the basis hint on AURA and the figures unchanged. The shared dashboard `kpi-card` stays for US11.
  - RED: `pipeline-money-band` on AURA.
  - Done:
    - Four AURA `Stat` tiles from the server entry. The figures take the text colour, with no success / warning tone, as the board draws them. Each value is one string ("500.00 THB", the localised unit).
    - The linked tiles link through their label and carry AURA's arrow icon. The prior-years line is its own link, in the danger tone.
    - The basis hint is an AURA `Popover`. It is kept although the board omits it.
    - The skeleton is four loading `Stat` tiles.
- [x] T705 [US7] "Renewals by month" in an AURA `Card`: the bar chart on AURA chart tokens, bars that filter, and the month chip.
  - RED: `month-bar-chart` and `month-filter-chip`.
  - Done:
    - AURA server `Card` titled with the open count; it is the chip's focus target. The failure is an AURA danger `Alert` and the empty state is an AURA `EmptyState`.
    - The Overdue bar takes AURA's danger colour and every month bar `--aura-chart-1`, as the board draws them. The four-band palette and its helper are gone.
    - The month chip is an AURA `Tag` with its remove button.
    - Extra test: `renewals-by-month-section`.
- [x] T706 [US7] The at-risk section: counters, a table (risk badge, main signal, last computed, Contact / Snooze) and the snooze and outreach dialogs on AURA, with the same requests.
  - RED: `at-risk-widget-snooze-gate` and `snooze-dialog-error-map` on AURA.
  - Done:
    - The section sits inside the work queue without a card of its own. Band filters are AURA tabs with counts; rows are an AURA table that stacks into cards on a phone; the company links to the member.
    - Contact and Snooze are AURA buttons. The snooze and outreach dialogs are AURA alertdialogs (radio fieldset; selects, textarea with its counter as hint or error). Payloads are unchanged.
    - The board's "Main signal" column is not shown, because the at-risk API returns no such field.
    - Extra test: `outreach-dialog`.
- [x] T707 [US7] Pending review, the lapsed tab and the members-without-cycle tray on AURA cards, tables and dialogs, with the same reactivate request.
  - RED: `pending-review-list` on AURA.
  - Done:
    - Pending review: an AURA table that stacks on a phone, with the settling and aged chips as AURA badges and Approve / Review as AURA buttons. The approve confirmation is the shell `ConfirmationDialog` (AURA), with the same `/reactivate` request, 409 path and focus return.
    - Lapsed tab: an AURA info alert, an AURA table, reasons as AURA badges toned by meaning, and an AURA row menu.
    - Tray: an AURA server card with a borderless AURA table; the failure is an AURA danger alert.
    - Extra tests: `lapsed-tab`, `members-without-cycle-tray`.
- [x] T708 [US7] The bulk bar on AURA `ActionBar` with the selection count, and the single and bulk mark-paid dialogs on AURA `Dialog`. The single dialog follows the board's amounts and warnings; the bulk one keeps its settlement preview. Money is unchanged.
  - RED: `mark-paid-offline-dialog`, `bulk-mark-paid-confirm-dialog`, `pipeline-bulk-action-bar` and `pipeline-row-mark-paid` on AURA.
  - Done:
    - Bulk bar: AURA `ActionBar` in the page flow, with the selection count, Send reminder, Mark paid, Clear selection and the over-cap status; idle at zero. The fixed bar, its spacer and the `ResizeObserver` padding are gone. The run results panel sits above it.
    - Single mark-paid: an AURA `Dialog` with method select, reference field, payment date on AURA `DatePicker` (Asia/Bangkok) and the board's can't-undo warning as an AURA warning alert (new copy `taxDocWarningTitle` / `taxDocWarningBody` in EN, TH, SV). Cancel takes the first focus; focus return is unchanged. Same request body.
    - Bulk mark-paid: an AURA alertdialog, not dismissible while submitting, keeping the settlement preview; same fields and request.
    - Not shown, for review: the board's amount summary (the dialog has no server figure, and a client-side sum could disagree with the invoice) and its 3% WHT sentence (it conflicts with the §65 bis (13) WHT-exempt copy). Both go to the financial-integrity and thai-tax reviews at T711.
- [x] T709 [US7] Page frame and states:
  - the layout container and header kept;
  - the empty state as the board draws it;
  - the error state on `RouteErrorPanel`;
  - loading on AURA skeletons;
  - the shared renewals badges and pills (`urgency-pill`, `tier-badge`, `bill-issued-badge`, `cycle-cells`, `risk-score-badge`) on AURA `Badge` / `StatusPill`.
  - RED: the badge tests and `renewals-empty-state` on AURA.
  - Done:
    - Frame: `TableContainer` and `PageHeader` kept; the work-queue, pending-review and feature-off cards are AURA cards; "Next 50" is an AURA secondary button.
    - Empty (`Admin-state-renewals-empty`): the shell empty state with a primary AURA "View all members" button and the "Review schedule settings" link stacked beneath it (still permission-gated); the suspended bridge line is on AURA tokens.
    - Error (`Admin-state-renewals-error`): the pipeline load failure is AURA's danger empty state with Try again / Go back and the reference id, as the board draws it. That board is this in-page failure, not a route boundary, so `RouteErrorPanel` (Retry only, no Go back or reference) is not used here.
    - Loading: AURA card and shell `SkeletonBlock`s in the page's new order; one table shimmer from 640px, three stacked cards below it.
    - Badges on AURA `Badge`: tier neutral, Partnership accent (Clarifications, Session 2026-10-01: a tier never takes a status tone; the board was updated to match); urgency neutral → warning → danger as the deadline nears, suspended solid warning, terminated neutral outline; risk band success / warning / danger / critical solid danger; "Bill issued" neutral outline. Labels are unchanged, so colour is never the only signal.
    - `cycle-cells` on AURA tokens; the card-list-only props (`linkClassName`, the expires `label`) are gone with the card list. The shared retry button used by the tasks and tier-upgrades pages is an AURA button.
    - Extra test: `risk-score-badge`.
- [x] T710 [US7] Every US7a path joins `MIGRATED_PATHS` (RED: a US7a block in `ui-import-ratchet.test.ts`). Preview views `renewals`, `renewals-needs-action`, `renewals-empty` and `renewals-error`, plus the mark-paid dialog, all from the page's own view. e2e selectors for the stacked table.
  - Done:
    - `MIGRATED_PATHS` gains the pipeline page, its loading skeleton, every `_components` piece and `src/components/renewals/**`; a US7a block in `ui-import-ratchet.test.ts` (control: the tasks page waits for US7b). The two stacked-card reaches in `row-actions` carry the `#118` label.
    - The page's view is `_components/renewals-pipeline-view.tsx`: `renderRenewalsPipelineView` (money band, section tabs, work queue, chart, tray as slots), `renderPipelineLens` (empty state or filters, table and paging) and `renderPipelineLoadError`. The page keeps its data and Suspense islands; the preview passes settled fixture reads.
    - Preview views `renewals`, `renewals-needs-action` (work queue opens on Needs action: new `defaultLens`), `renewals-empty`, `renewals-error` and `renewals-mark-paid`; sample data in `renewal-fixtures.ts`, the at-risk read answered in the browser by `renewal-previews.tsx`. `preview-shares-page-views` covers them. Measured at 1440 and 390: no horizontal overflow.
    - e2e: urgency chips are a nav of links, the tier select is "Tier", the bulk bar is the "Bulk actions" region, the mark-paid date is typed then blurred.
    - `empty-state-cta-permission-wiring` reads the page's object-form gate (`canManageSchedules: canPerform(…)`); a wrong key still fails it.
    - A dev key warning (the server-built result count beside the table) is gone behind a keyed fragment.
- [x] T711 [US7] Exit:
  - gates, build and the bundle budget for `/admin/renewals`;
  - board screenshots and a parity page;
  - enterprise-ux, i18n and financial-integrity (money band, mark-paid amounts, settlement preview) reviews;
  - the PR;
  - the relay request for the pipeline e2e.
  - Done:
    - Full unit + contract suite green (1630 files, 18,442 tests); typecheck, lint and the static gates clean; `next build` passes; `/admin/renewals` re-baselined 1390 → 1160 KB (1056.8 KB measured).
    - Parity page "US7a Renewals Pipeline Parity" (board vs live at 1440 and 390; dark, TH, SV); no horizontal overflow anywhere.
    - Reviews: financial-integrity PASS; thai-tax conditional pass (warning names the tax invoice/receipt; the WHT line stays out); enterprise-ux and i18n no blockers, MEDIUMs fixed. Maintainer decisions from the review are in the spec (Session 2026-10-01): tier badges take no status tone (boards updated), and the pre-existing TH/SV copy and the bulk tax warning are fixed here.
    - AURA handoff Addendum 22: #118 (stacked-card action row) and #119 (stacked title that wraps).
    - Fixed on the way: `aura-foundation-css` had been red since T702 because the #118 stand-in sat before the shell's `@layer components` block.
    - PR #483 (draft); relay R22 for the ten renewal e2e specs.
- [ ] T712 [US7] Round 2, from R22 and the maintainer's review of the parity page (spec Clarifications, Session 2026-10-01 US7a review, third question):
  - adopt AURA 5.22: the actions column is `card: 'footer'`, and the #118/#119 stand-ins go (RED: `pipeline-table`, the internal-class ratchet);
  - the bulk bar reserves its measured height plus its sticky offset as scroll padding, so the last phone card is never under it (R22 #1; RED: `pipeline-bulk-action-bar`);
  - the work-queue card is frameless with no padding on a phone, "Tier" is shown only on a phone, Last reminder shows at 1440 (RED: `renewals-pipeline-view`, `tier-filter-select`, `pipeline-table`);
  - `renewal-pipeline-dashboard.spec.ts` drives the phone Urgency select (R22 #3);
  - the plans list's table card follows the same phone rule, at the maintainer's request (RED: `plans-list-view`);
  - the boards are updated, the parity page is re-captured, and relay R23 re-runs the R22 specs.

### US7b — cycle detail, tasks, tier upgrades, schedules (two PRs)

US7b ships as two PRs (spec Clarifications, Session 2026-10-01 US7b start). It is a money PR, so it gets a financial-integrity review.

#### US7b-1 — cycle detail and tier upgrades (PR 11)

- [x] T720 [US7] Spec Clarifications "Session 2026-10-01 (maintainer, US7b start)" with the two-PR split and the board decisions; these tasks.
- [x] T721 [US7] Cycle detail view on AURA:
  - header "Cycle detail · {company}" with the status as an AURA `StatusPill`, using the tone map shared with the member-detail Renewal health card;
  - the four cards (Member & plan as one list, Linked invoice, Period & timeline, Activity) as AURA `Card`s;
  - the state notices as AURA `Alert`s;
  - "Frozen price (excl. VAT)" and "Total (incl. VAT)";
  - on a phone, Linked invoice first;
  - the page view is `renderCycleDetailView`, shared with the preview.
  - RED: `cycle-detail-view`, `cycle-status-badge`.
- [x] T722 [US7] Cycle actions in the page header:
  - "Record payment on {bill}" / "Mark paid offline" primary, "Cancel cycle" danger;
  - the cancel confirm is an AURA alertdialog with the same reason field and request;
  - on a phone, Cancel cycle sits in a danger zone at the end of the page.
  - RED: `cycle-admin-actions`.
- [x] T723 [US7] Pending reactivation:
  - the warning `Alert`;
  - Approve reactivation and Reject & refund in the header, their dialogs on AURA with the same requests and toasts.
  - RED: `pending-reactivation-actions`.
- [x] T724 [US7] Cycle detail `loading.tsx` on AURA skeletons, matching the card layout. RED: `cycle-detail-loading`.
- [x] T725 [US7] Tier upgrade queue:
  - one AURA table that stacks into cards below 640px;
  - plan cells with the annual fee "{fee} excl. VAT";
  - Accept plus a ⋯ menu (Escalate, Dismiss) named for its row;
  - Accept and Dismiss confirm in AURA alertdialogs, with "Fees exclude VAT." in Accept;
  - status as `StatusPill`; the `ui/status-badge` type import goes.
  - RED: `tier-upgrade-queue`, `tier-upgrade-status-tone`.
- [x] T726 [US7] Tier upgrades frame:
  - the page card with the section tabs;
  - the phone caption;
  - the error card, empty state and `loading.tsx` on AURA;
  - the page view is `renderTierUpgradesView`.
  - RED: `tier-upgrades-error-boundary`, `tier-upgrades-loading-skeleton`, `tier-upgrades-view`.
- [x] T727 [US7] Ratchet and preview:
  - `MIGRATED_PATHS` gains the cycle-detail and tier-upgrade paths; `ui-import-ratchet` gets a US7b-1 block (the tasks-page control stays);
  - preview views `renewal-cycle`, `renewal-cycle-reminded`, `renewal-cycle-pending`, `tier-upgrades`, `tier-upgrade-accept`;
  - `preview-shares-page-views` covers them;
  - e2e selectors follow.
- [ ] T728 [US7] Exit:
  - gates, the full unit suite, `next build`, bundle budgets;
  - the parity page (board vs live at 1440 and 390, dark, TH, SV);
  - reviews: financial-integrity, enterprise-ux, i18n;
  - draft PR; relay R24 for the cycle-detail and tier-upgrade e2e specs.
  - Done so far:
    - typecheck, full lint and the static gates clean; `next build` passes; `/admin/renewals/[cycleId]` re-baselined 1140 → 910 KB (806.8 measured) and `/admin/renewals/tier-upgrades` 1250 → 950 KB (841.9 measured);
    - reviews: financial-integrity PASS (no blockers; four LOW, all pre-existing); i18n no HIGH (SV/TH danger-zone names and the SV fee sentence fixed); enterprise-ux no blockers — H1 (320px payment action), M1–M5, M7, M8 and L1, L5, L8, L10 fixed, M6 decided in the spec (Reject & refund joins the phone danger zone);
    - AURA handoff Addendum 23: #120 (a full-width field in the stacked card), open in `docs/aura-adoption.md`.

#### US7b-2 — escalation tasks and reminder schedules (PR 12)

A UI swap with no money on screen: UX and i18n reviews, no financial review (spec Clarifications, Session 2026-10-01 US7b-2 start).

- [x] T730 [US7] Spec Clarifications "Session 2026-10-01 (maintainer, US7b-2 start)"; these tasks.
- [x] T731 [US7] Escalation task filters:
  - Status (decided in RED: a reload per choice is a press, not a tab) and Assignment as AURA toggle chips in named groups; `status-tablist` is deleted;
  - the Task type select as an AURA `Select`;
  - the overdue toggle card on tokens;
  - the manager note as an AURA `Alert`.
  - RED: the filter cases of `escalation-task-queue`.
- [x] T732 [US7] Escalation task table:
  - an AURA `DataTable` that stacks into cards below 640px;
  - "Done" plus a ⋯ menu (Skip, Reassign, View timeline) named for its row; a closed row or a manager gets a "View timeline" link instead (UX review);
  - the Overdue badge;
  - the empty states.
  - RED: `escalation-task-queue-row-actions` (columns and phone fields live there too).
- [x] T733 [US7] Task dialogs on AURA alertdialogs: Done with its optional note and counter, Skip with its required reason; same bodies. RED: `task-action-dialog`, `done-task-dialog`, `skip-task-dialog`.
- [x] T734 [US7] Reassign picker:
  - an AURA `Combobox` over the same staff read;
  - the current assignee marked and disabled;
  - the same `{to_user_id}` body.
  - RED: `reassign-task-dropdown`.
- [x] T735 [US7] Escalation tasks frame:
  - the error card;
  - "Next 50" and "Showing 50 per page";
  - `loading.tsx` on AURA skeletons and a new `error.tsx`;
  - the page view is `renderTasksQueueView`.
  - RED: `tasks-loading-skeleton`, `tasks-error-boundary`.
- [x] T736 [US7] Schedule step card:
  - an AURA `RadioGroup` for the channel;
  - `Select` for the timing (with "Custom…") and the assignee role;
  - `NumberField` and Before/After for a custom offset;
  - a `Combobox` with `allowCustomValue` for the task type;
  - `IconButton`s to move and remove;
  - `step_id` composition unchanged.
  - RED: `step-card`.
- [x] T737 [US7] Schedule chart: an SVG on a day scale replacing the legacy `Stepper`, with an accessible sentence and a legend. RED: `reminder-timeline`.
- [x] T738 [US7] Schedule editor and frame:
  - tier tabs on AURA `Tabs`, with the tier as the section heading;
  - the save bar (sticky on a phone);
  - the save error and read-only notice as AURA `Alert`s;
  - the feature-off and load-failure states, `loading.tsx`, a new `error.tsx`;
  - the page states are `renderSchedulesStateView` (the editor itself is the client view).
  - RED: `schedule-editor`, `schedules-loading-skeleton`, `schedules-error-boundary`.
- [ ] T739 [US7] Ratchet, preview and exit:
  - `MIGRATED_PATHS` gains the tasks and schedules paths, and `ui-import-ratchet` flips the two tasks controls;
  - preview views `renewal-tasks` (+`-manager`, `-empty`, `-error`) and `renewal-schedules` (+`-error`);
  - e2e selectors follow;
  - gates, the full unit suite, `next build`, bundle budgets;
  - the parity page;
  - reviews: enterprise-ux, i18n;
  - draft PR; relay R25.
  - Done so far: ratchet, preview views, e2e selectors, lint, typecheck, `check:i18n`; UX review (H1, M1–M5, L1/L2/L4/L6 fixed; H2 filed separately) and i18n review applied.

### US7c — portal renewal (PR 13)

Boards: `Portal-renewal`, `Portal-renewal-processing`, `Portal-renewal-success`, each with `-mobile`. This is a money screen, so it gets the UX, i18n and financial-integrity reviews (spec Clarifications, Session 2026-10-01 US7c start). The confirm request, the `pay_url` redirect, the error codes, the beacon and every amount stay as they are.

- [x] T740 [US7] Spec Clarifications "Session 2026-10-01 (maintainer, US7c start)"; these tasks.
- [x] T741 [US7] Renewal page frame:
  - "Membership plan" as an AURA `Card` with the tier as an accent badge;
  - the first-renewal welcome as an AURA info `Alert`;
  - the pending-review, rejected-refund and not-yet-open states on AURA;
  - the board's two-column layout from `lg`.
  - RED: a renewal page view test.
- [x] T742 [US7] Benefit summary: an AURA `Card`, metered rows as AURA `Progress`, unmetered rows as plain rows. RED: `benefit-summary`.
- [x] T743 [US7] Confirm card:
  - the "Confirm renewal → Pay invoice" stepper;
  - the full-width primary "Confirm renewal" with its busy state;
  - the next-step line.
  - RED: the card cases of `renewal-confirm-flow`.
- [x] T744 [US7] Plan select, price panel and errors:
  - an AURA `Select` with the higher, current and lower option groups and the board's option text;
  - the change warning as an AURA `Alert`;
  - the price panel on tokens;
  - the error as a focused AURA danger `Alert`.
  - RED: `renewal-confirm-flow` rewritten without the old select mock, asserting the no-change, upgrade and downgrade bodies byte-for-byte.
- [x] T745 [US7] Downgrade dialog: an AURA alertdialog with the same copy, price panel, quota rows and over-quota description; Cancel takes first focus. RED: `downgrade-confirm-dialog`.
- [x] T746 [US7] Success page:
  - the board's hero for success and processing;
  - "Renewal details" as an AURA `Card` with a "Completed" status pill;
  - the same five download outcomes as AURA link buttons, with the receipt still preparing shown as a busy placeholder;
  - full-width actions on a phone.
  - RED: `renewal-success-receipt-gate` on AURA.
- [x] T747 [US7] Loading skeletons for both pages in the new shapes, keeping the status announcement. RED: a skeleton test.
- [x] T748 [US7] Ratchet and preview:
  - `MIGRATED_PATHS` gains the renewal route;
  - a US7c block in `ui-import-ratchet`;
  - preview views for the renewal page (plain, downgrade, first renewal, gate) and the success page (processing, complete).
- [x] T749 [US7] Exit:
  - e2e selectors where roles or names changed;
  - gates;
  - `next build` and bundle re-baseline;
  - the parity page;
  - UX, i18n and financial reviews;
  - draft PR; relay R27.

## Phase 10: User Story 8 — Invoicing administration (Priority: P2) — PRs 14–16 (US8a, US8b, US8c; T800)

US8 is a money phase: each PR gets the UX, i18n and financial-integrity reviews. Every fetch URL and body, typed phrase, router push and refresh, error-code router, toast and amount formatter stays as it is (spec Clarifications, Session 2026-10-02). After US8c the full e2e suite runs locally (Session 2026-09-26 checkpoint).

### US8a — invoice list and new invoice (PR 14)

Boards: `Admin-invoices`, `Admin-state-invoices-setup`, `Admin-invoice-new`, `Admin-record-payment` (+`-mobile`).

- [x] T800 [US8] Spec Clarifications "Session 2026-10-02 (maintainer, US8 start)"; the registers line in the user story; these tasks.
- [x] T801 [US8] One invoice status tone map shared by the portal list, the member invoices table and the admin list and detail: Paid `ready`, Issued `progress`, Overdue `blocked`, the rest `neutral`. RED: a unit test of the map.
- [x] T802 [US8] The invoice table is an AURA `DataTable` with the board's columns and phone cards:
  - Invoice No. carries "Issued {date}" and the credit-note count;
  - Receipt No. carries "PDF generating…" (busy) or the online method, and a "Receipt failed" link;
  - "Record payment…" plus a ⋯ menu with the downloads;
  - the queue and method columns only in their views.
  RED: the table test on AURA (headers, row actions, menu items, busy receipt, pill tones).
- [x] T803 [US8] The auto-renewal queue actions are an AURA `DropdownMenu`, with AURA alerts for the caution and errors, and the queue badges are AURA badges (the severity ladder: refused danger, unverified solid warning, price changed soft warning, fiscal year changed neutral) with keyboard-reachable tooltips. The invoice's own ⋯ menu (`invoice-more-menu`) is used only on the detail page, so it moves to US8b. Resend `{variant}`, `issue-auto-drafted` `{sendEmail}`, `discard-auto-draft` and the 429 path are unchanged. RED: the queue-action and badge tests on AURA (item names, the danger item, POST URLs and bodies, focus after refresh, badge tones).
- [x] T804 [US8] Record payment is one AURA dialog, which is a bottom sheet below 640px by itself. It carries the board's summary box (bill · member, amount received, the full-total note), the method select, reference, payment date (clamp kept) and notes. The POST body is unchanged. RED: the dialog and summary, the POST bodies byte for byte, the error alert tones.
- [x] T805 [US8] The CSV export dialog is an AURA dialog with two date fields; the export URL and its `window.open` are unchanged. RED: a test for the URL and the range check.
- [x] T806 [US8] The list page frame:
  - the header actions;
  - a frameless table card on phones;
  - the count line;
  - the setup state (admin-only "Configure Invoicing");
  - the empty and filtered-empty states;
  - the error boundary on `RouteErrorPanel`;
  - skeletons in the new shape.
  RED: the load-error, setup-state and skeleton tests.
- [x] T807 [US8] New invoice:
  - "What is this invoice for?" as an AURA radio group;
  - the membership card (member combobox, plan block, renewal-period info alert);
  - the event-fee form, attendee picker and non-member buyer fields on AURA fields, with the duplicate warning as an AURA alertdialog.
  Every request body and push is unchanged. RED: the switcher, event-fee, attendee-picker, buyer-fields and renewal-context tests on AURA.
- [x] T808 [US8] Ratchet and preview:
  - `MIGRATED_PATHS` gains the list page, its components except the detail-only dialogs, `_lib`, the loading and error files, and `new/**`;
  - a US8a block in `ui-import-ratchet`, with the control moved to the detail page;
  - preview views for the list (plain, setup, empty, manager), new invoice (membership, event fee) and record payment.
- [ ] T809 [US8] Exit:
  - e2e selectors where roles or names changed;
  - gates;
  - `next build`, adding bundle budgets for `/admin/invoices` and `/admin/invoices/new`;
  - the parity page;
  - UX, i18n and financial reviews, with fixes RED first: the receipt state on phone cards, focus and dismissal in Record payment, the invoice-total label, copy without the arrow, the draft row's menu name, and the drafts hint following `includeDrafts`. AURA handoff #125 (RadioGroup description) is filed;
  - draft PR; relay R29.

### US8b — invoice detail, dialogs, void and new credit note (PR 15)

Boards: `Admin-invoice-draft`, `-issued` (+`-mobile`), `-overdue`, `-paid`, `-credited`, `-manager`, `-auto-refund-failed`, `Admin-voided`, `Admin-invoice-issue`, `Admin-refund-*` (full, partial, settling, settled, failed, waived), `Admin-void` (+`-mobile`), `Admin-credit-note` (+`-mobile`).

- [x] T820 [US8] Adopt AURA 5.29 (handoff #134): the list skeletons' rows match the real rows (`skeletonLines`, `skeletonTouch`, labelled stacked cards), and the renewals skeletons drop their own phone cards. RED: the invoices and renewals skeleton tests (two-line cells, touch footer bar, no own phone cards).
- [x] T821 [US8] These tasks; the spec's US8b clarifications.
- [x] T822 [US8] The detail page's markup moves into `renderInvoiceDetailView`, which the page and the no-DB preview route both render; every data read and derived value stays in the page. RED: the view test renders from props alone.
- [x] T823 [US8] The one layout: "Invoice {number}" (or "Draft invoice") with the AURA status pill from `invoiceStatusTone`; a Details card holding the fields and, at its end, the totals (subtotal, VAT, total); then the payment details, voided, credit notes and line items, each in its own card, and the payment activity. Amounts, dates and field gates unchanged. RED: the view test (title, pill tone, card order, totals, gates per status).
- [x] T824 [US8] The header actions per status and role as before, on AURA buttons; the ⋯ menu on an AURA `DropdownMenu` (download names, resend calls and the hide-when-empty rule unchanged). Below 640px the actions become a bar at the bottom of the screen with the total (incl. VAT) and due date, and Void moves into the ⋯ menu. RED: the menu test without the legacy mock; the bar's summary and Void placement.
- [x] T825 [US8] The issue, delete-draft and refund dialogs on AURA (the typed phrases, request bodies, error routing and success handling unchanged; the refund `alertdialog` role, testids and `${id}-help` id kept). RED: the issue and refund form tests without the legacy wrapper, with the request bodies asserted.
- [x] T826 [US8] The email-failure and auto-refund-failed alerts, the payment activity and its skeleton, the copy-charge-id button and the credit-note action on AURA. RED: the alert tests (named buttons, alert/alertdialog roles) and the timeline tests on AURA.
- [x] T827 [US8] The void page (buttons stacked on a phone, Void above Cancel) and the new-credit-note page on AURA fields; their loading files, the detail loading file and `not-found` on AURA. RED: the void and credit-note form tests on AURA; the loading tests.
- [ ] T828 [US8] Ratchet and preview: `MIGRATED_PATHS` gains `admin/invoices/[invoiceId]/**` and the rest of `admin/invoices/_components/**`; the two ratchet controls move to US8c files; preview views for the detail states, the dialogs, void and credit note.
- [ ] T829 [US8] Exit: e2e selectors where roles changed; gates; `next build` with a bundle budget for `/admin/invoices/[invoiceId]`; the parity page; UX, i18n and financial reviews with fixes RED first; draft PR; relay R32.

### US8c — credit notes, registers and settings (PR 16; tasks written at its start)

- [ ] T840 [US8] Credit-notes list and detail, the tax-document registers (row count, totals and CSV equal `main`), the invoice settings; then the full local e2e checkpoint.

## Later phases (one PR each; tasks written when the phase starts)

- [ ] T900 [US9] Events: DatePicker/TimePicker (`Asia/Bangkok`), Combobox, FileUpload, erasure pages.
- [ ] T1000 [US10] Users, audit, compliance, settings: DataTable, Menu danger items.
- [ ] T1100 [US11] Dashboard: Stat tiles; recharts recoloured with `--aura-chart-*`.
- [ ] T1200 [US12] E-Blast: queue DataTable (item 52, or a local selection column), workspace, schedule dialog, member sign-off.
- [ ] T1300 [US13] Exit: delete `src/components/ui`; uninstall `@base-ui/react`, `tw-animate-css`, `shadcn`; drop the TanStack table UI; make the old-kit ban global; remove the token bridge; check the facade decision; confirm the date is within 10 weeks of the US0 merge.

## Dependencies & order

- **Order within US0:** T001–T002 → T003–T005 (commit A) → T006 → T008–T010 → T007 (commit B needs the bridge) → T011–T014 → T015–T016 → T017–T019 in parallel → T020–T022.
- **Later phases:** US1 blocks US2–US12. US2–US12 can go in any order (canvas order preferred). US13 comes last.
- **Logic-bug fixes** that a phase depends on merge first, as separate PRs (FR-011).
