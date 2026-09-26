# Contract: CSS layer order, imports, token bridge

## Head of `src/app/globals.css`

```css
@layer aura-tokens, theme, base, aura, components, utilities;
@import 'tailwindcss';
@import 'tw-animate-css';
@import 'shadcn/tailwind.css';
@import '@jirawatpyk/aura-tokens/aura.css' layer(aura-tokens);
@import '@jirawatpyk/aura-tokens/aura-fonts.local.css';
@import '@jirawatpyk/aura-tokens/tailwind.prefixed.css';
@import '../styles/aura-theme.css' layer(aura-tokens);
@import '@jirawatpyk/aura-react/styles.layer.css';
```

`@custom-variant dark (&:is(.dark *));` stays. AURA reads `.dark` on `<html>`, which next-themes already sets.

## Fonts (`@theme inline`)

| Variable | Stack |
|---|---|
| `--font-sans` | `"Inter", "Noto Sans Thai", sans-serif` |
| `--font-heading` | `"Fraunces", "Noto Sans Thai", serif` |
| `--font-mono` | `"JetBrains Mono", monospace` |

## Token bridge (`:root` → light; `.dark` → the same names, AURA's dark values resolve automatically)

| Legacy var | AURA token |
|---|---|
| `--background` | `var(--aura-bg-canvas)` |
| `--foreground` | `var(--aura-fg-primary)` |
| `--card` / `--card-foreground` | `var(--aura-bg-surface)` / `var(--aura-fg-primary)` |
| `--popover` / `--popover-foreground` | `var(--aura-bg-surface)` / `var(--aura-fg-primary)` |
| `--primary` / `--primary-foreground` | `var(--aura-button-primary-bg)` / `var(--aura-button-primary-fg)` |
| `--secondary` / `--secondary-foreground` | `var(--aura-bg-surface-hover)` / `var(--aura-fg-primary)` |
| `--muted` / `--muted-foreground` | `var(--aura-bg-surface-hover)` / `var(--aura-fg-secondary)` |
| `--accent` / `--accent-foreground` | `var(--aura-bg-selected)` / `var(--aura-fg-primary)` |
| `--destructive` | `var(--aura-fg-danger)` |
| `--destructive-surface` | `var(--aura-alert-danger-bg)` |
| `--success` / `-foreground` / `-surface` | `var(--aura-fg-positive)` / `var(--aura-alert-success-fg)` / `var(--aura-alert-success-bg)` |
| `--warning` / `-foreground` / `-surface` | `var(--aura-status-warning-fg)` / `var(--aura-alert-warning-fg)` / `var(--aura-alert-warning-bg)` |
| `--info` / `-foreground` / `-surface` | `var(--aura-fg-accent)` / `var(--aura-alert-info-fg)` / `var(--aura-alert-info-bg)` |
| `--border` | `var(--aura-border-default)` |
| `--input` | `var(--aura-border-control)` |
| `--ring` | `var(--aura-focus-ring)` |
| `--chart-1..5` | `var(--aura-chart-1..5)` |
| `--radius` | `var(--aura-radius-md)` |
| `--sidebar` / `--sidebar-foreground` | `var(--aura-bg-surface)` / `var(--aura-fg-primary)` |
| `--sidebar-primary` / `-foreground` | `var(--aura-button-primary-bg)` / `var(--aura-button-primary-fg)` |
| `--sidebar-accent` / `-foreground` | `var(--aura-bg-selected)` / `var(--aura-fg-accent)` |
| `--sidebar-border` / `--sidebar-ring` | `var(--aura-border-default)` / `var(--aura-focus-ring)` |
| `--brand-accent` / `-foreground` | `var(--aura-fg-accent)` / `var(--aura-fg-inverted)` |
| `--nav-indicator` | `var(--aura-fg-accent)` |

- **Unchanged:** layout, type-scale, table, card, modal and sizing variables.
- **Adjustments:** any foreground/background pair that fails axe on an un-migrated page is fixed in this table, never per page.

## Z-index

- Kit popups (popover, select, dropdown, tooltip): `var(--aura-z-menu)`.
- Kit dialogs and sheets: `var(--aura-z-dialog)`.
