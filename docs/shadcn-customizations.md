# shadcn/ui customizations (F4 + branch-006)

> ⚠️ **Before running `pnpm dlx shadcn@latest add <component>`**, review this
> file — the CLI may regenerate or overwrite these files. Re-apply every
> customization below after any `shadcn add`.
>
> **Lesson from branch-006**: the Label primitive's `mb-[var(--field-label-gap)]`
> customization was lost between F1 and the 006 review pass, causing every form
> field across the app to render Label flush against its control. A `shadcn add`
> of any component that depends on Label (or a hand-rewrite that dropped the
> class) can re-introduce this. Consider adding an inventory test that asserts
> the code matches this table before every release.

F4 (Page Layout Enterprise Standardization) modified the following shadcn/ui
primitives to align with the design tokens in `src/app/globals.css`. Branch
006 (Layout Container Tier 2) added the three new layout primitives and
restored the Label customization. The diffs are small and token-based — no
structural rewrites.

## Modified primitives

| File                                       | Summary of diff                                                                                                                                                                                                                      | Rationale       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `src/components/ui/button.tsx`             | Base class: added `cursor-pointer` + `disabled:cursor-not-allowed`. `size.default`: `h-8`→`h-9` (32→36px), `px-2.5`→`px-3` to align with `--input-height`.                                                                           | FR-014, US6, R2 Q1 |
| `src/components/ui/input.tsx`              | Replaced `h-8` with `h-[var(--input-height)]` and `px-2.5` with `px-[var(--input-padding-x)]`.                                                                                                                                        | FR-019, US9     |
| `src/components/ui/textarea.tsx`           | Replaced `px-2.5` with `px-[var(--input-padding-x)]`; added `disabled:pointer-events-none`.                                                                                                                                           | FR-019, US9     |
| `src/components/ui/select.tsx`             | SelectTrigger: `data-[size=default]:h-8` → `data-[size=default]:h-[var(--input-height)]`, `pl-2.5` → `pl-[var(--input-padding-x)]`.                                                                                                  | FR-019, US9     |
| `src/components/ui/label.tsx`              | Added `mb-[var(--field-label-gap)]` and `text-[length:var(--font-size-body)]`.                                                                                                                                                        | FR-019, US9     |
| `src/components/ui/table.tsx`              | TableHeader: `sticky top-0 z-10 bg-background`. TableRow: `h-[var(--table-row-height)]`, hover/focus-within `bg-[var(--table-row-hover-bg)]`. TableHead: uppercase + muted-foreground + token padding. TableCell: token padding.     | FR-020, US10    |
| `src/app/globals.css`                      | `[lang="th"] td { ... line-clamp: 2 }` rule for Thai cell overflow.                                                                                                                                                                   | FR-020          |
| `src/components/ui/card.tsx`               | Replaced `py-4` / `px-4` with `py-[var(--card-padding)]` / `px-[var(--card-padding)]`; `rounded-xl` → `rounded-[var(--card-radius)]`; added `shadow-[var(--card-shadow)]`.                                                            | FR-021, US11    |
| `src/components/ui/dialog.tsx`             | Overlay: backdrop opacity via `color-mix` + `--modal-backdrop-opacity`; `duration-100` → `duration-[var(--modal-duration)]`. Content: `max-w-sm` → `max-w-[var(--modal-max-width-md)]`; `p-4` → `p-[var(--card-padding)]`; `animationTimingFunction: var(--modal-easing)`. | FR-022, US11    |
| `src/components/ui/alert-dialog.tsx`       | Same overlay/content token application as Dialog, plus `sm:max-w-[var(--modal-max-width-sm)]` for confirmation dialogs.                                                                                                               | FR-022, US11    |
| `src/components/ui/sheet.tsx`              | Overlay: `--modal-backdrop-opacity` + `--modal-duration`. Content: `max-w-sm` → `max-w-[var(--modal-max-width-md)]`, `shadow-lg` → `shadow-[var(--card-shadow)]`.                                                                     | FR-022, US11    |

## DropdownMenu trigger audit (T089, critique R2 E7)

Grep `DropdownMenuTrigger` / `DropdownMenu.Trigger` usage:

- `src/components/shell/user-menu.tsx` — already uses `asChild` with `<Button variant="ghost" />`.
- `src/components/shell/theme-toggle.tsx` — already uses `asChild` with `<Button variant="ghost" />`.
- All other occurrences audited: every trigger wraps a `<Button variant="ghost">` per FR-023.

