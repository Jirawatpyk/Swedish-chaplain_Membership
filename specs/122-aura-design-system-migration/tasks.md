# Tasks: AURA Design-System Migration

**Input**: `specs/122-aura-design-system-migration/` (spec.md, plan.md, research.md, contracts/, data-model.md, quickstart.md)

**Tests**: MANDATORY (Principle II). Each behaviour below names the test that must go RED first. The feature is presentation-only, with no tenant-scoped data, so there is no cross-tenant probe.

**Organization**:
- US0 (Foundation) ships in this PR and is detailed task by task.
- US1–US13 are one PR each. Each gets its own task breakdown in this file when it starts; each is one line here until then.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [x] T001 [US0] Add `@jirawatpyk/aura-react@5.5.0` and `@jirawatpyk/aura-tokens@5.5.0` (bumped to 5.6.0 on 2026-09-26 when handoff items 52–56 shipped, and to 5.7.0 – 5.7.2 in US1 when 57–64 shipped) as exact pins in `package.json` and `pnpm-lock.yaml`. Remove `react-day-picker`, delete `src/components/ui/calendar.tsx` and `src/components/ui/scroll-area.tsx` (0 importers), and confirm `pnpm typecheck` and `pnpm test` are green.
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
- [ ] T209 [US2] Exit: gates, build + bundle budgets, board screenshots (390 / 1280, light / dark, EN / TH / SV), enterprise-ux-designer and mobile-a11y-ux-reviewer passes, whole-branch review. No e2e checkpoint for this phase (next: after US4).

## Later phases (one PR each; tasks written when the phase starts)

- [ ] T300 [US3] Portal home, profile, account: Card, Stat, StatusPill, link Tabs, ActionBar.
- [ ] T400 [US4] Portal invoicing + pay sheet: DataTable totals, Stepper, Drawer ≤ 92 dvh around the unchanged Stripe Elements. Financial-integrity review.
- [ ] T500 [US5] Members: DataTable server mode with the URL contract, FilterBar, bulk action bar.
- [ ] T600 [US6] Plans: forms, SegmentedControl, Switch.
- [ ] T700 [US7] Renewals: one DataTable (stacked on phone), cycle detail, tasks, schedules.
- [ ] T800 [US8] Invoicing admin: registers with sticky footer; refund, void, credit and record-payment dialogs. Financial-integrity review.
- [ ] T900 [US9] Events: DatePicker/TimePicker (`Asia/Bangkok`), Combobox, FileUpload, erasure pages.
- [ ] T1000 [US10] Users, audit, compliance, settings: DataTable, Menu danger items.
- [ ] T1100 [US11] Dashboard: Stat tiles; recharts recoloured with `--aura-chart-*`.
- [ ] T1200 [US12] E-Blast: queue DataTable (item 52, or a local selection column), workspace, schedule dialog, member sign-off.
- [ ] T1300 [US13] Exit: delete `src/components/ui`; uninstall `@base-ui/react`, `tw-animate-css`, `shadcn`; drop the TanStack table UI; make the old-kit ban global; remove the token bridge; check the facade decision; confirm the date is within 10 weeks of the US0 merge.

## Dependencies & order

- **Order within US0:** T001–T002 → T003–T005 (commit A) → T006 → T008–T010 → T007 (commit B needs the bridge) → T011–T014 → T015–T016 → T017–T019 in parallel → T020–T022.
- **Later phases:** US1 blocks US2–US12. US2–US12 can go in any order (canvas order preferred). US13 comes last.
- **Logic-bug fixes** that a phase depends on merge first, as separate PRs (FR-011).
