# Implementation Plan: F4 — Page Layout Enterprise Standardization & Responsive Design

**Branch**: `004-page-layout-standard` | **Date**: 2026-04-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-page-layout-standard/spec.md`
**Constitution**: [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) **v1.4.0**
**Predecessor**: F3 Nav Menu (branch `003-nav-menu`), F2 Membership Plans (shipped on `002-membership-plans`), F1 Auth & RBAC (shipped via PR #1)

## Summary

F4 delivers a **complete enterprise design-system foundation** for Chamber-OS — expanded from a pure "page layout" feature into 11 user stories covering page structure, responsive behaviour, breadcrumbs, buttons, typography, focus rings, form fields, data tables, and overlays. After F4 ships, every page across admin + portal shares a single canonical set of visual primitives, unblocking F5 (Invoices), F6 (Events), F7 (E-Blast) to build new surfaces without re-inventing layout or styling.

The feature ships: (a) **three page primitives** — PageHeader (FR-001), ContentContainer (FR-002/008), BreadcrumbNav (FR-006/007) composing into a PageShell pattern; (b) **standardized top bar** (FR-016) for admin + portal; (c) **Button cursor + disabled + 36px height** (FR-014/015 + Clarifications Round 2 Q1); (d) **typography scale** with semantic classes `.text-h1`–`.text-h4`, `.text-body`, `.text-caption` + Thai-aware line-height override (FR-017 + Round 2 Q2); (e) **universal focus ring** across all interactive primitives (FR-018); (f) **form-field consistency** at 36px height aligned with Button (FR-019); (g) **data-table consistency** with row/cell/hover tokens + responsive horizontal scroll (FR-020); (h) **overlay consistency** — Card, Dialog, Sheet, DropdownMenu (FR-021/022/023). All ~11 existing admin + portal pages migrate in the same feature; shipped as **one atomic migration** (Round 2 Q3) to avoid an intermediate half-migrated visual state.

All ~7 existing admin pages and ~2 portal pages are **migrated in this feature** to achieve 100% adoption at ship (Clarifications Q3). No database changes, no new API endpoints, no new external dependencies — this is a pure presentation-layer feature that standardizes what exists and fills the gaps identified in the F3 nav-menu retrospective.

**Technical approach**: Reuse the F1/F2/F3 stack unchanged — no new npm dependencies. Work spans three layers: (1) **CSS tokens in `globals.css`** — ~30 tokens covering spacing, max-widths, top-bar height, typography scale (h1–h4 + body + caption + Thai-aware line-height), form-field dimensions, table dimensions, card padding/radius/shadow, modal max-widths/backdrop/duration, focus-ring pattern; (2) **shadcn/ui primitive updates** — edit `button.tsx` (height 32→36px + cursor + disabled), `input.tsx` / `textarea.tsx` / `select.tsx` / `checkbox.tsx` / `radio-group.tsx` / `switch.tsx` / `label.tsx` (apply form-field tokens), `table.tsx` (apply table tokens + responsive wrapper), `card.tsx` + `dialog.tsx` + `alert-dialog.tsx` + `sheet.tsx` (apply overlay tokens); (3) **new layout components in `src/components/layout/`** as Server Components (no client state) — `page-header.tsx`, `content-container.tsx`, `breadcrumb-nav.tsx` + a Client Component `breadcrumb-provider.tsx` for dynamic label registration via React Context.

Breadcrumb strategy follows Clarifications Q2 — pages pass dynamic labels via provider context, not extra API fetches. Breadcrumbs render only on route depth ≥ 3 per Round 1 refinement (top-level pages rely on sidebar active state + h1 instead, avoiding noise). Button `size="default"` becomes 36px platform-wide (Round 2 Q1) to match Input height and meet WCAG 2.5.5 touch-target guidance. Typography scale uses semantic class names (`.text-h2` not `text-2xl`) per Round 2 Q2 so Thai line-height overrides apply automatically under `[lang="th"]`. All 11 existing pages migrate in the same atomic release (Round 2 Q3); ESLint `no-restricted-syntax` blocks regressions of the FR-003 utility-class list on page-root elements.

## Technical Context

**Language/Version**: TypeScript 5.7+ (strict mode, `strict: true`, `noUncheckedIndexedAccess: true`) — unchanged from F1
**Runtime**: Node.js 22 LTS — unchanged from F1
**Framework**: Next.js 16 App Router, React 19, Turbopack dev — unchanged from F3
**Primary Dependencies** (all from F1/F2/F3, no new packages):
  - `next@^16`, `react@^19`, `next-intl`, `next-themes`
  - shadcn/ui: `Sidebar`, `Sheet`, `Tooltip`, `Card`, `Badge`, `Button`, `Skeleton` — all already installed
  - `lucide-react` — icons for breadcrumb separator and empty states
  - `tailwindcss@^4` — CSS-first config via `globals.css`
  - `vitest`, `playwright`, `@axe-core/playwright`, `@testing-library/react` — test suite
  - **No new npm dependencies required** — breadcrumb uses native shadcn/ui Breadcrumb primitives (already available from Radix)
**Storage**: N/A — no database changes. Client-side `localStorage` for sidebar collapse (existing from F3).
**Testing**:
  - `vitest` — unit tests for breadcrumb path parsing, label resolution, truncation logic
  - `@testing-library/react` — component tests for PageHeader, ContentContainer, Breadcrumb rendering
  - `playwright` — E2E viewport tests at 320px, 375px, 768px, 1024px, 1440px; breadcrumb navigation; responsive reflow verification
  - `@axe-core/playwright` — WCAG 2.1 AA regression scan on all migrated pages
**Target Platform**: Web browsers (last 2 versions of Chrome, Firefox, Safari, Edge, mobile Safari, Chrome Android). Vercel `sin1`.
**Project Type**: Web application (Next.js full-stack, single repo) — unchanged
**Performance Goals**:
  - **SC-006**: CLS = 0 during sidebar toggle (no layout shift)
  - **Constitution Principle VI**: LCP < 2.5s, INP < 200ms, CLS < 0.1 on mid-range mobile
  - Layout components add zero JavaScript bundle overhead (Server Components, no client state)
**Constraints**:
  - CSS logical properties (`padding-inline`, `margin-block`) for future RTL/i18n extensibility (FR-013)
  - All spacing/dimension values must use design tokens — no magic numbers (SC-007)
  - SV+EN+TH at release; missing EN key is a build-breaker
  - WCAG 2.1 AA on every screen; skip-to-content preserved
  - Existing F1/F2/F3 test suites must remain green — zero regressions
**Scale/Scope**:
  - ~11 admin + portal pages migrated to PageShell composition
  - ~4 new layout components (PageHeader, ContentContainer, BreadcrumbNav, BreadcrumbProvider)
  - ~12 shadcn/ui primitives updated (button, input, textarea, select, checkbox, radio-group, switch, label, table, card, dialog, alert-dialog, sheet, dropdown-menu triggers)
  - ~30 new CSS design tokens in `globals.css`
  - ~22 i18n keys (breadcrumb + layout namespaces × 3 locales = 66 translations)
  - 92 tasks across 14 phases
  - No runtime complexity — thin wrappers, no data fetching, no state management (beyond single Client Component for Breadcrumb Context)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
*Source: [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) **v1.4.0***

### NON-NEGOTIABLE gates (any FAIL blocks the plan; no waivers)

- [x] **I. Data Privacy & Security — including v1.4.0 Tenant Isolation clause**
  - **No new PII** in F4. All components are presentation-only layout wrappers with no data access.
  - **RBAC** inherited unchanged from F1. F4 adds no new protected routes or resources.
  - **Tenant Isolation**: N/A — F4 is a pure presentation feature with no database tables, no queries, no tenant-scoped data. The existing `runInTenant` plumbing from F2 is untouched.
  - **OWASP Top 10**: No new attack surface. Breadcrumb labels come from page props (not URL params or user input), eliminating XSS risk. No dynamic HTML rendering.
  - **TLS / encryption**: unchanged from F1.

- [x] **II. Test-First Development**
  - Failing tests planned BEFORE implementation:
    - Unit tests for breadcrumb path parsing and truncation logic
    - Component tests for PageHeader, ContentContainer, Breadcrumb rendering variants
    - E2E viewport tests for responsive behaviour at 5 breakpoints
    - axe-core accessibility regression scan on all migrated pages
  - Coverage targets: ≥80% line on layout components; 100% branch on breadcrumb truncation logic (path-parsing is a correctness-critical function)

- [x] **III. Clean Architecture**
  - F4 operates entirely in the **Presentation layer**. No Domain, Application, or Infrastructure changes.
  - New components live in `src/components/layout/` (shared layout primitives) — same location as existing `staff-sidebar.tsx`, `member-nav.tsx`, `nav-item.tsx`.
  - No new bounded context module needed. No barrel file changes.
  - No framework types leak — components use standard React props, no Drizzle/ORM imports.
  - **Client/Server boundary**: PageHeader, ContentContainer, BreadcrumbNav are **React Server Components** (zero client JS). `BreadcrumbProvider` is a **Client Component** (`'use client'`) because React Context providers must run on the client. The admin layout remains a Server Component; it imports and renders `<BreadcrumbProvider>` as a client island around its children. This is the standard Next.js App Router pattern for cross-cutting UI context.

- [x] **IV. Payment Security (PCI DSS)**
  - N/A — F4 does not touch payment surfaces.

### Core principle gates (FAIL must be justified in Complexity Tracking)

- [x] **V. Internationalization (SV/EN/TH)**
  - New i18n keys added for: breadcrumb labels (`breadcrumb.admin`, `breadcrumb.dashboard`, `breadcrumb.users`, `breadcrumb.plans`, `breadcrumb.settings`, `breadcrumb.fees`), page titles (reuse existing `nav.*` keys where possible), empty-state messages.
  - All keys in EN (canonical) + TH + SV. Missing EN key = build-breaker.
  - Breadcrumb labels use `useTranslations('breadcrumb')` — locale-aware.

- [x] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA)**
  - Design starts at 320px (FR-004). Responsive breakpoints at 640px, 768px, 1024px.
  - WCAG 2.1 AA: breadcrumb uses `<nav aria-label="Breadcrumb">`, skip-to-content preserved, focus management unchanged.
  - axe-core scan on every migrated page.
  - Breadcrumb truncation on mobile (FR-007) ensures usability on small screens.

- [x] **VII. Performance & Observability**
  - **Performance**: Layout components are React Server Components — zero client JS. CLS target = 0 for sidebar toggle (SC-006). No additional network requests.
  - **Observability**: No new logging/metrics — layout is stateless presentation. Existing pino + @vercel/otel unchanged.

- [x] **VIII. Reliability**
  - Error paths: breadcrumb handles missing labels gracefully (falls back to route segment slug). ContentContainer handles missing children (renders empty). PageHeader with only title (subtitle/actions optional).
  - No transactional boundaries — no data mutations.
  - No audit-log entries — no state changes.

- [x] **IX. Code Quality Standards**
  - TypeScript strict, ESLint clean, Conventional Commits enforced by hooks.
  - Solo-maintainer substitute applies (consistent with F1/F2/F3). Review via automated review passes + test coverage.

- [x] **X. Simplicity (YAGNI)**
  - Three thin components (PageHeader, ContentContainer, Breadcrumb) — no speculative abstractions.
  - Breadcrumb label resolution via props/context (not an auto-fetching system) — simplest approach per Clarifications Q2.
  - No responsive table component (deferred — tables work at current scale, revisit at F5+).
  - No animation system — sidebar animation is handled by existing shadcn Sidebar, not by F4.

## Project Structure

### Documentation (this feature)

```text
specs/004-page-layout-standard/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── spec.md              # Feature specification
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── app/
│   ├── globals.css                          # + layout design tokens (--content-max-width, --page-padding-*)
│   ├── (staff)/admin/
│   │   ├── layout.tsx                       # + BreadcrumbProvider context wrapper
│   │   ├── page.tsx                         # MIGRATE → PageHeader + ContentContainer
│   │   ├── account/page.tsx                 # MIGRATE → PageHeader + ContentContainer
│   │   ├── users/page.tsx                   # MIGRATE → PageHeader + ContentContainer (remove ad-hoc max-w-6xl)
│   │   ├── plans/
│   │   │   ├── layout.tsx                   # MIGRATE → remove ad-hoc breadcrumb, use Breadcrumb component
│   │   │   ├── page.tsx                     # MIGRATE → PageHeader + ContentContainer
│   │   │   ├── new/page.tsx                 # MIGRATE → PageHeader + ContentContainer + Breadcrumb labels
│   │   │   ├── clone/page.tsx               # MIGRATE → PageHeader + ContentContainer + Breadcrumb labels
│   │   │   └── [year]/[planId]/
│   │   │       ├── page.tsx                 # MIGRATE → PageHeader + ContentContainer + Breadcrumb labels
│   │   │       └── edit/page.tsx            # MIGRATE → PageHeader + ContentContainer + Breadcrumb labels
│   │   └── settings/fees/page.tsx           # MIGRATE → PageHeader + ContentContainer
│   └── (member)/portal/
│       ├── layout.tsx                       # MIGRATE → use ContentContainer for consistent portal width
│       ├── page.tsx                         # MIGRATE → PageHeader
│       └── account/page.tsx                 # MIGRATE → PageHeader
├── components/
│   ├── layout/
│   │   ├── page-header.tsx                  # NEW — PageHeader (title, subtitle, actions)
│   │   ├── content-container.tsx            # NEW — ContentContainer (max-width wrapper + design tokens)
│   │   ├── breadcrumb-nav.tsx               # NEW — Breadcrumb (nav trail + mobile truncation)
│   │   ├── breadcrumb-provider.tsx          # NEW — BreadcrumbProvider context (label registry)
│   │   ├── staff-sidebar.tsx                # EXISTING — no changes
│   │   ├── member-nav.tsx                   # EXISTING — no changes
│   │   └── nav-item.tsx                     # EXISTING — no changes
│   ├── shell/
│   │   ├── empty-state.tsx                  # EXISTING — may add default slot in PageHeader
│   │   └── ...                              # EXISTING — no changes
│   └── ui/
│       ├── breadcrumb.tsx                   # NEW — shadcn/ui Breadcrumb primitive (if not already installed)
│       ├── button.tsx                       # MODIFIED — cursor-pointer + disabled-cursor + size="default" 32→36px (FR-014 + Clarifications R2 Q1)
│       ├── input.tsx                        # MODIFIED — apply --input-height/--input-padding-x/--field-label-gap + disabled state (FR-019)
│       ├── textarea.tsx                     # MODIFIED — apply form-field tokens (FR-019)
│       ├── select.tsx                       # MODIFIED — apply form-field tokens to trigger (FR-019)
│       ├── checkbox.tsx                     # MODIFIED — apply focus-ring + disabled (FR-018/019)
│       ├── radio-group.tsx                  # MODIFIED — apply focus-ring + disabled (FR-018/019)
│       ├── switch.tsx                       # MODIFIED — apply focus-ring + disabled (FR-018/019)
│       ├── label.tsx                        # MODIFIED — standardize font-size + margin-block-end (FR-019)
│       ├── table.tsx                        # MODIFIED — apply --table-* tokens + responsive horizontal-scroll wrapper (FR-020)
│       ├── card.tsx                         # MODIFIED — apply --card-padding/--card-radius/--card-shadow (FR-021)
│       ├── dialog.tsx                       # MODIFIED — apply --modal-* tokens (FR-022)
│       ├── alert-dialog.tsx                 # MODIFIED — apply --modal-* tokens (FR-022)
│       ├── sheet.tsx                        # MODIFIED — apply --modal-* tokens (FR-022)
│       └── dropdown-menu.tsx                # AUDIT — verify all triggers use Button variant="ghost" (FR-023)

