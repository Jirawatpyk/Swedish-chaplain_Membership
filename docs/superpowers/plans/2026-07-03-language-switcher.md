# Language Switcher (EN/TH/SV) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-facing control that switches the interface language between English / ไทย / Svenska on every page (including pre-login auth pages and mobile), cookie-only.

**Architecture:** A client `LocaleSwitcher` mirrors the existing `ThemeToggle` — a shadcn/Base-UI `DropdownMenu` whose trigger shows the current-language endonym and whose menu is a radio group. Selecting a locale writes the `NEXT_LOCALE` cookie and calls `router.refresh()`, so `getRequestConfig` re-reads the cookie and the RSC tree re-renders with new messages, Buddhist-Era date formats, and `<html lang>`. A small `AuthPageControls` server component clusters the switcher + theme toggle for the 7 auth pages.

**Tech Stack:** Next.js 16 App Router, React 19, next-intl v4, Base UI menu (`@base-ui/react`), Tailwind v4, lucide-react. No new dependencies.

**Design doc:** `docs/superpowers/specs/2026-07-03-language-switcher-design.md`

## Global Constraints

- Package manager is **pnpm**, never npm. Dev server runs on **port 3100**.
- Commits: **Conventional Commits** (`feat(i18n): …`), enforced by commit-msg hook. Not a Spec Kit feature — no `[Spec Kit]` prefix.
- i18n: **EN is canonical**; every key MUST exist in `th.json` + `sv.json` (the `pnpm check:i18n` gate hard-fails on release branches for a missing TH/SV key). Add all three in the same commit.
- **No new npm dependencies** (Constitution X). `LanguagesIcon` already ships with lucide-react.
- TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Run `pnpm typecheck` as the final gate before each commit.
- Presentation-only (Constitution III): the component may import `@/i18n/config` (pure config) and `@/components/ui/*`; it must NOT touch `src/modules/*`.
- Cookie-only: the switcher MUST NOT write member `preferred_locale` (email language stays an Account-settings preference).
- Accessibility: WCAG 2.1 AA + 2.2 AA. Active locale announced via `aria-checked`; the trigger's accessible name must contain its visible endonym (SC 2.5.3).
- E2E: always run with `--workers=1`.

**Working directory:** worktree `.claude/worktrees/language-switcher` on branch `worktree-language-switcher` (already set up, deps installed).

---

## Task 1: `LOCALE_COOKIE_NAME` shared const

Extract the `NEXT_LOCALE` cookie name into one exported const so the read side (`request.ts`) and the write side (the switcher) cannot drift.

**Files:**
- Modify: `src/i18n/config.ts` (add the const)
- Modify: `src/i18n/request.ts:25` (read via the const)
- Test: `tests/unit/i18n/locale-cookie-name.test.ts`

**Interfaces:**
- Produces: `export const LOCALE_COOKIE_NAME = 'NEXT_LOCALE'` from `@/i18n/config`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/i18n/locale-cookie-name.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { LOCALE_COOKIE_NAME } from '@/i18n/config';

