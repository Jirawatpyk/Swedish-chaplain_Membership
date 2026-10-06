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
- **On a phone:** the chips wrap, as on Members.
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

The AURA handoff doc (a Claude Doc titled "AURA v4.9 handoff — Chamber-OS requirements") is the contract between Chamber-OS and AURA. Items 1–51 shipped in 5.5.0, items 52–56 (Addendum 4) in 5.6.0, items 57–62 (Addendum 5, found in US1) in 5.7.0, item 63 in 5.7.1, item 64 (Addendum 6) in 5.7.2, item 65 (Addendum 7, found in US2) in 5.7.3, items 66–69 (Addendum 8, found in US3) in 5.8.0, items 70–71 (Addendum 9, found in US4) in 5.9.0, items 72–74 (Addendum 10, found adopting 5.9.0 in US4) in 5.10.0, items 75–78 (Addendum 11, found in US5a) in 5.11.0, item 79 (Addendum 12) in 5.12.0 and items 80–84 (Addendum 13) in 5.13.0, items 85–100 (Addenda 14–15) in 5.14.0–5.16.0, items 101–108 (Addendum 16, found in US5b-1) in 5.14.0 and 5.16.0, item 109 (Addendum 17) in 5.16.1, items 110–111 (Addendum 18) in 5.17.0 and item 112 (Addendum 19, found in US6) in 5.18.0, items 113–116 (Addendum 20, found in US6) in 5.19.0 and 5.20.0 and items 118–119 (Addendum 22, found in US7a) in 5.22.0 and items 120–122 (Addenda 23–25, found in US7b) in 5.23.0 and item 123 (Addendum 26) in 5.24.0 and item 124 (Addendum 27) in 5.25.0 and items 125–129 (Addenda 28–32) in 5.26.0 and items 130–131 (Addenda 33–34) in 5.27.0 and items 132–133 (Addenda 35–36) in 5.28.0 and item 134 (Addendum 37) in 5.29, items 135–137 (Addenda 38–40) in 5.30.0, items 138–139 (Addenda 41–42) in 5.31.0 — **5.31.0** is the current pin. Items 85–100 (Addenda 14–15, found adopting 5.13.0 and applying the parity rule to US1–US5a) shipped in 5.14.0 (86, 88, 91, 97), 5.15.0 (85, 87, 89, 90, 92–94, 99, 100) and 5.16.0 (95, 96, 98), and are adopted below (T512). The two gaps found adopting them (Addendum 18: #110 `Stat`, #111 `Progress`) shipped in 5.17.0, and 5.16.1 fixed #109 (a custom `Select` painted with the disabled ground). Addendum 20 (items 113–116, found in US6: #113–#114 from the UX review, #115–#116 from the board check) shipped in 5.19.0 and 5.20.0, and US6 dropped each stand-in. Addendum 21 (#117, the directory's Recent exports rows) shipped in 5.21.0, and Addendum 22 (#118–#119, found in US7a) in 5.22.0:

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

No items are open (the ratchet in `tests/unit/architecture/aura-internal-class-ratchet.test.ts` reads this table; a new gap goes here as `| #N | … |`):

| Item | AURA gap | Chamber-OS stand-in |
|---|---|---|

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
