# Feature Specification: Page Layout Enterprise Standardization & Responsive Design

**Feature Branch**: `004-page-layout-standard`  
**Created**: 2026-04-12  
**Status**: Draft  
**Input**: User description: "page layout enterprise standardization and responsive design"

## Clarifications

### Session 2026-04-12

- Q: What standard max-width should the admin outer content container use? → A: `max-w-6xl` (72rem / 1152px). Inner components control their own narrower widths as needed.
- Q: How should breadcrumbs resolve human-readable labels for dynamic route segments (e.g., plan names from UUIDs)? → A: Each page passes labels via props/context — no extra API fetch in the breadcrumb component itself.
- Q: Should all existing admin pages be migrated to the new page shell within this feature, or incrementally? → A: Migrate all existing pages (~5) within this feature to achieve 100% adoption before ship.
- Q: How should page header action buttons behave when they overflow on narrow viewports? → A: Actions wrap to a second line below the title — all actions remain visible without an overflow menu.

### Session 2026-04-12 (Round 2 — post scope expansion)

- Q: Button vs Input height reconciliation (FR-014 `h-8`=32px vs FR-019 `--input-height`=36px conflict)? → A: Both 36px. Button `size="default"` is updated from `h-8` (32px) to `h-9` (36px) so buttons visually align with inputs in forms and meet WCAG touch-target guidance.
- Q: Typography utility class naming for FR-017 scale? → A: Semantic classes — `.text-h1`, `.text-h2`, `.text-h3`, `.text-h4`, `.text-body`, `.text-caption` (not Tailwind native `text-2xl` nor element-selector styles), because semantic classes encode size + weight + Thai line-height in one reusable unit.
- Q: Should F4 ship as one atomic feature (92 tasks) or split into F4a (Layout) + F4b (Design System)? → A: Ship as one atomic F4 — avoids intermediate visual inconsistency during the migration window; all 11 user stories ship together in a single coordinated release.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Consistent Page Structure Across Admin Pages (Priority: P1)

As a staff user (admin or manager), when I navigate between different admin pages — users, plans, settings, dashboard — every page looks structurally identical: a clear page title area at the top with optional subtitle and action buttons, followed by the main content area with consistent spacing and maximum width. This eliminates the current visual inconsistency where each page uses different heading sizes, spacing, and content widths.

**Why this priority**: Structural consistency is the foundation of enterprise UX. Without it, every subsequent feature (F4 invoicing, F5 payments, F6 events) will continue ad-hoc layouts, compounding technical debt and visual fragmentation.

**Independent Test**: Navigate to every admin page (/admin/dashboard, /admin/users, /admin/plans, /admin/settings/fees) and verify that page title, subtitle, action area, and content container all follow the same visual pattern with identical spacing and max-width.

**Acceptance Scenarios**:

1. **Given** a staff user on any admin page, **When** the page loads, **Then** a standardized page header displays the page title, optional subtitle, and optional action buttons in a consistent layout across all pages.
2. **Given** a staff user comparing two admin pages side-by-side, **When** both pages render, **Then** the title font size, spacing below the title, content container width, and horizontal padding are visually identical.
3. **Given** a newly created admin page, **When** a developer uses the page shell component, **Then** the page automatically inherits correct heading, spacing, and container width without manual styling.

---

### User Story 2 - Responsive Admin Layout on Mobile Devices (Priority: P1)

As a staff user accessing the admin portal from a tablet or phone, the page content reflows gracefully: single-column layouts replace multi-column grids, page headers stack vertically when action buttons overflow, and content remains readable without horizontal scrolling. The sidebar already collapses to a Sheet overlay on mobile — now the page content area itself must adapt properly.

**Why this priority**: Thai chamber staff frequently access the system from mobile devices while at events or meetings. A responsive content area (not just sidebar) is essential for real-world usability.

**Independent Test**: Open any admin page on a 375px-wide viewport (mobile) and a 768px viewport (tablet) — content is fully usable without horizontal scrolling, all actions are reachable, and data grids collapse to stacked cards or single-column layouts.

**Acceptance Scenarios**:

1. **Given** a staff user on a 375px-wide viewport, **When** viewing any admin page, **Then** the content area uses full width with appropriate padding, no horizontal scrollbar appears, and all interactive elements are reachable.
2. **Given** a staff user on a 768px-wide viewport, **When** viewing a page with a two-column detail grid, **Then** the grid transitions to a single-column layout.
3. **Given** a page header with a title and multiple action buttons, **When** the viewport is narrower than 640px, **Then** the actions wrap to a second line below the title, remaining fully visible without a dropdown menu.

---

