# AURA adoption

Spec: `specs/122-aura-design-system-migration/`. This page is the working guide for moving Chamber-OS from the legacy component kit (`src/components/ui/`, shadcn on Base UI) to **AURA**, one phase per PR.

AURA consists of two packages, both pinned exactly and upgraded only in a dedicated PR:
- `@jirawatpyk/aura-react`: the components
- `@jirawatpyk/aura-tokens`: the tokens, fonts and Tailwind theme

The migration was decided on 2026-09-26, with these settled points:
- End state is AURA only.
- Fonts are AURA's.
- Toasts appear at the top centre.
- Skeletons use AURA's pulse.
- Both libraries coexist for **at most 10 weeks** after the foundation (US0) merges. This is recorded as an exception to Constitution Principle VI in `plan.md` Complexity Tracking.

**US0 merged:** 2026-09-26 (PR #419). The 10-week window closes on 2026-12-05.

## How AURA is wired

| Piece | Where | Notes |
|---|---|---|
| CSS layer order + imports | head of `src/app/globals.css` | `@layer aura-tokens, theme, base, aura, components, utilities;` then Tailwind, the legacy kit's CSS, AURA tokens, AURA fonts, the prefixed AURA Tailwind theme, the brand theme, and AURA's layered component CSS. Utilities beat AURA components without `!important`. See `specs/122-…/contracts/css-layers.md`. |
| Token bridge | `:root` / `.dark` in `src/app/globals.css` | Legacy shadcn variables (`--background`, `--primary`, `--border`, `--ring`, `--chart-*`, `--sidebar-*`, `--radius`, …) are aliases of `--aura-*`, so un-migrated pages already look like AURA. A contrast failure is fixed in this mapping, never per page. It is removed at US13. |
| Brand theme | `src/styles/aura-theme.css` (generated) | Regenerate with `npx aura-theme --brand "#10487A" --out src/styles/aura-theme.css`. The CLI exits 1 if any contrast check fails. Do not edit by hand. |
| Fonts | `@jirawatpyk/aura-tokens/aura-fonts.local.css` | Inter + Noto Sans Thai (text and kit headings), Fraunces (AURA display only), JetBrains Mono (mono), served from our own origin. The CSP is unchanged. |
| Provider | `src/components/providers/aura-bridge.tsx`, mounted in `src/app/layout.tsx` | `locale` (en/th/sv); `calendar` (Buddhist for `th`, else Gregorian — display only); the tenant `timeZone`; `linkComponent` = `next/link`. AURA's built-in labels come in EN/TH/SV. |
| Density | `<AuraDensity>` (from the bridge file) in `src/app/(staff)/admin/layout.tsx` (compact) and `src/app/(member)/portal/layout.tsx` (comfortable) | Inherits everything else from the bridge. |
| Toasts | `@/lib/toast` (facade) → AURA `toast`; `<Toaster position="top-center" offset={80}>` in the bridge (below the 72px portal header) | The only toast import. Options: `description` (text or JSX), `id`, one `action` (with `href` / `dismiss`), `duration`. At most 3 visible; errors persist by default; Alt+T reaches the newest toast (AURA). |
| Dates | `src/lib/format-date-localised.ts` | Stays the only formatter. AURA's `formatDate` / `useFormatDate` are lint-banned. |
| Overlay stacking | legacy kit wrappers use `var(--aura-z-menu)` / `var(--aura-z-dialog)` | AURA scale: dialog 900, menu 1000, toast 1200, tooltip 1300. Never open an overlay from one library inside an overlay from the other. |

## Server components never import AURA directly


AURA's root entry is `'use client'`. When a **server** file imports from `@jirawatpyk/aura-react`, the whole barrel becomes a client reference and every AURA component ships on every route: this measured **+138 KB** first-load JS on every page during US0. Import AURA only from client files (`'use client'`), and let server layouts render a small client wrapper (as `AuraDensity` does). With that rule, US0 is 2–8 KB *smaller* per route than before, because sonner is gone.

A server component that needs an AURA look without its behaviour uses AURA's classes instead (`aura-card`, `aura-empty`): `EmptyState` and `LoadErrorCard` do this.

## The ratchet

- The rule is `@typescript-eslint/no-restricted-imports`, built by `uiRatchet(MIGRATED_PATHS)` in `eslint.ui-ratchet.mjs` and spread at the end of `eslint.config.mjs`. It uses a distinct rule id on purpose, so it never replaces the architecture `no-restricted-imports` blocks.
- It bans everywhere:
  - `sonner` (use `@/lib/toast`)
  - AURA's root `formatDate` / `useFormatDate`
  - `cmdk`, except in its one host `src/components/ui/command.tsx`. US1 moved both command palettes to AURA `Command`; the host stays for the pickers and `ui/combobox` until the last of their modules migrates (at the latest US13)
- **`MIGRATED_PATHS`** lists the directories that are on AURA. Any `@/components/ui/*` import there fails lint. **`NOT_YET_ON_AURA`** names the few files inside them that still wait for a later phase, each with that phase; it only shrinks.
- A phase PR adds its directories to this list in the same PR that removes their last legacy import.
- The list only grows. At US13 the ban becomes global and the list is deleted.
- `tests/unit/architecture/ui-import-ratchet.test.ts` proves each ban fires (the positive control).

## Definition of done for a phase (spec FR-010)

1. Its paths import nothing from `@/components/ui`, and they are added to `MIGRATED_PATHS`.
2. Its screens match their canvas boards on the "Chamber-OS Portal — Aura" design canvas, at 390 and 1280 px, in light and dark. Screenshots go in the PR. Where a board is marked **Proposed**, the PR says whether it was implemented or deferred.
3. `check:layout`, `check:i18n`, `check:strict-aria` and `check:dates` are green.
4. Its unit/component tests and every required CI check pass. The local e2e, `@a11y` and `@i18n` suites run only at the **checkpoints** — after US1, after US4/US8 (money), and before US13 — because e2e has no CI job and a full run takes over an hour.
5. Bundle budgets are re-baselined (`scripts/check-bundle-budgets.ts`, `ceil(kb/10)*10+100`).
6. An enterprise-ux-designer review has signed; on money screens, a financial-integrity review as well.
7. **No logic change.** A defect found along the way ships as its own PR, merged first.

## Phases

The phases follow the order on the canvas page "Migration plan — AURA":

| # | Phase |
|---|---|
| 0 | Foundation |
| 1 | Shell |
| 2 | Auth |
| 3 | Portal home / profile / account |
| 4 | Portal invoicing + pay sheet |
| 5 | Members |
| 6 | Plans |
| 7 | Renewals |
| 8 | Invoicing admin |
| 9 | Events |
| 10 | Users / audit / compliance / settings |
| 11 | Dashboard |
| 12 | E-Blast |
| 13 | Exit |

Phases 2–12 each depend on 1 and can land in any order.

## AURA gaps (the handoff doc)

The AURA handoff doc (a Claude Doc titled "AURA v4.9 handoff — Chamber-OS requirements") is the contract between Chamber-OS and AURA. Items 1–51 shipped in 5.5.0, items 52–56 (Addendum 4) in 5.6.0, items 57–62 (Addendum 5, found in US1) in 5.7.0, item 63 in 5.7.1, item 64 (Addendum 6) in 5.7.2 and item 65 (Addendum 7, found in US2) in **5.7.3**, the current pin. None is open.

How Chamber-OS uses the Addendum 5 – 7 items (US1 and US2 dropped their bridge for each):

| # | Shipped in | Used by |
|---|---|---|
| 57 | 5.7.0: `DropdownMenu` `header` (outside the items, the menu's description) | `UserMenu`: name, role and email |
| 58 | 5.7.0: `Breadcrumb` item without `href` / `onClick` renders as text (`.aura-crumbs__text`) | `BreadcrumbNav` keeps its own `aura-crumbs` markup (phone ellipsis trail, e2e data-slots) and uses the class for organisational segments |
| 59 | 5.7.0: `AppShell` `<main tabIndex={-1}>` | `StaffShell`: focus fallbacks to `#main-content` land with no local effect |
| 60 | 5.7.0: `Dialog` `dismissOnScrim`, default off for `role="alertdialog"` | `ConfirmationDialog`: a stray click outside keeps the typed reason; Escape and Cancel still close it. `dismissible={false}` still makes the rotated webhook secret close only from its buttons |
| 61 | 5.7.0: `BottomNav` item `ariaLabel` | `MemberBottomTabs`: the full name where it contains the short label (SV "Konto" → "Mitt konto", TH "บัญชี" → "บัญชีของฉัน"); otherwise the short label, so the name always holds the visible text |
| 62 | 5.7.0: `SideNav` rows 44px on coarse pointers | AURA's own CSS; the local rule is gone |
| 63 | 5.7.1: `SideNav` labels wrap to two lines, then clamp | The staff nav and drawer: long TH/SV names ("Godkännande av medlemsändringar") read in full; one-line rows stay 36px |
| 64 | 5.7.2: `SideNav` labels hyphenate long compounds (`hyphens: auto`, words of 12+ letters) | The drawer's SV "Marknadsförings-" / "målgrupp" where the browser has a Swedish dictionary (Safari, Chrome on macOS / Android); elsewhere it still breaks where the line runs out |
| 65 | 5.7.3: `FormErrorSummary` with `focusKey` takes focus only after a submit, never while live errors come and go as someone types | The auth forms pass react-hook-form's live `errors` with `focusKey={formState.submitCount}` and `shouldFocusError: false`; the `useSubmittedErrors` snapshot is gone |

How Chamber-OS uses the 5.6.0 items:

| # | Shipped in 5.6.0 | Used by |
|---|---|---|
| 52 | DataTable `isRowSelectable(row)` / `rowSelectDisabledLabel(row)` | US12: the E-Blast queue ticks only rows awaiting marketing review (no local selection column) |
| 53 | Toast `description` takes JSX; `actions` with `href` / `dismiss` | The supersede warning: one line per bill, each with its own "Open bill" link (`use-supersede-warning-toast.tsx`) |
| 54 | Toaster `position="top-center"` + `offset` | AuraBridge: `<Toaster position="top-center" offset={80} />`, below the tallest top bar (the 72px portal header since US1) |
| 55 | Toaster `hotkey` (default Alt+T) | AURA's default; the local listener is gone |
| 56 | 44px toast actions on coarse pointers | AURA's own CSS; the local rule is gone |

AURA also returns focus when a toast that held it closes, so the facade no longer does.

When AURA ships an item:
1. Bump the pin in a dedicated PR, or in the open phase PR that added the bridges it removes (5.7.0 – 5.7.2 rode in US1 and 5.7.3 in US2 for that reason).
2. Delete the `// AURA-handoff #NN` wrapper.
3. Update this table.
