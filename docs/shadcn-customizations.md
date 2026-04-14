# shadcn/ui customizations (F4)

> ⚠️ **Before running `pnpm dlx shadcn@latest add <component>`**, review this
> file — the CLI may regenerate or overwrite these files. Re-apply F4
> changes after any `shadcn add`.

F4 (Page Layout Enterprise Standardization) modified the following shadcn/ui
primitives to align with the F4 design tokens in `src/app/globals.css`.
The diffs are small and token-based — no structural rewrites.

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

## Admin vs portal shell asymmetry

`src/app/(staff)/admin/layout.tsx` and `src/app/(member)/portal/layout.tsx`
place `ContentContainer` differently:

- **Portal**: the shell wraps `{children}` in
  `<ContentContainer variant="portal">`. Portal pages **do not** import
  ContentContainer themselves — keep their file roots as `<>` fragments.
- **Admin**: the shell renders `<BreadcrumbNav />` (which must sit between
  the top bar and the content) and then `{children}`. Each admin page
  owns its `<ContentContainer>` so breadcrumb can render above the
  container without a separate padding rule.

Do not "fix" this by mirroring the two shells — the asymmetry exists so
breadcrumb spacing stays consistent without double-wrapping. A future
`<AdminPageShell>` wrapper could absorb the boilerplate, but the shape
must stay: `TopBar → BreadcrumbNav → ContentContainer → page content`.
