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
