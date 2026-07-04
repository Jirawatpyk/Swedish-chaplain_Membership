# Language Switcher (EN/TH/SV) — Design

**Date:** 2026-07-03
**Branch:** `worktree-language-switcher` (off `main`)
**Status:** Approved (brainstorming) — revised after specialist review (i18n / a11y / component-arch)

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
Buddhist-Era date formatting + `<html lang>`) re-render in that language, on
every page — including the pre-login auth pages, and on mobile.

Non-goals (YAGNI): URL-prefix locale routing, adding new locales, translating
the language names themselves (shown as endonyms). **Cross-device / account
persistence is intentionally out of scope** — see § Relationship to
`preferred_locale`.

## Approach

Mirror the existing `ThemeToggle` (`src/components/shell/theme-toggle.tsx`) —
same shadcn `DropdownMenu` + ghost trigger, same client-only nature, same
header cluster. It differs in two deliberate ways: (1) the trigger shows the
**current language endonym** next to the icon (a language switcher must be
legible to someone who cannot read the current UI language — an icon-only
tooltip is in that same unreadable language); (2) the menu uses a
**radio group** so the active locale is announced to screen readers.

### Chosen mechanism — client cookie + `router.refresh()`

```ts
document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; path=/; max-age=31536000; samesite=lax`;
startTransition(() => router.refresh());
```

`router.refresh()` re-runs the RSC render; `getRequestConfig` re-reads the
`NEXT_LOCALE` cookie and returns the new locale's `messages` **and**
`buildFormats(locale)` (so Thai BE dates switch too). The root
`app/layout.tsx` sets `<html lang={locale}>` from `getLocale()`, so the
document language attribute switches on the same refresh (WCAG 3.1.1/3.1.2 —
free from the existing architecture). `document.cookie` is synchronous, so it
is written before the refresh request is sent. No new route, server action, or
middleware is introduced.

The refresh is wrapped in `useTransition`; while `isPending`, the trigger
reflects a busy state (double-click debounce + feedback on slow networks).
Focus must return to the trigger after the menu closes (not fall to `<body>`).

**Cookie name is a shared const.** Add `export const LOCALE_COOKIE_NAME =
'NEXT_LOCALE'` to `src/i18n/config.ts` and use it on both the read side
(`request.ts`) and the write side (switcher + tests) so they cannot drift.

**Rejected alternative — server action + `cookies().set()` + `revalidatePath`.**
More ceremony, enables `httpOnly`, but locale is not a security-sensitive
cookie and next-intl reads it as a plain cookie already. Overkill; violates
Simplicity (Constitution Principle X). Also diverges from the client-only
`ThemeToggle` pattern for no benefit.

## Relationship to `preferred_locale` (deliberate separation)

A per-member `preferred_locale` column already exists (set via
`PreferredLocaleForm` / `AdminPreferredLocaleCard` → `PATCH
/api/portal/preferred-locale` + the admin variant). It feeds **email /
broadcast targeting only** — `request.ts` never reads it for UI rendering.

This switcher deliberately does **not** write `preferred_locale`. Rationale:

- The cookie is the only mechanism that works everywhere the switcher lives
  (auth pages have no session; staff have no `preferred_locale`). Syncing would
  only cover the logged-in-member subset and add conditional role logic + a
  network call with a failure mode on every switch.
- "UI reading language right now" and "language TSCC emails me in" are
  genuinely separate preferences; conflating them is not obviously correct.

Consequence (accepted): the UI language (cookie, per browser) and email
language (`preferred_locale`, per account) are independent and can differ. The
Account-settings copy stays the source of truth for email language. A future
"sync UI language to account" enhancement is a separate backlog item, not part
of this feature.

## Components

### New: `src/components/shell/locale-switcher.tsx` (client component)

- `'use client'`; `DropdownMenu` with a ghost `Button` trigger containing a
  `LanguagesIcon` (lucide-react) **plus the current-language endonym**
  (`localeLabels[locale]`, e.g. "ไทย"). Kept to one short word so the header
  stays compact.
- Reads the active locale via `useLocale()` (next-intl).
- Menu is a `DropdownMenuRadioGroup` with one `DropdownMenuRadioItem` per
  locale from `locales` + `localeLabels`: English · ไทย · Svenska. The radio
  item gives `role="menuitemradio"` + `aria-checked` + a built-in indicator on
  the active row (replaces a hand-rolled `aria-hidden` CheckIcon), so the
  selected locale is announced to screen readers.
- On select: write the cookie (via `LOCALE_COOKIE_NAME`) then
  `startTransition(() => router.refresh())`.
- Props mirror `ThemeToggle`: `{ size?: 'icon' | 'icon-lg'; className?: string }`,
  `cn(className)` merged last so a `size-*` override can win. Kept for API
  parity; in-scope placements pass none.
- `aria-label` from `t('shell.locale.label')` (action phrase — see § i18n).

### New: `src/components/shell/auth-page-controls.tsx`

The 7 auth pages currently each repeat, verbatim:

```tsx
<header className="absolute right-4 top-4 z-10">
  <ThemeToggle />
