# Sync `preferred_locale` on member language switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a logged-in member switches the UI language, also persist that locale to `members.preferred_locale` (email/broadcast language), via a best-effort background write — staff and auth pages stay cookie-only.

**Architecture:** A new shared client transport (`updatePreferredLocale`) owns the PATCH to the existing `/api/portal/preferred-locale`; both the `LocaleSwitcher` (new opt-in `persistToAccount` branch) and the existing `PreferredLocaleForm` call it. The switcher's persist is a detached, abort-superseded, timeout-bounded, retry-once (5xx/network only) write that never blocks the cookie-driven UI refresh.

**Tech Stack:** Next.js 16 App Router (RSC), React 19 (`useRef`, `useTransition`), TypeScript strict, Vitest + Testing Library, Playwright.

**Design doc:** `docs/superpowers/specs/2026-07-03-preferred-locale-sync-design.md`

## Global Constraints

- Package manager **pnpm**, never npm. Dev port **3100**.
- Conventional Commits (`feat(i18n): …`); NOT a Spec Kit feature — no `[Spec Kit]` prefix.
- **No new npm dependencies**; TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) — run `pnpm typecheck` + `pnpm lint` before each commit.
- Presentation-only (Constitution III): the switcher, transport, and form call an existing HTTP endpoint; none imports `src/modules/*`.
- **Cookie-only elsewhere**: `persistToAccount` defaults `false`; staff layout + the 7 auth pages must remain unchanged (no persist).
- **INVARIANT** — the switcher's detached persist path does **no** `setState` and **no** `toast`; only `console.warn`. (Orphaned-update hazard after `router.refresh()`.)
- Retry **only** on network error / 5xx — never on a 4xx (deterministic).
- E2E always `--workers=1`.

**Working dir:** worktree `.claude/worktrees/preferred-locale-sync` on branch `worktree-preferred-locale-sync` (off `main` @ `f3082a1a`, deps installed, `.env.local` present).

---

## Task 1: Shared transport `updatePreferredLocale`

**Files:**
- Create: `src/components/portal/preferred-locale-client.ts`
- Test: `tests/unit/components/portal/preferred-locale-client.test.ts`

**Interfaces:**
- Produces: `PREFERRED_LOCALE_ENDPOINT: string`, `type PreferredLocale = 'en'|'th'|'sv'|null`, and `updatePreferredLocale(preferredLocale: PreferredLocale, signal?: AbortSignal): Promise<Response>`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/components/portal/preferred-locale-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  updatePreferredLocale,
  PREFERRED_LOCALE_ENDPOINT,
} from '@/components/portal/preferred-locale-client';

describe('updatePreferredLocale', () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('PATCHes the endpoint with the locale body + same-origin creds', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    await updatePreferredLocale('th');
    expect(fetchSpy).toHaveBeenCalledWith(
      PREFERRED_LOCALE_ENDPOINT,
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preferredLocale: 'th' }),
      }),
    );
  });

  it('threads an AbortSignal through when provided', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    const ac = new AbortController();
    await updatePreferredLocale('en', ac.signal);
    expect(fetchSpy.mock.calls[0]?.[1]).toHaveProperty('signal', ac.signal);
  });

  it('omits signal from the request init when not provided', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    await updatePreferredLocale(null);
    expect(fetchSpy.mock.calls[0]?.[1]).not.toHaveProperty('signal');
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm test tests/unit/components/portal/preferred-locale-client.test.ts`
Expected: FAIL — cannot resolve `@/components/portal/preferred-locale-client`.

- [ ] **Step 3: Implement the transport**

Create `src/components/portal/preferred-locale-client.ts`:

```ts
/**
 * Client transport for the member preferred-locale endpoint. Owns the URL +
 * request shape ONLY — callers apply their own policy (the LocaleSwitcher
 * persist branch retries; the Account form toasts). Single source of truth so
 * the route string + body shape cannot drift across consumers.
 */
export const PREFERRED_LOCALE_ENDPOINT = '/api/portal/preferred-locale';

export type PreferredLocale = 'en' | 'th' | 'sv' | null;

/**
 * PATCH the current member's preferred locale. Returns the raw Response so the
 * caller decides retry (5xx / network) vs give up (4xx). The member is resolved
 * server-side from the session (no id in the body) — no IDOR. Rejects only on
 * network error / abort; callers catch.
 */
export function updatePreferredLocale(
  preferredLocale: PreferredLocale,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(PREFERRED_LOCALE_ENDPOINT, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preferredLocale }),
    // exactOptionalPropertyTypes: only include `signal` when defined.
    ...(signal ? { signal } : {}),
  });
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `pnpm test tests/unit/components/portal/preferred-locale-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/portal/preferred-locale-client.ts tests/unit/components/portal/preferred-locale-client.test.ts
git commit -m "feat(i18n): shared updatePreferredLocale client transport"
```

