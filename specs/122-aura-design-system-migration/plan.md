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
**Primary Dependencies**: next-intl · next-themes · Tailwind v4 · **+ `@jirawatpyk/aura-react@5.10.0`, `@jirawatpyk/aura-tokens@5.10.0`** (Constitution X justification in Complexity Tracking). US0 removes: `sonner`, `react-day-picker`. Later phases remove: `cmdk` (with its last picker, at the latest US13 — the palettes leave it in US1); `@base-ui/react`, `tw-animate-css`, `shadcn` (dev), and the `@tanstack/react-table` UI use (US13).  
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
  - Re-checked against constitution 2.1.0 (2026-10-18): component, style and markup phases may use the allowance (test and code in one commit, with the failing run's test name and failure line recorded). `route.ts`, server actions, guards and validation keep separate RED commits.
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
| 4 | Portal invoicing + pay sheet | DataTable, StatusPill, Alert, right Drawer (full screen on phones) around unchanged Stripe Elements — no Stepper (spec Clarifications, US4 start) | US1 | L, money |
| 5 | Members (three PRs: US5a list, directory, change requests; US5b-1 detail, timeline, benefits, their dialogs; US5b-2 forms) | DataTable server mode (URL contract), FilterBar, bulk action bar, Dialog, Stat | US1 | L |
| 6 | Plans | forms, Select, Switch, Tabs, Stepper, Table | US1 | M |
| 7 | Renewals | one DataTable (stacked cards on phone), cycle detail, tasks | US1 | L |
| 8 | Invoicing admin | registers (summary line above the table), refund/void/credit/record-payment dialogs; three PRs (US8a/b/c) | US1; void/auto-refund logic task first | L, money |
| 9 | Events | DatePicker/TimePicker (`timeZone="Asia/Bangkok"`), Combobox, FileUpload | US1 | L |
| 10 | Users/audit/compliance/settings | DataTable, Menu danger items | US1 | M |
| 11 | Dashboard | Stat tiles; recharts recoloured with AURA chart tokens | US1 | M |
| 12 | E-Blast | queue DataTable (+ item 52 or a local selection column), workspace, schedule dialog, member sign-off | US1 | L |
| 13 | Exit | delete `src/components/ui`; uninstall `@base-ui/react`, `tw-animate-css`, `shadcn`; drop the TanStack table UI; global lint ban | all | M |

Each phase's definition of done is FR-010. Logic defects found on the way ship as separate PRs merged first (FR-011).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **X. Two new dependencies** (`@jirawatpyk/aura-react`, `@jirawatpyk/aura-tokens`, exact 5.10.0) | They carry the design system the ~300 canvas boards are built on. The maintainer owns AURA, and the handoff doc (items 1–56) makes it the Chamber-OS component contract. **Net −4 at US13**: sonner, react-day-picker, cmdk, `@base-ui/react`, tw-animate-css and shadcn go (−6); the two AURA packages come in (+2). | Re-skinning the local kit to look like AURA was rejected (maintainer, 2026-09-26). It keeps two design sources in sync forever and still leaves sonner/cmdk/day-picker. A hybrid (AURA only where the kit lacks a component) was also rejected: it never reaches one library. |
| **VI. Two component libraries coexist** (`constitution.md:496–497`) | A big-bang swap of about 110 pages cannot be reviewed or rolled back safely. Phase-per-PR keeps every PR reviewable and revertable. | Big-bang PR: unreviewable, and one regression blocks everything. Keeping the old kit indefinitely breaks VI permanently. **Bound: ≤ 10 weeks from the US0 merge to the US13 merge**; renewal needs a new recorded decision. The lint ratchet (FR-008) makes the old-kit import count fall monotonically. |
| **VII. Temporary bundle growth** during coexistence | Both CSS/JS sets ship until the old kit's last importer migrates. | Code-splitting AURA per route is already automatic (App Router); the residual growth is the shared CSS. Budgets are re-baselined per phase with the existing formula `ceil(kb/10)*10+100`, and must end at or below today's ceilings at US13. |
| **FR-011 (no logic change) — three small behaviour changes ride in US1** | Each is forced by AURA replacing a primitive whose behaviour the old code relied on: (1) the idle warning's Escape / × / scrim now run the "Stay signed in" heartbeat — AURA's Dialog adds a × and a scrim close the old AlertDialog lacked, and closing without a heartbeat left the server session ageing under a fresh countdown; (2) ⌘B no longer toggles the rail while typing — the old primitive's shortcut ate the editor's Bold; (3) the member palette shows F-04's "all paid up" line as an inert row — under cmdk it could never render. | Splitting each into its own PR merged before US1 (FR-011's rule) was rejected: each fix exists only because of the AURA swap, and shipping US1 without them would ship the regression (a closeable idle warning that signs people out unexpectedly). Each has its own RED test in the US1 PR. |

