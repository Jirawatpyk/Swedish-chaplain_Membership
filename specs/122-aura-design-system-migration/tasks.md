# Tasks: AURA Design-System Migration

**Input**: `specs/122-aura-design-system-migration/` (spec.md, plan.md, research.md, contracts/, data-model.md, quickstart.md)

**Tests**: MANDATORY (Principle II). Each behaviour below names the test that must go RED first. The feature is presentation-only, with no tenant-scoped data, so there is no cross-tenant probe.

**Organization**:
- US0 (Foundation) ships in this PR and is detailed task by task.
- US1–US13 are one PR each. Each gets its own task breakdown in this file when it starts; each is one line here until then.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [x] T001 [US0] Add `@jirawatpyk/aura-react@5.5.0` and `@jirawatpyk/aura-tokens@5.5.0` (bumped to 5.6.0 on 2026-09-26 when handoff items 52–56 shipped) as exact pins in `package.json` and `pnpm-lock.yaml`. Remove `react-day-picker`, delete `src/components/ui/calendar.tsx` and `src/components/ui/scroll-area.tsx` (0 importers), and confirm `pnpm typecheck` and `pnpm test` are green.
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
- [ ] T021 [US0] Run e2e locally (`--workers=1`): `@a11y|@i18n`, the toast-touching specs, and then the full suite once. Fix axe contrast in the token-bridge table only. Link the run log in the PR.
- [ ] T022 [US0] Visual pass: screenshots of `/admin`, `/admin/members`, one admin form, `/portal` and `/portal/invoices` in EN/TH/SV, light/dark, at 390/1280. CLS < 0.1 on `/`, `/portal` and `/admin`. Then an enterprise-ux-designer review, a mobile-a11y review and a whole-branch review. Open a draft PR and subscribe to it.

**Checkpoint**: US0 merged. The 10-week clock for FR-004 starts at the merge date; record it in `docs/aura-adoption.md`.

---

## Later phases (one PR each; tasks written when the phase starts)

- [ ] T100 [US1] Shell: AppShell/SideNav/BottomNav, header, menus, Breadcrumb, Pagination, Command (remove `cmdk`, ratchet to `error`), idle/confirm dialogs, EmptyState, Skeleton pulse (remove shimmer CSS). Layout containers keep API + `data-slot`.
- [ ] T200 [US2] Auth pages: TextField, PasswordField, Checkbox (`hideLabel`), FormErrorSummary.
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