</header>
```

Growing each from 1 → 2 controls would be 7× duplicated edits with drift risk
(order / spacing could diverge 7 ways), and the header has **no flex/gap
wrapper** today (two inline controls would sit <8px apart, violating
ux-standards § 9.1). Extract the cluster once:

```tsx
export function AuthPageControls() {
  return (
    <header className="absolute right-4 top-4 z-10">
      <div className="flex items-center gap-2">
        <LocaleSwitcher />
        <ThemeToggle />
      </div>
    </header>
  );
}
```

Replace the header in all 7 auth pages with `<AuthPageControls />`. This slot
is **not** forced onto the two app-shell layouts — their clusters differ
(`OutboxHealthBadge` + `UserMenu`, `sm:contents` wrapper), so inlining
`<LocaleSwitcher />` there directly is the correct, non-abstracted choice.

### Modified: placement (2 layouts inline + 7 auth pages via `AuthPageControls`)

**Staff shell** — `src/app/(staff)/admin/layout.tsx`: add `<LocaleSwitcher />`
immediately before `<ThemeToggle />` inside the existing `gap-2` cluster.

**Member shell** — `src/app/(member)/portal/layout.tsx`: `ThemeToggle` there is
wrapped in `<span className="hidden sm:contents">` (hidden below 640px).
`<LocaleSwitcher />` must be placed **outside** that span (a direct child of
the visible right-hand cluster) so it renders at **every breakpoint** — locale
has no OS/`Accept-Language` fallback and there is no `UserMenu` entry, so a
hidden mobile switcher would strand a member in a language they cannot read.
Verify the 320px header does not overflow with the switcher visible.

**Auth pages** (via `<AuthPageControls />`): admin/sign-in, portal/sign-in,
forgot-password, reset-password/[token], invite/[token],
email-verification/[token], email-change/revert/[token].

No duplicate inside the member `UserMenu` dropdown — the always-visible header
switcher (mobile included) covers the requirement (YAGNI).

## i18n

Add a `shell.locale` scope to all three message files with parity
(`check:i18n` gate). The label is an **action phrase**, parallel to
`shell.theme.label` ("Toggle theme"):

| key                 | en                | th            | sv          |
|---------------------|-------------------|---------------|-------------|
| `shell.locale.label`| `Change language` | `เปลี่ยนภาษา`  | `Byt språk` |

**Option labels are endonyms from `localeLabels`** (English · ไทย · Svenska),
not per-locale message keys. This is a deliberate deviation from the project's
`common.languageOptions` (which carries localized glosses like
`English (อังกฤษ)` and serves in-form "pick a language" dropdowns): a top-level
UI switcher follows the Wikipedia/Google convention of showing each language in
its **own script**, so a speaker recognises their language regardless of the
current UI language. No new per-option keys are added.

## Accessibility (WCAG 2.1 AA + 2.2 AA, ux-standards)

- Trigger `aria-label` = "Change language" / "เปลี่ยนภาษา" / "Byt språk"; the
  `LanguagesIcon` is `aria-hidden` (the endonym text carries the visible
  meaning).
- Active locale announced via `DropdownMenuRadioItem` `aria-checked`
  (WCAG 1.3.1 / 4.1.2) — not a visual-only check.
- Keyboard nav, Esc-to-close, focus-trap, and focus-return come from the Base
  UI `DropdownMenu` primitive; verify focus lands back on the trigger after the
  post-select `router.refresh()`.
- `<html lang>` switches with the locale (WCAG 3.1.1/3.1.2), asserted in E2E.
- Icon-trigger size follows ux-standards **§ 19** (app-shell header controls =
  32px, the standing precedent for `ThemeToggle`/`UserMenu` since F1); this
  also satisfies WCAG 2.2 SC 2.5.8 (≥24px, AA). The endonym affix makes the
  actual target wider. `size`/`className` allow a ≥44px target if reused in a
  portal CTA context.

## Testing

### Unit / RTL — `tests/unit/components/locale-switcher.test.tsx` (primary)

Render with a real `NextIntlClientProvider` (en messages) + mocked
`next/navigation`:
- Trigger shows the current-language endonym + exposes the localized
  `aria-label`.
- Opens all three radio options (English / ไทย / Svenska); the current locale's
  item has `aria-checked="true"`.
- Selecting "ไทย" writes `NEXT_LOCALE=th` (via `LOCALE_COOKIE_NAME`) to
  `document.cookie` with `path=/`, and calls `router.refresh()` exactly once.

Use real-message rendering (no bare mocking of translation keys).

### E2E — `tests/e2e/locale-switcher.spec.ts` (`@i18n`, `--workers=1`, serial)

Gated on `E2E_ADMIN_EMAIL/PASSWORD`. Unlike the existing i18n specs (which seed
the cookie directly), this drives the **real control**:

1. **Authenticated (staff header):** sign in → open the LocaleSwitcher → pick
   "ไทย" → assert a known Thai nav/heading string renders, `NEXT_LOCALE=th`
   cookie is set, **and `document.documentElement.lang === 'th'`** → switch back
   to English and assert it reverts.
2. **Pre-login (auth page):** on `/admin/sign-in`, use the switcher to select
   "ไทย" → assert the sign-in form re-renders with Thai copy (auth-public
   placement works before a session exists).
3. **Mobile member portal:** at a 320–375px viewport on the member portal,
   assert the LocaleSwitcher is **visible** (regression guard for the
   `hidden sm:contents` placement fix).

Follows project E2E conventions: `mode: 'serial'`, `clearE2ERateLimits()` in
`beforeAll`, base URL `http://localhost:3100`.

## Process / rollout

- Small, self-contained UI addition. No DB, no migration, no new dependency
  (`LanguagesIcon` ships with lucide-react). No feature flag — additive and
  safe by default (unset cookie → existing `en`).
- Touched files: new `locale-switcher.tsx` + `auth-page-controls.tsx`;
  `config.ts` (`LOCALE_COOKIE_NAME`) + `request.ts` (use the const); 2 layouts;
  7 auth pages; 3 message files; unit + e2e tests.
- Gates before PR: `pnpm lint && pnpm typecheck && pnpm test` (unit) +
  `pnpm check:i18n` + targeted E2E. Full CI on the PR.
- Ships as an independent PR off `main`, unrelated to the in-flight
  `088-invoice-tax-flow-redesign` branch.