## Evidence

Failing runs recorded under constitution 2.1.0 (D-023): for UI presentation the test and the code share one commit, and the test's failure against the old code is recorded here. One row per task: the test, the failure line it printed against the old code, and the commit.

### US12a

| Task | Test | Failure against the old code | Commit |
|---|---|---|---|
| T1202 | `tests/unit/components/shell/tiptap-loader.test.tsx` › shows one labelled status with shared skeleton blocks while the editor loads | `AssertionError: expected  to have a length of 2 but got +0` (the legacy `Skeleton` blocks, run with the import pointed at `@/components/ui/tiptap-loader`) | (this commit) |
| T1203 | `tests/unit/broadcasts/components/admin-template-library.test.tsx` › spec 122 US12a: the pills are AURA tags, the table and Starter badge are AURA | `Error: expect(element).toHaveClass("aura-tag")` | (this commit) |
| T1204 | `tests/unit/broadcasts/components/admin-template-form.test.tsx` › renders the name, subject and locale as AURA fields | `AssertionError: expected null not to be null` (the other two cases, errors after first submit and the POST body, passed on the old form: behaviour kept) | (this commit) |
| T1205 | `tests/unit/broadcast/admin-image-allowlist-editor-errors.test.tsx` › uses an AURA field, an AURA table and an AURA confirm for Remove | `AssertionError: expected null not to be null` (the three error-envelope cases passed on the old editor; the final-focus source scan stays green) | (this commit) |
| T1206 | `tests/unit/broadcast/brand-settings-form.test.tsx` › draws three AURA cards with AURA fields, and the notices as AURA alerts | `AssertionError: expected  to have a length of 3 but got +0` (the 24 behaviour cases passed on the old form) | (this commit) |
| T1207 | `tests/unit/components/marketing/audience-filters.test.tsx` › spec 122 US12a: the filters are AURA FilterSelects in a FilterBar that folds into a sheet on phones; `audience-table.test.tsx` › spec 122 US12a: the table and its badges are AURA | `TestingLibraryElementError: Unable to find an accessible element with the role "region" and name /filters/i`; `Error: expect(element).toHaveClass("aura-tbl")` (the URL-sync, Clear-focus, hostile-param and debounce cases passed on the old bar: behaviour kept) | (this commit) |
| T1209 UX M1 | `tests/unit/broadcast/compose-and-settings-skeletons.test.tsx` › templates (UX M1): phones get five card blocks, the table rows show from sm up | `AssertionError: expected  to have a length of 5 but got +0` | (this commit) |
| T1209 UX M2/L1/L3 | `tests/unit/broadcasts/components/admin-template-library.test.tsx` › UX M2 subject wraps on phone cards; UX L1 visible count; Starter badge sr-only name | `Error: expect(element).not.toHaveClass("truncate")`; `Unable to find an element with the text: 5 templates, which matches selector '[data-slot="template-count"]'`; `Unable to find an element with the text: /seeded by the platform/i` | (this commit) |
| T1209 UX M4/M5/L5 | `tests/unit/broadcast/brand-settings-form.test.tsx` › the swatch uses the control border and sits beside the field at every width; Save is full width on phones | `Error: expect(element).toHaveClass("border-[var(--aura-border-control)]")`; `Error: expect(element).toHaveClass("max-sm:w-full")` | (this commit) |
| T1209 UX M3/L6 | `tests/unit/components/marketing/audience-table.test.tsx` › stacks into AURA cards below 640 px; fixed layout and min-width from sm up only; `audience-table-skeleton.test.tsx` › phone cards, AURA border token | `Error: expect(element).toHaveClass("aura-tbl--stack-sm")`; `AssertionError: expected '1048px' to be ''`; `AssertionError: expected 0 to be greater than 0`; `Error: expect(element).toHaveClass("border-[var(--aura-border-default)]")` | (this commit) |
| T1209 UX L7 | `tests/unit/broadcast/admin-image-allowlist-editor-errors.test.tsx` › the Add button drops by the shared field-box offset | refactor (the shared constant names the same class): green before and after | (this commit) |
| T1209 UX L8 | `tests/unit/broadcast/compose-and-settings-skeletons.test.tsx` › the new-template card does not repeat the page title or subtitle; the edit-template card keeps the name but not a second subtitle | `AssertionError: expected <h2 class="aura-card__title"></h2> to have a length of +0 but got 1`; `AssertionError: expected [ 'editPageDescription', …(1) ] to have a length of 1 but got 2` | (this commit) |
| T1209 UX L4 | `tests/unit/broadcast/brand-settings-form.test.tsx` › an invalid colour gets the danger border without moving the hint Save points at | `AssertionError: expected 'aura-field is-touch min-w-0 flex-1 sm…' to contain '[&_div:has(>input[aria-invalid=true])…'` | (this commit) |
| T1209 admin form align | `tests/unit/architecture/admin-form-align.test.ts` › every FormContainer under (staff) passes align="start" | `AssertionError: expected [ …(19) ] to deeply equal []` (template new/edit, broadcast settings, brand, invoices/new, renewal schedules — page, loading, error) | (this commit) |
| T1209 parity comments | `admin-template-library.test.tsx` › phone Edit full-width outline at the foot; outer frame drops below 640 px · `compose-and-settings-skeletons.test.tsx` › skeleton frame flush · `admin-template-form.test.tsx` › Cancel and Save in the pinned phone action bar · `audience-table.test.tsx` › phone contact cards per board | `Error: expect(received).toHaveClass()`; `Error: expect(element).toHaveClass("aura-card--flush-below-sm")`; `AssertionError: expected null not to be null`; `Unable to find an accessible element with the role "list" and name "Marketing audience — contacts and their marketing state"` | (this commit) |
| T1209 brand preview + badge | `brand-settings-form.test.tsx` › the e-mail preview card (board): logo, heading and button in the brand colour, e-mail footer; follows typed colour and address; "Sent by …" without an address; chamber name without a logo · `admin-template-library.test.tsx` › on a phone card the Starter badge sits at the right end of the title row | `TypeError: Cannot read properties of undefined (reading 'caption')` (×4, no preview strings or card yet); `Error: expect(element).toHaveClass("max-sm:flex max-sm:w-full max-sm:justify-between max-sm:flex-nowrap")` · then CI on `aaaa22fd1`: `tests/contract/broadcasts/brand-page-guard.test.ts` › `TypeError: Cannot read properties of undefined (reading 'url')` (the page's new chamber-name read loaded the DB client; the guard test now mocks it and pins it after the gate) | `aaaa22fd1` + follow-up |
| T1212 queue table | `queue-table-client-a11y.test.tsx` › an AURA grid named by the table label; only actionable rows carry a checkbox (others say why not); announcer 0→1; select-all picks only actionable rows; read-only has no selection; `aria-sort` on the column the order follows · `queue-with-bulk.test.tsx` (grid roles, native checkboxes) | `Unable to find an accessible element with the role "grid" and name "Broadcast review queue"` (×10, run against the TanStack table at `2b97b643b`); `Unable to find an accessible element with the role "checkbox" and name "Select all rows"` | (this commit) |
| T1213 phone cards | `queue-card-list.test.tsx` › one card per row in a list; one full-width Review link per card to the detail page; no checkbox and no inline Approve / Reject · `queue-card-list-columns.test.tsx` › date + SLA chip, subject, member, audience · recipients; stage pill and whose turn kept (FR-026) | `TypeError: Cannot read properties of undefined (reading 'getRowModel')` (×15, the card list at `2b97b643b` takes the TanStack table, has a checkbox and inline Approve / Reject) | (this commit) |
| T1214 bulk bar + dialog | `queue-bulk-action-bar.test.tsx` › an AURA ActionBar named for the bulk actions, count outside any live region, no spacer; Clear and Approve are AURA touch buttons; the in-flight status is the bar's own status line · `bulk-approve-confirm-dialog.test.tsx` › an AURA alert dialog with an AURA radio group, the send-now warning describing Confirm, the schedule an AURA field | `Unable to find an accessible element with the role "region" and name "Bulk actions for selected broadcasts"` (×7, the fixed `role=toolbar` bar at `fedfc9814`); `expected null not to be null` (no AURA dialog); `expected undefined to be an instance of Function` (no AURA `Dialog` to hand `finalFocus` to) | (this commit) |
| T1215 filters | `queue-filters-*` (4 files) › the stage chips are AURA toggles (`aria-pressed`) carrying `data-status`, same hrefs; the presets are AURA selected chips; Reset an AURA touch button; focus after an unmounting control lands on the first stage chip; an AURA FilterBar named for the queue filters with a "Filters (3)" sheet button | 15 failed against `12653e1a6`: `Unable to find an accessible element with the role "button"` (×7, checkbox chips), `… role "region" and name "Broadcast queue filters"` (×2), `expect(element).toHaveClass("aura-tag is-selected")`, `expected <input …> to be null` (×2, focus went to the checkbox) | (this commit) |
| T1218 shared dialogs | `reason-confirmation-dialog.test.tsx` › an AURA alert dialog with an AURA textarea; a required reason takes first focus, an optional one hands it to Cancel; busy Confirm spins (`.aura-spin`) and keeps focus; errors follow the field box; danger / primary tone · `typed-phrase-field.test.tsx` › an AURA text field with the phrase as its label addon; body type; touch-height copy button · `member-sign-off-actions` tone asserts | 10 failed against `59f02c662`: `expected null not to be null` (no AURA field / spinner), `Cannot read properties of null (reading 'nextElementSibling')` (×2), `expect(element).toHaveClass("aura-btn--danger")`, `… ("aura-btn aura-btn--touch")`, `expected '…' to match /aura-text-body/` | (this commit) |
| T1216 review dialogs | `review-actions-halves.test.tsx` › Approve primary / Reject danger outline AURA buttons, 44 px on touch · `approve-dialog-recipient.test.tsx` › an AURA alert dialog with a "When to send" radio group and the schedule an AURA field · `f7-staff-dialogs-read-only.test.tsx` › clear halt opens from an AURA button; Confirm waits for the typed name | 3 failed against `22100af8b`: `expect(element).toHaveClass("aura-btn aura-btn--primary aura-btn--touch")`, `Unable to find an accessible element with the role "group" and name "When to send"`, `expect(element).toHaveClass("aura-btn aura-btn--touch")` | (this commit) |
| T1217 banners, page frame, loading, error | `sla-banner.test.tsx` › the SLA banner is an AURA alert in the severity tone (red speaks as an alert) · `overdue-banner.test.tsx` › an AURA danger alert · `queue-loading-skeleton.test.tsx` › chips h-8, phone queue-card skeletons, the phone Filters button block · `approval-staff-read-only` / `f7-staff-dialogs-read-only` / `member-sign-off-actions` / `read-only-member-surfaces` › the inline warning is an AURA warning alert | 11 failed against `2c638dacf`: skeleton `h-8` / `queue-card` / `filters-button` (3), `expect(element).toHaveClass("aura-alert--warning")` (3), SLA tone and role (3), `expect(element).toHaveClass("aura-alert aura-alert--danger")` (overdue) | (this commit) |
| T1219 queue columns fit | `queue-table-columns.test.tsx` › the column minimums add up to at most 871 px · the rows are only as wide as those minimums (stand-in until AURA #159) · a long stage name wraps inside its pill (stand-in until AURA #158) | 2 failed against `d177a0ae6`: `expected 1396 to be less than or equal to 959` (first budget; corrected to 871 px once the 48 px row gutters were counted), `expected element to have class "[&_.aura-pill]:whitespace-normal"`; preview at 1440/1280 EN/TH/SV: the grid scrolled 217/377 px and hid Actions, now 0 px with no overflowing cell | (this commit) |
| T1219 UX review fixes | `queue-filters-ux-review.test.tsx` › the default view reads "Filters (1)" · a stage chip lifts AURA's 24ch cap from sm up and has no title (stand-in until AURA #160) · `halt-state-banner.test.tsx` › the member link is accent and 44 px on a phone; the row stacks · `approve-dialog-recipient.test.tsx` › no header close while the request runs | 5 failed against `6fbbc297d`: `toHaveTextContent("Filters (1)")`, `toHaveClass("sm:[&_.aura-tag\_\_text]:max-w-none")`, `toHaveClass("text-[var(--aura-fg-accent)] min-h-11 sm:min-h-0")`, `toHaveClass("max-sm:flex-col max-sm:items-stretch")`, `expected <button …> to be null` (Close) | (this commit) |
| T1219 parity comments (19 Oct) | `queue-filters-ux-review.test.tsx` › one AURA "Submitted" range, no native date boxes · "Any time" drops both days and the cursor · In review / Closed / Quick views named by visible captions · presets before the member field; `typed-phrase-field.test.tsx` › a label that names the phrase shows it once, nothing focusable before the input | 7 failed against `e5b168005`: `Unable to find role="button" and name "Submitted: Any time"` (×2), `Unable to find role="group" and name "In review"` / `"Closed"` / `"Quick views"` (×4), `expected <span id="ch-phrase" tabindex="0">…</span> to be null` | (this commit) |
| T1219 queue table + skeleton + bulk list (19 Oct) | `queue-table-columns.test.tsx` › seven columns (no Whose turn header) · Stage min 200 px and a 16 px pill radius · whose turn is a line under the pill; `queue-loading-skeleton.test.tsx` › seven columns · a row has the select column and two h-9 actions, min-h 5.5rem; `bulk-approve-confirm-dialog.test.tsx` › lists each selected E-Blast with member · recipients in a scrolling list | 6 failed against `b0bb16dd2`: headers had `"Whose turn"`, `--aura-cell-min: 120px`, `Whose turn:\s*Marketing` not found, `queue-column` length 8 ≠ 7 (×2), `[data-skeleton="queue-select"]` null, `Unable to find role="list" and name "E-Blasts to approve"` | (this commit) |
| T1219 Approve / Reject side by side (19 Oct) | `queue-table-columns.test.tsx` › Actions has a 128 px minimum, not a fixed width, and the grow stand-in (#162) · no grow on a read-only table; `queue-loading-skeleton.test.tsx` › actions side by side from 1,440 px and rows 4.25rem from 1,800 px | 2 failed against `b3dc68372`: `expected "--aura-cell-flex:none;--aura-cell-w:128px" to match /--aura-cell-min:\s*128px/`, `expected "flex flex-col gap-1" to contain "min-[1440px]:flex-row"` | (this commit) |
| Wheel over a table scrolls the page (19 Oct, all pages) | `aura-table-wheel-css.test.ts` › the table box passes vertical scrolling on, inside `@layer components` | `AssertionError: .aura-table__scroll rule: expected -1 to be greater than -1`; Playwright on the production preview, mouse over the grid, wheel up 120: invoices at 800 px 262 → 262 and the queue at 1,024 px 662 → 662 (both grids scroll sideways), after the fix 262 → 142 and 662 → 542 | (this commit) |
| Tables inside a card bleed (19 Oct) | `directory-aura.test.tsx` › bleeds to the card edges · loading skeleton is AURA's table skeleton; `table-in-card-bleed.test.ts` › 7 tables pass `bleed` | 2 + 6 failed before: `expected null not to be null`, `expected '<Table caption={t(\'title\')} …>' to match /\sbleed\b/`; a measure of every preview view at 1440 found 7 framed tables under an `.aura-card` (directory, audience, at-risk, member invoices, invoice line items, portal invoices, portal line items), 0 after | (this commit) |
| Wide screens share the spare width (19 Oct, option ก) | `table-column-share.test.ts` › members / directory text columns are flexible, audience Contact and Member share, invoice Actions fits Record payment… + ⋯ and Total fits six figures; `audience-table.test.tsx` › Contact and Member flex | 4 failed before: `expected false to be true`, `companyName: expected false to be true`, `expected { contact: 184, … } to not have property "member"`, `expected 184 to be greater than or equal to 206`; measured on the production preview: members at 1440 unchanged (Company 188, Primary contact 164, Plan 151) and 285 / 285 / 285 at 1920; the invoice ⋯ ends at one x on every row (was 6px further right on rows with Record payment…); no grid scrolls sideways at 1024–1920; the audience at 1280 scrolled 89px before (floor 1048 in a 959px card) and none after, red first as `expected 1048 to be less than or equal to 944`; the audience and queue skeletons read the tables' own layout modules, red first as `expected '…' to match /from '\.\/audience-table-layout'/` | (this commit) |
| Table skeletons match their tables (19 Oct, every list) | `plans-loading-skeletons.test.tsx` › the admin's seven heads; measured by a sweep of every list preview vs its loading view at 1280 / 1440 / 1920 | sweep before, at 1440: Plans 6 heads against 7 (Δ62px), Change requests Δ65px, Users Δ78px (skeleton columns all 214px), Audit Δ74px (all 179px); the plans test red as `expected [ 'columns.name', …(6) ] to deeply equal [ 'columns.name', …(5) ]` until it pinned the seven heads; after: every list within 31px at 1440, Users and Audit on AURA's static Table with the real shares (new shared `StaticTableSkeleton`), Users rows 49 vs 49 and Plans 50 vs 49; residuals: Change requests 45px and Audit 34px at 1280 (their real tables size columns to content), Members 40px at 1280 (checkbox column) | (this commit) |
| Audience count beside the filters (19 Oct) | `audience-count-row.test.ts` › the card body wraps, the filters take their one-row width as a basis, the count joins them when it fits | 2 failed before (`expected … to match /sm:flex-row sm:flex-wrap/`, `/data-audience-filters=""/`); measured: 1920 count beside the filters, 1440 and below on its own line under them (the four filters fill the row), no page overflow 390–1920, the table scrolls inside its box at 640–1024 as before; a grid column was tried first and squeezed the bar onto two rows at 1440 | (this commit) |
| Audience count at the end of the filter row at every width (19 Oct) | `audience-count-row.test.ts` › the filters take the width the count leaves; the count lines up with the bar's first row | 2 failed before (`expected … to match /sm:flex-row sm:flex-wrap sm:items-start/`, `/sm:\[&>#audience-count\]:min-h-9/`); measured: count right edge 1208 / 1368 / 1784 px at 1280 / 1440 / 1920, the same as Members' "131 results", on the bar's first control row (count 36 px tall, control top within 1 px) at 768–1920; the bar wraps its own controls when it must; no page overflow. StaticTableSkeleton labelled stand-in until AURA #164 (Addendum 65) | (this commit) |
| AURA 5.51 (#157–#163) adopted (19 Oct) | `queue-table-columns.test.tsx` › AURA counts the row minimum (#159), Stage pill `wrap` (#158), Actions `grow` 2.5 (#162); `queue-table-client-a11y.test.tsx` › row actions are Tab stops (#161), aria-sort via `sortDirection` (#157); `aura-table-wheel-css.test.ts` › AURA contains only the sideways axis and the app override is gone (#163); `queue-filters-ux-review.test.tsx` › the stage chip reaches into no `.aura-tag` class (#160) | 5 failed on 5.51 before the code moved off the stand-ins (`expected <span …> to have class "is-wrap"`, `expected '--aura-cell-min: 128px; --aura-cell-flex: 1 1 0' to match /--aura-cell-flex:\s*2\.5 1 0/`, a row button with `tabindex="-1"`, the `--queue-row-min` box, the globals override); measured after on the production preview: queue widths identical to the stand-ins at 1280 / 1440 / 1920 in EN/TH/SV (Actions 131 / 259 / 386, no scroll), `aria-sort` on Time in stage, Tab walks Approve → Reject → checkbox → link, the wheel scrolls the page over a sideways grid (262 → 142, 662 → 542) | (this commit) |
| T1222 stage badge as AURA status pill (US12c-1) | `admin-status-badge.test.tsx` › renders the stage word in an AURA status pill, in the tone the queue uses; a long SV label wraps inside the pill | 2 failed before the change ("expected null not to be null": no `.aura-pill`, the legacy `Badge` rendered), 2 passed after |
| T1221 detail page frame on AURA (US12c-1) | `admin-eblast-detail-actions.test.tsx` › the approval round and the submission are AURA cards labelled by their h2; the version comparison is two AURA cards; every page note is an AURA alert that keeps its test id and role; a thread that cannot be read is a danger alert with the retry inside it; the held and failure-reason notes | 8 failed before the change (e.g. "expected '<section aria-labelledby=\"eblast-stage-title\" data-stage=\"review\">' to contain 'aura-card'"; held note had no `aura-alert`), 60 passed after; broadcast unit suite 747 passed |
| T1221 detail loading + error on AURA (US12c-1) | `admin-eblast-detail-skeleton.test.tsx` › every card is an AURA card and every bar the shared skeleton block; the content grid and 320 px checks read AURA cards and `skeleton-block` bars | 3 failed before the change ("expected 0 to be greater than 0": no `skeleton-block`; "expected [] to have a length of 2": no `.aura-card`), 5 passed after. `error.tsx` moves to the shared `RouteErrorPanel` (its own tests) |
| T1221 action row follows the board (US12c-1) | `admin-eblast-detail-actions.test.tsx` › submitted: Cancel and Reject at the start; Start and Approve at the end; member_approved: Schedule at the end, Cancel and Reject at the start | 2 failed before the change ("expected 'data-testid=\"eblast-action-row\"><div …' to contain 'aura-actionbar'"; "aura-actionbar__actions: expected -1 to be greater than -1"), 2 passed after; broadcast unit suite 750 passed |
| T1221 member original folds on a phone (US12c-1) | `original-disclosure.test.tsx` › on a phone the original is folded under its summary; from lg it is open, with the summary hidden, and the card rendered once · `admin-eblast-detail-actions.test.tsx` › the read-only comparison puts the original, not the version, in the disclosure | before the change: the component file did not exist ("Failed to resolve import \"@/components/broadcast/admin/original-disclosure\"") and the page test failed ("expected -1 to be greater than -1": no `eblast-original-disclosure`); 65 passed after |
| T1223 Start formatted version on AURA (US12c-1) | `start-formatted-version-action.test.tsx` › M3 secondary trigger (`aura-btn--secondary`), from changes_requested the primary (`aura-btn--primary`), the void confirmation is an AURA alert dialog whose confirm is the danger button; H1, H2 (aria-disabled, keeps focus), D8 and V1 unchanged and green | 3 failed before the change (legacy `Button` had no `aura-btn--*`; the legacy AlertDialog rendered), 8 passed after; broadcast + broadcasts suites 2706 passed |
