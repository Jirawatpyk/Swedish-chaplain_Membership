# Language Switcher (EN/TH/SV) — Design

**Date:** 2026-07-03
**Branch:** `worktree-language-switcher` (off `main`)
**Status:** Approved (brainstorming) — ready for implementation plan

## Problem

The app resolves its active locale from the `NEXT_LOCALE` cookie
(`src/i18n/request.ts`), with `en` as the fallback default. There is **no
middleware URL-prefix routing** and **no user-facing switcher** — the cookie
can only be set by hand via browser DevTools (or seeded by E2E tests). End
users cannot change the interface language. The `<UserMenu>`/`request.ts`
comments already flag a "future locale-switcher" as the intended gap-filler.

## Goal

Ship a user-facing control that lets anyone switch the interface language
between **English / ไทย / Svenska** and have the whole app (messages +
Buddhist-Era date formatting) re-render in that language, on every page —
including the pre-login auth pages.

Non-goals (YAGNI): URL-prefix locale routing, server-side locale persistence
per user account, adding new locales, translating the language names
themselves (they are proper nouns).

## Approach

Mirror the existing `ThemeToggle` (`src/components/shell/theme-toggle.tsx`)
exactly — same shadcn `DropdownMenu` + icon-trigger shape, same client-only
nature, same header placement, same `size`/`className` props for 44px
tap-target support on the member portal.

### Chosen mechanism — client cookie + `router.refresh()`

```ts
document.cookie = `NEXT_LOCALE=${locale}; path=/; max-age=31536000; samesite=lax`;
router.refresh();
```

`router.refresh()` re-runs the RSC render; `getRequestConfig` re-reads the
`NEXT_LOCALE` cookie and returns the new locale's `messages` **and**
`buildFormats(locale)` (so Thai BE dates switch too). No new route, server
action, or middleware is introduced.

**Rejected alternative — server action + `cookies().set()` + `revalidatePath`.**
More ceremony, enables `httpOnly`, but locale is not a security-sensitive
cookie and next-intl reads it as a plain cookie already. Overkill; violates
Simplicity (Constitution Principle X). Also diverges from the client-only
`ThemeToggle` pattern for no benefit.

## Components

### New: `src/components/shell/locale-switcher.tsx` (client component)

- `'use client'`; DropdownMenu with a `LanguagesIcon` (lucide-react) trigger.
- Reads the active locale via `useLocale()` (next-intl).
- Renders one `DropdownMenuItem` per locale from `locales` +
  `localeLabels` (`src/i18n/config.ts`): English / ไทย / Svenska.
- The active locale row shows a `CheckIcon` (aria-hidden) as the selected
  indicator.
- On select: set the cookie (above) then `router.refresh()`.
- Props mirror `ThemeToggle`: `{ size?: 'icon' | 'icon-lg'; className?: string }`,
  `cn(className)` merged last so a `size-*` override can win. In-scope
  placements use the default `icon` size (32px), identical to `ThemeToggle`
  in the same headers; the override prop exists only for parity/future reuse.
- `aria-label` from `t('shell.locale.label')`.

### Modified: placement (9 sites — everywhere `ThemeToggle` already renders)

`<LocaleSwitcher />` placed immediately **before** `<ThemeToggle />` in:

1. `src/app/(staff)/admin/layout.tsx`
2. `src/app/(member)/portal/layout.tsx`
3. `src/app/(auth-public)/admin/sign-in/page.tsx`
4. `src/app/(auth-public)/portal/sign-in/page.tsx`
5. `src/app/(auth-public)/forgot-password/page.tsx`
6. `src/app/(auth-public)/reset-password/[token]/page.tsx`
7. `src/app/(auth-public)/invite/[token]/page.tsx`
8. `src/app/(auth-public)/email-verification/[token]/page.tsx`
9. `src/app/(auth-public)/email-change/revert/[token]/page.tsx`

Member portal usage that already renders `ThemeToggle` at 44px (Account hub)
is **out of scope** — the header switcher covers the requirement; no
duplicate inside the member `UserMenu` dropdown (YAGNI).

## i18n

Add a `shell.locale` scope to all three message files with parity
(`check:i18n` gate):

| key                 | en         | th     | sv       |
|---------------------|------------|--------|----------|
| `shell.locale.label`| `Language` | `ภาษา` | `Språk`  |

Language option names come from `localeLabels` (proper nouns) and are **not**
re-translated per locale.

## Accessibility (WCAG 2.1 AA, ux-standards)

- Trigger `aria-label` = "Language"/"ภาษา"/"Språk"; icon `aria-hidden`.
- Keyboard navigation and focus management come free from the shadcn
  `DropdownMenu` primitive (same as `ThemeToggle`).
- Active-locale `CheckIcon` gives a non-color-only selected cue.
- In-scope placements render at the 32px icon size (matching `ThemeToggle`),
  which passes WCAG 2.2 SC 2.5.8 (target size ≥24px, AA). The `size`/
  `className` props allow a ≥44px target if reused in a portal CTA context.

## Testing

### Unit / RTL — `tests/unit/components/locale-switcher.test.tsx` (primary)

Render with a real `NextIntlClientProvider` (en messages) + mocked
`next/navigation`:
- Renders all three options (English / ไทย / Svenska).
- The current locale's row shows the check indicator.
- Clicking "ไทย" writes `NEXT_LOCALE=th` to `document.cookie` with
  `path=/` and calls `router.refresh()` exactly once.
- Trigger exposes the localized `aria-label`.

Use `src/lib/zod-i18n.ts`-style real-message rendering conventions; no bare
mocking of translation keys.

### E2E — `tests/e2e/locale-switcher.spec.ts` (`@i18n`, `--workers=1`, serial)

Gated on `E2E_ADMIN_EMAIL/PASSWORD`. Unlike the existing i18n specs (which
seed the cookie directly), this drives the **real control**:

1. **Authenticated (staff header):** sign in → open the LocaleSwitcher in the
   header → pick "ไทย" → assert a known Thai nav/heading string renders and
   `NEXT_LOCALE=th` cookie is set → switch back to English and assert it
   reverts.
2. **Pre-login (auth page):** on `/admin/sign-in`, use the switcher to select
   "ไทย" → assert the sign-in form re-renders with Thai copy (proves the
   auth-public placement works before a session exists).

Follows project E2E conventions: `mode: 'serial'`, `clearE2ERateLimits()` in
`beforeAll`, base URL `http://localhost:3100`.

## Process / rollout

- Small, self-contained UI addition. No DB, no migration, no new dependency
  (LanguagesIcon/CheckIcon already ship with lucide-react). No feature flag
  needed — additive and safe by default (unset cookie → existing `en`).
- Gates before PR: `pnpm lint && pnpm typecheck && pnpm test` (unit) +
  `pnpm check:i18n` + targeted E2E. Full CI on the PR.
- Ships as an independent PR off `main`, unrelated to the in-flight
  `088-invoice-tax-flow-redesign` branch.