### User Story 3 - Breadcrumb Navigation on All Admin Pages (Priority: P2)

As a staff user navigating nested admin pages (e.g., Plans > 2026 > Corporate Gold > Edit), a consistent breadcrumb trail shows my location in the hierarchy and lets me jump back to any ancestor page. Currently breadcrumbs exist only in the Plans section — this extends them to all admin areas.

**Why this priority**: As the platform grows with F4–F10 features, deep page nesting will increase. Universal breadcrumbs prevent disorientation and reduce reliance on the browser back button. This is important but not blocking — the sidebar already provides primary navigation.

**Independent Test**: Navigate to a deeply nested page in any admin section and verify breadcrumbs show the full path with clickable links for each ancestor.

**Acceptance Scenarios**:

1. **Given** a staff user navigating to `/admin/plans/2026/plan-id`, **When** the page loads, **Then** breadcrumbs display: Admin > Plans > 2026 > [Plan Name], and each segment is a clickable link.
2. **Given** a staff user on a top-level admin page like `/admin/users` (depth 2), **When** the page loads, **Then** NO breadcrumb is rendered — the sidebar active state and the page `<h1>` already communicate location, avoiding duplicate information.
3. **Given** a staff user on mobile (< 640px viewport), **When** viewing breadcrumbs, **Then** only the current page and immediate parent are shown (truncated breadcrumbs), with a "..." indicator for deeper ancestors.

---

### User Story 4 - Consistent Member Portal Page Layout (Priority: P2)

As a member accessing the self-service portal, pages follow the same standardized structure as the admin portal — a consistent header area, content container, and responsive behavior — adapted for the simpler horizontal-nav layout of the member portal. The current `max-w-5xl` container is formalized as the portal's content standard.

**Why this priority**: The member portal will grow significantly from F3 onwards (member directory, benefit dashboard, profile). Standardizing now prevents the same fragmentation that occurred in the admin portal.

**Independent Test**: Navigate to the member portal landing page and any future member pages — they share the same header pattern, container width, and responsive behavior.

**Acceptance Scenarios**:

1. **Given** a member on the portal landing page, **When** the page loads, **Then** the content is centered with the standardized portal container width and consistent header treatment.
2. **Given** a member on a 375px viewport, **When** viewing any portal page, **Then** content uses full-width with appropriate mobile padding and no horizontal scrolling.

---

### User Story 5 - Loading & Empty States in Page Shell (Priority: P3)

As a staff or member user, when a page is loading data or has no content to display, a standardized loading skeleton or empty-state illustration appears in the content area — consistent across all pages rather than each page implementing its own shimmer or "no data" message.

**Why this priority**: While `empty-state.tsx` and skeleton components exist, they aren't composed into the page shell. This is a polish item that improves perceived quality.

**Independent Test**: Throttle the network and navigate to any admin page — the page shell shows shimmer skeletons in the content area. Navigate to a page with no data and see a consistent empty state.

**Acceptance Scenarios**:

1. **Given** a page that is loading data, **When** the shell renders before data arrives, **Then** a shimmer skeleton appears in the content area matching the expected content layout.
2. **Given** a page with no data (e.g., no plans created), **When** the page renders, **Then** a standardized empty-state component appears with an icon, message, and optional action button (e.g., "Create your first plan").

---

### User Story 6 - Button Cursor & Disabled State Consistency (Priority: P2)

As a staff or member user interacting with any button in the system, the cursor visually confirms whether the button is clickable: a pointer cursor on hover when enabled, a not-allowed cursor when disabled. Disabled buttons also show reduced opacity and do not respond to clicks. This consistent affordance across all button variants (default, outline, secondary, ghost, destructive, link, icon) eliminates the current ambiguity where the browser's default arrow cursor makes buttons feel less interactive.

**Why this priority**: Cursor feedback is a fundamental interaction primitive expected by users of enterprise software. The current Button component lacks `cursor-pointer` on hover, making buttons feel less responsive than competing products. Fix is low-cost (single line in `buttonVariants`) but broadly visible.

**Independent Test**: Hover over any button on any page — cursor changes to pointer when enabled, not-allowed when disabled. Verified with Playwright hover + pseudo-class inspection on every Button variant and size.

**Acceptance Scenarios**:

1. **Given** a user on any page, **When** hovering over an enabled button (any variant, any size), **Then** the cursor changes to `pointer` indicating the element is clickable.
2. **Given** a user on any page, **When** hovering over a disabled button, **Then** the cursor shows `not-allowed`, the button opacity is reduced to 50%, and click events have no effect.
3. **Given** an icon button (size="icon" or "icon-sm"), **When** hovered in enabled or disabled state, **Then** the cursor behaviour is identical to a text button in the same state.