docs/
└── shadcn-customizations.md             # NEW — catalog of F4 modifications to shadcn/ui primitives + collision-prevention checklist (T060c, per critique R2 E4)
├── i18n/messages/
│   ├── en.json                              # + breadcrumb.*, layout.* keys
│   ├── th.json                              # + breadcrumb.*, layout.* keys
│   └── sv.json                              # + breadcrumb.*, layout.* keys
└── hooks/
    └── use-mobile.ts                        # EXISTING — unchanged (768px breakpoint)

tests/
├── unit/layout/
│   ├── breadcrumb-path.test.ts              # NEW — path parsing, truncation logic
│   ├── page-header.test.tsx                 # NEW — render variants
│   ├── content-container.test.tsx           # NEW — variant + fullBleed
│   └── breadcrumb-provider.test.tsx         # NEW — context registration
├── e2e/
│   ├── layout-consistency.spec.ts           # NEW — all admin pages use page shell (US1 / SC-001)
│   ├── layout-responsive.spec.ts            # NEW — viewport tests at 5 breakpoints (US2 / SC-002)
│   ├── page-header-wrap.spec.ts             # NEW — actions wrap below 640px (US2)
│   ├── breadcrumb-navigation.spec.ts        # NEW — nav trail + mobile truncation + depth ≥ 3 only (US3 / SC-004)
│   ├── portal-layout.spec.ts                # NEW — portal 64rem container (US4)
│   ├── top-bar-consistency.spec.ts          # NEW — admin + portal top bar identical 56px (US4 / SC-009)
│   ├── button-cursor-states.spec.ts         # NEW — cursor + disabled matrix (US6 / SC-008)
│   ├── empty-state-composition.spec.ts      # NEW — EmptyState inside ContentContainer (US5)
│   ├── typography-scale.spec.ts             # NEW — h2/h3/h4 tokens applied (US7 / SC-010)
│   ├── focus-ring.spec.ts                   # NEW — universal focus ring (US8 / SC-011)
│   ├── form-field-consistency.spec.ts       # NEW — input/textarea/select matrix (US9 / SC-012)
│   ├── table-consistency.spec.ts            # NEW — row/cell/hover tokens (US10 / SC-013)
│   ├── overlay-consistency.spec.ts          # NEW — Card/Dialog/DropdownMenu (US11 / SC-014)
│   ├── layout-a11y.spec.ts                  # NEW — axe-core scan on all migrated pages
│   └── layout-cls.spec.ts                   # NEW — CLS ≤ 0.01 sidebar toggle (SC-006)
```

**Structure Decision**: F4 adds components to the existing `src/components/layout/` directory (alongside F3's sidebar and nav components). No new bounded-context module is needed — this is a presentation-layer-only feature. Design tokens go in `globals.css` (CSS-first Tailwind v4 convention). Tests follow the existing directory convention (`tests/unit/`, `tests/e2e/`).

## Implementation & Commit Strategy

F4 is a **single atomic feature** (per Clarifications Round 2 Q3) but spans 92 tasks touching ~30 files — too large for a single commit. The solo-maintainer workflow uses **commit-per-phase / task-cluster** on the `004-page-layout-standard` branch so individual commits remain reviewable (both for the maintainer's own future recall and for any automated review agents), while atomicity is preserved at the **merge** step.

Commit strategy:
- **One commit per task or logical task cluster** using Conventional Commits (`feat:`, `refactor:`, `test:`, `chore:`) + `[Spec Kit]` prefix on gate-transition commits
- **Push frequently** — every commit triggers Vercel preview deploy, giving immediate visual QA feedback
- **Do NOT merge to `main` until all 92 tasks are complete** — the ship strategy is atomic (no half-migrated state reaches production)
- **Staff-review agent runs on the final diff** before ship, not per-commit — the solo-maintainer substitute (Constitution Principle IX) is applied at Ship gate
- **Critical commits to call out in PR description** when drafting the Ship gate: T002 (design tokens), T049 (Button height change), T011–T015 (layout primitives), T028 (plan layout strip), T060b (dark-mode audit summary)

Rollback strategy: F4 is a presentation-layer migration with no DB changes. Rollback = revert the merge commit on `main` + redeploy. No migration reversal needed. The Vercel preview deploys on each commit act as a rolling safety net during development.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Solo-maintainer review substitute (Principle IX) | Single developer — no second reviewer available | Same substitute stack as F1/F2/F3: automated review + test coverage + staff-review agent. Substitute is reversible when a second maintainer joins. |
| Breadcrumb uses React Context instead of pure props (Principle X — added complexity) | Dynamic route segments need human-readable labels from the page that loaded the data, but the breadcrumb renders in the parent layout which doesn't have that data | Pure props would require threading labels through every layout level (3-4 deep in Plans), creating prop drilling. Context is the standard React pattern for this cross-cutting concern and adds ~30 LOC. |
