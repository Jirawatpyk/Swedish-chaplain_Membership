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
4. Its unit/component tests and every required CI check pass. The local e2e, `@a11y` and `@i18n` suites run only at the **checkpoints** — after US1, after US4/US8 (money), and before US13 — because a full run takes over an hour; per PR, CI runs only the `@critical` set, and the full suite runs nightly (`docs/runbooks/e2e-ci.md`).
5. Bundle budgets are re-baselined (`scripts/check-bundle-budgets.ts`, `ceil(kb/10)*10+100`).
6. An enterprise-ux-designer review has signed; on money screens, a financial-integrity review as well.
7. **No logic change.** A defect found along the way ships as its own PR, merged first.

**Board parity rule (US5a, 28 Sep 2026).** AURA's component defaults (spacing, sizes, radius, type scale) win over a board's pixel values. The board wins on content, structure, order, icons and copy. When a board value is clearly better, it goes to the AURA handoff, never into a per-page override. Styling that reaches into AURA's internal classes (`.aura-table__*`, `.aura-tbl__*`, `.aura-empty*`, `.aura-filterbar__*`, `.aura-card__*`, `.aura-alert*`, `.aura-stat*`, `.aura-progress*`, `.aura-nav*`, `.aura-shell*`, `.aura-bottomnav*`, a hand-applied `aura-icon`) is a stand-in: it gets a `stand-in until AURA #NN` comment naming an item open below. A reach AURA's owner agreed is app content (e.g. hiding part of a cell only on a stacked phone card) is labelled `AURA app content: <why>` instead. `tests/unit/architecture/aura-internal-class-ratchet.test.ts` enforces both over every `MIGRATED_PATHS` entry and `globals.css`, and fails on a label naming an item that is no longer open: when AURA ships an item, its stand-ins are swapped in the same PR that bumps the pin.

**Button icons (US8a, 2 Oct 2026).** The boards disagree with each other on button icons: 15 labels carry different icons on different boards. "Board wins on icons" therefore needs one rule, and this is it:
- **These actions carry an icon:**
  - create or add: `plus`;
  - download or export: `download`;
  - send or remind: `mail` or `send`;
  - confirm a money step: `check`, e.g. Record payment, or an as-paid issue;
  - retry: `rotate-ccw`;
  - destructive actions, with their own icons: Archive, Erase, Reject & refund, Void invoice (`archive`, as on `Admin-void`) and Delete draft… (`trash-2`, as on `Admin-invoice-issue`; US8b parity comment, 3 Oct).
- **These carry none:** Cancel, Save, Apply, Done, Review, Go back, and in-row text actions such as the invoice list's "Record payment…".
- **Exception:** a Cancel that works as "back" in a form header keeps the board's `arrow-left`, as on the member forms.
- **How to apply it:**
  - The same label carries the same icon on every screen.
  - On an AURA `Button`, use its `icon` prop.
  - On a link styled with `buttonClass`, put a lucide icon (`aria-hidden`, `size-4`) or the `/server` `Icon` before the text.
- **Where it was checked:** the 2 Oct audit compared every preview view with the boards. It found four buttons that broke the rule: Try again on the shared load-error card, Send reminder in the renewal pipeline, Invite colleague on the portal profile, and the invoice list's empty-state New invoice. `tests/unit/app/button-icon-rule.test.tsx` pins each one.