---

## Task 2: Migrate `PreferredLocaleForm` onto the shared transport

Mechanical refactor — **no behavior change**. Removes the duplicated inline PATCH + the magic-string URL.

**Files:**
- Modify: `src/components/portal/preferred-locale-form.tsx`

**Interfaces:**
- Consumes: `updatePreferredLocale`, `PREFERRED_LOCALE_ENDPOINT`, `PreferredLocale` from Task 1.

- [ ] **Step 1: Add the import**

In `src/components/portal/preferred-locale-form.tsx`, add near the other imports:

```ts
import {
  updatePreferredLocale,
  PREFERRED_LOCALE_ENDPOINT,
  type PreferredLocale,
} from '@/components/portal/preferred-locale-client';
```

Then delete the local type declaration line `type PreferredLocale = 'en' | 'th' | 'sv' | null;` (now imported).

- [ ] **Step 2: Use the const for the mount GET**

Replace the GET fetch URL:

```ts
const res = await fetch('/api/portal/preferred-locale', {
  credentials: 'same-origin',
});
```

with:

```ts
const res = await fetch(PREFERRED_LOCALE_ENDPOINT, {
  credentials: 'same-origin',
});
```

- [ ] **Step 3: Use the transport for the submit PATCH**

Replace the submit fetch block:

```ts
      const res = await fetch('/api/portal/preferred-locale', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preferredLocale: value }),
      });
```

with:

```ts
      const res = await updatePreferredLocale(value);
```

(The surrounding `if (res.ok) { toast.success … } else { toast.error … }` stays exactly as-is — the form keeps its own UX policy.)

- [ ] **Step 4: Verify — no behavior change**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors (the local `PreferredLocale` type is now imported; `value: PreferredLocale` still assignable to the transport param).

Run any existing form test if present:
`pnpm test tests/unit/components/portal/preferred-locale-form.test.tsx 2>/dev/null || echo "no dedicated form test — covered by typecheck"`
Expected: PASS (or the "no dedicated form test" note).

- [ ] **Step 5: Commit**

```bash
git add src/components/portal/preferred-locale-form.tsx
git commit -m "refactor(i18n): PreferredLocaleForm uses the shared transport"
```

---

## Task 3: `LocaleSwitcher` — `persistToAccount` detached persist

**Files:**
- Modify: `src/components/shell/locale-switcher.tsx`
- Test: `tests/unit/components/shell/locale-switcher.test.tsx` (extend)

**Interfaces:**
- Consumes: `updatePreferredLocale` (Task 1).
- Produces: `LocaleSwitcher` now accepts `{ className?: string; persistToAccount?: boolean }`.

- [ ] **Step 1: Write the failing tests (extend the existing file)**

At the TOP of `tests/unit/components/shell/locale-switcher.test.tsx`, add the transport mock right after the existing `vi.mock('next/navigation', …)` block:

```ts
vi.mock('@/components/portal/preferred-locale-client', () => ({
  PREFERRED_LOCALE_ENDPOINT: '/api/portal/preferred-locale',
  updatePreferredLocale: vi.fn(),
}));
```

Add these imports to the existing import list:

```ts
import { waitFor } from '@testing-library/react';
import { updatePreferredLocale } from '@/components/portal/preferred-locale-client';
```

Add this helper below the existing `renderSwitcher` function:

```ts
const updateMock = vi.mocked(updatePreferredLocale);

// Minimal Response stub — the persist path only reads `.ok` and `.status`.
// `as unknown as Response` avoids TS2352 (a bare `{ok,status}` object lacks
// Response's other members) and sidesteps needing a real `Response` global.
const res = (status: number): Response =>
  ({ ok: status >= 200 && status < 300, status }) as unknown as Response;

function renderWithPersist(locale: 'en' | 'th' | 'sv' = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={enMessages}>
      <LocaleSwitcher persistToAccount />
    </NextIntlClientProvider>,
  );
}

async function pickThai() {
  fireEvent.click(screen.getByRole('button', { name: /change language/i }));
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'ไทย' }));
}
```

Append a new describe block at the end of the file:

```ts
describe('<LocaleSwitcher persistToAccount>', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useRealTimers();
    refreshSpy.mockClear();
    updateMock.mockReset();
    document.cookie = 'NEXT_LOCALE=; path=/; max-age=0';
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    cleanup();
    vi.useFakeTimers();
  });

  it('persists the chosen locale to the account', async () => {
    updateMock.mockResolvedValue(res(200));
    renderWithPersist('en');
    await pickThai();
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock).toHaveBeenCalledWith('th', expect.any(AbortSignal));
  });

  it('retries once on 5xx then succeeds without warning', async () => {
    updateMock
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200));
    renderWithPersist('en');
    await pickThai();
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(2));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT retry on a 4xx (403)', async () => {
    updateMock.mockResolvedValue(res(403));
    renderWithPersist('en');
    await pickThai();
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    // give any erroneous retry a chance to fire, then confirm it did not.
    await new Promise((r) => setTimeout(r, 50));
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns once after both attempts reject (network) and never throws', async () => {
    updateMock.mockRejectedValue(new Error('network down'));
    renderWithPersist('en');
    await pickThai();
    await waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it('does not persist when persistToAccount is absent (default cookie-only)', async () => {
    updateMock.mockResolvedValue(res(200));
    renderSwitcher('en'); // no persistToAccount
    await pickThai();
    await new Promise((r) => setTimeout(r, 50));
    expect(updateMock).not.toHaveBeenCalled();
  });
});
```

> Note on the superseded/abort path: it is verified by code review + the
> `expect.any(AbortSignal)` assertion above (proving the signal is wired), NOT
> by a dedicated unit test — reproducing two overlapping in-flight persists
> deterministically fights the `isPending` guard + Base UI menu timing and
> would be flaky. Do not add a timing-racy abort test.

- [ ] **Step 2: Run the new tests — verify they fail**

Run: `pnpm test tests/unit/components/shell/locale-switcher.test.tsx`
Expected: the 5 new `persistToAccount` tests FAIL (the prop is ignored / `updateMock` never called); the original 4 still pass.

- [ ] **Step 3: Implement the persist path**

In `src/components/shell/locale-switcher.tsx`:

**(a)** Change the React import to add `useRef`:

```ts
import { useRef, useTransition } from 'react';
```

**(b)** Add the transport import after the `@/lib/utils` import:

```ts
import { updatePreferredLocale } from '@/components/portal/preferred-locale-client';
```

**(c)** Add a module-level const above the component (after the imports):

```ts
/** Abort a stuck preferred-locale sync after this long (captive-portal guard). */
const PERSIST_TIMEOUT_MS = 8000;
```

**(d)** Change the component signature to accept the prop:

```ts
export function LocaleSwitcher({
  className,
  persistToAccount = false,
}: {
  readonly className?: string;
  readonly persistToAccount?: boolean;
} = {}) {
```

**(e)** Add the abort ref after the `useTransition` line:

```ts
  const syncAbortRef = useRef<AbortController | null>(null);
```

**(f)** Add the persist helper between the ref and `handleValueChange`:

```ts
  // Best-effort background write of preferred_locale (email/broadcast language)
  // for logged-in members. Detached: never blocks the cookie-driven UI refresh.
  // INVARIANT: no setState / no toast here — only console.warn. A state update
  // fired after router.refresh() would be an orphaned-update bug.
  const persistPreferredLocale = (locale: Locale): void => {
    syncAbortRef.current?.abort(); // supersede any older in-flight sync
    const controller = new AbortController();
    syncAbortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), PERSIST_TIMEOUT_MS);
    void (async () => {
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await updatePreferredLocale(locale, controller.signal);
            if (res.ok || res.status < 500) return; // ok, or deterministic 4xx → stop
            // 5xx → fall through to the one retry
          } catch {
            if (controller.signal.aborted) return; // superseded or timed out
            // network error → fall through to the one retry
          }
        }
        console.warn('[LocaleSwitcher] preferred_locale sync failed');
      } finally {
        clearTimeout(timer);
      }
    })();
  };
```