Rule to enforce at code review:

```tsx
<DropdownMenuTrigger asChild>
  <Button variant="ghost" size="icon">{/* trigger content */}</Button>
</DropdownMenuTrigger>
```

**Every new interactive primitive MUST carry `focus-visible:border-ring
focus-visible:ring-3 focus-visible:ring-ring/50`** (or the equivalent
shadcn base-class pattern) — don't rely on the global `*:focus-visible`
fallback. The fallback is a safety net for unclassed elements, not a
substitute for primitive-level focus styling.

## Dark-mode token audit (T060b)

- `--card-shadow` has a dark override (`0 1px 2px 0 rgb(0 0 0 / 0.3)`) so
  elevation remains visible against dark card backgrounds.
- All other F4 tokens inherit dark values from upstream Tailwind + existing
  shadcn theme variables.

## Thai rendering verification (T060d)

- Thai line-height override (`--line-height-th: 1.65`) applied via
  `[lang="th"] .text-h{1-4}, [lang="th"] .text-body` rule.
- Thai table cell line-clamp (`[lang="th"] td { line-clamp: 2 }`) prevents
  row-height expansion from tone-mark/diacritic envelopes.

## Focus-ring pattern (SC-011)

Single convergent pattern — two layers, one implementation each:

1. **Primitive-level ring** (Tailwind `focus-visible:ring-*`): every
   interactive shadcn primitive (`button.tsx`, `input.tsx`, `textarea.tsx`,
   `select.tsx`, etc.) uses `focus-visible:border-ring focus-visible:ring-3
   focus-visible:ring-ring/50`. This is the canonical visible ring and
   what SC-011 asserts identity on.
2. **Global fallback** (`*:focus-visible { outline: 2px solid currentColor }`
   in `globals.css`): covers unclassed elements (e.g. a raw `<a href>` or a
   custom control that forgot to style focus). The ring is derived from
   `currentColor` so it inherits text contrast automatically.

No intermediate utility class — a previous `.focus-ring` utility was
removed because it was unused and invited divergence from the two layers
above. Don't reintroduce one unless a real call site needs the
WHCM-safe transparent-outline + box-shadow combo; at that point, promote
the style into the primitive itself rather than a shared class.

## Table sticky header

`table.tsx` ships with `thead { position: sticky; top: 0; z-10 }` so column
labels stay visible while the `<div data-slot="table-container">`
horizontal-scrolls on narrow viewports. This assumes the Table lives in a
full-page scroll context (the default — e.g. `/admin/users`,
`/admin/plans`). **If you place a Table inside a fixed-height Card or a
constrained-scroll region**, the sticky behavior can surprise. Opt out per
call site with `className="[&_thead]:static"` on the `<Table>` element.

## Admin vs portal shell — post branch-006

Both shells now follow the **same** pattern: each `page.tsx` owns its own
layout container (one of `TableContainer` / `FormContainer` / `DetailContainer`
from `@/components/layout`). Neither shell wraps children in a container.

- **Admin shell** (`src/app/(staff)/admin/layout.tsx`): renders
  `<BreadcrumbNav />` between the top bar and `{children}`; each page picks
  its container per the Content-Type Mapping in `docs/ux-standards.md` § 18.
- **Portal shell** (`src/app/(member)/portal/layout.tsx`): renders the header
  bar only; each page picks its container (`DetailContainer` for
  `/portal` + `/portal/profile`, `FormContainer` for the edit/invite/account
  routes).

**Do not** re-introduce a wrapping `ContentContainer` at the shell level —
it was removed in branch-006 because single-variant wrapping couldn't express
the table/form/detail split. `pnpm check:layout` enforces the per-page
ownership: every `page.tsx` AND its sibling `loading.tsx` must import exactly
one of the three primitives, and the pair must match (FR-007 CLS-0).

## Layout container primitives (branch-006)