**List card (US8a, 2 Oct 2026).** The boards disagree on whether a list sits in a card: of the 14 admin list boards, 10 frame the filters and the table in one card; Members and Invoices do not, Credit notes does not, and Change requests does on some boards and not others. The rule:
- **A page whose main content is a list** puts its filters, result count, table (or empty state, or load error) and paging in one AURA `Card` with `flushBelow="sm"` and `max-sm:border-0 max-sm:p-0`. Below 640px the card drops its frame and padding, so the phone rows, which are cards of their own, sit on the page gutter.
- **A list that is one section of a page** (such as the invoices on a member's page) keeps that section's card; it gets no second one.
- **Inside the card** an empty state has no border of its own (`bordered={false}` on the shell `EmptyState`, no `bordered` on AURA's), so there is never a frame in a frame. A load error keeps its danger frame: the red border is how it reads as an alert (board `Admin-state-members-error`).
- **The route's `loading.tsx`** draws the same card, for CLS 0.
- **Where it applies today:** Plans, the renewals pipeline, escalation tasks, tier upgrades, Invoices, Members and Change requests. Lists still on the legacy kit take it in their own phase.
- **The table runs edge to edge inside the card** (maintainer, 2 Oct, the Polaris / GitHub pattern): no side borders or radius, the header band and rules kept, the filters on the card's padding. Applied with AURA 5.27's `bleed` (#127, #130), which reaches through our unpadded wrappers: from 640px up the table takes the card's full width, and the route's skeleton draws the same AURA table with `bleed`. A table that ends its card (tier upgrades) adds `bleedEnd`; one followed by a pager, a bulk bar or a note does not.

**Filters (decided and applied 2 Oct 2026).** The migrated lists use four different filter rows, and the boards disagree: Members draws AURA's `FilterBar`, while Change requests and Plans draw labelled form fields with an Apply button. The maintainer chose the pattern the large SaaS dashboards share (Stripe, Shopify Polaris, Vercel, GitHub, Jira):
- **One row:** the search first, if the list searches, then one compact `FilterSelect` per closed-set filter ("Status All"). The chosen value shows on its face, with no label above it.
- **Filter as you pick:** no Apply button for the row.
- **Dates:** one date-range control, not two date fields.
- **On/off filters:** a toggle chip (`Tag` with `selected` and `touchHeight`), like Members' "Needs portal invite".
- **More than four filters:** the rest go behind a "More filters" popover.
- **Always:** the result count through `FilterBar`'s `resultCount`, and "Clear all" while a filter is set.
- **On a phone** (15 Oct, AURA #146): every bar passes `collapseBelow="sm"`, so below 640px the filter controls fold into a "Filters (n)" sheet and the search, chips, Clear all, count and actions stay in the bar. A "More filters" popover lays its fields out flat in the sheet (render them as bar children when `useBreakpoint() === 'base'`). Keep every filter controlled (`value` + `onChange`): the sheet remounts what it moves. A toggle that is not a chip is added to `filterCount`.
- **Not covered:** a report form, which is a query someone runs on purpose (Tax registers' "View register"), keeps its labelled fields and button.
- **Where it changes:**
  - Members already follows it.
  - Invoices, shared with the portal list: plain `Select` becomes `FilterSelect`.
  - Change requests: Status becomes a `FilterSelect` and the two dates one range. The Apply button goes, and the URL parameters stay the same, including the inclusive end date.
  - Plans: search, Category and Year become `FilterSelect`s, and "Active only" and "Show deleted" become toggle chips.
- **Layout review of the mock** (UX, 2 Oct), carried into the filter PR:
  - **Result count:** always through `FilterBar`'s `resultCount`, at the right of the row, even with no search field. AURA moves it to its own line on a phone, and it is already a polite live region. Members gains one.
  - **Invoices:** "Status All" is untrue while drafts are hidden. The first status option says so ("All except drafts", admin only), and the drafts hint becomes a quiet line under the row, never part of the count, which does not wrap. The applied secondary filters move to `FilterBar`'s `filters` chips, and the popover button reads "More filters".
  - **Plans:** the order is Search → Year → Category → Active only → Show deleted. Year always has a value and stays put when the others hide for an empty year.
  - **Touch:** every toggle `Tag` (Plans and Members) and the Invoices "More filters" button take `touchHeight`, so the row is 44px on touch, like the `FilterSelect`s.
  - **A selected toggle chip** shows a check: AURA's toggle `Tag` swaps its icon for one while selected, so selection is not shown by colour alone and nothing extra is needed.
  - **Clear all** appears only for a non-default value. The change-request default status and the plans' current year do not count.
  - **Change requests:** Outcome appears right after Status, only under Decided, and focus stays on Status.
- **Dates:** AURA `FilterDateRange` (5.26, #128): a `FilterSelect`-style face that opens the range calendar in one click, with presets.
- **Applied:** in its own PR on AURA 5.26, after the mock review on 2 Oct. Every applied filter, select values included, is a removable chip in the bar (`filters`), which is what brings its "Clear filters"; a toggle chip in the row is not repeated, so when it is the only filter on, a ghost "Clear filters" sits beside it, as on Members. The change-request queue has no pre-hydration submit any more: `FilterDateRange` has no form field and nothing in the bar is typed.

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

The AURA handoff doc (a Claude Doc titled "AURA v4.9 handoff — Chamber-OS requirements") is the contract between Chamber-OS and AURA. Items 1–51 shipped in 5.5.0, items 52–56 (Addendum 4) in 5.6.0, items 57–62 (Addendum 5, found in US1) in 5.7.0, item 63 in 5.7.1, item 64 (Addendum 6) in 5.7.2, item 65 (Addendum 7, found in US2) in 5.7.3, items 66–69 (Addendum 8, found in US3) in 5.8.0, items 70–71 (Addendum 9, found in US4) in 5.9.0, items 72–74 (Addendum 10, found adopting 5.9.0 in US4) in 5.10.0, items 75–78 (Addendum 11, found in US5a) in 5.11.0, item 79 (Addendum 12) in 5.12.0 and items 80–84 (Addendum 13) in 5.13.0, items 85–100 (Addenda 14–15) in 5.14.0–5.16.0, items 101–108 (Addendum 16, found in US5b-1) in 5.14.0 and 5.16.0, item 109 (Addendum 17) in 5.16.1, items 110–111 (Addendum 18) in 5.17.0 and item 112 (Addendum 19, found in US6) in 5.18.0, items 113–116 (Addendum 20, found in US6) in 5.19.0 and 5.20.0 and items 118–119 (Addendum 22, found in US7a) in 5.22.0 and items 120–122 (Addenda 23–25, found in US7b) in 5.23.0 and item 123 (Addendum 26) in 5.24.0 and item 124 (Addendum 27) in 5.25.0 and items 125–129 (Addenda 28–32) in 5.26.0 and items 130–131 (Addenda 33–34) in 5.27.0 and items 132–133 (Addenda 35–36) in 5.28.0 and item 134 (Addendum 37) in 5.29, items 135–137 (Addenda 38–40) in 5.30.0, items 138–139 (Addenda 41–42) in 5.31.0, items 140–144 (Addenda 43–47) in 5.38.0 and 5.39.0, item 145 (Addendum 48) in 5.40.0, items 146–147 (Addendum 49) in 5.42.0, item 148 (Addendum 50) in 5.43.0, item 149 (Addendum 51) in 5.44.0, item 150 (Addendum 52) in 5.45.0, item 151 (Addendum 53) in 5.46.0, item 152 (Addendum 54) in 5.47.0, items 153–154 (Addendum 55) in 5.48.0 item 155 (Addendum 56) in 5.49.0 item 156 (Addendum 57) in 5.50.0 and items 157–163 (Addenda 58–64, found in US12b) in 5.51.0 and item 164 (Addendum 65) in 5.52.0 and item 165 (Addendum 66) in 5.53.0 and item 166 (Addendum 67) in 5.54.0 and items 167–168 (Addenda 68–69) in 5.55.0 and 5.56.0 and items 169–170 (Addenda 70–71) in 5.57.0 and items 171–172 (Addenda 72–73) in 5.58.0 and 5.59.0 and items 173–175 (Addenda 74–76) in 5.60.0 and item 176 (Addendum 77) in 5.61.0 and item 177 (Addendum 78) in 5.62.0 and item 178 (Addendum 79) in 5.63.0 — **5.63.0** is the current pin. The app's page header is AURA's `PageHeader` since 5.46 (#151), so #149's one-row actions reach every header, and the invoice page's phone bar is `actionsBarBelow` (#150): the hand-written `invoice-action-bar.tsx` is gone. Items 85–100 (Addenda 14–15, found adopting 5.13.0 and applying the parity rule to US1–US5a) shipped in 5.14.0 (86, 88, 91, 97), 5.15.0 (85, 87, 89, 90, 92–94, 99, 100) and 5.16.0 (95, 96, 98), and are adopted below (T512). The two gaps found adopting them (Addendum 18: #110 `Stat`, #111 `Progress`) shipped in 5.17.0, and 5.16.1 fixed #109 (a custom `Select` painted with the disabled ground). Addendum 20 (items 113–116, found in US6: #113–#114 from the UX review, #115–#116 from the board check) shipped in 5.19.0 and 5.20.0, and US6 dropped each stand-in. Addendum 21 (#117, the directory's Recent exports rows) shipped in 5.21.0, and Addendum 22 (#118–#119, found in US7a) in 5.22.0:

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
| 125 | 5.26.0: a RadioGroup option (and a labelled Checkbox) is named by its label alone, its description read after it; Accordion, Combobox and Command items follow | The new-invoice type and event-fee mode tests match exact names plus `toHaveAccessibleDescription`; the command palette's member option is named by the company, its number the description |
| 126 | 5.26.0: `Container` `align="start"`, attributes (`id`, `aria-*`, `data-*`) reach the element, and utilities overriding `max-width` / `margin` are guaranteed under `styles.layer.css` | Adopted with #131 (5.27, `/server`): the staff member and plan forms pass `align="start"`; widths (2 Oct) form `narrow` 720, detail and portal the 1280 default, table our 1536 override |
| 127 | 5.26.0: `bleed` on DataTable / Table (edge to edge inside a Card), DataTable `bordered={false}` | Adopted with #130 (5.27): the seven list cards pass `bleed`; no list uses `bordered={false}` |
| 128 | 5.26.0: `FilterDateRange`, a compact date-range filter for `FilterBar` with presets | The change-request queue's "Submitted" filter (the filter pattern, § Filters) |
| 129 | 5.26.0: Table `stickyHeader` (pins to the page under the shell's bar) and `maxHeight` | `/admin/plans` passes `stickyHeader` (FR-020); `table-consistency.spec.ts` checks the header stays in view while the page scrolls. DataTable's head pins only inside its own scroll box, so the DataTable lists do not pin to the page |
| 130 | 5.27.0: `bleed` reaches through wrappers that add no padding or frame and do not clip or scroll; `bleedEnd` closes the card's bottom corners when the table is its last content | The seven list cards and their skeletons pass `bleed` (§ List card); the tier upgrade queue, which ends its card, adds `bleedEnd` |
| 131 | 5.27.0: `Container` exported from `@jirawatpyk/aura-react/server`; the override guarantee covers padding | `src/components/layout/{form,detail,table}-container.tsx` render AURA `Container` (form `narrow` + `align`, detail the default, table our 1536px override), keeping our gutter and `data-slot` |
| 132 | 5.28.0: `FilterBar` chips take their own width, and a cut chip shows its full text on hover and focus | Nothing to change: the change-request range and company chips show in full |
| 133 | 5.28.0: the bar's own "Clear all" reaches the touch target height | Nothing to change: the row is 44px on touch end to end |
| 134 | 5.29.0: `DataTable` loading rows follow `rowHeight="auto"`; a column's `skeletonLines` draws one bar per text line, stacked skeleton cards keep their `data-label`, and `skeletonTouch` gives a touch-height footer a 44px bar | The renewal pipeline, tier upgrade and escalation task skeletons drop their own phone cards and the `max-sm:hidden` on `DataTableSkeleton`; the shared column layouts (`*-columns.ts`, `invoices-table-columns.ts`) carry `skeletonLines: 2` on two-line cells and `skeletonTouch` on touch-height actions |
| 135 | 5.30.0: `touchHeight` on TextField, Textarea, Select, RadioGroup and Checkbox; `"always"` gives a 44px field box or choice row at every width, `true` only below 640px or on a coarse pointer | The issue dialog's zero-rate radio group, certificate number and date, and typed-phrase field pass `touchHeight="always"` (088 FR-036); the `_lib/touch-targets.ts` stand-in goes |
| 136 | 5.30.0: an open `Menu` moves with its trigger on scroll and resize, closing only once the trigger leaves view (inside a Dialog or Drawer focus returns to the trigger) | The e2e retries around the closing menu go (`event-fee-as-paid`, the renewal pipeline's row menu, PR #506) |
| 137 | 5.30.0: `StatusPill` text is a fixed 500 weight (Badge stays 600) | Nothing to change: the pills beside the invoice h1 and in the lists render at 500 |
| 138 | 5.31.0: `labelAddon` on TextField, Textarea, PasswordField and Field, a node between the label and the box (`.aura-field__addon`, id `{id}-addon`), first in the input's `aria-describedby` (`labelAddonDescribes={false}` keeps it out) | The typed-phrase chip sits above the box on the void page and in the full-refund dialog; the hand-wired chip id leaves the input's `aria-describedby` (US8c-2) |
| 139 | 5.31.0: `aura-theme` / `createTheme` emit `--aura-control-checked-bg/-fg` from the brand (#10487A: light `#2e6397` with a white mark, dark `#9cc5f1` with an ink mark) | `src/styles/aura-theme.css` regenerated; the hand-written `src/styles/aura-overrides.css` stand-in and its test go (US8c-2) |
| 140 | 5.38.0: `touchHeight` on `FilterBar` and `FilterSelect` — 44px below 640px or on a coarse pointer for the bar's search and every field-height control in it | `touchHeight` on every AURA `FilterBar` (users, audit, erasure log, events, attendees, directory ×2, timeline, change requests, invoices, credit notes, plans) |
| 141 | 5.38.0: `touchHeight` on `Combobox`, `DatePicker`, `DateRangePicker`, `TimePicker`, `NumberField`, with 44px inner buttons | On the pickers beside 44px fields: member picker (invite dialog), event picker, relink dialog, reminder step card, inline event create |
| 142 | 5.38.0: DataTable `rowProps` for `data-*` and `id` on rows | Nothing to change: `/admin/users` keeps its static `Table` (its phone cards are its own) |
| 143 | 5.39.0: `Tabs` `touchHeight` for link and button tabs in both variants; `FilterDateRange` `touchHeight` (and the bar's reaches it) | `touchHeight` on every `Tabs` (renewals, erasure log, member detail sections, schedules, benefits, pay sheet, plan locale) |
| 144 | Not a gap (AURA status, 13 Oct): the search box is 44px on touch; the 42px measured was the `<input>` inside its 1px border, as in every AURA text box. Below 640px with a mouse the bar's `touchHeight` (#140) makes it 44px | As #140; measure the box (`.aura-filterbar__search`), not the `searchbox` |
| 145 | 5.40.0: type follows the browser's default font size (`max(<px>, <rem>)` for every font size and px line height; Badge, small SegmentedControl options, the calendar title and the DataTable footer grow with their text) | Nothing to change in code: identical at the default 16px, and text scales at a larger default size (checked at 32px, 390 wide) |
| 146 | 5.42.0: `FilterBar` `collapseBelow` — below the breakpoint the children move behind a "Filters (n)" button opening a sheet (one labelled row each, Clear all + Done); search, chips, count and actions stay in the bar | `collapseBelow="sm"` on all 12 AURA `FilterBar`s (an architecture test keeps it); the invoices and audit "More filters" fields are bar children below 640px so the sheet lists them flat; the timeline's own phone toggle goes; bars with toggles that are not chips pass `filterCount`; the audit acting user is controlled |
| 147 | 5.42.0: `.aura-input` has `min-width: 0` and its control a percentage width, so no text box widens a phone at a large default size (FilterBar search, fields in grids and row Stacks) | Nothing to change: at 32px / 390 no list scrolls sideways any more |
| 148 | 5.43.0: `FilterBar` `collapseBelow` with no search — the lead row is `is-alone` and the Filters button fills it below the breakpoint | The timeline (portal and staff) drops its `max-sm:[&_.aura-filterbar__more]:flex-1` stand-in |
| 151 | 5.46.0: `PageHeader` `subtitle`, `titleAddon`, an eyebrow of chips (a `div`), `size` hero/hero-lg, `focusTitleOnMount`, `actionsAlign` | `src/components/layout/page-header.tsx` is a thin wrapper over `PageHeader` with the same props (badge → `titleAddon`, autoFocusTitle → `focusTitleOnMount`, portal → `actionsAlign="start"` via `useDensity()`, `actionsFullWidthBelow="sm"`); sizes per #152 |
| 152 | 5.47.0: `PageHeader` `size="compact"` (26 / 32px), `hero` 30 → 36px from 1024px, `--aura-page-header-hero-space` | The wrapper maps `default` to `size="compact"`; `.chamber-portal` sets the hero space to 4px (8px from 1024px), so a hero title sits 24 / 40px down as the boards draw it |
| 153 | 5.48.0: `PageHeader` `actionsBarBelow` defaults to ActionBar's edge strip (full width, top border; `actionsBarLook="floating"` keeps the card) | Nothing to change: the invoice phone bar is the board's strip |
| 154 | 5.48.0: on a screen 480px tall or less `actionsBarBelow` is not fixed (the actions return to the header row, laid out by `actionsFullWidthBelow`), viewport `ActionBar`s go static and AppShell's top bar scrolls away | The wrapper always passes `actionsFullWidthBelow="sm"` with the bar, so a short screen gets the full-width row |
| 155 | 5.49.0: the #154 short-screen thresholds are `30rem` / `30.00125rem`, so they follow the browser's text size (Chrome, Edge, Firefox; not iOS Dynamic Type); AppShell re-measures its bar height when the text size changes | Nothing to change: at a 32px default font a 390×844 phone gets the header-row actions, a static ActionBar and a top bar that scrolls away |
| 156 | 5.50.0: `TextField`, `Textarea` and `Field` take `invalid` — the danger border and `aria-invalid="true"` with no message, and `aria-describedby` left as it is | The brand colour field passes `invalid`; its field-DOM selector stand-in is gone |
| 157–163 | 5.51.0: DataTable `sortDirection` (a fixed `aria-sort`, #157), `StatusPill wrap` (#158), the row minimum counts each flexible column's `minWidth` (#159), a toggle `Tag` inside FilterBar shows its whole label from 640px (#160), `keyboard="tab"` (row controls are Tab stops, #161), a column `grow` weight (#162), and `.aura-table__scroll` contains only the sideways axis (#163) | The E-Blast queue drops its stand-ins: `sortDirection` on the column the page orders by (no `aria-sort` effect), `wrap` on the Stage pill (no `[&_.aura-pill]` classes), no `--queue-row-min`, `grow: 2.5` on Actions (no `:has()` grow classes), `keyboard="tab"`, and the filter Tags lose their `.aura-tag__text` reach; `globals.css` drops its `overscroll-behavior-y` override |
| 164 | 5.52.0: a static `Table` takes `loading` / `loadingRows`, and `TableSkeleton` (from `/server`) draws the same loading table for a route's `loading.tsx` (#164) | The users and audit skeletons are `TableSkeleton` with the real columns' shares; the app's `StaticTableSkeleton` is gone |
| 165 | 5.53.0: below 640px a Dialog or Drawer footer's Buttons (direct, or the only Button in a wrapper) are at least 44px and wrap, whatever the density; `fullWidth="below-sm"` / `"below-md"` on Button and `buttonClass` (#165) | The `touchHeight` on every Dialog footer Button (about 70) and `FULL_WIDTH_BELOW_SM` are gone; phone-only stretched rows use `fullWidth="below-sm"`. `tests/unit/architecture/dialog-footer-touch.test.ts` now refuses a `touchHeight` there and any container `w-full` stretch |
| 166 | 5.54.0: below 640px every Button in an `ActionBar`'s `children` and `start` (and a `PageHeader` `actionsBarBelow` bar) is at least 44px, whatever the density (#166) | The bars' per-button `touchHeight` is gone (bulk bars, E-Blast detail, template form). The rule is viewport-based; on a touch tablet from 640px, compact density already makes a default button 44px (`pointer: coarse`); a `size="sm"` button does not, so the nine `size="sm"` buttons in the members, renewal pipeline and E-Blast queue bulk bars keep `touchHeight` to hold #123's 44px on a touch tablet (R69 caught `renewal-a11y` #123 at 32px; maintainer, 22 Oct). The guard asks for `touchHeight` on every `size="sm"` button in a footer or bar, and refuses it on a default-size one. The E-Blast ⋯ IconButton keeps `touchHeight`: inside DropdownMenu it sits two wrappers deep, past AURA's IconButton rule. The invoice-settings save bar drops its `min-h-11` too: 088 FR-036 asks for 44px on phones, which the bar now gives (maintainer, 22 Oct: consistent with the other bars) |
| 167 | 5.55.0: the footer and ActionBar rules (#165, #166) use touchHeight's query, `(max-width: 639.98px), (pointer: coarse)`, and reach `size="sm"` Buttons too (#167) | The nine `size="sm"` bulk-bar buttons (members ×5, renewal pipeline ×2, E-Blast queue ×2) drop the `touchHeight` R69 restored: AURA now gives them 44px on a touch tablet. `dialog-footer-touch.test.ts` refuses `touchHeight` on any Button in a footer or bar, whatever its size, and `small-button-touch.test.ts` leaves those Buttons to AURA. The bars' own `touchHeight` prop (their Clear, #122) stays |
| 168 | 5.56.0: AppShell's menu button ("Open navigation") carries `touchHeight` itself (#168) | No app change: the staff shell's menu button is 44px below 640px or on a coarse pointer, where it was 32px at 390 |
| 169–170 | 5.57.0: a Dialog, Drawer or Popover never picks, or Tabs to, a control inside a closed `<details>`, and the `<summary>` counts as a stop (#169); a titled `Alert` with a role is named by its title through `aria-labelledby` (#170) | The company details Drawer drops `data-autofocus` on its Close button and opens on the record's first visible control (the "Technical details" summary on a member with no Tax ID or website); `ErasedBanner` drops `aria-label={title}`, and the renewal first-renewal welcome (a `/server` Alert, which can't generate an id) takes `id="renewal-onboarding"` so AURA names it through `aria-labelledby`, not a fallback `aria-label`. Both are `note`s, so AURA's open point (a live `alert`/`status` read twice by some screen readers) does not apply |
| 171–172 | 5.58.0: with `touchHeight`, a short tab is at least 44px wide as well as tall below 640px or on a coarse pointer (#171); 5.59.0: `linkClass({ tone, underline, touchHeight, className })`, from the root and `/server`, styles a text link (or a `<button>` with its chrome reset) with the accent colour, underline, Button's focus ring and a 44×44 target below 640px or on a coarse pointer (#172) | #171 needs no app change: the section tabs on member detail and invoice settings already pass `touchHeight`. #172: `linkClass({ underline: 'hover', touchHeight: true })` replaces the hand-written accent colour, focus ring and `max-sm:min-h-11` / `pointer-coarse:min-h-11` on nine text links: the event picker's "Create new event" button, the portal profile's "More details" summary, website, email and phone links, the plans list's plan name, the marketing audience card's company, brand settings' "Manage" logo link, the renewal cycle's invoice link and the finance dashboard's oldest-overdue document number. A Tailwind utility on the same element wins over `aura` (a later layer), so none of them carries `flex`, `min-w-0` or a `min-h-*` |
| 173–175 | 5.60.0: a `touchHeight` link (and a `<button>` or `<summary>` with the class) is laid out at every width — `inline-flex`, centred, a 4px icon gap, `min-width: 0`, `max-width: 100%`, a summary that hugs its text, the label at the start under the touch query — and a type class on the `<a>` wins (#173); a static `Td` / `Th` wraps between words by default (`overflow-wrap: break-word`) and takes `wrap="word" | "none" | "anywhere"` (#174); a wide `stickyHeader` table puts its header in flow above the first row (#175) | #173: the hand-written `inline-flex items-center`, `min-w-0`, `max-w-full`, `flex w-fit list-none`, the marker hide and `justify-start` go from the event picker, the portal profile's website, More details, email and phone links. `self-start` stays where a flex parent would stretch the link across the row (picker, brand, renewal cycle, audience card: 606px instead of 127 at 1280 without it); the picker's label type stays on a child span, because AURA's button font reset (layer `aura`) beats `aura-text-label` (layer `aura-tokens`). #174: `[overflow-wrap:normal]` goes from the plans name, finance buyer, change-request member/submitter/fields and template name/locale cells; `whitespace-nowrap` on the finance document number and due date and the change-request Submitted cell becomes `wrap="none"`; and text with no break points no longer widens its table: the audit log's codes, ids and detail values take `[overflow-wrap:anywhere]` on their own spans (the labels beside them keep wrapping between words), and the users list's email gets a `<wbr>` after its `@` (without these the audit table ran 326px past its box at 768; now 49px, 64 on 5.59). The narrow-grid column drops, the template Subject cut, Overdue below the wait and `TIGHT_CELLS_IN_NARROWEST_GRID` stay: they are about fit, labelled as app content. #175 needs no app change |
| 176 | 5.61.0: the page-header share rule (`flex: 1 1 0; min-width: max-content`, in `actionsFullWidthBelow` sm/md/lg and the `actionsBarBelow` bar) skips a visually hidden child (`.sr-only`, `.aura-sr-only`, `.visually-hidden`, `.screen-reader-text`, `[hidden]`, an inline `position: absolute`) | The admin credit note's hidden "Email a copy" description keeps its 1px box at 390, so the page no longer scrolls ~250px sideways; the `.sr-only { min-width: 0 }` stand-in drafted in #634 never shipped, and `tests/unit/app/sr-only-min-width.test.ts` guards that it stays gone |
| 177 | 5.62.0: a `PageHeader` `meta` made only of elements (Badges, a StatusPill; Fragments and arrays looked through) is a wrapping row 8px apart, like `eyebrow` (`.aura-page-header__meta--rich`); any text keeps it a line (#177) | Not enough on its own: in `next dev` a server-component chip reaches the client as a `react.lazy` node, which the check does not count, so the row stays a text line (R84 found the chips 0px apart on a dev server; a production build was right). The Dashboard and Benefits chips keep the page-side row as a stand-in for #178 |
| 178 | 5.63.0: `PageHeader` `metaLayout` (`row` / `line` / `auto`); `row` lays `meta` out as the wrapping chip row whatever its children are, and `auto` now looks through resolved lazy nodes (#178) | The Dashboard and Benefits headers (and the `aura-portal` fixture) pass `metaLayout="row"`; the page-side row div is gone. `tests/unit/app/portal/portal-header-meta-chips.test.ts` asks every portal `meta` with a Badge or StatusPill for `metaLayout="row"` |
| 179 | 5.64.0: `Progress` `legend={{ value?, secondary }}`, a key under the bar shown only while the reserved part is drawn; aria-hidden; swatches in the bar's tone, the second striped; the valuetext names the reserved count (#179) | The quota card (`quota-display.tsx`) and the Dashboard's E-Blast bar pass `legend`; the app's `quota-legend.tsx` is deleted |
| 180 | 5.65.0: `IconButton` draws `aria-pressed="true"` (or the new `pressed` prop) as on: the selected fill with an accent icon, Highlight in forced colours (#180) | The E-Blast editor toolbar passes `pressed`; its `aria-pressed:` stand-in classes are gone |
| 181 | 5.66.0: a checkable `Menu` item with an `icon` keeps the icon at the start and shows its state as a check mark at the end; `checkPlacement: 'start'` keeps the old look (#181) | The phone toolbar's "Lists and headings" menu shows its icons with trailing checks; no code change (the items already pass `icon`) |
| 182 | 5.66.0: `Combobox` takes `invalid` and `aria-describedby`, as `TextField` (#182) | `MemberPicker` passes both: staff compose's member refusals mark the picker invalid and are read after its name (`proxy-compose-form.tsx`); the stand-in is gone |
| 183 | 5.67.0: `CheckboxGroup`, RadioGroup's many-choice twin: a fieldset named by its legend with `hint`, `error` (each box `aria-invalid`, pointing at the error line), `required` (a `*` and a hidden "(required)" in EN/TH/SV), `touchHeight`, values in option order (#183) | `segment-picker.tsx` `TierCategoriesField` is one `<CheckboxGroup required hint error>`; the stand-in fieldset, legend and hint paragraph are gone. Until 5.68 the field kept its own polite `sr-only` status for the error, which #184 replaced with `errorLive` |
| 184 | 5.68.0: `RadioGroup` and `CheckboxGroup` add `is-disabled` when `disabled`, so the legend greys like a disabled `Field` label; `errorLive` on `CheckboxGroup` / `RadioGroup` / `Field` keeps an empty polite error line in the page that fills when the error appears (#184) | The recipients radio and the categories group grey their legends while the compose form is busy, with no app change. `TierCategoriesField` passes `errorLive`; its `sr-only` `role="status"` stand-in is gone |
| 185 | 5.69.0: `ActionBar` `look="edge"` and `edgeBelow="sm"\|"md"`: PageHeader's edge strip below the breakpoint (full width, top border only, on the bottom edge or a BottomNav, fixed, the page padded by `--aura-actionbar-height`), the floating card above it (#185) | Every viewport `ActionBar` passes `edgeBelow="sm"` (D-039, PR N1; `viewport-actionbar-edge.test.ts`). The app's phone edge rules and the from-640 static rows in `globals.css` are gone; `useActionBarClearance` counts only the sticky card |
| 186 | 5.70.0: `Button` merges a passed `aria-busy` with `loading`; a link `Button` and `IconButton` keep a passed `aria-disabled` and swallow clicks (#186) | PR N1 rides the pin: the E-Blast phone toolbar's menu buttons, `aria-disabled` while the host saves, no longer open their menus (the maintainer, 30 Oct). The Resend button's swap is PR P |
| 187–190 | 5.70.0: `Pagination mode="cursor"` (#187), sortable `Th` (#188), `Spinner` + `StatusPill busy` (#189), `FileUpload variant="button"` (#190) | Pinned in PR N1; adopted in PRs O–Q |
| 191 | 5.71.0: `PageHeader actionsBar` — with `actionsBarBelow`, only those actions become the phone bar; `actions` stay in the page (handoff addendum 92) | Adopted (PR R): the portal invoice's pay bar is the `actionsBar` strip; the hand-built `max-sm:fixed` bar, its spacer and its `globals.css` scroll padding are gone |
| 192 | 5.72.0 / 5.73.0: an edge `ActionBar` (and a PageHeader bar) with no box — in a hidden tab panel, by any hiding — is skipped when the page is padded for the strip | Pinned in PR N2. The renewal schedule editor keeps mounting its save bar only in the active tier tab, the shape AURA calls simplest |
| 193 | 5.74.0: a PageHeader bar whose content is all hidden (but its status) takes no box and drops its page padding | Adopted in PR N2: the `globals.css` rule that hid the portal pay-bar strip (`stand-in until AURA #193`) is gone |
| — | Chamber-OS rule, no AURA change (22 Oct): a `size="sm"` Button or `buttonClass` in a page body, and every IconButton (32px whatever its `size`, which sizes the icon), carries `touchHeight` everywhere the user taps it: page bodies, tables, row ⋯ menus, copy buttons, the top bar (57 sites), since no AURA rule sizes these in a body | Compact by design: only the help icon beside a heading or label (an `IconButton` as a `Popover` trigger; `InfoHint` renders the same one since PR 6). Guarded by `small-button-touch.test.ts`, which since 5.55 (#167) leaves a Button in a footer or bar to AURA |

Open items (the ratchet in `tests/unit/architecture/aura-internal-class-ratchet.test.ts` reads this table; a new gap goes here as `| #N | … |`):

| Item | AURA gap | Chamber-OS stand-in |
|---|---|---|
| #194 | A `Dialog` with `footer` on a very short screen (320×256, i.e. 400% zoom; landscape with the keyboard open): the head, description and footer are `flex: none`, so the scrolling body can shrink to nothing and its fields can't be reached (WCAG 1.4.10). Ask: under `max-height: 30rem` the dialog scrolls as one box (handoff addendum 95, found in PR N2) | `globals.css`, `stand-in until AURA #194`: under `max-height: 30rem` the `.aura-dialog` panel scrolls (`overflow-y: auto`) and `.aura-dialog__body` stops shrinking (`flex: none; min-height: auto; overflow: visible`), the footer at the end of the content; guarded by `tests/unit/styles/dialog-short-screen-css.test.ts` |

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
| 92 | 5.15.0: `FilterBar` `controlsLayout="fill"`, `stackBelow="lg"` | The timeline filters (equal columns); the invoice filters used it until the filter pattern (2 Oct 2026) |
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
