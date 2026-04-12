# Feature Specification: Navigation Menu

**Feature Branch**: `003-nav-menu`  
**Created**: 2026-04-12  
**Status**: Draft  
**Input**: User description: "Nav menu"

## Clarifications

### Session 2026-04-12

- Q: Should sidebar collapse preference persist across sessions (localStorage) or reset on each sign-in (sessionStorage)? → A: localStorage — persist across sessions. Users set it once, it stays.
- Q: Should Settings be an expandable group with sub-items or a flat link to a single page? → A: Expandable group — Settings is a collapsible section with sub-items (Fees, and future settings pages).
- Q: How to handle existing breadcrumbs in Plans layout when sidebar is added? → A: Keep existing breadcrumbs untouched. Sidebar and breadcrumbs work together. No new breadcrumbs added in this scope.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Staff Sidebar Navigation (Priority: P1)

Admin and manager users need a persistent sidebar navigation in the staff portal (`/admin`) so they can quickly move between sections (Dashboard, Plans, Users, Settings) without relying on URLs or the command palette alone.

**Why this priority**: The staff portal currently has 6+ route areas but no visible navigation between them. Staff must type URLs or use the command palette to move around. A sidebar is the most impactful UX improvement for daily admin workflows.

**Independent Test**: Can be fully tested by signing in as an admin user, verifying the sidebar appears on all `/admin/**` pages, and clicking each nav link to confirm correct routing. Delivers immediate productivity for staff users.

**Acceptance Scenarios**:

1. **Given** an admin user is signed in, **When** they land on any `/admin/**` page, **Then** a sidebar navigation is visible showing links to Dashboard, Plans, Users, and a Settings expandable group (with sub-items such as Fees).
2. **Given** an admin user clicks a sidebar link, **When** the target page loads, **Then** the corresponding sidebar item is visually highlighted as active.
3. **Given** a manager user is signed in, **When** they view the sidebar, **Then** they see the same navigation items as admin (visibility of actions within each page is controlled by existing RBAC, not the nav).
4. **Given** the sidebar is displayed, **When** the user views it, **Then** each section shows an icon and a text label for clarity.
5. **Given** an admin user is on any page, **When** they look at the sidebar, **Then** the sidebar shows the current tenant/organisation name or logo at the top.

---

### User Story 2 - Collapsible Sidebar (Priority: P1)

Staff users need to collapse the sidebar to an icon-only rail to reclaim horizontal screen space when working on data-dense pages (plan editing, user lists).

**Why this priority**: Data-dense admin pages need maximum horizontal space. A non-collapsible sidebar wastes valuable screen real estate and frustrates power users. This is tied to P1 because shipping a sidebar without collapse would degrade the editing experience.

**Independent Test**: Can be tested by toggling the collapse button and verifying the sidebar switches between full-width (icon + label) and icon-only modes. The collapse state persists across page navigations within the same session.

**Acceptance Scenarios**:

1. **Given** the sidebar is expanded, **When** the user clicks the collapse toggle, **Then** the sidebar shrinks to show icons only (no text labels).
2. **Given** the sidebar is collapsed, **When** the user hovers over an icon, **Then** a tooltip shows the full label.
3. **Given** the sidebar is collapsed, **When** the user clicks the collapse toggle again, **Then** the sidebar expands back to full width with labels.
4. **Given** the user collapses the sidebar, **When** they navigate to another `/admin/**` page, **Then** the sidebar remains collapsed (state persists within the session).
5. **Given** the user's collapse preference, **When** they start a new session (sign in again), **Then** the sidebar restores the previously saved preference (persisted across sessions via browser local storage).

---

### User Story 3 - Mobile-Responsive Navigation (Priority: P2)

Staff and member users on tablets or narrow browser windows need a navigation experience that adapts to smaller screens — the sidebar should hide by default and be accessible via a hamburger menu.

**Why this priority**: While most admin work happens on desktop, tablet usage (e.g., at events or meetings) is realistic. A responsive nav prevents the sidebar from overlapping content on small screens.

**Independent Test**: Can be tested by resizing the browser to tablet/mobile widths and verifying the sidebar transforms into a slide-out drawer toggled by a hamburger button.

**Acceptance Scenarios**:

1. **Given** the viewport width is below the tablet breakpoint, **When** a staff page loads, **Then** the sidebar is hidden and a hamburger menu button appears in the header.
2. **Given** the hamburger button is visible, **When** the user taps it, **Then** the sidebar slides in as an overlay drawer.
3. **Given** the mobile drawer is open, **When** the user taps a navigation link, **Then** the drawer closes and the target page loads.
4. **Given** the mobile drawer is open, **When** the user taps outside the drawer or presses Escape, **Then** the drawer closes.

---

### User Story 4 - Member Portal Navigation (Priority: P2)

