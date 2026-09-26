# Research: AURA Design-System Migration (US0 decisions)

Sources:
- AURA 5.5.0 packages, unpacked from the npm registry on 2026-09-26 (`dist/index.d.ts`, package `exports`, READMEs).
- The AURA 4.17 source.
- The Chamber-OS code at `87f6e3f3e`.

## R1 — How AURA's CSS enters without breaking the shadcn pages

- **Decision**: use AURA's documented "next to another Tailwind theme (shadcn), page by page" setup. `src/app/globals.css` starts with this layer order and these imports:
  ```css
  @layer aura-tokens, theme, base, aura, components, utilities;
  @import 'tailwindcss';
  @import 'tw-animate-css';
  @import 'shadcn/tailwind.css';
  @import '@jirawatpyk/aura-tokens/aura.css' layer(aura-tokens);
  @import '@jirawatpyk/aura-tokens/tailwind.prefixed.css';
  @import '../styles/aura-theme.css' layer(aura-tokens);
  @import '@jirawatpyk/aura-react/styles.layer.css';
  ```
- **Rationale**:
  - `aura.css` is unlayered, so layering it puts its variables below everything. The prefixed Tailwind theme adds only `aura-*` utilities (`bg-aura-bg-surface`, `font-aura-sans`) and redefines nothing of shadcn's.
  - `styles.layer.css` wraps the component CSS in `@layer aura`. That sits between `base` (preflight) and `utilities`, so a utility class can still override an AURA component without `!important`.
  - The existing `@custom-variant dark (&:is(.dark *))` stays. AURA also reads `.dark` / `data-theme="dark"` on `<html>`, and next-themes already sets `.dark`.
- **Alternatives**:
  - The unlayered `styles.css`: rejected, because it beats utilities and would fight Tailwind on every migrated page.
  - AURA's un-prefixed `tailwind.css`: rejected, because it redefines `--color-*` and collides with shadcn's `@theme inline`.

## R2 — Token bridge (FR-002)

- **Decision**: in `:root` and `.dark`, the shadcn variables that `@theme inline` maps to `--color-*` take AURA tokens: `--background`, `--foreground`, `--card*`, `--popover*`, `--primary*`, `--secondary*`, `--muted*`, `--accent*`, `--destructive`, `--success|warning|info` (+ `-foreground`, `-surface`), `--border`, `--input`, `--ring`, `--chart-1..5`, `--sidebar-*` and `--radius`. The mapping lives in `contracts/css-layers.md`.
  - Layout, type, table, card and modal sizing variables stay as they are, so page geometry does not move.
  - Chamber-only variables (`--brand-accent`, `--nav-indicator`, `--sidebar-flag`) map to the closest AURA brand/signal tokens.
- **Rationale**:
  - Un-migrated pages get AURA's palette and radius on day one, with no per-file edits.
  - Contrast is guaranteed by AURA's own pairs. The generated brand theme exits non-zero on any failed contrast check (R3).
- **Alternatives**:
  - Leaving the legacy colours until each phase: rejected, because pages would disagree visually for up to 10 weeks.
  - Rewriting every class to `aura-*` utilities: rejected, because that is the per-phase work itself.
- **Risk**: axe contrast on un-migrated pages. Mitigation: run the full `@a11y` e2e once on US0 and fix mapping pairs, never individual pages.

## R3 — Brand theme

- **Decision**: run `npx aura-theme --brand "#10487A" --out src/styles/aura-theme.css` once and commit the output.
  - The CLI takes `--key value`, space-separated; `--brand=#…` prints usage and exits 1.
  - It is regenerated only by re-running the CLI, noted in `docs/aura-adoption.md`.
- **Rationale**: one brand for the product UI now. The future F12 white-label can swap this file for AURA's runtime `ThemeStyle` per tenant.
- **Alternatives**: runtime `<ThemeStyle brand>`: rejected for now (YAGNI; adds client JS to every page).