---

### User Story 7 - Typography Scale System (Priority: P2)

As a designer / developer working on any Chamber-OS page, I use a single canonical typography scale — h1 through h6, body, caption, all defined via design tokens — so that every heading and text element across admin and portal shares identical sizing and weight. Currently only h1 is standardized via PageHeader (FR-001); h2–h6 and inline text styles are ad-hoc.

**Why this priority**: Typography is the second most visible consistency axis after layout. Without a scale, h2 in Users page, h2 in Plans card, and h2 in Dialog all render at different sizes.

**Independent Test**: Inspect every heading on admin + portal — all h1 size X, h2 size Y, h3 size Z consistently. No inline `text-xl` / `text-2xl` utility on heading elements.

**Acceptance Scenarios**:

1. **Given** any admin or portal page, **When** any `<h2>` is rendered, **Then** its computed font-size and font-weight match the `--font-size-h2` and `--font-weight-heading` tokens.
2. **Given** body text on any page, **When** rendered, **Then** it inherits `--font-size-body` and `--line-height-body` (Thai-aware line-height for `th-TH` locale).

---

### User Story 8 - Universal Focus Ring (Priority: P2)

As a keyboard user navigating Chamber-OS with Tab, every interactive element (buttons, links, inputs, checkboxes, selects, menu triggers, tabs) shows a visible, consistent focus ring — matching the existing Button `focus-visible:ring-3 focus-visible:ring-ring/50` pattern. Currently buttons have it; other interactives are inconsistent or missing.

**Why this priority**: WCAG 2.1 AA § 2.4.7 (Focus Visible) is mandatory. Inconsistent focus rings hurt accessibility and break keyboard UX.

**Independent Test**: Keyboard-tab through every interactive element on 5 representative pages — every element receives a visible focus ring of identical style.

**Acceptance Scenarios**:

1. **Given** a user navigating via Tab key, **When** focus lands on any interactive element, **Then** a 3px `ring-ring/50` outline appears around the element.
2. **Given** an element is in hover and focus state simultaneously, **When** rendered, **Then** the focus ring remains visible on top of the hover background.

---

### User Story 9 - Form Field Consistency (Priority: P3)

As a staff user filling out forms (plan creation, user invitation, fee configuration), every form control — Input, Textarea, Select, Checkbox, Radio, Switch — shares consistent height, padding, label typography, error-state appearance, and disabled-state treatment. Currently fields rely on shadcn defaults but labels, spacing, and error visuals vary per page.

**Why this priority**: Forms are the primary data-entry surface. Inconsistency makes the product feel unfinished and increases cognitive load.

**Independent Test**: Compare Users invite form, Plan create form, and Fees configuration form — all inputs share identical height (e.g., 2.25rem / 36px), identical label-to-field spacing, identical error state treatment.

**Acceptance Scenarios**:

1. **Given** any form on admin or portal, **When** rendered, **Then** all text Inputs have identical computed height (from `--input-height` token) and identical label-gap.
2. **Given** a form field in error state, **When** rendered, **Then** the border color, helper-text color, and icon (if present) match the canonical error-state tokens.
3. **Given** a disabled form field, **When** rendered, **Then** it shows `opacity: 0.5` + `cursor: not-allowed` + non-interactive, mirroring FR-014 Button disabled behaviour.

---

### User Story 10 - Data Table Consistency (Priority: P3)

As a staff user viewing any data table (Users, Plans list, future Members/Invoices), every table shares consistent row height, cell padding, header styling, and row hover treatment. Currently the Users table and Plans table use shadcn `<Table>` defaults but with ad-hoc padding variations.

**Why this priority**: F3 Members (hundreds of rows) and F4 Invoices will stress-test table patterns; standardizing now prevents each new table from re-inventing a slightly different look.

**Independent Test**: Inspect Users table and Plans table — row heights identical, cell padding identical, header typography identical, hover row highlight identical.

**Acceptance Scenarios**:

1. **Given** any data table in admin, **When** rendered, **Then** rows have computed height = `--table-row-height` token; th and td use `--table-cell-padding-x/y` tokens.
2. **Given** a user hovering a table row, **When** the cursor enters, **Then** the row background changes to `--table-row-hover-bg` consistently across all tables.
3. **Given** a narrow viewport (<768px), **When** viewing a table, **Then** horizontal scroll is enabled on the table container (not on the page); page content below remains reachable without horizontal scroll.

---

### User Story 11 - Overlay Consistency (Card, Modal/Dialog, DropdownMenu) (Priority: P3)