| File                                             | Summary                                                                                                         | Rationale (spec) |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/components/layout/table-container.tsx`      | Thin `<div data-slot="layout-container" data-variant="table">` capping at `var(--layout-max-width-table)` (96rem).  | 006 FR-001, FR-002 |
| `src/components/layout/form-container.tsx`       | Same shape, `data-variant="form"`, `var(--layout-max-width-form)` (42rem).                                       | 006 FR-003       |
| `src/components/layout/detail-container.tsx`     | Same shape, `data-variant="detail"`, `var(--layout-max-width-detail)` (72rem — pixel-parity with the old admin ContentContainer). | 006 FR-004       |
| `src/components/layout/index.ts`                 | Barrel export of all three. Import via `@/components/layout`, never via `@/components/layout/<variant>-container`. | 006 FR-014       |
| `scripts/check-layout-container-usage.ts`        | Static CI gate (wired into `.husky/pre-push` + full-CI chain in `CLAUDE.md`).                                    | 006 FR-005, FR-006, FR-007 |

None of the three primitives sets `overflow-x` at the root (FR-015). Wide
tables must be absorbed by the shadcn `<Table>`'s `overflow-x-auto` wrapper,
not by the container itself.

## Design-system tier-1 primitives (009 side-quest)

Introduced alongside F5 to close six P0 gaps from `docs/design-system-audit.md`.
None replace shadcn upstream — they extend the primitive surface so payment,
invoice, and member state-machine screens share a canonical visual + a11y
contract.

| File                                       | Purpose                                                                     | Notes |
| ------------------------------------------ | --------------------------------------------------------------------------- | ----- |
| `src/components/ui/status-badge.tsx`       | Semantic status pill: 5 tones × 2 emphases (subtle surface / solid fill)    | Always pair color with text/icon (WCAG 1.4.1). `data-tone` for tests. |
| `src/components/ui/status-dot.tsx`         | 8px semantic disc for dense surfaces                                        | `aria-label` required (no text companion). Optional `pulse` for live signals. |
| `src/components/ui/inline-alert.tsx`       | Compact in-form / in-card alert (vs. card-style `<Alert>`)                  | `role="alert"` default; override to `role="status"` for non-urgent info. |
| `src/components/ui/progress.tsx`           | WAI-ARIA progressbar; determinate + indeterminate (skeleton-shimmer)        | Tones reuse semantic tokens. Degrades under prefers-reduced-motion. |
| `src/components/ui/progress-bar.tsx`       | Labeled wrapper over Progress with numeric readout                          | `formatValue` lets caller render locale-aware strings (Intl stays at consumer). |
| `src/components/ui/stepper.tsx`            | Multi-step flow indicator (complete / current / upcoming)                   | `role="list"` + `aria-current="step"`. Horizontal + vertical. |
| `src/components/ui/live-region.tsx`        | Visually-hidden ARIA live region for inline async feedback                  | For non-toast announcements (polling, step transitions). sonner handles toasts separately. |

Semantic color tokens feeding the above live in `src/app/globals.css` under
the `:root` + `.dark` blocks: `--success`, `--warning`, `--info` (plus
`-foreground` and `-surface` pairs for each). WCAG contrast audited at
authoring time (≥4.5:1 fg-on-surface, light + dark).

Canonical flows that compose these primitives (destructive confirm,
bulk action, wizard, unsaved-changes, import/export) are documented in
`docs/ux-patterns.md`. Land those patterns before re-inventing the same
flow in a feature branch.

## Tailwind v4 `@source` hygiene (branch-006)

`src/app/globals.css` carries two `@source not` directives:

```css
@import 'tailwindcss';
...
/* Exclude non-source markdown docs from Tailwind v4 auto-detection so
   example class strings (e.g. `max-w-[var(--TOKEN)]`) inside specs/ or
   docs/ markdown never leak into generated CSS. */
@source not "../../specs/**/*";
@source not "../../docs/**/*";
```

**Why**: Tailwind v4 auto-scans the project for class strings. A literal
token like `` `max-w-[var(--TOKEN_NAME)]` `` in a markdown file (as an example
for reviewers) is picked up and emitted as real CSS. The `@source not`
directives below exclude `specs/**` and `docs/**` from auto-scan, and
and `docs/**` prevents the class. **Every new tenant / project
bootstrap should carry these directives.**

If a legitimate user-facing class lives in a `.md` file (for example, a
code sample that should render), use a placeholder name like
`max-w-[var(--TOKEN_NAME)]` — **never** the three-dot sentinel
`var(--DOT DOT DOT)` because three dots are not a valid CSS identifier
and PostCSS will fail to parse the generated rule.