## R4 — Toasts: facade first, then AURA (FR-007)

- **Facts**:
  - 115 `src/` files `import { toast } from 'sonner'`. Calls: `.error` ×326, `.success` ×128, `.warning` ×32, `.info` ×22, `.loading` ×5, `.dismiss` ×5, plain `toast(...)` ×2.
  - Options used: `description` ×67, `id` ×64, `action` ×33, `duration` ×17 (incl. `Infinity`), `closeButton` ×3.
  - Nobody uses `toast.promise`.
  - One call passes a React-node `description`, with links: `use-supersede-warning-toast.tsx`.
  - AURA 5.5: `toast(opts|string)`, `.success/.error/.warning/.info/.loading(title, {description?: string, action?: {label, onClick}, duration?, id?})`, `.dismiss(id)`. At most 3 visible. `id` replaces in place. `<Toaster position?: 'top'|'bottom'>` (default bottom).
- **Decision**:
  1. **Commit A**: add `src/lib/toast.ts` re-exporting sonner behind the narrow type in `contracts/toast-facade.md`. Codemod the 115 imports and 111 `vi.mock('sonner')` to `@/lib/toast`. Behaviour is identical and the suite stays green.
  2. **Commit B**: re-implement the facade on AURA.
     - Map options straight across.
     - `closeButton` is accepted and ignored: AURA toasts are always dismissible.
     - A non-string `description` is a type error. The supersede toast becomes a text description plus **one** `action` (with one failed bill, "Open SC-…" through the router; with several, "Open invoices" filtered to them).
  3. Mount AURA `<Toaster position="top">` inside `AuraBridge`. Delete `ui/sonner.tsx` and uninstall `sonner`.
- **Rationale**: the facade isolates the swap to one file. The test mocks keep working because they mock the facade module, not the library. Commit A is reviewable as a pure rename.
- **AURA gap**: a rich description (links in a toast) is logged as handoff item **53**. Until AURA ships it, the text-plus-one-action fallback holds.
- **Alternatives**:
  - Codemod straight to `@jirawatpyk/aura-react`: rejected, because it couples 115 files to the library again.
  - Keep sonner until US1: rejected by the maintainer's decision to have one toast surface from US0.

## R5 — AuraBridge provider (FR-005, FR-006)