describe('LOCALE_COOKIE_NAME', () => {
  it('is the next-intl locale cookie name read by request.ts', () => {
    expect(LOCALE_COOKIE_NAME).toBe('NEXT_LOCALE');
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm test tests/unit/i18n/locale-cookie-name.test.ts`
Expected: FAIL — `LOCALE_COOKIE_NAME` is not exported from `@/i18n/config` (module has no such export).

- [ ] **Step 3: Add the const to `src/i18n/config.ts`**

Append to the end of `src/i18n/config.ts` (after the `isLocale` function):

```ts

/**
 * Name of the cookie next-intl reads for the active locale (see request.ts).
 * Shared by the read side (request.ts) and the write side (LocaleSwitcher) so
 * the two can never drift.
 */
export const LOCALE_COOKIE_NAME = 'NEXT_LOCALE';
```

- [ ] **Step 4: Use the const in `src/i18n/request.ts`**

Change the import on line 3 from:

```ts
import { defaultLocale, isLocale, type Locale } from './config';
```

to:

```ts
import { defaultLocale, isLocale, LOCALE_COOKIE_NAME, type Locale } from './config';
```

Then change line 25 from:

```ts
  const fromCookie = cookieStore.get('NEXT_LOCALE')?.value;
```

to:

```ts
  const fromCookie = cookieStore.get(LOCALE_COOKIE_NAME)?.value;
```

- [ ] **Step 5: Run the new test + the existing i18n unit tests — verify all pass**

Run: `pnpm test tests/unit/i18n/`
Expected: PASS — the new const test passes and the existing `request-config` tests stay green (cookie resolution unchanged).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/i18n/config.ts src/i18n/request.ts tests/unit/i18n/locale-cookie-name.test.ts
git commit -m "refactor(i18n): extract LOCALE_COOKIE_NAME shared const"
```

---

## Task 2: i18n keys — `shell.locale.label`

Add the switcher's accessible-name label (an action phrase, parallel to `shell.theme.label`) to all three message files.

**Files:**
- Modify: `src/i18n/messages/en.json` (after the `shell.theme` block, ~line 166)
- Modify: `src/i18n/messages/th.json` (after the `shell.theme` block, ~line 166)
- Modify: `src/i18n/messages/sv.json` (after the `shell.theme` block, ~line 166)

**Interfaces:**
- Produces: message key `shell.locale.label` in en/th/sv.

- [ ] **Step 1: Add the key to `en.json`**

In `src/i18n/messages/en.json`, find the `theme` block inside `shell` and insert a `locale` block immediately after it. Replace:

```json
    "theme": {
      "label": "Toggle theme",
      "light": "Light",
      "dark": "Dark",
      "system": "System"
    },
```

with:

```json
    "theme": {
      "label": "Toggle theme",
      "light": "Light",
      "dark": "Dark",
      "system": "System"
    },
    "locale": {
      "label": "Change language"
    },
```

- [ ] **Step 2: Add the key to `th.json`**

In `src/i18n/messages/th.json`, replace:

```json
    "theme": {
      "label": "สลับธีม",
      "light": "สว่าง",
      "dark": "มืด",
      "system": "ตามระบบ"
    },
```

with:

```json
    "theme": {
      "label": "สลับธีม",
      "light": "สว่าง",
      "dark": "มืด",
      "system": "ตามระบบ"
    },
    "locale": {
      "label": "เปลี่ยนภาษา"
    },
```

- [ ] **Step 3: Add the key to `sv.json`**

In `src/i18n/messages/sv.json`, replace:

```json
    "theme": {
      "label": "Växla tema",
      "light": "Ljust",
      "dark": "Mörkt",
      "system": "System"
    },
```

with:

```json
    "theme": {
      "label": "Växla tema",
      "light": "Ljust",
      "dark": "Mörkt",
      "system": "System"
    },
    "locale": {
      "label": "Byt språk"
    },
```

- [ ] **Step 4: Run the i18n parity gate — verify it passes**

Run: `pnpm check:i18n`
Expected: PASS — `shell.locale.label` present in all three locales, no missing-key errors.

- [ ] **Step 5: Commit**

```bash
git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json
git commit -m "feat(i18n): add shell.locale.label for the language switcher"
```

---

## Task 3: `LocaleSwitcher` component

The switcher itself, TDD via RTL. Mirrors `ThemeToggle`; trigger shows the current endonym; menu is a Base UI radio group.

**Files:**
- Create: `src/components/shell/locale-switcher.tsx`
- Test: `tests/unit/components/shell/locale-switcher.test.tsx`

**Interfaces:**
- Consumes: `LOCALE_COOKIE_NAME`, `locales`, `localeLabels`, `isLocale`, `Locale` from `@/i18n/config` (Task 1); message key `shell.locale.label` (Task 2); `DropdownMenu*` from `@/components/ui/dropdown-menu`; `Button` from `@/components/ui/button`.
- Produces: `export function LocaleSwitcher({ className }: { readonly className?: string }): JSX.Element`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/components/shell/locale-switcher.test.tsx`:

```tsx
/**
 * LocaleSwitcher unit test — endonym trigger + radio-group locale switch.
 *
 * Base UI's Menu portal uses floating-ui internals that need real timers
 * (same pattern as user-menu.test.tsx). `useLocale()` reads the provider's
 * `locale` prop; `localeLabels` come from config, so passing enMessages for
 * every locale is fine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { LocaleSwitcher } from '@/components/shell/locale-switcher';

const refreshSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshSpy }),
}));

function renderSwitcher(locale: 'en' | 'th' | 'sv' = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={enMessages}>
      <LocaleSwitcher />
    </NextIntlClientProvider>,
  );
}

describe('<LocaleSwitcher>', () => {
  beforeEach(() => {
    vi.useRealTimers();
    refreshSpy.mockClear();
    document.cookie = 'NEXT_LOCALE=; path=/; max-age=0';
  });
  afterEach(() => {
    cleanup();
    vi.useFakeTimers();
  });

  it('shows the current-language endonym on the trigger', () => {
    renderSwitcher('en');
    expect(
      screen.getByRole('button', { name: /change language/i }),
    ).toHaveTextContent('English');
  });

  it('opens a radio group of all three locales with the active one checked', async () => {
    renderSwitcher('en');
    fireEvent.click(screen.getByRole('button', { name: /change language/i }));
    const en = await screen.findByRole('menuitemradio', { name: 'English' });
    expect(en).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('menuitemradio', { name: 'ไทย' }),
    ).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menuitemradio', { name: 'Svenska' })).toBeInTheDocument();
  });

  it('writes NEXT_LOCALE=th and refreshes when Thai is chosen', async () => {
    renderSwitcher('en');
    fireEvent.click(screen.getByRole('button', { name: /change language/i }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'ไทย' }));
    expect(document.cookie).toContain('NEXT_LOCALE=th');
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('does not refresh when the already-active locale is re-selected', async () => {
    renderSwitcher('en');
    fireEvent.click(screen.getByRole('button', { name: /change language/i }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'English' }));
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm test tests/unit/components/shell/locale-switcher.test.tsx`
Expected: FAIL — cannot resolve `@/components/shell/locale-switcher` (module does not exist yet).

- [ ] **Step 3: Implement the component**

Create `src/components/shell/locale-switcher.tsx`:

```tsx
'use client';

/**
 * LocaleSwitcher — EN/TH/SV interface-language switcher (ux-standards § 19).
 *
 * Cookie-only: writes the `NEXT_LOCALE` cookie (`LOCALE_COOKIE_NAME`) then
 * `router.refresh()` so the RSC tree re-reads it via `getRequestConfig` — new
 * messages + Buddhist-Era date formats + `<html lang>` (set from `getLocale()`
 * in the root layout). Client-only, mirroring `ThemeToggle`. It does NOT touch
 * member `preferred_locale` (email language) — that stays an Account-settings
 * preference (see the design doc).
 *
 * The trigger shows the current-language endonym so it is legible to someone
 * who cannot read the current UI language (an icon-only tooltip would be in
 * that same unreadable language). An `sr-only` label makes the accessible name
 * "<action> <endonym>" — conveying purpose AND satisfying WCAG 2.5.3 (the
 * visible endonym is contained in the accessible name). The menu is a radio
 * group so the active locale is announced (`aria-checked`) to screen readers.
 */
import { LanguagesIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  LOCALE_COOKIE_NAME,
  isLocale,
  localeLabels,
  locales,
  type Locale,
} from '@/i18n/config';

export function LocaleSwitcher({
  className,
}: {
  readonly className?: string;
} = {}) {
  const t = useTranslations('shell.locale');
  const activeLocale = useLocale() as Locale;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleValueChange = (value: string) => {
    if (!isLocale(value) || value === activeLocale) return;
    // 1-year, path=/ so it applies to every route; SameSite=Lax is fine for a
    // non-sensitive UI-preference cookie. Synchronous — written before the
    // refresh request is sent, so the RSC pass reads the new value.
    document.cookie = `${LOCALE_COOKIE_NAME}=${value}; path=/; max-age=31536000; samesite=lax`;
    startTransition(() => router.refresh());
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-busy={isPending}
            // h-8 (32px) height-matches the neighbouring ThemeToggle/UserMenu
            // icon buttons (size="icon" = size-8); cn'd last so it wins over
            // the `sm` variant's h-7 via tailwind-merge.
            className={cn('h-8 gap-1.5', className)}
          />
        }
      >
        <LanguagesIcon className="size-4" aria-hidden />
        {/* sr-only action phrase + visible endonym → accessible name is
            "Change language English", which contains the visible label. */}
        <span className="sr-only">{t('label')}</span>
        <span className="text-sm font-medium">{localeLabels[activeLocale]}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={activeLocale} onValueChange={handleValueChange}>
          {locales.map((locale) => (
            // closeOnClick: Base UI RadioItem defaults to false (menu stays
            // open). Closing on select matches the expected switcher UX and
            // keeps the E2E round-trip robust (a re-open is a fresh open).
            <DropdownMenuRadioItem key={locale} value={locale} closeOnClick>
              {localeLabels[locale]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `pnpm test tests/unit/components/shell/locale-switcher.test.tsx`
Expected: PASS (4 tests).

> If `aria-checked` is not present on the Base UI radio items, open the running
> app or inspect the rendered DOM to confirm the actual selected-state
> attribute (Base UI may expose `data-checked`) and adjust the two
> `toHaveAttribute('aria-checked', …)` assertions to the real attribute before
> continuing. Do not weaken the test to "exists only".

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors (lint catches react-hooks rules that typecheck misses).

- [ ] **Step 6: Commit**

```bash
git add src/components/shell/locale-switcher.tsx tests/unit/components/shell/locale-switcher.test.tsx
git commit -m "feat(i18n): add LocaleSwitcher control (cookie + refresh)"
```

---

## Task 4: `AuthPageControls` cluster

A server component that clusters `LocaleSwitcher` + `ThemeToggle` with a flex/gap wrapper, replacing the duplicated single-control header on the 7 auth pages.

**Files:**
- Create: `src/components/shell/auth-page-controls.tsx`
- Test: `tests/unit/components/shell/auth-page-controls.test.tsx`

**Interfaces:**
- Consumes: `LocaleSwitcher` (Task 3), `ThemeToggle` (`@/components/shell/theme-toggle`).
- Produces: `export function AuthPageControls(): JSX.Element` — renders `<header class="absolute right-4 top-4 z-10"><div class="flex items-center gap-2">…</div></header>`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/components/shell/auth-page-controls.test.tsx`:

```tsx
/**
 * AuthPageControls unit test — renders both header controls.
 * Mocks the client-hook deps of the two child controls.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { AuthPageControls } from '@/components/shell/auth-page-controls';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ setTheme: vi.fn() }) }));

afterEach(cleanup);

describe('<AuthPageControls>', () => {
  it('renders both the language switcher and the theme toggle', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthPageControls />
      </NextIntlClientProvider>,
    );
    expect(
      screen.getByRole('button', { name: /change language/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /toggle theme/i }),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm test tests/unit/components/shell/auth-page-controls.test.tsx`
Expected: FAIL — cannot resolve `@/components/shell/auth-page-controls`.

- [ ] **Step 3: Implement the component**

Create `src/components/shell/auth-page-controls.tsx`:

```tsx
import { LocaleSwitcher } from '@/components/shell/locale-switcher';
import { ThemeToggle } from '@/components/shell/theme-toggle';

/**
 * AuthPageControls — top-right control cluster shared by all 7 `(auth-public)`
 * pages. Extracted when the cluster grew from one control (ThemeToggle) to two
 * (LocaleSwitcher + ThemeToggle) so the flex/gap wrapper + order stay
 * consistent across pages instead of drifting 7 ways. The app-shell layouts
 * have different clusters (UserMenu, OutboxHealthBadge, an `sm:contents`
 * wrapper) and inline the controls directly rather than using this slot.
 *
 * Server component — it only composes two client children, so it needs no
 * `'use client'` directive.
 */
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

- [ ] **Step 4: Run the test — verify it passes**

Run: `pnpm test tests/unit/components/shell/auth-page-controls.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/shell/auth-page-controls.tsx tests/unit/components/shell/auth-page-controls.test.tsx
git commit -m "feat(i18n): add AuthPageControls cluster for auth pages"
```

---

## Task 5: Wire placement into the 2 layouts + 7 auth pages

Mechanical wiring. Verified by typecheck + lint + build (runtime coverage is the E2E in Task 6).

**Files:**
- Modify: `src/app/(staff)/admin/layout.tsx` (import + insert before `<ThemeToggle />`)
- Modify: `src/app/(member)/portal/layout.tsx` (import + insert OUTSIDE the `hidden sm:contents` span)
- Modify (replace header + swap import) in all 7 auth pages:
  - `src/app/(auth-public)/admin/sign-in/page.tsx`
  - `src/app/(auth-public)/portal/sign-in/page.tsx`
  - `src/app/(auth-public)/forgot-password/page.tsx`
  - `src/app/(auth-public)/reset-password/[token]/page.tsx`
  - `src/app/(auth-public)/invite/[token]/page.tsx`
  - `src/app/(auth-public)/email-verification/[token]/page.tsx`
  - `src/app/(auth-public)/email-change/revert/[token]/page.tsx`

- [ ] **Step 1: Staff layout**

In `src/app/(staff)/admin/layout.tsx`, add the import next to the existing `ThemeToggle` import:

```ts
import { LocaleSwitcher } from '@/components/shell/locale-switcher';
```

Then insert `<LocaleSwitcher />` immediately before `<ThemeToggle />` in the header cluster:

```tsx
              <Suspense fallback={null}>
                <OutboxHealthBadge />
              </Suspense>
              <LocaleSwitcher />
              <ThemeToggle />
```

- [ ] **Step 2: Member layout (mobile-visible placement)**

In `src/app/(member)/portal/layout.tsx`, add the import next to the existing `ThemeToggle` import:

```ts
import { LocaleSwitcher } from '@/components/shell/locale-switcher';
```

Then insert `<LocaleSwitcher />` as the **first child of the right-hand cluster**, OUTSIDE the `hidden sm:contents` span (so it renders at every breakpoint — locale has no OS/`Accept-Language` fallback). Replace:

```tsx
          <div className="flex shrink-0 items-center gap-2">
            {/* ThemeToggle is hidden on mobile (< 640 px) to give the
                fixed-width header room for the icon-only MemberNav.
                Mobile users can change theme via their OS `prefers-
                color-scheme` setting (honoured automatically) or via
                the UserMenu which remains always-visible. */}
            <span className="hidden sm:contents">
              <ThemeToggle />
            </span>
```

with:

```tsx
          <div className="flex shrink-0 items-center gap-2">
            {/* LocaleSwitcher is ALWAYS visible (even on mobile): unlike
                theme, locale has no OS fallback and no UserMenu entry, so a
                hidden switcher would strand a member in a language they can't
                read. ThemeToggle stays hidden < 640px (OS prefers-color-scheme
                is the mobile fallback). */}
            <LocaleSwitcher />
            <span className="hidden sm:contents">
              <ThemeToggle />
            </span>
```

- [ ] **Step 3: Replace the header in all 7 auth pages**

For **each** of the 7 files listed above, make the same two edits:

**(a)** Replace the import line:

```ts
import { ThemeToggle } from '@/components/shell/theme-toggle';
```

with:

```ts
import { AuthPageControls } from '@/components/shell/auth-page-controls';
```

**(b)** Replace the entire top-right header element (the `<header className="absolute right-4 top-4 z-10">…</header>` block — including its inner JSX comment and `<ThemeToggle />`, whichever comment variant the page has) with a single line:

```tsx
      <AuthPageControls />
```

Example — `src/app/(auth-public)/forgot-password/page.tsx` before:

```tsx
      <header className="absolute right-4 top-4 z-10">
        {/* Brand wordmark replaced by the vertical lockup above the card. */}
        <ThemeToggle />
      </header>
```

after:

```tsx
      <AuthPageControls />
```

- [ ] **Step 4: Typecheck + lint + build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: no errors — no unused `ThemeToggle` import remains in any of the 7 auth pages, and all placements type-check.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/admin/layout.tsx" "src/app/(member)/portal/layout.tsx" "src/app/(auth-public)"
git commit -m "feat(i18n): place LocaleSwitcher in shells + auth pages"
```

---

## Task 6: E2E — drive the real control

An `@i18n` E2E that operates the actual switcher (not a seeded cookie), across a staff header, a pre-login auth page, and a mobile member portal (regression guard for the `hidden sm:contents` fix).

**Files:**
- Create: `tests/e2e/locale-switcher.spec.ts`

**Interfaces:**
- Consumes: `expect`, `test`, `fillField` from `./fixtures`; `clearE2ERateLimits` from `./helpers/rate-limit`; env vars `E2E_ADMIN_EMAIL/PASSWORD`, `E2E_MEMBER_EMAIL/PASSWORD`.

- [ ] **Step 1: Write the E2E spec**

Create `tests/e2e/locale-switcher.spec.ts`:

```ts
/**
 * E2E — user-facing LocaleSwitcher (EN/TH/SV).
 *
 * @i18n
 *
 * Drives the REAL control (the other i18n specs seed the NEXT_LOCALE cookie
 * directly):
 *   1. Staff header  — EN→TH updates <html lang> + cookie, then back to EN.
 *   2. Auth page     — switch to TH before signing in (no session).
 *   3. Member portal — switcher stays visible at a 360px mobile width.
 *
 * Gated on E2E_ADMIN_* / E2E_MEMBER_* env vars.
 */
import type { Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

async function signIn(page: Page, email: string, password: string, portal: 'admin' | 'portal') {
  await page.goto(`/${portal}/sign-in`);
  await fillField(page.getByLabel(/email/i), email);
  await fillField(page.getByRole('textbox', { name: /^password$/i }), password);
  await page.getByRole('button', { name: /sign in/i }).click();
  const base = portal === 'admin' ? '/admin' : '/portal';
  await page.waitForURL(
    (u) => {
      const p = new URL(u).pathname;
      return p.startsWith(base) && !p.includes('/sign-in');
    },
    { timeout: 15_000 },
  );
}

// The trigger's accessible name is localized (sr-only label + endonym), so
// after a switch it is no longer English. Match ALL three label variants so
// the trigger re-lookup is locale-stable across a round-trip. Radio-item
// endonyms (localeLabels) are locale-stable, so `optionName` can stay exact.
const TRIGGER_NAME = /change language|เปลี่ยนภาษา|byt språk/i;

async function chooseLanguage(page: Page, optionName: RegExp) {
  await page.getByRole('button', { name: TRIGGER_NAME }).click();
  await page.getByRole('menuitemradio', { name: optionName }).click();
}

test.describe.configure({ mode: 'serial' });

test.describe('LocaleSwitcher @i18n', () => {
  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('staff header switches EN↔TH and updates <html lang> + cookie', async ({ page, context }) => {
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_EMAIL/PASSWORD');
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!, 'admin');

    await chooseLanguage(page, /^ไทย$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'th');
    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === 'NEXT_LOCALE')?.value).toBe('th');

    await chooseLanguage(page, /^English$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('auth page switches to Thai before sign-in (no session)', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await chooseLanguage(page, /^ไทย$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'th');
  });

  test('member portal keeps the switcher visible at 360px', async ({ page }) => {
    test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'Set E2E_MEMBER_EMAIL/PASSWORD');
    await page.setViewportSize({ width: 360, height: 780 });
    await signIn(page, MEMBER_EMAIL!, MEMBER_PASSWORD!, 'portal');
    await expect(page.getByRole('button', { name: /change language/i })).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the E2E spec**

Requires the dev server on port 3100 and the `E2E_*` creds in `.env.local`.
Run: `pnpm test:e2e --grep "LocaleSwitcher" --workers=1`
Expected: PASS (member-portal test skips if `E2E_MEMBER_*` is unset).

> If sign-in times out on a rate limit, re-run — the global setup clears
> Upstash limits. Do not add sleeps.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/locale-switcher.spec.ts
git commit -m "test(i18n): e2e for the LocaleSwitcher control"
```

---

## Final verification (before opening the PR)

- [ ] Reproduce the relevant CI subset locally:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm check:i18n && pnpm build
```

- [ ] E2E (if dev server + creds available): `pnpm test:e2e --grep "LocaleSwitcher" --workers=1`
- [ ] Manual smoke at 320 / 375 / 768px: member-portal header does not overflow with the switcher visible; auth-page top-right controls sit ≥8px apart and aligned.
- [ ] Open PR off `main` (branch `worktree-language-switcher`), independent of `088-invoice-tax-flow-redesign`.