As a staff or member user opening overlays — Cards (static containers), Dialogs (modal confirmations), Sheets (mobile side panels), and DropdownMenus (user menu, sidebar triggers) — every overlay shares consistent padding, border radius, shadow elevation, and header/footer patterns. Currently each overlay uses shadcn defaults but Card padding varies (p-4 vs p-6), Dialog header styling varies, and DropdownMenu triggers lack consistent hover treatment.

**Why this priority**: Overlays are high-visibility polish surfaces. Inconsistency here is the first thing enterprise buyers notice.

**Independent Test**: Open every Card, Dialog, Sheet, and DropdownMenu on admin + portal — padding, radius, shadow identical per surface type.

**Acceptance Scenarios**:

1. **Given** any Card on any page, **When** rendered, **Then** its padding equals `--card-padding`, its radius equals `--card-radius`, its shadow equals `--card-shadow`.
2. **Given** any Dialog (AlertDialog or plain Dialog), **When** opened, **Then** its max-width, header/footer padding, and backdrop opacity are consistent across all admin + portal invocations.
3. **Given** a DropdownMenu trigger (user menu, sidebar trigger, future row action menu), **When** hovered, **Then** it uses the same `hover:bg-muted` pattern as Button variant="ghost".

---

### Edge Cases

- What happens when the page title is extremely long (e.g., a plan name with 100+ characters)? Title uses CSS `line-clamp: 2` (max 2 lines) with ellipsis. At the narrowest supported viewport (320px) this accommodates ~40–50 characters; on desktop ~80–100 characters per line.
- What happens when action buttons overflow the header on a medium viewport? Actions wrap to a second line below the title — all actions remain visible at all times (no overflow menu). Wrap triggers below 640px (sm breakpoint).
- How does the layout behave when the sidebar transitions between collapsed and expanded? Content area smoothly adjusts width with the existing sidebar animation — no content reflow jank.
- What happens with right-to-left (RTL) languages? Explicitly out of scope for v1 (SV/EN/TH are all LTR) — no RTL test coverage required. Layout MUST use CSS logical properties (`padding-inline`, `margin-block`) for future-proofing (FR-013).
- How does the page shell handle pages that need full-bleed content (e.g., a future map or dashboard)? The ContentContainer `fullBleed` prop disables the max-width constraint. Page-edge horizontal padding (`--page-padding-x`) is PRESERVED in fullBleed mode — only the 72rem/64rem centering constraint is removed.
- What happens when a page uses `fullBleed` content AND needs a breadcrumb? The breadcrumb remains at the standard admin max-width (72rem) above the fullBleed content area, providing a consistent navigation anchor regardless of content layout.
- What happens when a dynamic breadcrumb segment's label is not registered (e.g., page forgets to call `setBreadcrumbLabel`)? The breadcrumb falls back to the URL path segment slug as the label, so navigation remains functional but degraded.
- What about headings h5 and h6? Explicitly OUT OF SCOPE for F4 — Chamber-OS does not currently use h5/h6 on any page, and adding tokens pre-emptively would violate YAGNI. If a future feature needs h5/h6, the scale extends naturally (h5 ~1rem/600, h6 ~0.875rem/600) but the tokens are not defined in F4.
- What if a Radix primitive's state-driven styling (`data-state=open`, `data-state=active`) conflicts with the `.focus-ring` utility applied by FR-018? The shadcn wrapper layer applies `.focus-ring` to the outer slot via `cn()` — Radix state attributes drive `background`/`color`, not `outline`/`box-shadow`, so there is no styling conflict in practice. Any edge-case conflict discovered during audit (T072) MUST be resolved by keeping the focus-ring (a11y requirement) and adjusting the state-driven style if needed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a reusable page header component that renders a page title (required), subtitle (optional), and action area (optional) in a consistent layout across all staff admin pages. The title MUST be an `<h1>` rendered via the **`.text-h1` semantic utility class** (defined in FR-017 — 1.875rem, font-weight 600, with Thai line-height override); the subtitle MUST use the `.text-body` class + `text-muted-foreground`; the gap between header and content MUST use the `--page-header-gap` design token (default 1.5rem). PageHeader MUST NOT use direct Tailwind size utilities (`text-2xl`, `text-3xl`, etc.) on its h1 — typography always flows through the `.text-h1` class so Thai line-height and future scale changes apply automatically.
- **FR-002**: System MUST provide a content container component that enforces a standardized maximum width of 72rem (1152px) for admin pages, with the ability to opt out for full-bleed content. Inner components may apply their own narrower constraints.
- **FR-003**: All ~11 existing admin and portal pages MUST be migrated to the standardized page shell within this feature: admin (9 pages) — `/admin`, `/admin/account`, `/admin/users`, `/admin/plans`, `/admin/plans/new`, `/admin/plans/clone`, `/admin/plans/[year]/[planId]`, `/admin/plans/[year]/[planId]/edit`, `/admin/settings/fees`; portal (2 pages) — `/portal`, `/portal/account`. "Ad-hoc styling" is defined as direct use of any of these utility classes on the top-level page element: `max-w-*`, `mx-auto`, `container`, `p-*`/`px-*`/`py-*`, heading font-size classes (`text-xl`/`text-2xl`/`text-3xl`), or space-between classes (`space-y-*`). All of these MUST come from the PageShell / PageHeader / ContentContainer components instead.
- **FR-004**: Page content MUST be fully usable without horizontal scrolling at viewport widths down to 320px.
- **FR-005**: Responsive breakpoints are defined as: **640px (sm)** — page header actions wrap to second line; breadcrumb truncates to parent + current. **768px (md)** — multi-column grids (e.g., two-column detail lists) MUST collapse to single-column. **1024px (lg)** — full layout. Content MUST remain fully usable at all widths down to 320px (FR-004).
- **FR-006**: System MUST provide a breadcrumb component that renders a navigation trail on admin pages with **route depth ≥ 3** only. Top-level admin pages (depth 1 or 2, e.g., `/admin`, `/admin/users`, `/admin/plans`, `/admin/account`) do NOT render breadcrumbs because the sidebar active state and page `<h1>` already communicate location — adding a breadcrumb would duplicate information and add visual noise. Static segments derive labels from route path (i18n keys); dynamic segments receive human-readable labels via props/context from the hosting page (no extra data fetching within the breadcrumb itself).
- **FR-007**: Breadcrumbs MUST truncate on mobile viewports, showing only the current page and immediate parent.
- **FR-008**: The member portal MUST use a portal-specific page shell variant that matches the horizontal-nav layout. The portal content container uses a standardized max-width of 64rem (1024px), narrower than the admin 72rem due to simpler content (no data tables). Responsive behaviour is identical to the admin shell.
- **FR-009**: Pages MUST compose the existing loading (shimmer skeleton) and empty-state components as children of ContentContainer — the layout components provide no built-in slot API for these states. The composition pattern ensures consistency without adding complexity.
- **FR-010**: All spacing, padding, and max-width values in the page shell MUST use design tokens (CSS variables or Tailwind theme values), not hardcoded pixel values.
- **FR-011**: Page headers MUST support i18n — all static text (breadcrumb labels, empty-state messages) MUST use the existing next-intl translation system with keys in EN, TH, and SV.
- **FR-012**: The standardized layout MUST not introduce any accessibility regressions — all existing WCAG 2.1 AA compliance (skip-to-content, focus management, contrast) MUST be preserved.
- **FR-013**: Page layout components MUST use CSS logical properties (`padding-inline`, `margin-block`) instead of directional properties for future i18n extensibility.
- **FR-014**: The base `Button` component (`src/components/ui/button.tsx`) MUST include `cursor-pointer` in its base class (applied when enabled) and `disabled:cursor-not-allowed disabled:opacity-50 disabled:pointer-events-none` for the disabled state. These rules MUST apply uniformly across all button variants (default, outline, secondary, ghost, destructive, link) and all sizes (default, xs, sm, lg, icon, icon-xs, icon-sm, icon-lg). The `size="default"` variant MUST use height 2.25rem (`h-9` / 36px) to visually align with form inputs (FR-019 `--input-height`) and meet WCAG 2.5.5 touch-target guidance — changed from the previous `h-8` (32px) baseline as a scope-wide correction in F4. **Visual baseline requirement**: Because the height change affects every Button across the entire deployed product (including pages outside the F4 migration list — sign-in, forgot-password, invite accept, modals), visual-regression baselines MUST be captured BEFORE the button.tsx modification is committed, so reviewers can confirm no unexpected visual breakage on non-F4 pages. See tasks.md T048b.
- **FR-015**: All interactive elements that render as buttons (including icon buttons, dropdown triggers from shadcn/ui DropdownMenu, Sidebar triggers, and any custom Base UI button-based components) MUST inherit the cursor + disabled behaviour defined in FR-014 via the shared `buttonVariants` / `Button` component. Components that build their own button-like primitives WITHOUT using the shared base MUST be identified and either refactored to use `Button` or MUST explicitly replicate the FR-014 rules.
- **FR-016**: The top bar (the `<header>` element at the top of every admin and member portal page, holding the sidebar trigger / logo, theme toggle, and user menu) MUST have a consistent fixed height of 3.5rem (56px) via the `--top-bar-height` design token, consistent horizontal padding via `--page-padding-x`, and consistent internal `gap-2` between items. Both `src/app/(staff)/admin/layout.tsx` and `src/app/(member)/portal/layout.tsx` MUST apply these tokens so admin and portal top bars are visually identical in height, padding, and spacing.
- **FR-017**: A typography scale MUST be defined via CSS design tokens for h1 (`--font-size-h1: 1.875rem`, weight 600), h2 (`--font-size-h2: 1.5rem`, weight 600), h3 (`--font-size-h3: 1.25rem`, weight 600), h4 (`--font-size-h4: 1.125rem`, weight 600), body (`--font-size-body: 0.875rem`, `--line-height-body: 1.5`), caption (`--font-size-caption: 0.75rem`, `--line-height-caption: 1.4`). All non-h1 headings across admin + portal MUST use these tokens via **semantic utility classes**: `.text-h1`, `.text-h2`, `.text-h3`, `.text-h4`, `.text-body`, `.text-caption` — each class encodes size + weight + line-height (including a Thai-aware line-height override for `[lang="th"]` contexts) in a single reusable unit. No direct `text-xl`/`text-2xl`/`text-3xl` Tailwind utility classes are allowed on `<h2>`/`<h3>`/`<h4>` elements in migrated pages.
- **FR-018**: All interactive elements (buttons, links in navigation contexts, inputs, textareas, selects, checkboxes, radios, switches, menu triggers, tab triggers) MUST show a consistent focus ring on keyboard focus using the existing `focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:border-ring` pattern established in the Button base class. A shared utility class `.focus-ring` MUST be available for custom interactive primitives that don't inherit from a shadcn component. **Third-party primitive conflicts**: Radix UI components (the underlying primitives for shadcn) use `data-[state=*]` attributes rather than `:focus` styling — applying `.focus-ring` on the shadcn wrapper layer MUST NOT conflict with Radix state-driven styling. **Dark mode**: the `--ring` token already has a dark-mode variant defined in the existing theme; the `ring-ring/50` alpha channel correctly inherits in both modes — no separate dark-mode focus-ring definition needed.
- **FR-019**: All form field primitives (`Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Label`) MUST have consistent height via `--input-height: 2.25rem` (36px — matches Button `size="default"` for visual alignment), consistent horizontal padding via `--input-padding-x: 0.75rem`, consistent label-to-field gap via `--field-label-gap: 0.375rem` for **stacked label-above-field layouts** (inline/horizontal label layouts use the same token as gap between label and field inline), consistent error-state visuals (border color, helper-text color, AND an optional trailing error icon slot — implementation may use `AlertCircle` from lucide-react as the default affordance) via `--field-error-color` (mapped to `--destructive`), and consistent disabled-state styling mirroring Button disabled (opacity 0.5 + `cursor-not-allowed` + non-interactive). Compound field components (DatePicker, MultiSelect, Autocomplete, Combobox) introduced in future features MUST reuse these tokens on their trigger/input surface — the 36px height rule extends to all text-input-like affordances, not just primitive Input.
- **FR-020**: All data tables rendered via the shared shadcn `<Table>` primitive MUST use consistent row height `--table-row-height: 2.75rem`, consistent cell padding `--table-cell-padding-x: 0.75rem` + `--table-cell-padding-y: 0.5rem`, consistent header typography (uppercase letter-spacing, `text-muted-foreground`, font-medium), and consistent row hover `--table-row-hover-bg: var(--muted)/50`. The same `--table-row-hover-bg` MUST apply when a row receives keyboard focus (`focus-within` state) so keyboard users get identical visual feedback as mouse users. On viewports below 768px, the table container MUST enable horizontal scroll (`overflow-x-auto`) so the table itself can scroll while the enclosing page remains horizontally fixed; the `<TableHeader>` MUST remain sticky (`sticky top-0`) during horizontal scroll so column labels stay visible. **Thai text overflow**: cells containing Thai content MUST use `line-clamp: 2` to cap at 2 lines with ellipsis — this prevents vowel/tone-mark stacking from expanding row height unpredictably while preserving readability; full content is accessible via row detail view or tooltip on hover.
- **FR-021**: The shared `Card` component (`src/components/ui/card.tsx`) MUST use consistent padding via `--card-padding: 1.5rem`, consistent border-radius via `--card-radius: var(--radius-lg)`, and consistent shadow via `--card-shadow`. Direct use of `<Card className="p-4">` or `<Card className="p-8">` overrides MUST be removed from all migrated pages.
- **FR-022**: All modal surfaces (shadcn `Dialog`, `AlertDialog`, `Sheet`) MUST use consistent header padding, consistent footer padding, consistent backdrop opacity (`--modal-backdrop-opacity: 0.8`), and consistent enter/exit animation duration + easing (`--modal-duration: 200ms`, `--modal-easing: cubic-bezier(0.4, 0, 0.2, 1)` — Material "standard" curve, natural deceleration). Three max-width tokens are defined with specific use cases: `--modal-max-width-sm: 25rem` for **confirmation dialogs** (yes/no, delete confirms — AlertDialog usage); `--modal-max-width-md: 32rem` for **form dialogs** (invite user, create plan, edit fee config); `--modal-max-width-lg: 42rem` for **detail/read dialogs** (plan detail preview, audit log entry). Choosing a different token for a new dialog requires a one-line rationale in the component comment.
- **FR-023**: All `DropdownMenu` triggers (user menu, sidebar trigger, future row-action menu, theme toggle) MUST use the shared Button `variant="ghost"` primitive so hover state (`hover:bg-muted hover:text-foreground`), cursor, focus ring, and disabled state automatically inherit from FR-014/FR-018. Custom trigger styles are forbidden; any custom affordance (avatar, avatar + chevron, badge, indicator dot, icon + label combo) MUST be rendered as **children of the shared Button** (using the shadcn `asChild` pattern correctly: `<DropdownMenu.Trigger asChild><Button variant="ghost"><Avatar />{label}<ChevronDownIcon /></Button></DropdownMenu.Trigger>`), not as a replacement for the Button. The user-menu trigger (which currently renders an avatar circle) is an explicit example — it MUST wrap the avatar inside a `<Button variant="ghost" size="icon">` to inherit cursor/focus/disabled states.