**(g)** In `handleValueChange`, fire the persist after the cookie write, before the refresh:

```ts
    document.cookie = `${LOCALE_COOKIE_NAME}=${value}; path=/; max-age=31536000; samesite=lax`;
    if (persistToAccount) persistPreferredLocale(value); // value is Locale (isLocale guard above)
    startTransition(() => router.refresh());
```

- [ ] **Step 4: Run the tests — verify all pass**

Run: `pnpm test tests/unit/components/shell/locale-switcher.test.tsx`
Expected: PASS (4 original + 5 new = 9).

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/shell/locale-switcher.tsx tests/unit/components/shell/locale-switcher.test.tsx
git commit -m "feat(i18n): LocaleSwitcher persistToAccount syncs preferred_locale"
```

---

## Task 4: Wire `persistToAccount` in the member layout

**Files:**
- Modify: `src/app/(member)/portal/layout.tsx:93`

- [ ] **Step 1: Pass the prop**

In `src/app/(member)/portal/layout.tsx`, change the always-visible switcher (line ~93) from:

```tsx
            <LocaleSwitcher />
```

to:

```tsx
            <LocaleSwitcher persistToAccount />
```

(Staff layout + the 7 auth pages are left unchanged — they render `<LocaleSwitcher />` → `persistToAccount` defaults `false`.)

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(member)/portal/layout.tsx"
git commit -m "feat(i18n): member portal switcher persists preferred_locale"
```

---

## Task 5: E2E — member persists, staff does not

**Files:**
- Modify: `tests/e2e/locale-switcher.spec.ts`

**Interfaces:**
- Consumes: the existing `signIn(page, email, password, portal)` + `chooseLanguage(page, optionName)` helpers already in the spec.

- [ ] **Step 1: Add the two tests**

In `tests/e2e/locale-switcher.spec.ts`, inside the existing
`test.describe('LocaleSwitcher @i18n', …)` block, add:

```ts
  test('member portal switch persists preferred_locale (fires PATCH)', async ({ page }) => {
    test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'Set E2E_MEMBER_EMAIL/PASSWORD');
    await signIn(page, MEMBER_EMAIL!, MEMBER_PASSWORD!, 'portal');
    const patch = page.waitForRequest(
      (r) => r.url().includes('/api/portal/preferred-locale') && r.method() === 'PATCH',
      { timeout: 10_000 },
    );
    await chooseLanguage(page, /^ไทย$/);
    await patch; // throws if the PATCH never fires
  });

  test('staff header switch does NOT fire a preferred-locale request', async ({ page }) => {
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_EMAIL/PASSWORD');
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!, 'admin');
    const seen: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/portal/preferred-locale')) seen.push(r.method());
    });
    await chooseLanguage(page, /^ไทย$/);
    await page.waitForTimeout(1_000); // let any stray request surface
    expect(seen).toEqual([]);
  });
```

- [ ] **Step 2: Validate statically (live run deferred to CI/preview)**

A live run needs this branch served on :3100 (conflicts with the operator's dev server), so validate compilation only:
Run: `pnpm typecheck && pnpm test:e2e --grep "LocaleSwitcher" --list`
Expected: typecheck clean; `--list` collects the now-5 tests × 3 projects with no compile/collection error.

> The controller may instead run these live against a throwaway worktree dev
> server on :3101 (see the team's e2e-worktree recipe) — but the implementer
> should NOT attempt a live run that touches :3100.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/locale-switcher.spec.ts
git commit -m "test(i18n): e2e — member persists preferred_locale, staff does not"
```

---

## Final verification (before opening the PR)

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- [ ] Confirm `git grep -n "fetch('/api/portal/preferred-locale'" src` returns **nothing** (all consumers now go through the transport; the form's GET uses the const).
- [ ] E2E live (controller, via a :3101 worktree server — never :3100): `pnpm exec playwright test --config=<:3101-override> --grep "LocaleSwitcher" --project=chromium --workers=1`.
- [ ] Open PR off `main`.
