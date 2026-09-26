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
  - no `strings`: AURA 5.5 ships its built-in labels (Close, Clear, Previous/Next page, Loading, "N selected", Show/Hide password, …) in EN, TH and SV and picks them by `locale`. A product-specific override, if one is ever needed, goes through `strings` from next-intl.
- `children`
- `<Toaster position="top" />`, rendered once

## Where it is mounted

- It goes in `src/app/layout.tsx`, inside `ThemeProvider` and around `children`.
- It replaces the sonner `<Toaster>` mount.

## Density

Density is scoped by a nested provider:
- `src/app/(staff)/admin/layout.tsx` sets `<AuraProvider density="compact">`.
- `src/app/(member)/portal/layout.tsx` sets `<AuraProvider density="comfortable">`.

The nested provider inherits `locale`, `calendar`, `timeZone` and `linkComponent` from the root bridge (verified against 5.5 by the test below).

## Tests (RED first)

`tests/unit/providers/aura-bridge.test.tsx`:
- In `th`, `useAuraLocale` reports calendar `buddhist`; in `en` and `sv` it reports `gregory`.
- The tenant time zone and the router link reach AURA.
- A nested `<AuraProvider density>` keeps the language, calendar, time zone and link.
- The Toaster is present once, at the top (commit B).