### Key Entities

- **PageShell**: A **composition pattern**, not a distinct component — pages directly compose `<BreadcrumbNav />` (when depth ≥ 3) + `<PageHeader />` + `<ContentContainer>{children}</ContentContainer>`. Two de-facto variants emerge from context: staff (sidebar layout, `ContentContainer variant="admin"`) and portal (horizontal-nav layout, `ContentContainer variant="portal"`). No `PageShell.tsx` file is created.
- **PageHeader**: Title, subtitle, actions area. Responsive — actions wrap to second line on narrow viewports (no overflow menu).
- **ContentContainer**: Max-width wrapper with standardized horizontal padding. Supports opt-out for full-bleed.
- **Breadcrumb**: Navigation trail with static labels from route path and dynamic labels passed via props/context. Truncation on mobile (current + parent only).
- **Design Tokens**: CSS variables defining spacing scale, max-widths, top-bar height, typography scale (h1–h4, body, caption, weights, Thai-aware line-heights), form-field dimensions, table dimensions, card padding/radius/shadow, modal max-widths/backdrop/duration, and focus-ring pattern — all referenced by FR-002, FR-008, FR-010, FR-016, FR-017, FR-018, FR-019, FR-020, FR-021, FR-022.
- **Typography Scale** (FR-017): Six-tier scale — h1 (1.875rem / 600), h2 (1.5rem / 600), h3 (1.25rem / 600), h4 (1.125rem / 600), body (0.875rem / 1.5 line-height), caption (0.75rem / 1.4 line-height). Exposed as `.text-h{1-4}`, `.text-body`, `.text-caption` utility classes.
- **Form Field Primitives** (FR-019): Input, Textarea, Select, Checkbox, Radio, Switch, Label — all sharing `--input-height`, `--input-padding-x`, `--field-label-gap`, `--field-error-color` tokens.
- **Table Primitives** (FR-020): shadcn `<Table>`, `<TableHeader>`, `<TableRow>`, `<TableCell>` — sharing `--table-row-height`, `--table-cell-padding-x/y`, `--table-row-hover-bg` tokens + responsive horizontal-scroll container.
- **Overlay Primitives** (FR-021/022/023): Card, Dialog, AlertDialog, Sheet, DropdownMenu — sharing `--card-*`, `--modal-*` tokens and using Button `variant="ghost"` for all menu triggers.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the ~11 admin + portal pages enumerated in FR-003 use the standardized page shell (PageHeader + ContentContainer, with BreadcrumbNav on nested admin pages). "Standardized page shell" = the top-level `<main>` or page-root element renders exclusively via the new layout components with no direct Tailwind utility classes from the FR-003 ad-hoc list. Verified via grep + automated lint.
- **SC-002**: All admin and portal pages are fully usable (no horizontal scroll, all actions reachable) at 320px, 375px, 768px, 1024px, and 1440px viewport widths.
- **SC-003**: New admin pages created for future features (F4+) can achieve correct layout by using the page shell component with zero custom CSS for heading, spacing, or container width.
- **SC-004**: Breadcrumb navigation is present on all admin pages with route depth ≥ 3 (nested beyond sidebar entry points). Depth 1–2 pages MUST NOT render breadcrumbs.
- **SC-005**: All existing accessibility tests (axe-core WCAG 2.1 AA, skip-to-content, keyboard navigation) continue to pass with zero regressions.
- **SC-006**: F4 migration MUST NOT regress the existing CLS = 0 sidebar toggle behaviour (inherited from F3). Measurement methodology: Playwright's `page.evaluate()` with the Web Vitals API (`PerformanceObserver` for `'layout-shift'` entries) records cumulative layout shift across a sidebar toggle sequence on each migrated page; CLS MUST be <= 0.01 (effectively zero).
- **SC-007**: All layout spacing and dimension values trace to named design tokens — no magic numbers in page-level code.
- **SC-008**: 100% of Button variants (default, outline, secondary, ghost, destructive, link) × all sizes (default, xs, sm, lg, icon, icon-xs, icon-sm, icon-lg) pass cursor + disabled visual tests.
- **SC-009**: The top bar `<header>` has identical computed height (56px), horizontal padding, and gap on both admin and portal layouts.
- **SC-010**: All `<h2>`, `<h3>`, `<h4>` elements across migrated admin + portal pages have computed font-size and font-weight exactly matching the FR-017 tokens. Verified by Playwright iteration over all headings on 5 representative pages.
- **SC-011**: Keyboard-tab through every interactive element on 5 representative pages (Users, Plans list, Plan edit form, Fees settings, Portal home) shows a visible focus ring of identical computed `outline` / `box-shadow`. Verified via Playwright `page.keyboard.press('Tab')` loop + screenshot diff baseline.
- **SC-012**: All form fields on Users invite dialog, Plan create form, and Fees configuration form have identical computed height (36px), identical label-gap, identical error-state border color. Verified via Playwright.
- **SC-013**: Row heights, cell padding, and hover backgrounds are identical across the Users table and the Plans list table. Verified via Playwright computed-style inspection.
- **SC-014**: Cards, Dialogs, and DropdownMenu triggers across all pages have identical padding, radius, shadow, and hover treatment (per surface type). Verified via Playwright + a rendered matrix test route. Verified via Playwright: render `/admin` and `/portal`, assert `document.querySelector('header').getBoundingClientRect().height === 56` on both, and compute identical `padding-inline` + `gap` values. Verified via a single parameterized Playwright test that iterates the variant × size matrix, hovers each in enabled and disabled states, and asserts the computed cursor value (`pointer` when enabled, `not-allowed` when disabled) and opacity (1.0 enabled, 0.5 disabled).

