# Quickstart: validating US0 (Foundation)

## Prerequisites

- `pnpm install`, with the new AURA packages resolved from npm.
- `.env.local` pointing at the Neon `dev` branch, as usual.

## 1. Static gates

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm check:i18n && pnpm check:layout && pnpm check:dates && pnpm check:strict-aria
pnpm vitest run tests/unit/architecture/ui-import-ratchet.test.ts tests/unit/lib/toast-facade.test.ts tests/unit/providers/aura-bridge.test.tsx
```

Expected:
- Everything is green.
- `rg "from 'sonner'" src tests` returns nothing.
- `rg "@/components/ui/(calendar|scroll-area|sonner)" src` returns nothing.

## 2. Build, fonts and bundle

```bash
pnpm build && pnpm check:bundle-budgets
```

Expected:
- The woff2 files for Inter, Fraunces, JetBrains Mono and Noto Sans Thai are in `.next/static/media`.
- No route exceeds its re-baselined ceiling.

## 3. Run and look

```bash
pnpm dev   # http://localhost:3100
```

- **Pages:** open `/admin`, `/admin/members`, one admin form, `/portal`, `/portal/invoices` in EN, TH and SV, light and dark, at 390 px and 1280 px. Expect:
  - AURA colours, radius and fonts
  - no layout shift
  - the TH date pickers (if any) show Buddhist-era years
- **Toasts:** trigger a success, an error (a failed save) and a read-only toast. Expect one AURA toast at the top centre and at most 3 stacked.
- **Network:** DevTools → Network shows no request to `fonts.googleapis.com` / `fonts.gstatic.com` or any other new origin, and no CSP violations in the console.

## 4. e2e (local only; link the log in the PR)

```bash
pnpm test:e2e --grep "@a11y|@i18n" --workers=1
pnpm test:e2e --workers=1          # full suite once for the foundation
```

Expected: zero axe violations. Contrast failures are fixed in the token-bridge table (`contracts/css-layers.md`), not per page.

## 5. Performance

In Lighthouse (mobile) on `/`, `/portal` and `/admin`, CLS must stay below 0.1 after the font swap.