Member users need a simple navigation in the member portal (`/portal`) so they can access current and future self-service pages (Dashboard, Account, and pages added by F3+ such as invoices, events).

**Why this priority**: The member portal currently has only 2 pages, but F3 (Members & Contacts), F5 (Payment), and F6 (Events) will add more. Shipping member nav now establishes the pattern and avoids retrofitting later.

**Independent Test**: Can be tested by signing in as a member, verifying a top nav bar or minimal sidebar appears with links to Dashboard and Account, and confirming active-state highlighting.

**Acceptance Scenarios**:

1. **Given** a member is signed in, **When** they land on any `/portal/**` page, **Then** a navigation element is visible with links to Dashboard and Account.
2. **Given** a member clicks a nav link, **When** the target page loads, **Then** the clicked item is highlighted as active.
3. **Given** the member portal nav, **When** future features add new pages (e.g., Invoices, Events), **Then** adding a new nav item requires only a configuration change (adding an entry to a nav config), not a structural refactor.
4. **Given** the member is on a mobile-width viewport, **When** the page loads, **Then** the navigation adapts to the smaller screen (responsive behaviour consistent with US3).

---

### User Story 5 - Keyboard Accessibility (Priority: P3)

All navigation elements must be fully keyboard-accessible and meet WCAG 2.1 AA requirements, consistent with the project's accessibility standards.

**Why this priority**: WCAG 2.1 AA is a constitutional requirement (Principle VI). While important, this is P3 because the visual nav (P1/P2) must exist first.

**Independent Test**: Can be tested using keyboard-only navigation (Tab, Enter, Escape, arrow keys) and running axe-core scans on nav-containing pages.

**Acceptance Scenarios**:

1. **Given** a keyboard user on the staff portal, **When** they press Tab, **Then** focus moves through sidebar items in a logical order (top to bottom).
2. **Given** a sidebar item is focused, **When** the user presses Enter, **Then** the corresponding page loads.
3. **Given** the mobile drawer is open, **When** the user presses Escape, **Then** the drawer closes and focus returns to the hamburger button.
4. **Given** the sidebar is collapsed, **When** a keyboard user tabs to an icon, **Then** the tooltip (or accessible name) is announced by screen readers.
5. **Given** any navigation page, **When** an axe-core accessibility scan runs, **Then** zero critical or serious violations related to navigation are found.
6. **Given** a screen reader user on the staff portal, **When** the sidebar collapses or expands, **Then** the state change is announced via `aria-expanded` on the toggle control.
7. **Given** a user with `prefers-reduced-motion` enabled, **When** the sidebar collapses or expands or the mobile drawer opens/closes, **Then** state changes are instant with no animation.

---

### Edge Cases