## Assumptions

- The existing sidebar and navigation components (F3 `003-nav-menu`) are stable and will not change structurally — this feature builds on top of them, not replaces them. **F4 dependency chain**: F4 may be developed in parallel with F3 on a branch based off `003-nav-menu`, but F4 MUST NOT merge to `main` until F3 has shipped to `main`. The ship order is strictly F3 → F4.
- The current mobile breakpoint at 768px (`useIsMobile` hook) remains the primary breakpoint. Additional breakpoints (640px for small mobile, 1024px for tablet landscape) may be introduced in the responsive grid system.
- The member portal currently has only a landing placeholder page (F1). Portal shell standardization is proactive — preparing for F3+ member content pages.
- Admin content max-width is standardized to `max-w-6xl` (72rem / 1152px) for the outer container. Inner components control their own narrower widths where needed (e.g., forms at `max-w-4xl`, clone pages at `max-w-2xl`).
- Performance impact of adding wrapper components is negligible — these are thin layout containers with no data fetching or complex logic.
- Thai language text (which tends to be longer than English for UI labels) is considered in the responsive header overflow behavior.
- **Typography scale + Thai line-height rationale**: See `research.md` § 8 — documents why h1–h4 values match common enterprise-app conventions and why Thai line-height is 1.65 (~10–15% diacritic envelope). Subject to empirical validation in T060d Thai content check.
- **No new user-facing strings from US7–US11**: Typography/Focus Ring/Form Fields/Tables/Overlays are purely visual token applications — zero new i18n keys are introduced by these five user stories. The 22 new i18n keys in F4 all come from US3 Breadcrumb (breadcrumb.* namespace) + US5/empty-state layout messages (layout.* namespace). No i18n coverage gap exists for the expanded scope.
