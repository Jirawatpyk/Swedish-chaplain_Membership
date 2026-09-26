# Implementation Plan: AURA Design-System Migration

**Branch**: `claude/jolly-feynman-8hpoyh` | **Date**: 2026-09-26 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/122-aura-design-system-migration/spec.md`

## Summary

Replace the local shadcn/Base-UI component kit, `sonner`, `cmdk`, `react-day-picker` and the TanStack table UIs with AURA (`@jirawatpyk/aura-react` + `@jirawatpyk/aura-tokens`, **5.5.0 exact**), one phase per PR (US0–US13). **This PR ships US0 (Foundation)**, which has five parts:

- **CSS:** AURA's tokens and component CSS enter through the CSS cascade-layer order AURA documents for coexisting with Tailwind + shadcn. A **token bridge** feeds the legacy shadcn variables from `--aura-*`, so every page takes AURA's look at once.
- **Fonts:** AURA's self-hosted fonts replace Geist.
- **Provider:** an `AuraBridge` client provider passes locale, calendar, time zone, router link and density to AURA; AURA's own EN/TH/SV labels are used.
- **Toasts:** a `src/lib/toast.ts` facade first re-points all 115 call sites and 111 test mocks, then swaps the implementation to AURA's toast. `sonner` is removed and the Toaster sits top-centre.
- **Lint ratchet:** a separate rule (`@typescript-eslint/no-restricted-imports`) stops regressions without touching the architecture import rules.

US1–US13 are specified here at phase level. Each gets its own detailed plan section and tasks when it starts.

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) · Node 22 LTS · Next.js 16.2.3 App Router · React 19.2.4 (locked)  
**Primary Dependencies**: next-intl · next-themes · Tailwind v4 · **+ `@jirawatpyk/aura-react@5.7.3`, `@jirawatpyk/aura-tokens@5.7.3`** (Constitution X justification in Complexity Tracking). US0 removes: `sonner`, `react-day-picker`. Later phases remove: `cmdk` (with its last picker, at the latest US13 — the palettes leave it in US1); `@base-ui/react`, `tw-animate-css`, `shadcn` (dev), and the `@tanstack/react-table` UI use (US13).  
**Storage**: none touched (presentation only)  
**Testing**: Vitest (unit/contract) · Playwright + axe (`--workers=1`, local only; run log linked in the PR) · coverage pins in `vitest.config.ts` unchanged  
**Target Platform**: Vercel `sin1`; CSP in `src/proxy.ts` `buildCsp` (`font-src 'self' data:`, `style-src 'self' 'unsafe-inline'`) stays unchanged  
**Bounded contexts touched**: none (`src/modules/**` untouched). Presentation only: `src/app/**` layouts, `src/components/**`, `src/lib/toast.ts` (new), `src/styles/` (new), `src/app/globals.css`  
**Performance Goals**: LCP < 2.5 s, INP < 200 ms, CLS < 0.1 on `/`, `/portal`, `/admin` (Constitution VII). Per-route first-load JS within the re-baselined budget (`scripts/check-bundle-budgets.ts`, `ceil(kb/10)*10+100`).  
**Constraints**: no new external origin (fonts self-hosted); BE display-only for `th`; dates formatted only through `src/lib/format-date-localised.ts`; layout containers keep API + `data-slot`; 44 px targets, 320 px no horizontal scroll, reduced motion; overlays from the two libraries never nest  
**Scale/Scope**: 48 kit files; 115 toast importers; 111 toast mocks; about 110 pages across the two portals; ~300 canvas boards as the visual reference

## Constitution Check

*Source: `.specify/memory/constitution.md` v1.4.2*

**NON-NEGOTIABLE gates**

- [x] **I. Data Privacy & Security**
  - No PII, route, permission or query changes.
  - The font and CSS origins stay same-origin, so no new third-party data flow.
  - CSP unchanged.
  - Tenant isolation: N/A (no tenant-scoped data touched).
- [x] **II. Test-First Development**
  - Each US0 behaviour has a RED-first test, listed in tasks.md:
    - the toast facade contract
    - the AuraBridge props
    - the lint-ratchet positive control
    - the token-bridge presence
    - the font-origin check
  - The existing unit, contract and e2e suites are the regression net.
  - No new use case, so no integration test is required.
- [x] **III. Clean Architecture**
  - Presentation layer only.
  - `src/lib/toast.ts` is a presentation utility with no domain imports.
  - Module barrels and the architecture lint blocks are untouched. The new ratchet uses a different rule name so it cannot replace them.
- [x] **IV. PCI DSS**: N/A. The Stripe Elements mount and SAQ-A scope are untouched. US4 re-skins the pay sheet around the unchanged Elements iframe.

**Core principle gates**

- [x] **V. i18n**
  - No new user-facing strings in US0. AURA 5.5 carries its built-in labels in EN/TH/SV and picks them by `locale`.
  - EN/TH/SV parity is kept (`pnpm check:i18n`).
  - Calendar is `buddhist` for `th`, `gregory` otherwise; storage is unchanged.
- [ ] **VI. Inclusive UX**: FAIL (justified). Two libraries coexist until US13, against "UI MUST be built from a single shared component library" (`constitution.md:496–497`). See Complexity Tracking. WCAG 2.1 AA and 320 px stay gates per phase (FR-013).
- [x] **VII. Performance & Observability**
  - Budgets as stated above.
  - Bundle growth during coexistence is re-baselined per phase (Complexity Tracking).
  - CLS is measured after the font swap.
  - No new logs, metrics or traces (presentation only).
- [x] **VIII. Reliability**
  - Error paths: the toast facade emulates unsupported options and never throws.
  - A rich (React-node) toast description degrades to text plus one action (research R4).
  - No state changes, no audit events.
- [x] **IX. Code Quality**: strict TS, ESLint clean, Conventional Commits, ≥1 reviewer. UI PRs also get an enterprise-ux-designer pass, and money screens a financial-integrity-reviewer pass.
- [x] **X. Simplicity**: two new deps (justified below); the facade is temporary (inlined or kept as the single toast import at US13); no speculative abstraction.

**Post-design re-check (after Phase 1)**: unchanged. The only FAIL is VI, justified with a hard end date.

## Project Structure

### Documentation (this feature)

```text
specs/122-aura-design-system-migration/
├── spec.md · plan.md · research.md · data-model.md · quickstart.md
├── contracts/
│   ├── toast-facade.md       # src/lib/toast.ts API (the 115 call sites' contract)
│   ├── aura-bridge.md        # provider props + density scoping
│   ├── css-layers.md         # layer order, imports, token-bridge map
│   └── lint-ratchet.md       # banned imports + migrated-paths list
├── checklists/requirements.md
└── tasks.md                  # /speckit.tasks
```

### Source Code (US0 touches)

```text
package.json · pnpm-lock.yaml                 # +aura-react, +aura-tokens (exact) · −sonner · −react-day-picker
src/app/globals.css                           # layer order, AURA imports, token bridge, font vars
src/styles/aura-theme.css                     # NEW, generated: aura-theme --brand "#10487A"
src/app/layout.tsx                            # drop Geist; mount <AuraBridge>; drop sonner <Toaster>
src/components/providers/aura-bridge.tsx      # NEW, client: AuraProvider + AURA <Toaster position="top">
src/app/(staff)/admin/layout.tsx              # density="compact" (nested provider)
src/app/(member)/portal/layout.tsx            # density="comfortable"
src/lib/toast.ts                              # NEW facade (sonner → AURA)
src/components/ui/sonner.tsx                  # DELETE
src/components/ui/calendar.tsx, scroll-area.tsx  # DELETE (0 importers)
src/components/invoices/use-supersede-warning-toast.tsx  # rich description → text + action (R4)
src/**/*.{ts,tsx} (115 files)                 # import { toast } from '@/lib/toast'
tests/**/*.{ts,tsx} (111 files)               # vi.mock('@/lib/toast', …)
tests/helpers/aura.ts                         # NEW: expectToast, pickSelect, checkBox, openMenu
tests/unit/architecture/ui-import-ratchet.test.ts  # NEW positive control for the lint rule
tests/unit/lib/toast-facade.test.ts           # NEW facade contract
tests/unit/providers/aura-bridge.test.tsx     # NEW
eslint.config.mjs                             # @typescript-eslint/no-restricted-imports block (appended)
scripts/check-bundle-budgets.ts               # re-baselined ceilings
docs/ux-standards.md · docs/aura-adoption.md (NEW) · docs/design-system-audit.md · CLAUDE.md
```

**Structure Decision**:
- No new module under `src/modules/`.
- AURA wiring lives in the presentation layer: providers, layouts and one `src/lib` utility.
- The generated brand theme is a committed stylesheet in `src/styles/`, regenerated only by the CLI, so the future F12 white-label feature can replace it with a per-tenant runtime theme in one place.

## Phase plan (US1–US13, one PR each — detailed when each starts)

| US | Phase | Main swaps | Depends on | Risk |
|---|---|---|---|---|
| 1 | Shell | AppShell/SideNav (from `src/config/nav.ts` via the permission evaluator), member top nav + BottomNav, header/user menu, Breadcrumb, Pagination, Command (drop `cmdk`), idle/confirm Dialogs, EmptyState, Skeleton (pulse; remove shimmer CSS) | US0 | L |
| 2 | Auth | TextField, PasswordField, Checkbox (`hideLabel`), FormErrorSummary | US1 | M |
| 3 | Portal home/profile/account | Card, Stat, StatusPill, link Tabs, ActionBar | US1; colleague-contact decision | M |
| 4 | Portal invoicing + pay sheet | DataTable + totals, Stepper, Drawer sheet ≤ 92 dvh around unchanged Stripe Elements | US1 | L, money |
| 5 | Members | DataTable server mode (URL contract), FilterBar, bulk action bar | US1 | L |
| 6 | Plans | forms, SegmentedControl, Switch | US1 | M |
| 7 | Renewals | one DataTable (stacked cards on phone), cycle detail, tasks | US1 | L |
| 8 | Invoicing admin | registers (sticky footer), refund/void/credit/record-payment dialogs | US1; void/auto-refund logic task first | L, money |
| 9 | Events | DatePicker/TimePicker (`timeZone="Asia/Bangkok"`), Combobox, FileUpload | US1 | L |
| 10 | Users/audit/compliance/settings | DataTable, Menu danger items | US1 | M |
| 11 | Dashboard | Stat tiles; recharts recoloured with AURA chart tokens | US1 | M |
| 12 | E-Blast | queue DataTable (+ item 52 or a local selection column), workspace, schedule dialog, member sign-off | US1 | L |
| 13 | Exit | delete `src/components/ui`; uninstall `@base-ui/react`, `tw-animate-css`, `shadcn`; drop the TanStack table UI; global lint ban | all | M |

Each phase's definition of done is FR-010. Logic defects found on the way ship as separate PRs merged first (FR-011).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **X. Two new dependencies** (`@jirawatpyk/aura-react`, `@jirawatpyk/aura-tokens`, exact 5.7.3) | They carry the design system the ~300 canvas boards are built on. The maintainer owns AURA, and the handoff doc (items 1–56) makes it the Chamber-OS component contract. **Net −4 at US13**: sonner, react-day-picker, cmdk, `@base-ui/react`, tw-animate-css and shadcn go (−6); the two AURA packages come in (+2). | Re-skinning the local kit to look like AURA was rejected (maintainer, 2026-09-26). It keeps two design sources in sync forever and still leaves sonner/cmdk/day-picker. A hybrid (AURA only where the kit lacks a component) was also rejected: it never reaches one library. |
| **VI. Two component libraries coexist** (`constitution.md:496–497`) | A big-bang swap of about 110 pages cannot be reviewed or rolled back safely. Phase-per-PR keeps every PR reviewable and revertable. | Big-bang PR: unreviewable, and one regression blocks everything. Keeping the old kit indefinitely breaks VI permanently. **Bound: ≤ 10 weeks from the US0 merge to the US13 merge**; renewal needs a new recorded decision. The lint ratchet (FR-008) makes the old-kit import count fall monotonically. |
| **VII. Temporary bundle growth** during coexistence | Both CSS/JS sets ship until the old kit's last importer migrates. | Code-splitting AURA per route is already automatic (App Router); the residual growth is the shared CSS. Budgets are re-baselined per phase with the existing formula `ceil(kb/10)*10+100`, and must end at or below today's ceilings at US13. |
| **FR-011 (no logic change) — three small behaviour changes ride in US1** | Each is forced by AURA replacing a primitive whose behaviour the old code relied on: (1) the idle warning's Escape / × / scrim now run the "Stay signed in" heartbeat — AURA's Dialog adds a × and a scrim close the old AlertDialog lacked, and closing without a heartbeat left the server session ageing under a fresh countdown; (2) ⌘B no longer toggles the rail while typing — the old primitive's shortcut ate the editor's Bold; (3) the member palette shows F-04's "all paid up" line as an inert row — under cmdk it could never render. | Splitting each into its own PR merged before US1 (FR-011's rule) was rejected: each fix exists only because of the AURA swap, and shipping US1 without them would ship the regression (a closeable idle warning that signs people out unexpectedly). Each has its own RED test in the US1 PR. |
