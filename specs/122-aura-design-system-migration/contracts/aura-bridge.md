# Contract: `AuraBridge` provider

`src/components/providers/aura-bridge.tsx` is `'use client'`.

```ts
interface AuraBridgeProps {
  locale: 'en' | 'th' | 'sv';   // from next-intl (root layout)
  timeZone: string;             // tenant TZ, e.g. 'Asia/Bangkok'
  children: React.ReactNode;
}
```

## What it renders

- `<AuraProvider>` with these props:
  - `locale`
  - `calendar`: `'buddhist'` if `locale === 'th'`, else `'gregory'`
  - `timeZone`
  - `linkComponent={Link}`, where `Link` comes from `next/link`
  - `strings`, built from the next-intl namespace `aura.*` via `useTranslations('aura')`: AURA's built-in labels such as Close, Clear, Previous/Next page, Loading, "N selected", and Show/Hide password
- `children`
- `<Toaster position="top" />`, rendered once

## Where it is mounted

- It goes in `src/app/layout.tsx`, inside `ThemeProvider` and around `children`.
- It replaces the sonner `<Toaster>` mount.

## Density

Density is scoped by a nested provider:
- `src/app/(staff)/admin/layout.tsx` sets `<AuraProvider density="compact">`.
- `src/app/(member)/portal/layout.tsx` sets `<AuraProvider density="comfortable">`.

The nested provider inherits `locale`, `calendar`, `timeZone`, `linkComponent` and `strings` from the root bridge. Verify this in 5.5 during implementation; if it does not inherit, the bridge exposes `density` as a prop instead.

## Tests (RED first)

`tests/unit/providers/aura-bridge.test.tsx`:
- In `th`, AURA's DatePicker (or `useAuraLocale`) reports calendar `buddhist`; in `en` and `sv` it reports `gregory`.
- An AURA `Button href` renders through the provided link component.
- The Toaster is present once.
- The `strings` keys resolve in all three locales. `check:i18n` covers the `aura.*` namespace.
