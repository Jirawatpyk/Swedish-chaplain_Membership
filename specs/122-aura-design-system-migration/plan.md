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
| T1225 schedule dialog on AURA (US12c-1) | `schedule-confirm-dialog.test.tsx` › spec 122 US12c-1: AURA trigger, AURA alert dialog, AURA radio group and time field; the mode tests read the native radios (`toBeChecked`, `toBeDisabled`), the unavailable keep option is explained by the proposal line in the dialog description; modes, request body, M4 focus, H1/D8/T166/V9 unchanged and green | 1 failed before the change ("expected null not to be null": no `fieldset.aura-radio-group`), 21 passed after |
| T1226 version thread on AURA (US12c-1) | `version-thread.test.tsx` › spec 122 US12c-1: the thread is an AURA card titled by its own h2, on both sides; order, authors and the portal naming rule unchanged and green | 1 failed before the change ("staff: expected false to be true": the thread was a legacy card inside a section), 7 passed after; broadcast + architecture suites 249 files passed |
| T1227 cancel action on AURA (US12c-1) | `cancel-broadcast-action.test.tsx` › spec 122 US12c-1: the trigger is AURA's danger outline button on both surfaces; the dialog, its reason rule and both endpoints unchanged and green | 1 failed before the change ("admin: expected 'group/button inline-flex …' to contain 'aura-btn--danger-secondary'"), 10 passed after |
| T1227 preview dialog, pane and states on AURA (US12c-1) | `preview-dialog.test.tsx` › the dialog and its trigger are AURA's (replaces the legacy `motion-reduce:duration-0` check: AURA's dialog drops its motion under reduced motion itself) · `preview-pane-empty-state.test.tsx` › shows a skeleton while the first render is in flight (the shared `skeleton-block`, no legacy `skeleton`); widths, same bytes, focus return, sandbox and every state unchanged and green | 2 failed before the change (no `aura-btn` on the trigger; no `skeleton-block`), 23 passed after; broadcast, broadcasts, architecture and events suites 265 files passed |
| T1224 formatted-version workspace + test copy on AURA (US12c-1) | `formatted-version-workspace.test.tsx` › card, fields, buttons and the original are AURA (AURA card + h2, subject/note AURA fields, Save secondary with no icon, Send primary with `mail`, test copy AURA, the original an AURA card inside the phone disclosure, the send confirmation AURA's alert dialog); H2 now reads AURA's `aria-disabled` (the legacy `data-disabled` hook is gone) and M7 finds the refusal in the field's group; request bodies, dirty guard, conflict and focus paths unchanged and green | 1 failed before the change ("expected false to be true": the workspace was a legacy card), 21 passed after; broadcast, broadcasts and architecture suites 249 files passed. e2e `eblast-approval` and `eblast-a11y` open the folded original below lg before reading it |
| T1228 ratchet (US12c-1) | `ui-import-ratchet.test.ts` › the US12c-1 staff approval-round detail and its shared pieces are on AURA (15 paths); the six US12c legacy controls moved to US12d compose files (`compose-form`, `proxy-compose-form`, `admin/broadcasts/new/error`, `compose/template-picker`); the portal controls stay until US12c-2 | 15 failed before `MIGRATED_PATHS` gained the paths, 400 passed after; architecture suite 37 files passed |
| T1229 workspace + Preview touch height (US12c-1) | `formatted-version-workspace.test.tsx` › the footer buttons stay 44px on a phone (touch height, no 36px floor) · `preview-dialog.test.tsx` › the Preview button is 44px on a phone | 2 failed before the change ("expected … to have class max-sm:min-h-11; received … max-sm:h-auto max-sm:min-h-9"; "expected aura-btn--touch; received aura-btn aura-btn--secondary aura-btn--sm"), measured on the preview at 390 as 36/36/36/32 px; broadcast and broadcasts suites 212 files passed after |
| T1229 e2e: open a dialog from the action row (US12c-1) | `helpers/open-action-dialog.ts`, used by `eblast-approval` (Start), `helpers/eblast-approval-flow` (Start) and `admin-review-queue` AS2–AS4 (Approve, Reject) | RED on the preview, not yet in the relay: a bare `locator.click()` on Confirm schedule missed 3 of 3 at 800, 1023 and 1440 px (focus ended in the email-preview iframe, no pointer event reached the page), 0 of 3 at 390 and with a 2200 px tall viewport; scroll first then click opened it every time. Relay R58 confirms on chromium |
| T1229 UX review: phone action row order + focus clearance, comparison cards level (US12c-1) | `eblast-detail-actions-css.test.ts` › wraps in DOM order, never reversed · keeps a focused control clear of its two-line bar · `original-disclosure.test.tsx` › from lg it fills the comparison column | 3 failed before the change ("expected … to match /flex-wrap:\s*wrap;/" on `wrap-reverse`; "html:has(.eblast-detail-actions) { not found"; "expected details to have class lg:h-full"), 287 passed after across styles, disclosure, parity-cleanup and detail suites |
| T1229 parity 20 Oct: timeline on AURA, error token (US12c-1) | `admin-audit-timeline-view.test.tsx` (5) | 5 failed before (no `AuditTimelineView` export; InlineError class "flex items-start gap-1.5 text-sm text-destructive"); passed after, committed separately |
| T1229 parity 20 Oct: phone ⋯ menu, two-column round, editor first in design (US12c-1) | `admin-detail-more-menu.test.tsx` (4) · `admin-eblast-detail-actions.test.tsx` › the staff detail page on a phone (3) · `admin-eblast-detail-skeleton.test.tsx` card count 4 → 5 | 3 + 2 failed before ("Unable to find role=button name 'More actions'"; stage `<dl>` class "grid gap-3 sm:grid-cols-2 lg:grid-cols-3"; no `max-sm:order-2` on the round card); 93 passed after across the detail, menu, Start and Cancel suites |
| T1229 parity 20 Oct: the phone row stays one line (US12c-1) | `eblast-detail-actions-css.test.ts` › keeps Reject · next step · ⋯ on one line | failed before (".eblast-detail-actions > div > :last-child { not found"); measured on the preview: member-approved bar 113px (two lines) at 390 EN/SV and 360 EN/SV/TH → 61px (one line) in all after |
| T1229 parity 20 Oct: the phone bar's status line (US12c-1) | `stage-duration.test.ts` (8) · `admin-eblast-detail-actions.test.tsx` › the bar carries the board's status line · `eblast-detail-actions-css.test.ts` › shows the status line on a phone only | failed before ("Failed to resolve import …/stage-duration"; no `data-bar-status` in the bar; the 640px rule hiding the status cell absent); passed after; on the preview at 390 "130 recipients · All members · 2 hours in stage" (TH/SV too), hidden at 1280 |
| T1229 parity 20 Oct: Approve fills the phone bar; design state per board (US12c-1) | `eblast-detail-actions-css.test.ts` › stretches the next step … in a wrapper · gives Reject the free space when ⋯ is the only control · `formatted-version-workspace.test.tsx` › follows board `Admin-eblast-design` | failed before (".eblast-detail-actions > div > :last-child > div { not found"; "… :only-child) > :last-child { not found"; "expected 'aura-btn aura-btn--secondary aura-btn…' to contain 'aura-btn--ghost'"); passed after. Approve measured 183px at 390, 153px at 360 |
| T1229 AURA 5.52 (#164): list skeletons on `TableSkeleton` (US12c-1) | `static-table-loading.test.tsx` (3) | 3 failed before ("expected  to have a length of 1 but got +0"; "expected true to be false" — the stand-in file still there); passed after |
| T1229 parity 20 Oct: staff detail e-mail frames fit the e-mail; comparison cards not stretched (US12c-1) | `preview-surface-fit.test.tsx` (6) · `admin-eblast-detail-actions.test.tsx` › the comparison cards end at their own content and their frames fit the e-mail | failed before ("with fit: same-origin only … takes the e-mail height" red; "expected '<section class=\"aura-card h-full min-…' not to match /\bh-full\b/"; after security review: "measures a document that loaded before hydration" and "stops watching when the frame goes away" failed); passed after. `security-engineer`: APPROVE |
| T1229 parity audit 20 Oct (all 16 pairs): e-mail in its own frame, note before subject, failed-step cross, outline Start, phone footer order (US12c-1) | `admin-eblast-detail-actions.test.tsx` › a version card reads note, subject, then the e-mail in its own frame · `admin-audit-timeline-view.test.tsx` › marks a failed dispatch with a danger cross · `start-formatted-version-action.test.tsx` › from changes_requested … an outline button · `formatted-version-workspace.test.tsx` › on a phone, Send to member sits first | 4 failed before ("expected -1 to be greater than -1" — no `data-version-note`; no `svg.lucide-circle-x`; class `aura-btn--primary`; no `max-sm:order-1`); passed after |
| T1229 parity audit 20 Oct: the phone bar meets the screen edge at the end of the scroll (US12c-1) | `eblast-detail-actions-css.test.ts` › reaches the bottom edge at the end of the scroll | failed before (".eblast-detail-actions { not found"); passed after. Measured at 390: 32px gap under the bar at the end of the scroll before, 0 after (review, design) |
| US12c-1 follow-up 20 Oct: one action-rules function for the page and the preview | `admin-detail-actions-rules.test.ts` (9) | failed before ("Failed to resolve import …/_components/detail-actions"), committed separately (`30a99a21e`); passed after, with the page's own 68 tests unchanged |
| US12c-1 follow-up 20 Oct: staff Delivery card (maintainer, thread 22962e5c) | `admin-eblast-detail-actions.test.tsx` › once sending has begun, a Delivery card · before sending begins there is no Delivery card and no read | failed before ("expected \"spy\" to be called with arguments: [ 'tenant-a', …(1) ]"), committed separately (`d4949f0fb`); passed after |
| US12c-1 follow-up 20 Oct: Delivery card UX review (HIGH 200% wrap; MEDIUM caption count, tones) | `admin-eblast-detail-actions.test.tsx` › the caption counts every recipient row · tones only a figure that is there · a tile label wraps inside its tile | failed before ("expected … to contain 'delivery.caption:130'" — it read the estimate, 42; "not to contain '--aura-fg-positive'" on 0 delivered; "expected '<div class=\"aura-stat\">' to contain 'min-w-0'"), committed separately; passed after |
| US12c-1 follow-up 20 Oct: Delivery tiles one per row at 200% on a phone (labels broke mid-word) | `admin-eblast-detail-actions.test.tsx` › a tile label wraps inside its tile | failed before ("expected … to contain 'grid-cols-[repeat(auto-fit,minmax(min…'"), same commit (UI presentation, D-023); passed after |
| US12c-1 follow-up 20 Oct: version history beside the lifecycle timeline from 1024px (maintainer) | `admin-eblast-detail-actions.test.tsx` › version history and the lifecycle timeline sit side by side · with no version history the lifecycle timeline keeps the full width | failed before (`data-testid="eblast-history-row": expected -1 to be greater than -1`), same commit (UI presentation, D-023); passed after |
| US12c-1 follow-up 2, 20 Oct: whose-turn bar | `admin-detail-turn-bar.test.ts` (6) · `admin-eblast-detail-actions.test.tsx` › a whose-turn bar sits under the header · no whose-turn bar once nobody acts next · an admin reads it as their own turn | failed before (`Failed to resolve import …/turn-bar`; `data-testid="eblast-turn-bar": expected -1 to be greater than -1`), committed separately (`97e2d7e63`); passed after |
| US12c-1 follow-up 2, 20 Oct: lifecycle timeline round steps | `admin-audit-timeline-events.test.ts` › labels the approval-round steps · reads the round steps … broadcast_id | failed before (`TypeError: timelineLabelKey is not a function`), committed separately; passed after |
| US12c-1 follow-up 2, 20 Oct: member form axe at end of scroll (e2e) | `members-create` @a11y, `members-edit-with-bundle-warning` @a11y on mobile-chrome | failed before on base and branch (R60: target-size ×2, target-offset ×1); preview axe after scrolling to the end: 0 on member new/edit, plan new, template new; relay re-run pending |
| US12c-1 follow-up 2, 20 Oct: history row cards shrink with the screen (#603 regression: 65 px page overflow at 390 / 200% text from the timeline's actor e-mail) | `admin-eblast-detail-actions.test.tsx` › version history and the lifecycle timeline sit side by side | failed before (`expected '<div class="grid gap-6 lg:grid-cols-2…' to contain '[&>*]:min-w-0'`), same commit (UI presentation, D-023); passed after |
| US12c-1 follow-up 20 Oct: every pinned phone bar meets the screen edge | `pinned-bar-edge-css.test.ts` (2) | failed before ("margin-bottom: calc(-1 * var(--page-padding-bottom)); not found"); passed after. Measured at 390 before: member/plan forms 32px, template/clone 49px under the bar |
| US12c-2 T1241/T1243, 20 Oct: portal detail frame on AURA; e-mail frames fit | `portal-eblast-sign-off-page.test.tsx` › delivery breakdown is an AURA card titled in its head · delivery counts in the board order, toned only above 0 · stage banner is an AURA info alert holding a wrapping StatusPill · each e-mail frame fits the e-mail inside an EmailFrame (×2) · `portal-eblast-detail-body.test.tsx` › subject as a real h2 in the AURA card-title type | failed before (`expected '<h2 id="broadcast-detail-fields-headi…' to contain 'aura-card__title'`; `expected '<div data-slot="inline-alert" data-to…' to contain 'aura-alert--info'`; `expected [ 8600, 8785, 8966, 9153, … ] to deeply equal [ 8600, 8785, 9153, 8966, … ]`; `Target cannot be null or undefined`); passed after |
| US12c-2 T1242, 20 Oct: member sign-off on AURA | `member-sign-off-actions.test.tsx` › Request changes is a normal step … Withdraw approval stays destructive · the too-long note error sits immediately under the note · the decision card is an AURA card; Approve primary; Cancel E-Blast at the end · the approve confirmation is an AURA alertdialog that opens on Cancel | failed before (`expect(element).toHaveClass("aura-btn--secondary")`; `expect(received).toHaveTextContent()`; `toHaveClass("aura-card")`; `toHaveClass("aura-dialog")`); passed after |
| US12c-2 T1244, 20 Oct: loading, error and not-found on AURA | `portal-eblast-detail-skeleton.test.tsx` (3) · `portal-eblast-not-found.test.tsx` › title and body … the way back is an AURA button | failed before (`expected [] to have a length of 3 but got +0`; `expected 'group/button inline-flex shrink-0 cur…' to contain 'aura-btn'`); passed after |
| US12c-2 T1245, 20 Oct: ratchet block and controls moved to US12d files | `ui-import-ratchet.test.ts` › the US12c-2 portal E-Blast detail and the member sign-off are on AURA (9) | failed before (9 × `expected [] to have a length of 1`) until `MIGRATED_PATHS` listed them; passed after. The moved controls (`compose-form.tsx`, `schedule-picker.tsx`) pass, so each still sees the legacy kit |
| US12c-2 T1249, 20 Oct: UX review M1/M2/L7 | `portal-eblast-sign-off-page.test.tsx` › awaiting the member: the stage pill is in the progress tone; `refresh-page-button.test.tsx` › takes the touch height; `portal-eblast-detail-skeleton.test.tsx` › renders the stage banner… | failed before (`expected 'aura-pill aura-pill--neutral is-wrap …' to contain 'aura-pill--progress'`; `expected 'aura-btn aura-btn--secondary aura-btn…' to contain 'aura-btn--touch'`; `expected 'rounded-md skeleton-shimmer h-16 w-fu…' to contain 'h-24'`); passed after |

### Sign-in reasons follow-up (after #607; size M, plan agreed 2026-10-21)

Follow-ups 1–4 from the #607 review: behaviour changes, so a PR of their own (not a UI swap).

- **Plan.**
  - The `?reason=` message moves into `SignInForm` as a `notice` prop. It is a static AURA info `Alert` with `id="signin-notice"` and no live region, and it describes the email field.
  - That field takes focus on mount, so the reason is read with its label. Before this, the focus announcement cut off the old post-hydration live region.
  - After a sign-in attempt the notice gives way to the error, so only one alert shows.
  - The idle sign-out carries `returnTo` (via `buildSignInUrl(portal, fromPath, reason)`).
  - A heartbeat 401 means the session was already gone (another tab, revoked, past its cap). It now reads `?reason=session-ended` with its own copy instead of "inactivity".
  - `SecurityUpdateBanner` is deleted.
- **RED** (commit `test(auth): …`, run before any code change): 14 failed, 62 passed across 5 files.
  - `idle-warning-dialog.test.tsx`: "on countdown expiry…" and "BUG-018: Stay signed in signs out only on a definitive 401" → `expected "spy" to be called with arguments` (no `returnTo`, no `session-ended`).
  - `return-url.test.ts`: "appends the sign-in reason after returnTo" → `Expected "/portal/sign-in?returnTo=%2Fportal%2Fprofile&reason=idle"`, `Received "/portal/sign-in?returnTo=%2Fportal%2Fprofile"`. "keeps the reason when the path is missing or unsafe" → `Received "/portal/sign-in"`.
  - `sign-in-form-errors.test.tsx`: "shows the sign-in reason as a standing notice…" → no `#signin-notice`.
  - `portal-sign-in-idle.test.tsx` (both pages): `?reason=idle|session-ended|security-update hands the form its notice` → `expected '' to be 'auth.idleWarning.signedOutInactive'` etc.; "renders no reason banner of its own beside the form" → `expected <div role="status" …> to be null`.
  - `portal-sign-in-link-invalid.test.tsx`: "hands the form the … notice" → no `data-notice`.
- **Review follow-up (UX LOW 1), RED:** `sign-in-form-errors.test.tsx` › "keeps the notice after a network failure — no inline error replaces it, only a toast" → `expect(received).toHaveTextContent()` on a null `#signin-notice`. After a network failure, nothing on the card replaced the notice; only the toast was left.
- **Accepted risk (security LOW 2):** an idle sign-out on `/admin/members?q=<name or email>` carries the search into `returnTo`. It stays same-origin, there is no analytics, and the referrer is cut to the origin. `requireSession` on main already does the same.

### Dialog footer touch targets + `fullWidth` (follow-up 5, with 6; size M, plan agreed 2026-10-21)

- **Plan.**
  - Every `<Button>` in an AURA `Dialog`'s `footer` carries `touchHeight`, so it is 44px below 640px (or on a coarse pointer) in compact density too. Before this, staff footers were 36px with a fine pointer.
  - A stretched AURA button uses `fullWidth` rather than the `w-full` class, which keeps AURA's fixed height and `nowrap`, so long labels overflowed.
  - Phone-only stretch has no AURA prop, so it is `fullWidth` plus the `FULL_WIDTH_BELOW_SM` reset above `sm` (a stand-in until AURA #165).
  - Guarded by `tests/unit/architecture/dialog-footer-touch.test.ts`. It parses with the TypeScript compiler, and it has positive controls: a CRLF fixture that must fail, and more than 30 footers parsed.
- **RED** (commit `test(ui): …`): the 2 positive controls passed and the 2 real checks failed.
  - "every Button in an AURA Dialog footer carries touchHeight" → `expected [ …(70) ] to deeply equal []`: 70 footer buttons across 36 files, including the shared `ConfirmationDialog` and `ReasonConfirmationDialog`.
  - "no AURA Button or buttonClass stretches with a bare w-full" → `expected [ …(5) ] to deeply equal []` (cycle-admin-actions, pending-reactivation-actions, member-sign-off-actions ×2, section-nav).
- **Mobile/a11y review follow-up:**
  - The guard now also catches a `buttonClass(...)` link in a footer without `touchHeight: true`. RED: `event-fee-form.tsx:1161` (the duplicate dialog's "View invoice"). Fixed.
  - On `issue-invoice-form`, the confirm names the total, and at 320px the label ran out of the button because the container's `max-sm:[&>*]:w-full` kept `nowrap`. Each button is now `fullWidth` plus `FULL_WIDTH_BELOW_SM`.
  - The other container-stretched rows still fit their labels (refund, void, credit note, events wizard/mapping, erase page). They are listed as a follow-up, and the guard doesn't see them yet.

### Sign-in and Stripe URL follow-up (PR 4 of the #607/#610 follow-ups; size M, plan agreed 2026-10-21)

These are logic fixes from the #608 reviews, in a PR of their own. The touch-target follow-ups from #610 are in the next PR (maintainer, 21 Oct: split into 2 PRs).

- **Plan.**
  - **Stripe redirect keys.** After a 3DS redirect, Stripe appends `payment_intent`, `payment_intent_client_secret` and `redirect_status` to the invoice URL. Nothing reads them.
    - The invoice detail page now removes them from the address bar on load (`StripStripeReturnParams`). It does this on every invoice, paid ones included, because the pay sheet never mounts on a paid invoice.
    - `buildSignInUrl` drops the same keys before `safeReturnTo`.
    - `paid` and `pay` stay.
  - **Sign-in notice on retry.** The notice now gives way only to an inline error (server or format) or to success, not at the start of a submit.
  - **Notice copy.** It now lives under `auth.signIn.notice.*`; the wording is unchanged.
- **Logging check:**
  - App code never logs the secret. `src/proxy.ts` logs `nextUrl.pathname` only. The query reaches the `x-pathname` header, and every reader of that header drops the query or goes through `buildSignInUrl`.
  - What a client-side fix cannot remove: the first GET after a 3DS redirect is still recorded by Vercel's request logs and by Next's root span (`http.target`). This comes from how Stripe's `return_url` works, and `redirect: 'if_required'` keeps it rare.
  - A client secret is not cardholder data, so scope stays SAQ-A (`pci-saqa-guardian`).
  - A scoped 303 redirect in the proxy would also close the device-history and same-origin Referer copies. That is left as a possible follow-up.
- **RED** (commit `d0d115f5e`, before any code change): 8 failed, 69 passed across 4 files.
  - `return-url.test.ts`:
    - "drops the Stripe redirect parameters and keeps the rest of the query" → `Received "/portal/sign-in?returnTo=%2Fportal%2Finvoices%2Fi1%3Fpay%3D1%26payment_intent%3Dpi_1%26payment_intent_client_secret%3D…"`
    - "keeps returnTo when only a long Stripe client secret made the path too long" → `Received "/portal/sign-in"`
  - `strip-stripe-return-params.test.tsx` (stub component): "removes the Stripe redirect parameters and keeps pay, paid and the path" → `expected '?paid=1&payment_intent=pi_1&…' to be '?paid=1&pay=1'`. The bare-path case failed too.
  - `portal-invoice-detail-download-number.test.tsx`: "issued|paid invoice → renders the URL cleanup" → `expected '<span …' to contain 'data-testid="strip-stripe-return-params-marker"'`
  - `sign-in-form-errors.test.tsx`:
    - "keeps the notice while a retry after a network failure is still in flight" → `expect(received).toHaveTextContent()`, "received value must be a Node" (the notice was gone)
    - "a format error after a network failure replaces the notice" → `expected <div id="signin-notice" …> to be null`
- **Review follow-ups, RED** (commit `1862aa9a0`):
  - `strip-stripe-return-params.test.tsx`: "hands Next a null state so the router learns the clean URL" → `expected "replaceState" to be called with arguments: [ null, '', …(1) ]`. The component passed `window.history.state`. That state carries Next's `__NA` marker, so Next skipped its router sync, and a later `router.refresh()` would write the secret back (`financial-integrity-reviewer`).
  - `return-url.test.ts`: "still drops returnTo for an unsafe query that also carries Stripe keys" → `Received "/portal/sign-in?returnTo=%2Fportal%2Fx%3Fnext%3Dhttps%253A%252F%252Fevil.example"`. Stripping had re-encoded the query past `safeReturnTo` (`security-engineer`, LOW 1).

### AURA 5.54: touch-target stand-ins out (PR 5 of the #607/#610 follow-ups; size M, plan agreed 2026-10-22)

AURA shipped #165 (5.53) and #166 (5.54). The maintainer chose to remove the `touchHeight` stand-ins (22 Oct: "ถอดออก"), accepting that on a touch tablet from 640px the bulk bars' `size="sm"` buttons look 32px (44px hit area; default buttons are 44px there through the coarse-pointer density).

- **Plan.**
  - Bump to 5.54. The brand theme regenerated with identical tokens and only its header comment changed, so it was kept as is.
  - Remove `touchHeight` from Dialog/Drawer footers and ActionBar `children`/`start`.
  - `FULL_WIDTH_BELOW_SM` becomes `fullWidth="below-sm"`.
  - Container-stretched rows move to per-button `fullWidth="below-sm"`.
  - Body buttons AURA does not cover gain `touchHeight`: the preview width toggles and the invoice form rows.
  - The guard flips: it refuses a `touchHeight` stand-in where AURA sizes the button, and any container `w-full` stretch.
- **Kept, deliberately:**
  - The `.eblast-detail-actions` layout CSS (the wrapping row, `height: auto` and `white-space: normal` for a wrapped label). Its own `min-height: 2.75rem` came out later; see "E-Blast bar consistency" below.
- **RED** (commit `10f0ab703`, guard only): 2 failed, 4 passed (both positive controls held).
  - "no Button in a Dialog/Drawer footer or an ActionBar carries touchHeight" → 88 hits, for example `src/components/shell/confirmation-dialog.tsx:166`, `src/app/(staff)/admin/members/_components/bulk-action-bar.tsx:440`.
  - "no AURA Button or buttonClass stretches with a w-full class, on itself or from its container" → 6 hits: `event-detail-view.tsx:117`, `refund-form.tsx:692`, `credit-note-form.tsx:452`, `void-confirm-dialog.tsx:262`, `csv-mapping-form.tsx:1223`, `webhook-config-wizard.tsx:242`.
- **GREEN** (`c5e4fec84`, D-023 UI exception: the prop removals share the guard's GREEN commit). Seven component tests that asserted the removed classes were updated to assert AURA's (`aura-btn--full-below-sm`, a button inside `.aura-actionbar` without `aura-btn--touch`).
- **Review follow-up (`enterprise-ux-designer` MEDIUM), RED** (`0d76f081b`, with a stub that returns nothing): "positive control: a Button with a sibling in a wrapper, or two wrappers deep, is caught" → `Expected ["fixture.tsx:4", "fixture.tsx:5"]`, `Received []`. Now that `touchHeight` is banned in footers, a Button in such a wrapper would silently fall to the density height on a phone. The real check passes: every footer Button in the app is direct, or the only element in its wrapper.
- **Reviews:**
  - `enterprise-ux-designer`: Ship with follow-ups.
  - `mobile-a11y-ux-reviewer`: Ship.
  - Both confirmed that every Button whose stand-in came out is sized by AURA's selectors. The ActionBar rule is a descendant selector, so it reaches Buttons at any depth.
  - The tablet wording was corrected: default buttons are 44px on a coarse pointer in compact density.
  - The E-Blast ⋯ IconButton keeps `touchHeight`, now with a comment: DropdownMenu puts it two wrappers deep.
- **Save bar consistency (maintainer, 22 Oct: "ควรแก้ให้ consist" — make it consistent).**
  - The invoice-settings save bar dropped its `min-h-11` as well: the ActionBar gives 44px below 640px. 088 FR-036 asks for touch targets of at least 44px and a reachable Save at 320px. The earlier note that it meant "44px at every width" was wrong.
  - The Save shown while nothing has changed (in the form body) moves from `min-h-11 max-sm:w-full` to `fullWidth="below-sm"`.
  - Failing run first (D-023 UI, shared commit): `invoice-settings-discard.test.tsx` › "is an AURA Button…" and `invoice-settings-form.test.tsx` › "the primary Save button…" both gave `expect(element).not.toHaveClass("min-h-11")`.
- **E-Blast bar consistency (maintainer, 22 Oct).**
  - `globals.css`: the two `min-height: 2.75rem` lines on the E-Blast detail bar's buttons came out (the next step, and Reject in the design state). AURA 5.54's ActionBar rule reaches them in `children` and in `start`. The layout rules stay: wrap, `height: auto` so a wrapped label grows the button, and `white-space: normal`.
  - `detail-action-bar.tsx`: the dead `touchHeight` on `ActionBar` came out. It sizes only the bar's own Clear button, and this bar has no `onClearSelection`.
  - Failing run first (D-023 UI, shared commit): `eblast-detail-actions-css.test.ts` › "keeps Reject · next step · ⋯ on one line…" and "leaves the 44px minimum to AURA…" both gave `AssertionError: expected '.eblast-detail-actions > div …' not to match /min-height/`.
- **R69 regression: `size="sm"` bulk-bar buttons on a touch tablet.**
  - R69 found one branch-only red: `renewal-a11y.spec.ts:188` "122 #123 — PipelineBulkActionBar keeps 44px targets on a touch tablet (1024px, coarse pointer)" → `toolbar button 1 height >= 44px at 1024px`, Expected ≥ 44, Received 32, on both projects. Base passes it.
  - Cause: AURA 5.54's ActionBar rule (and 5.53's footer rule) is viewport-based (below 640px). A default-size button on a touch tablet still gets 44px from the coarse-pointer density; a `size="sm"` one does not. Removing its `touchHeight` broke #123.
  - Fix (maintainer, 22 Oct, asked for the consistent and correct option): `touchHeight` back on the nine `size="sm"` buttons in the members, renewal pipeline and E-Blast queue bulk bars. The guard now refuses `touchHeight` on a default-size footer or bar button and asks for it on a `size="sm"` one. An AURA handoff asks for the bar and footer rules to use the same `(max-width: 639.98px), (pointer: coarse)` query as `touchHeight` (#123), after which these nine can go.
  - **RED** (`d3d3efaae`, guard only): "every size=\"sm\" Button in a Dialog/Drawer footer or an ActionBar carries touchHeight" → 9 hits (`bulk-action-bar.tsx:440, 456, 475, 491, 506`, `pipeline-bulk-action-bar.tsx:606, 619`, `queue-bulk-action-bar.tsx:511, 520`). Its positive control holds.
  - **GREEN**: the nine props back. Three component tests that asserted no `aura-btn--touch` on those buttons now assert it.
  - **Verified in the preview** (production build): the renewal pipeline bar at 1024 with a touch context (`pointer: coarse`) is 44px for Clear selection, Send reminder and Mark paid. At 1440 with a mouse the same buttons are 32px, as on base. The e2e run here stopped in its Upstash rate-limit fixture before the test body, so the e2e itself is for the relay.
- **Members bulk bar: the count on the same line as the buttons (maintainer, 22 Oct, screenshot).** Pre-existing, same on base (R69 observation).
  - Cause: AURA's status cell asks for at least 8rem (`flex: 1 1 8rem`). At 1440 the members bar's row is 1041px; 8rem + 12px gap + 917px of buttons is 1057px, so the count wrapped onto its own line (bar 80px tall).
  - Fix: `.chamber-bulk-actionbar > div > :first-child { flex-basis: auto }` in `globals.css` (the app's class and the bar's structure, never AURA's classes), on the members and renewal pipeline bulk bars. The E-Blast queue bar is left out: its `start` slot puts its status on a row of its own by design.
  - Failing run first (D-023 UI, shared commit): `bulk-bar-status-css.test.ts` › "takes the width of its text, at every width" → `.chamber-bulk-actionbar > div > :first-child { not found: expected -1 to be greater than -1`; the members and pipeline bar tests → `expected null not to be null` on `closest('.chamber-bulk-actionbar')`.
  - Measured after: at 1440 the members bar is one line, 60px (count 112px wide, buttons 917px). At 1280 and 1024 it still wraps, as there is no room.

### Evidence: small body buttons carry `touchHeight` (follow-up 5, PR 6)

- **Rule (maintainer, 22 Oct: "consistent และถูกตามหลัก UI"):** a `size="sm"` AURA `Button`, `IconButton` or `buttonClass` the user taps is 44px below 640px or on a coarse pointer, wherever it sits: page bodies (not-found pages, empty and error states, banners, card actions, list rows, filter controls) as well as footers and bars. AURA's footer and ActionBar rules and the coarse-pointer density never reach a `size="sm"` button in a body, so without `touchHeight` it shows 32px (44px hit area only).
- **Compact by design** (first cut, narrowed after review, below): table cells and menu/popover icon triggers.
- **Inventory:** 53 `size="sm"` sites without `touchHeight` on main `fbc00a5a5`; 43 gain it. `copy-charge-id-button` drops its own `min-h-11 min-w-11` (44px at every width) for `touchHeight`, like the rest.
- **RED** (`5ec3af3aa`, guard only, `tests/unit/architecture/small-button-touch.test.ts`): "every size=\"sm\" AURA button the user taps outside a table carries touchHeight" → `expected [ …(43) ] to deeply equal []`. Both positive controls held (the fixture catches a body Button, a `buttonClass` link and a standalone IconButton, and passes a `Td` button, a column `render` button and two icon triggers; the app scan finds more than 40 small buttons).
- **GREEN** (`f9de30f60`): `touchHeight` on the 43 sites.
- **Review follow-up (`enterprise-ux-designer` and `mobile-a11y-ux-reviewer`, both MEDIUM, both "Ship with follow-ups"):** the trigger and table exemptions were inconsistent with the app. Twelve row ⋯ menus already carry `touchHeight`, the contact row's ⋯ sat at 32px beside Edit/Promote at 44px, and the DataTables stack into cards on a phone. The rule narrows: only the help ⓘ beside a heading (`IconButton icon="info"` as a `Popover` `trigger`: `at-risk-widget`, `money-basis-hint`, `pipeline-help`) stays compact. A `size` that is not a literal now fails.
  - **RED** (`a8ee45e1a`): the same test → `expected [ …(7) ] to deeply equal []` (`invoice-detail-view.tsx:612, 619`, `member-invoices-table.tsx:129`, `pending-review-list.tsx:315`, `recent-exports.tsx:92`, `contact-actions.tsx:131`, `members-table.tsx:453`). Its positive control holds: a `Td` button and a menu ⋯ are now caught, a help ⓘ is not, and `size={s}` fails as opaque.
  - **GREEN** (`766eb066f`): `touchHeight` on those 7.
- **Every IconButton (found while measuring the preview).** An `IconButton`'s `size` sizes the icon, not the box: every IconButton is 32px unless it carries `touchHeight`. At 390 the member page's copy buttons and header ⋯ measured 32×32. The guard now asks for `touchHeight` on every `IconButton` the user taps, whatever its `size`, except a `Popover` trigger (the help ⓘ / ?).
  - **RED** (`309a70950`): `expected [ …(7) ] to deeply equal []`: `resend-invoice-button.tsx:147`, `member-header-more-menu.tsx:43`, `webhook-secret-reveal.tsx:156, 161`, `staff-top-bar.tsx:150`, `copy-button.tsx:40`, `theme-toggle.tsx:24`. The fixture adds a bare IconButton, which is caught.
  - **GREEN**: `touchHeight` on those 7. The top bar search and the member header theme toggle drop their own `max-sm:size-11` (44px below 640px only) for `touchHeight`, which also covers a touch screen from 640px.
- **One help ⓘ size (relay R70b).** The emergency-primary ⓘ on the member page measured 24px while the renewals help ⓘ measured 32px. `InfoHint` (its only caller) was a hand-made 24px `<button>`, without AURA's 44px hit area and out of the guard's sight; the other four help triggers (`at-risk-widget`, `money-basis-hint`, `pipeline-help`, the company section's legal-entity ?) are AURA `IconButton`s. `InfoHint` now renders the same `IconButton icon="info" size="sm"`. UI presentation, shared commit (D-023).
  - **Failing run** (`tests/unit/components/shell/info-hint.test.tsx`, before the change): "InfoHint (AURA) > renders its trigger as an AURA IconButton, like the other help icons" → `Expected the element to have class: aura-icon-btn`.

### Evidence: adopt AURA 5.55/5.56 (follow-up 5, PR 7)

- **AURA 5.55 (#167):** the footer and ActionBar rules (`.aura-actionbar__actions .aura-btn`, `.aura-dialog__foot > .aura-btn`, …) moved to `(max-width: 639.98px), (pointer: coarse)` and reach `size="sm"`, read in the 5.56.0 `styles.css`. The R69 exception, sm bar buttons keeping `touchHeight` for a touch tablet, is gone.
- **AURA 5.56 (#168):** AppShell renders its menu `IconButton` with `touchHeight: true` (5.56.0 `esm/AppShell.js`). No app change.
- **RED** (`c660a1f54`, guards plus the 5.56.0 bump): `dialog-footer-touch.test.ts` "no Button in a Dialog/Drawer footer or an ActionBar carries touchHeight, whatever its size (AURA 5.55)" → `expected [ …(9) ] to deeply equal []`: `members/_components/bulk-action-bar.tsx:441, 458, 478, 495, 511`, `pipeline-bulk-action-bar.tsx:607, 621`, `queue-bulk-action-bar.tsx:511, 521`. Its fixture now flags a `size="sm"` button with `touchHeight` in a bar. `small-button-touch.test.ts`'s fixture adds an sm Button in an ActionBar's `start` and children and an sm `buttonClass` in a Dialog footer, none of them caught.
- **GREEN:** `touchHeight` comes off those 9 buttons; the bars' own `touchHeight` prop (their Clear, #122) stays. The three bar component tests now assert the actions carry no `aura-btn--touch`.
