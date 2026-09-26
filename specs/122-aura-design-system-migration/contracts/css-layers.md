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
| `--font-heading` | `"Inter", "Noto Sans Thai", sans-serif` — kit titles are h2/h3-level, which AURA sets in sans; Fraunces is AURA's display face only |
| `--font-mono` | `"JetBrains Mono", monospace` |

## Token bridge (`:root` → light; `.dark` → the same names, AURA's dark values resolve automatically)

| Legacy var | AURA token |
|---|---|
| `--background` | `var(--aura-bg-canvas)` |
| `--foreground` | `var(--aura-fg-primary)` |
| `--card` / `--card-foreground` | `var(--aura-bg-surface)` / `var(--aura-fg-primary)` |
| `--popover` / `--popover-foreground` | `var(--aura-bg-surface)` / `var(--aura-fg-primary)` |
| `--primary` / `--primary-foreground` | `var(--aura-fg-accent)` / `var(--aura-fg-inverted)` — not the ink button colour, which equals body text and would hide every `text-primary` link |
| `--secondary` / `--secondary-foreground` | `var(--aura-status-neutral-bg)` / `var(--aura-fg-primary)` |
| `--muted` / `--muted-foreground` | `var(--aura-status-neutral-bg)` / `var(--aura-fg-secondary)` — `bg-surface-hover` equals the light canvas, so muted fills would vanish |
| `--accent` / `--accent-foreground` | `var(--aura-bg-selected)` / `var(--aura-fg-primary)` |
| `--destructive` / `-foreground` / `-surface` | `var(--aura-fg-danger)` / `var(--aura-fg-inverted)` / `var(--aura-alert-danger-bg)` |
| `--success` / `-foreground` / `-surface` | `var(--aura-fg-positive)` / `var(--aura-fg-inverted)` / `var(--aura-alert-success-bg)` |
| `--warning` / `-foreground` / `-surface` | `var(--aura-alert-warning-fg)` / `var(--aura-fg-inverted)` / `var(--aura-alert-warning-bg)` |
| `--info` / `-foreground` / `-surface` | `var(--aura-fg-accent)` / `var(--aura-fg-inverted)` / `var(--aura-alert-info-bg)` |
| `--border` | `var(--aura-border-default)` |
| `--input` | `var(--aura-border-control)` |
| `--ring` | `var(--aura-focus-ring)` |
| `--chart-1..5` | `var(--aura-chart-1..5)` |
| `--radius` | `var(--aura-radius-md)` |
| `--sidebar` / `--sidebar-foreground` | `var(--aura-bg-surface)` / `var(--aura-fg-primary)` |
| `--sidebar-primary` / `-foreground` | `var(--aura-button-primary-bg)` / `var(--aura-button-primary-fg)` |
| `--sidebar-accent` / `-foreground` | `var(--aura-bg-selected)` / `var(--aura-fg-accent)` |
| `--sidebar-border` / `--sidebar-ring` | `var(--aura-border-default)` / `var(--aura-focus-ring)` |
| `--nav-indicator` | `var(--aura-fg-accent)` |

- **`-foreground` is text on the solid colour** (`bg-success text-success-foreground`), so it maps to `--aura-fg-inverted` (white in light, near-black in dark), never to an alert text colour. Each status colour is a *text* token in AURA (dark in light, light in dark), so the inverted foreground contrasts with it in both themes.
- **`--warning` is `--aura-alert-warning-fg`** (amber), not `--aura-status-warning-fg`, which is ink and would drop the warning hue.
- **`.dark` holds no bridged name.** The bridge is declared once on `:root`; `.dark` on `<html>` flips the `--aura-*` values on that same element, so the aliases follow. A bridged name left in `.dark` would pin the old dark value.
- **Unchanged:** layout, type-scale, table, card, modal and sizing variables, `--card-shadow`, and the TSCC gold `--brand-accent` / `-foreground` (decorative; AURA has no gold).
- **Kit fills:** skeletons use `--aura-bg-skeleton`; dark-mode control fills use `--aura-bg-input` (not a tint of `--input`, which is AURA's control border).
- **Guard:** `tests/unit/styles/token-bridge-contrast.test.ts` resolves the bridge through AURA's values and asserts the AA pairs in light and dark.
- **Adjustments:** any foreground/background pair that fails axe on an un-migrated page is fixed in this table, never per page.

## Z-index

- Kit popups (popover, select, dropdown, tooltip): `var(--aura-z-menu)`.
- Kit dialogs and sheets: `var(--aura-z-dialog)`.