- **Decision**: `src/components/providers/aura-bridge.tsx` (`'use client'`) renders `<AuraProvider>` with:
  - `locale` from next-intl (`th|en|sv`)
  - `calendar`: `buddhist` for `th`, `gregory` otherwise (AURA's own default for these locales, stated explicitly)
  - `timeZone="Asia/Bangkok"` (5.5 has it since 4.19; the tenant TZ, `env.tenant.timezone`, is passed down from the server layout)
  - `linkComponent={Link}` from `next/link`
  - `strings`: not passed. AURA 5.5 ships EN/TH/SV built-in labels ("Close", "Clear", pagination…) selected by `locale`, so none falls back to English. (The earlier plan of an `aura.*` next-intl namespace was dropped once 5.5 was verified.)
  - `<Toaster position="top" />`

  It mounts inside `ThemeProvider` in `src/app/layout.tsx`. Density comes from a nested `<AuraProvider density>` in the staff layout (`compact`) and the member layout (`comfortable`); AURA adds a `display: contents` wrapper for it.
- **Dates**: AURA's root `formatDate` / `useFormatDate` are banned by the lint ratchet (R6). The product keeps `src/lib/format-date-localised.ts`, and `scripts/check-dates.ts` keeps guarding bare-locale `Intl` calls.
- **Alternatives**: calling `AuraProvider` in each layout without a shared bridge: rejected, because it would duplicate the locale, time-zone and link setup.

## R6 — Lint ratchet without breaking the architecture rules (FR-008)

- **Facts**: `eslint.config.mjs` uses `no-restricted-imports` only for architecture boundaries, in many per-path blocks. Flat config **replaces** the rule per matching block, and the last `src/**` block (:824–853) wins.
- **Decision**: append blocks built by `uiRatchet(MIGRATED_PATHS)` (`eslint.ui-ratchet.mjs`) using **`@typescript-eslint/no-restricted-imports`**, a distinct rule id with the same semantics, so they compose with every existing block. The same last-block-wins rule applies within this rule id, so each block restates the global bans. It bans:
  - `sonner` (from US0)
  - `cmdk` at `error`, except in its one host `src/components/ui/command.tsx`, which leaves in US1 (a single rule id cannot mix `warn` and `error`, and an exemption for one file is stricter than a global warning)
  - `@jirawatpyk/aura-react` `importNames: ['formatDate', 'useFormatDate']`
  - `@/components/ui/*` for files in `MIGRATED_PATHS` (an array in `eslint.config.mjs`, empty in US0, grown by each phase)

  `tests/unit/architecture/ui-import-ratchet.test.ts` lints snippets through the real config and asserts each ban fires; the migrated-path ban is exercised by appending `uiRatchet([fixtureGlob])` through `overrideConfig`, so the real list never carries a test entry. That test is the positive control: it goes RED first, before the block exists.
- **Alternatives**:
  - Adding paths to every existing block: rejected, because it is fragile across nine blocks.
  - `no-restricted-syntax`: rejected, because its messages are worse and it cannot scope by import name.

## R7 — Fonts (FR-003)

- **Decision**:
  - Remove `Geist` / `Geist_Mono` (`next/font/google`, `layout.tsx:3,22–30,100–104`).
  - `@import '@jirawatpyk/aura-tokens/aura-fonts.local.css'` in `globals.css`: woff2 for Inter, Fraunces and JetBrains Mono (latin + latin-ext) and Noto Sans Thai, served same-origin through the bundler.
  - Point `--font-sans` (Inter + Noto Sans Thai), `--font-mono` (JetBrains Mono) and `--font-heading` (Fraunces) at AURA's stacks in `@theme inline` (`globals.css:31,32,46`).
- **Rationale**: the CSP `font-src 'self' data:` is already satisfied. There is no Google origin at runtime (`next/font` also self-hosted, but only Geist).
- **Verify**:
  - the `.next` build output contains the woff2 files
  - there are no font requests to external hosts
  - CLS < 0.1 on `/`, `/portal`, `/admin`
- **Alternatives**: `next/font/local` pointing into `node_modules`: kept as the fallback if Turbopack does not rewrite `url()` inside the package CSS.

## R8 — Overlay stacking (FR-014)

- **Decision**: AURA z-index tokens are dialog 900, menu 1000, toast 1200, tooltip 1300. The kit's Base UI popups (popover, select, dropdown, tooltip) take `z-[var(--aura-z-menu)]` and its dialogs/sheets take `z-[var(--aura-z-dialog)]`. This is done centrally in the kit's wrappers, not per page. No page may open an AURA overlay from inside a kit overlay, or the reverse; the phase that migrates the outer overlay migrates the inner one too.

## R9 — Test helpers

- **Decision**: `tests/helpers/aura.ts` exports:
  - `expectToast(title, tone?)`, asserting against the mocked facade
  - `pickSelect(label, option)`: AURA Select renders its own listbox (5.3), so `selectOption()` does not work
  - `checkBox(label)`
  - `openMenu(label)`

  Vitest setup turns AURA dev warnings (`console.warn` prefixed `[aura]`) into failures, so misuse such as a Checkbox label without `hideLabel` surfaces in CI.

## Open AURA gaps carried by this feature

- **52**: DataTable per-row selectable. Needed in US12, logged 2026-09-26.
- **53**: toast rich description (links), or a second action. Needed in US0 for the supersede warning; text fallback meanwhile. To be logged.
