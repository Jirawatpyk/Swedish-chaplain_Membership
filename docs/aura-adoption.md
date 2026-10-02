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

A server component that needs a static AURA component imports it from **`@jirawatpyk/aura-react/server`** (AURA 5.8, handoff #68): `Card`, `Badge`, `StatusPill`, `Alert` (no `onDismiss`), `EmptyState`, `Icon` and `buttonClass()` for a link that looks like a button. They share their render functions with the root components, so the HTML is the same, and they add no client reference. `buttonClass` comes from `/server` in client files too. `tests/unit/architecture/aura-server-imports.test.ts` fails when a file without `'use client'` imports a value from the root (type imports are fine). Anything interactive (a Switch, Tabs, a Dialog, an `Alert` with `onDismiss`) still needs a `'use client'` file.

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

**Board parity rule (US5a, 28 Sep 2026).** AURA's component defaults (spacing, sizes, radius, type scale) win over a board's pixel values. The board wins on content, structure, order, icons and copy. When a board value is clearly better, it goes to the AURA handoff, never into a per-page override. Styling that reaches into AURA's internal classes (`.aura-table__*`, `.aura-tbl__*`, `.aura-empty*`, `.aura-filterbar__*`, `.aura-card__*`, `.aura-alert*`, `.aura-stat*`, `.aura-progress*`, `.aura-nav*`, `.aura-shell*`, `.aura-bottomnav*`, a hand-applied `aura-icon`) is a stand-in: it gets a `stand-in until AURA #NN` comment naming an item open below. A reach AURA's owner agreed is app content (e.g. hiding part of a cell only on a stacked phone card) is labelled `AURA app content: <why>` instead. `tests/unit/architecture/aura-internal-class-ratchet.test.ts` enforces both over every `MIGRATED_PATHS` entry and `globals.css`, and fails on a label naming an item that is no longer open: when AURA ships an item, its stand-ins are swapped in the same PR that bumps the pin.

**Type scale.** Text sizes on AURA surfaces use AURA's type classes (`aura-text-label` 13/500, `aura-text-table-cell` 13/400, `aura-text-caption` 12, `aura-text-mono` 12 mono, `aura-text-pill-label` 11, `aura-text-h2` 24), not `text-[Npx]`. They load in the `aura-tokens` layer, below Tailwind's preflight, so on a `<button>`, `<kbd>` or heading (where preflight resets the font) the class goes on the inner text span; Tailwind `font-*` / `leading-*` utilities still win over it. Page titles keep the app's shared `--font-size-h1` step.

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

The AURA handoff doc (a Claude Doc titled "AURA v4.9 handoff — Chamber-OS requirements") is the contract between Chamber-OS and AURA. Items 1–51 shipped in 5.5.0, items 52–56 (Addendum 4) in 5.6.0, items 57–62 (Addendum 5, found in US1) in 5.7.0, item 63 in 5.7.1, item 64 (Addendum 6) in 5.7.2, item 65 (Addendum 7, found in US2) in 5.7.3, items 66–69 (Addendum 8, found in US3) in 5.8.0, items 70–71 (Addendum 9, found in US4) in 5.9.0, items 72–74 (Addendum 10, found adopting 5.9.0 in US4) in 5.10.0, items 75–78 (Addendum 11, found in US5a) in 5.11.0, item 79 (Addendum 12) in 5.12.0 and items 80–84 (Addendum 13) in 5.13.0, items 85–100 (Addenda 14–15) in 5.14.0–5.16.0, items 101–108 (Addendum 16, found in US5b-1) in 5.14.0 and 5.16.0, item 109 (Addendum 17) in 5.16.1, items 110–111 (Addendum 18) in 5.17.0 and item 112 (Addendum 19, found in US6) in 5.18.0, items 113–116 (Addendum 20, found in US6) in 5.19.0 and 5.20.0 and items 118–119 (Addendum 22, found in US7a) in 5.22.0 and items 120–122 (Addenda 23–25, found in US7b) in 5.23.0 and item 123 (Addendum 26) in 5.24.0 and item 124 (Addendum 27) in 5.25.0 — **5.25.0** is the current pin. Items 85–100 (Addenda 14–15, found adopting 5.13.0 and applying the parity rule to US1–US5a) shipped in 5.14.0 (86, 88, 91, 97), 5.15.0 (85, 87, 89, 90, 92–94, 99, 100) and 5.16.0 (95, 96, 98), and are adopted below (T512). The two gaps found adopting them (Addendum 18: #110 `Stat`, #111 `Progress`) shipped in 5.17.0, and 5.16.1 fixed #109 (a custom `Select` painted with the disabled ground). Addendum 20 (items 113–116, found in US6: #113–#114 from the UX review, #115–#116 from the board check) shipped in 5.19.0 and 5.20.0, and US6 dropped each stand-in. Addendum 21 (#117, the directory's Recent exports rows) shipped in 5.21.0, and Addendum 22 (#118–#119, found in US7a) in 5.22.0:

| Item | Shipped | Chamber-OS change |
|---|---|---|
| 113 | 5.19.0: `Switch` `readOnly`, `icon`, caller `aria-describedby` | A locked switch is read-only (in the tab order, its state and lock note heard) with `icon="lock"` via `lockedSwitchProps`; the `role="group"` stand-in and the local lock `Icon` go |
| 114 | 5.19.0: `Select` `readOnly` | `lockedSelectProps` sets `readOnly` in place of `disabled` |
| 115 | 5.20.0: the static `Table` takes the page's density | The plans table drops `density="compact"`; every static `Table` inside the compact staff frame is now compact too |
| 116 | 5.20.0: `ActionBar` `start` slot | The wizard's Cancel moves into `start`; `plan-form-actions--split` and `me-auto` go (`--start-wide` keeps the slot out of the pinned phone bar). 5.20 also gives the bar `width: 100%`, so the phone form bars set `width: auto` to reach the screen edges |
| 117 | 5.21.0: `Table` `rowHeight="density"`: every body row is at least the density's row height, cell padding clamped so a `sm` button, pill or one line give the same row | The directory's Recent exports table takes `rowHeight="density"`; its rows measure equal (were ~49px with Download, ~38px without) |
| 118 | 5.22.0: `DataTable` column `card: 'footer'`, the stacked card's last row, full width | The renewal pipeline's actions column is `card: 'footer'`; `RowActions` renders its Button and ⋯ straight into AURA's cell (no wrapper), so the footer grows "Send reminder" beside the ⋯; the `globals.css` actions-row rule and the `in-[.aura-table--stacked]` reaches go |
| 119 | 5.22.0: the stacked card's title wraps, its first line aligned with the pill and actions | The `globals.css` title-wrap rule goes |
| 120 | 5.23.0: `DataTable` column `card: 'wide'`, a field on its own full-width line of the stacked card, after the field grid | The tier upgrade queue's reason column, and the escalation task card's type and due lines, are `card: 'wide'` (boards `Admin-tier-upgrades-mobile`, `Admin-renewal-tasks-mobile`) |
| 121 | 5.23.0: the `Tabs` underline list draws its baseline as an inset shadow, so the active 2px indicator is no longer clipped | Nothing to change: the renewals section tabs show the full indicator |
| 122 | 5.23.0: `ActionBar touchHeight` gives the bar's own Clear the 44px touch height below 640px | The members and renewal pipeline bulk bars pass `touchHeight`; the `TouchClearActionBar` stand-in goes |
| 123 | 5.24.0: `touchHeight` applies under `(max-width: 639.98px), (pointer: coarse)`, so a tablet or other touch-first screen wider than 640px gets 44px targets too; a mouse at 640px and up keeps today's sizes | Nothing to change in the screens: every touch control already passes `touchHeight`. `renewal-a11y` asks the page which rule applies and adds a 1024px touch-context test |
| 124 | 5.25.0: a toggle `Tag` (`selected` + `onClick`) takes `touchHeight`, 44px under the same rule as #123; a plain or removable Tag ignores it | The escalation queue's six Status and Assignment chips (`PressedGroup`) pass `touchHeight` |

No item is open (the ratchet in `tests/unit/architecture/aura-internal-class-ratchet.test.ts` reads this table; a new gap goes here as `| #N | … |`):

| Item | AURA gap | Chamber-OS stand-in |
|---|---|---|

**#126 (Addendum 29) is open but is deliberately NOT in that table**, because it
has no stand-in to retire: it is not a reach into AURA's internals but a request
about AURA's own `Container`. AURA offers two page-column widths (`default` 1280,
`narrow` 720) where Chamber-OS uses four — 672 form, 1152 detail, 1536 table, and
the portal's 1200 content column — and centres with `margin: 0 auto`, while the
staff form boards put the 672 column at the page's start edge (`spec.md:118`). So
`src/components/layout/{form,detail,table}-container.tsx` stay for now. A live
cascade test (2 Oct 2026) shows `.aura-container` + `mx-0` +
`max-w-[var(--layout-max-width-form)]` already yields 672 at the start edge, and
AURA's container padding ladder already matches `--page-padding-x`, so the ask is
a written guarantee that utilities may override `Container`, not a new feature.
Nothing in the repo is labelled `#126`; when it is answered, the migration is a
component swap, not a stand-in removal.

**#129 (Addendum 32) is open and also outside that table**, for the same reason:
there is no stand-in to retire. AURA `Table` has no sticky-header option, and the
only `position` on `.aura-tbl__head` is the visually-hidden rule under
`--stack-sm` / `--stack-md`, so a list page that moves off the legacy kit stops
pinning its column labels. Measured 2 Oct 2026: `thead` is `sticky` on
`/admin/users`, `/admin/invoices` and `/admin/events` (legacy kit) and `static` on
`/admin/plans` and `/admin/directory` (AURA `Table`), while AURA `DataTable`
keeps its `.aura-table__head` sticky on `/admin/members`. FR-020
(`specs/004-page-layout-standard/spec.md:232`) requires the sticky header, so it is
unmet on those two pages until AURA ships `stickyHeader`. A local `sticky top-0`
is not available as a stand-in — it would have to reach `.aura-tbl__head`, which
the internal-class ratchet forbids. `tests/e2e/table-consistency.spec.ts` no longer
asserts stickiness (it was never part of SC-013) and names this item instead.

Addendum 16 (items 101–108, found in US5b-1, the member detail page) shipped in 5.14.0 and 5.16.0. US5b-1 dropped each stand-in:

| # | Shipped in | Used by |
|---|---|---|
| 101 | 5.16.0: `Dialog` `trigger` / `onOpen`, `finalFocus`, `onCloseComplete`, `data-*` on the panel | `RestorePrimaryDialog` (focus to the caller's target and the pick reset on close; the ref + microtask is gone); `ContactFormDialog` opens from its `trigger`, its open state still controlled so each open re-seeds the form (the `cloneElement` opener is gone) |
| 102 | 5.14.0: `Button` keeps a passed `aria-disabled` | the erase gate in `EraseMemberButton` and the expired Restore in `ArchivedBanner` (the plain `buttonClass` buttons are gone) |
| 103 | 5.14.0: `Avatar` from `/server` | the contact row in `contact-block.tsx` (`contact-avatar.tsx` is gone) |
| 104 | 5.14.0: `--aura-shell-bar-height` | the sticky "On this page" strip in `section-links.tsx` (was `top-14`) |
| 105 | 5.16.0: `Combobox` `allowCustomValue` and `groups` | US5b-2: the member form's country picker ("Suggested" group) and the province / district / sub-district comboboxes (typed names) |
| 106 | 5.14.0: `--aura-fg-warning` | the owed Remaining figure in `member-invoices-table.tsx` |
| 107 | 5.14.0: `Tabs` `current="location"` | the section links (`aria-current="location"`) |
| 108 | 5.14.0: stacked `DataTable` cards start `align: 'end'` values under their label | the invoice phone cards (`StartOnCard` is gone) |

One note stays with AURA: `Menu` closes on any scroll or window resize (iOS Safari fires resize when its toolbar moves), to be checked on a real iPhone before it becomes an item.

5.9.0 also prepares for 6.0, which builds in only English and drops icon names given as strings from the default bundle. Chamber-OS clears its dev notices without changing any output:
- `AuraBridge` passes AURA's Thai and Swedish locale packs as `strings`.
- Icons are registered by name once for each registry: `registerIcons(allIcons)` in `AuraBridge` for client components, and `@/lib/aura-server-icons` (imported by the root layout) for Server Components. `tests/setup.ts` registers both, since component tests render without the layout.
- Moving to icon components (`npx aura-icons-codemod`), which would let the 6.0 bundle drop the name map, is a separate change.

How Chamber-OS uses the Addendum 5 – 15 items (US1 to US5a and T512 dropped their bridge for each):

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
| 66 | 5.8.0: `Alert` `role` override, a custom `icon`, pass-through attributes | The pending-request, decision and "benefits paused" notices: `role="status"` in a warning / danger tone, clock and pause icons, `data-testid` / `data-outcome` |
| 67 | 5.8.0: `Table` `stackBelow` (a container query; labels from the column headers) | `ChangeRequestDiffTable`: each field a card below 640 px, values labelled "Seen" / "Proposed" |
| 68 | 5.8.0: `Card`, `Badge`, `StatusPill`, `Alert`, `EmptyState`, `Icon`, `buttonClass()` from `/server` | Every US3 server page; the local `aura-markup.tsx` copies and their comparison test are gone |
| 69 | 5.8.0: `Card` and `StatusPill` pass attributes to the root | Card scroll anchors (`id="renewal-prefs"`), `data-testid`, pill `data-state` / `data-outcome` |
| 70 | 5.9.0: `Drawer` passes `data-*` / `aria-*` to its panel; `closeLabel`, `closeProps` | The pay sheet: `pay-sheet-content` / `pay-sheet-close` and a close button named "Close payment drawer"; `markDrawer` is gone |
| 71 | 5.9.0: `Tabs` `keepMounted`, `activation="manual"`, per-tab `tabProps` | The pay sheet's Card / PromptPay tabs: Stripe `<Elements>` stays mounted, arrows only move focus (a switch re-initiates the PaymentIntent), Label-in-Name `aria-label`s and test ids; `MethodTablist` is gone |
| 72 | 5.10.0: `Tabs` `variant="segmented"` + `fullWidth` | The same tabs in the boards' segmented look, with AURA's inset focus ring and forced-colors marks; the local `.pay-method-tabs` rule is gone |
| 73 | 5.10.0: disabled `MenuItem`s are `aria-disabled` (reachable by the arrows), `disabledReason`, and a menu with nothing enabled takes focus | The phone card's ⋯ menu: "Email me a copy" is disabled while sending and for the 5-minute cooldown, with the reason "Just sent" (the interim toast is gone) |
| 74 | 5.10.0: measured, no change: the segmented selected pill is 4.6:1 light / 5.8:1 dark against its track, now checked in AURA's CI | Confirmed on the pay sheet: `--aura-border-control` resolves to `#71717a` in light mode, so no dark tokens leak; the review's 2.5:1 was an estimate that assumed the dark value |
| 75 | 5.11.0: `DataTable` `rowSelectLabel(row)` | `MembersTable` names each row checkbox "Select <company>"; the scoped key → name lookup is gone |
| 76 | 5.11.0: `Checkbox` keeps a passed `aria-describedby` and appends its description | The portal directory's contact toggles (`directory-visibility-form.tsx`) now announce their "whose data" hint, which 5.10 silently dropped; the change-request decision rows keep their `description` note |
| 77 | 5.11.0: 24×24 selection targets in `DataTable` (grid and cards) | The members table's `inset: -4px` override is gone; `members-target-size-2-2.spec.ts` still measures 24×24 |
| 78 | 5.11.0: `DataTable` `rowHeight="auto"` | The members and directory tables: names and badges wrap in full and rows grow (maintainer's choice, 28 Sep); the one-line truncation is gone |
| 79 | 5.12.0: `FilterSelect` (a compact "Status All ▾" trigger; AURA's list on a phone) | The members filters; `FilterChipSelect` is deleted |
| 80 | 5.13.0: `DataTable` column `card` / `cardOrder`, `hideSelectionInCards` | The members phone card (no checkbox, no ⋯ menu, no Last activity; the board's field order), shared with its skeleton through `MEMBERS_COLUMN_CARD`; the `PHONE_CARD` classes are gone |
| 81 | 5.13.0: static `Table` `align="middle"` and `bordered={false}` | Recent exports (frameless, centred) and the change-request queue (centred); the `.aura-tbl-wrap` / `.aura-tbl__td` overrides are gone there |
| 82 | 5.13.0: `EmptyState tone="danger"` (with `role` passed through) | `MembersErrorState`; the danger wrapper is gone |
| 83 | 5.13.0: `FilterBar` `searchGrow` | The members and directory filter bars, at AURA's own breakpoint (the search takes its own row below 768px); the `.aura-filterbar` overrides are gone |
| 84 | 5.13.0: `Td` / `Th` `card="title" \| "action"` on a stacked static `Table` | The change-request queue's phone card: company and member number as the title, Review beside it; the container-query grid is gone |
| 85 | 5.15.0: static `Table` `stackStyle="cards"` | The change-request queue's phone cards stand apart, each framed; the per-row `CARD` classes, the frameless wrap and the Review height reach are gone (Review takes `touchHeight`, #100) |
| 86 | 5.14.0: `EmptyState` `headingLevel={false}` | `shell/empty-state.tsx` renders AURA's `EmptyState` (title a `<p>`, the status role only with `announce`); the hand-built `aura-empty` markup is gone. A caller with no icon gets AURA's inbox icon (the directory list, the portal timeline) |
| 87 | 5.15.0: `Card` `header` | Loading cards (`AuraCardSkeleton`) and the change-request history card (pill above the h2 on phones) put their head in `header` |
| 88 | 5.14.0: `Stat` from `/server`, `headingLevel` | The portal dashboard's stat tiles (`StatCard`) and their loading tiles (`StatSkeleton`, `Stat loading`) |
| 89 | 5.15.0: `Progress` `secondaryValue` | The home benefits card's reserved E-Blasts, striped after the used ones |
| 90 | 5.15.0: underline `Tabs` `fullWidth="below-lg"` | The benefits tabs share the width on phones and tablets |
| 91 | 5.14.0: Drawer body scroll padding | The pay sheet's local `scroll-pt-4` is gone |
| 92 | 5.15.0: `FilterBar` `controlsLayout="fill"`, `stackBelow="lg"` | The invoice filters (search on its own row below 1024px) and the timeline filters (equal columns) |
| 93 | 5.15.0: `Card` `flushBelow="lg"` | The portal invoices list drops its frame where the rows become cards |
| 94 | 5.15.0: `Breadcrumb` `collapseBelow`, `itemProps` | `BreadcrumbNav`: the e2e `data-slot`s ride `itemProps`, the list slot a wrapper. The trail shows from 1024px only, so it needs no collapse |
| 95 | 5.16.0: `SideNav` action rows, `collapseToggle="row"` | The staff rail's labelled Collapse row and the phone drawer's Sign out |
| 96 | 5.16.0: `SideNav` `chevron="right"`; 8px header end padding | The staff nav's closed Settings group; the local chevron and header rules are gone |
| 97 | 5.14.0: `AppShell` `contentPadding={false}` | The staff and member frames; the page containers keep the padding |
| 98 | 5.16.0: `DataTable` `rangeSelect`, `onSelectionChange(keys, change)` | The members table's Shift-click range; the click-capture flag is gone |
| 99 | 5.15.0: `Checkbox` `hitArea` | The change-request decision rows' 40 × 32 target |
| 100 | 5.15.0: `touchHeight` on `Button` / `IconButton` (and Drawer `closeProps`) | The portal invoice and pay-sheet small buttons and the pay-sheet close: 44px on phones |
| 109 | 5.16.1: a custom `Select` keeps `--aura-bg-input` (the read-only rule no longer catches its button) | Every `Select`; no Chamber-OS change |
| 110 | 5.17.0: `Stat` attributes (`data-*`, `aria-*`), `status`, `linkArea="label"` | `StatCard`: `data-testid` / `data-variant` on the tile, the tone row in `status`, the label link stretched over the tile; `StatSkeleton` hidden with `aria-hidden` |
| 111 | 5.17.0: `Progress` `valueText` | The reserved E-Blasts bar reads "2 used, 1 reserved, 3 remaining of 6" while it shows "2 of 6 used" |
| 112 | 5.18.0: `Stepper` step `status: 'error'` ("has errors" in its name and the phone line) | The new-plan wizard: the step whose Next / Save failed, while it still has errors |

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
1. Bump the pin in a dedicated PR, or in the open phase PR that added the bridges it removes (5.7.0 – 5.7.2 rode in US1, 5.7.3 in US2, 5.8.0 in US3, and 5.9.0 and 5.10.0 in US4 for that reason).
2. Delete the `// AURA-handoff #NN` wrapper.
3. Update this table.