- What happens when the current URL does not match any sidebar item? The nav should show no item as active rather than incorrectly highlighting one.
- What happens when a nav section has only one child item? It should display as a flat link, not a collapsible group with one entry.
- What happens when a user navigates to a Settings sub-page? The Settings group should auto-expand and the active sub-item should be highlighted. A manually expanded/collapsed NavGroup retains its state during page navigations within the same session; it auto-expands only when the active URL matches a child.
- What happens on an extremely narrow viewport (< 320px)? The hamburger menu and drawer must still be functional without horizontal overflow.
- What happens if the user rapidly toggles the sidebar collapse? The animation should not glitch or leave the sidebar in an intermediate state.
- What happens with i18n? All nav labels must use translation keys (EN, TH, SV) — not hardcoded strings.
- What happens when the user is on the Dashboard (`/admin`) page? Dashboard must be active only on exact `/admin`, not on sub-paths like `/admin/plans`. The active-state matching must treat Dashboard as an exact-match exception or use "deepest prefix wins" to resolve correctly.
- What happens when the browser window is resized across the tablet breakpoint (768px) while the page is open? The sidebar must seamlessly switch between persistent mode and drawer mode without requiring a page reload, and the mobile drawer must close if it was open.
- What happens with long navigation labels in TH or SV locales? Labels MUST be truncated with an ellipsis within the sidebar width when expanded, and the full label shown in the tooltip when collapsed. No horizontal overflow or text wrapping is permitted.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST display a persistent sidebar navigation on all staff portal pages (`/admin/**`) containing links grouped by section: Dashboard, Plans, Users, and a Settings expandable group (with sub-items such as Fees; future settings pages are added as new sub-items). The sidebar MUST be approximately 240px wide when expanded and approximately 48px wide when collapsed (icon-only rail).
- **FR-002**: System MUST highlight the currently active navigation item based on the current URL path using a distinct background colour and/or left-border accent consistent with the design system's active-state tokens in both light and dark themes. Icons MUST be sized at 20×20px (lucide default) with consistent spacing between icon and label.
- **FR-003**: System MUST allow users to collapse the sidebar to an icon-only rail and expand it back, with the preference persisted across browser sessions (local storage) and synced to the server via a lightweight cookie so the server renders the correct initial sidebar state without layout shift. If localStorage or the cookie is unavailable, the sidebar MUST default to expanded.
- **FR-004**: System MUST transform the sidebar into a slide-out drawer on viewports below the tablet breakpoint (768px).
- **FR-005**: System MUST display a navigation element in the member portal (`/portal/**`) with links to available member pages (initially Dashboard and Account; future features add entries via the nav config pattern per FR-009).
- **FR-006**: System MUST support all three locales (EN, TH, SV) for navigation labels via translation keys.
- **FR-007**: All navigation elements MUST be fully keyboard-navigable and pass WCAG 2.1 AA axe-core scans with zero critical/serious navigation-related violations. The sidebar MUST use a `<nav>` landmark with a descriptive `aria-label` (e.g., "Staff navigation"). Collapse/expand state changes MUST be announced to screen readers via `aria-expanded`. The mobile drawer MUST trap focus while open (focus cycles within the drawer until it is dismissed). RTL layout is explicitly out of scope (EN, TH, SV are all LTR).
- **FR-008**: The mobile navigation drawer MUST be closable by tapping outside, pressing Escape, or selecting a navigation link. The drawer MUST render as an overlay with a semi-transparent backdrop. The hamburger toggle button MUST appear in the header bar, aligned to the left, when the viewport is below the tablet breakpoint. The drawer MUST appear below any active command palette overlay in the stacking order.
- **FR-009**: The navigation structure MUST be data-driven (configurable nav items array) so that adding a new page requires only adding an entry to the configuration, not modifying component structure.
- **FR-010**: The sidebar MUST display the organisation/tenant name at the top to reinforce context for multi-tenant awareness. Long names MUST be truncated with an ellipsis. When the sidebar is collapsed, the tenant area MUST show a compact identifier (e.g., first letter or small logo). If no tenant logo exists, the name text alone is sufficient.
- **FR-011**: System MUST support both light and dark themes for all navigation components, consistent with the existing `next-themes` setup.
- **FR-012**: The collapse/expand animation MUST use a CSS transition of approximately 200–300ms with ease-out easing, and MUST complete without visual glitches even under rapid toggling. Users with `prefers-reduced-motion` MUST see instant state changes (no animation).

### Key Entities

- **NavItem**: Represents a single navigation entry — label (i18n key), icon, href, active-match pattern, optional children (for grouped sections), optional role visibility filter.
- **NavGroup**: An expandable/collapsible group of NavItems (e.g., Settings → Fees). Auto-expands when the active URL matches any child. Renders as a flat link if it contains only one child.
- **NavSection**: A logical grouping of NavItems and NavGroups with an optional section header label.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Staff users can navigate between all existing admin sections (Dashboard, Plans, Users, Settings) in under 2 clicks from any page.
- **SC-002**: 100% of navigation labels render correctly in all 3 supported locales (EN, TH, SV).
- **SC-003**: The sidebar collapse/expand interaction completes in under 300ms (implemented as a 200–300ms CSS transition per FR-012).
- **SC-004**: Zero critical or serious WCAG 2.1 AA violations on any page containing navigation components.
- **SC-005**: Adding a new navigation item for a future feature page requires modifying only the nav configuration data, verified by a code-change audit.
- **SC-006**: The mobile navigation drawer is functional on viewports as narrow as 320px without horizontal scrolling or content overflow.
- **SC-007**: Navigation state (active item, collapse preference) is visually correct after page transitions with no flash of incorrect state.

## Assumptions

- The staff portal sidebar will follow a vertical sidebar pattern (left-side rail) consistent with enterprise admin dashboards and shadcn/ui sidebar patterns.
- The member portal will use a simpler top navigation bar (horizontal) rather than a full sidebar, since the member portal has fewer pages.
- The sidebar collapse preference is stored in browser `localStorage` (not server-side), persisting across sessions — no database schema changes are needed for this feature.
- The navigation configuration is defined in code (TypeScript config arrays), not managed via a database or CMS.
- The existing header component (with ThemeToggle and UserMenu) will be retained and integrated with the new sidebar layout, not replaced.
- The command palette (Cmd+K) continues to work alongside the sidebar — they are complementary navigation methods. Opening the command palette does not close or affect the sidebar, and vice versa. The command palette overlay renders above the sidebar and mobile drawer in the stacking order.
- This feature does not add new pages or routes — it provides navigation to existing pages only. Future features (F3+) will add their own nav entries using the config pattern established here.
- Existing breadcrumbs (e.g., Plans layout) are left untouched. The sidebar and breadcrumbs are complementary — no breadcrumbs are added or removed in this scope. Standardising breadcrumbs across all pages is a future enhancement.
