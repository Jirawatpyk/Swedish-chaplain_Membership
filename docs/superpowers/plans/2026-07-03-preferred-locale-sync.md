# Sync `preferred_locale` on member language switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a logged-in member switches the UI language, also persist that locale to `members.preferred_locale` (email/broadcast language), via a best-effort background write — staff and auth pages stay cookie-only.

**Architecture:** A new shared client transport (`updatePreferredLocale`) owns the PATCH to the existing `/api/portal/preferred-locale`; both the `LocaleSwitcher` (new opt-in `persistToAccount`) and the existing `PreferredLocaleForm` call it. The switcher's retry/abort policy lives in a separate, directly-testable `runPreferredLocalePersist`; the component wires it with an abort-previous ref + timeout, and never blocks the cookie-driven UI refresh.

**Tech Stack:** Next.js 16 App Router (RSC), React 19 (`useRef`, `useTransition`), TypeScript strict, Vitest + Testing Library, Playwright.

**Design doc:** `docs/superpowers/specs/2026-07-03-preferred-locale-sync-design.md`

## Global Constraints

- Package manager **pnpm**, never npm. Dev port **3100**.
- Conventional Commits (`feat(i18n): …`); NOT a Spec Kit feature — no `[Spec Kit]` prefix.
- **No new npm dependencies**; TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) — run `pnpm typecheck` + `pnpm lint` before each commit.
- Presentation-only (Constitution III): the switcher, persist policy, transport, and form call an existing HTTP endpoint; none imports `src/modules/*`.
- **Cookie-only elsewhere**: `persistToAccount` defaults `false`; staff layout + the 7 auth pages remain unchanged.
- **INVARIANT** — the switcher's detached persist path does **no** `setState` and **no** `toast`; only `console.warn` on a `'failed'` outcome. (Orphaned-update hazard after `router.refresh()`.)
- Retry **only** on network error / 5xx — never on a 4xx (deterministic).
- E2E always `--workers=1`.
- When applying an Edit, if a shown `old` snippet does not match, **derive `old_string` from a fresh Read of the file** — do not force the plan's snippet.

**Working dir:** worktree `.claude/worktrees/preferred-locale-sync` on branch `worktree-preferred-locale-sync` (off `main` @ `f3082a1a`, deps installed, `.env.local` present).

---

## Task 1: Shared transport `updatePreferredLocale`

**Files:**
- Create: `src/components/portal/preferred-locale-client.ts`
- Test: `tests/unit/components/portal/preferred-locale-client.test.ts`

**Interfaces:**
- Produces: `PREFERRED_LOCALE_ENDPOINT: string`; `type PreferredLocale = 'en'|'th'|'sv'|null`; `updatePreferredLocale(preferredLocale: PreferredLocale, signal?: AbortSignal): Promise<Response>`.

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

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm test tests/unit/components/portal/preferred-locale-client.test.ts`
Expected: FAIL — module `@/components/portal/preferred-locale-client` not found.

- [ ] **Step 3: Implement the transport**

Create `src/components/portal/preferred-locale-client.ts`:

```ts
/**
 * Client transport for the member preferred-locale endpoint. Owns the URL +
 * request shape ONLY — callers apply their own policy (the LocaleSwitcher
 * persist path retries; the Account form toasts). Single source of truth so the
 * route string + body shape cannot drift across consumers.
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

- [ ] **Step 4: Run — verify it passes**

Run: `pnpm test tests/unit/components/portal/preferred-locale-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck` → no errors.

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

> The `old` snippets below are indentation-sensitive. If any Edit fails to
> match, re-Read the file and derive the exact `old_string` (the GET block is
> nested inside a `void (async () => { … })()` in a `useEffect`, at 8/10-space
> indent).

- [ ] **Step 1: Add the import; drop the local type**

Add near the other imports in `src/components/portal/preferred-locale-form.tsx`:

```ts
import {
  updatePreferredLocale,
  PREFERRED_LOCALE_ENDPOINT,
  type PreferredLocale,
} from '@/components/portal/preferred-locale-client';
```

Delete the local declaration line `type PreferredLocale = 'en' | 'th' | 'sv' | null;` (now imported). Keep the `type LoadState = …` line.

- [ ] **Step 2: Use the const for the mount GET**

Replace (note the real 8/10-space indentation):

```tsx
        const res = await fetch('/api/portal/preferred-locale', {
          credentials: 'same-origin',
        });
```

with:

```tsx
        const res = await fetch(PREFERRED_LOCALE_ENDPOINT, {
          credentials: 'same-origin',
        });
```

- [ ] **Step 3: Use the transport for the submit PATCH**

Replace:

```tsx
      const res = await fetch('/api/portal/preferred-locale', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preferredLocale: value }),
      });
```

with:

```tsx
      const res = await updatePreferredLocale(value);
```

(The surrounding `if (res.ok) { toast.success … } else { toast.error … }` is unchanged — the form keeps its own UX policy.)

- [ ] **Step 4: Verify — no behavior change**

Run: `pnpm typecheck && pnpm lint` → no errors.
Run: `pnpm test tests/unit/components/portal/preferred-locale-form.test.tsx 2>/dev/null || echo "no dedicated form test — typecheck covers the refactor"`
Expected: PASS (or the note).

- [ ] **Step 5: Commit**

```bash
git add src/components/portal/preferred-locale-form.tsx
git commit -m "refactor(i18n): PreferredLocaleForm uses the shared transport"
```

---

## Task 3: `runPreferredLocalePersist` — the retry/abort policy (directly tested)

Extract the switcher's persist policy into a pure, directly-testable async
function, so the retry + 4xx + abort-stop branches (the feature's core
out-of-order-write guard) get deterministic coverage without DOM/menu timing.

**Files:**
- Create: `src/components/shell/locale-persist.ts`
- Test: `tests/unit/components/shell/locale-persist.test.ts`

**Interfaces:**
- Consumes: `updatePreferredLocale` (Task 1); `type Locale` from `@/i18n/config`.
- Produces: `type PersistOutcome = 'ok' | 'client_error' | 'aborted' | 'failed'`; `runPreferredLocalePersist(locale: Locale, signal: AbortSignal): Promise<PersistOutcome>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/components/shell/locale-persist.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/components/portal/preferred-locale-client', () => ({
  updatePreferredLocale: vi.fn(),
}));
import { updatePreferredLocale } from '@/components/portal/preferred-locale-client';
import { runPreferredLocalePersist } from '@/components/shell/locale-persist';

const updateMock = vi.mocked(updatePreferredLocale);
const res = (status: number): Response =>
  ({ ok: status >= 200 && status < 300, status }) as unknown as Response;

describe('runPreferredLocalePersist', () => {
  beforeEach(() => updateMock.mockReset());

  it('returns ok on 200 without retrying', async () => {
    updateMock.mockResolvedValue(res(200));
    expect(await runPreferredLocalePersist('th', new AbortController().signal)).toBe('ok');
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('returns client_error and does NOT retry on a 4xx (403)', async () => {
    updateMock.mockResolvedValue(res(403));
    expect(await runPreferredLocalePersist('th', new AbortController().signal)).toBe('client_error');
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('retries once on 5xx then succeeds', async () => {
    updateMock.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    expect(await runPreferredLocalePersist('th', new AbortController().signal)).toBe('ok');
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it('returns failed after both attempts are 5xx', async () => {
    updateMock.mockResolvedValue(res(503));
    expect(await runPreferredLocalePersist('th', new AbortController().signal)).toBe('failed');
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it('returns failed after both attempts reject (network)', async () => {
    updateMock.mockRejectedValue(new Error('network'));
    expect(await runPreferredLocalePersist('th', new AbortController().signal)).toBe('failed');
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it('stops with aborted (no retry) when the signal is aborted mid-flight', async () => {
    const ac = new AbortController();
    updateMock.mockImplementation(() => {
      ac.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    expect(await runPreferredLocalePersist('th', ac.signal)).toBe('aborted');
    expect(updateMock).toHaveBeenCalledTimes(1); // did NOT retry after abort
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm test tests/unit/components/shell/locale-persist.test.ts`
Expected: FAIL — module `@/components/shell/locale-persist` not found.

- [ ] **Step 3: Implement**

Create `src/components/shell/locale-persist.ts`:

```ts
import { updatePreferredLocale } from '@/components/portal/preferred-locale-client';
import type { Locale } from '@/i18n/config';

export type PersistOutcome = 'ok' | 'client_error' | 'aborted' | 'failed';

/**
 * The LocaleSwitcher's best-effort persist policy for a member's preferred
 * locale: up to 2 attempts, retrying ONLY on network error / 5xx (a 4xx is
 * deterministic → stop). Stops immediately if `signal` is aborted (superseded
 * by a newer selection, or timed out). Never throws. The caller warns only on
 * `'failed'`.
 */
export async function runPreferredLocalePersist(
  locale: Locale,
  signal: AbortSignal,
): Promise<PersistOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await updatePreferredLocale(locale, signal);
      if (res.ok) return 'ok';
      if (res.status < 500) return 'client_error'; // 4xx → deterministic, stop
      // 5xx → fall through to the one retry
    } catch {
      if (signal.aborted) return 'aborted'; // superseded / timed out
      // network error → fall through to the one retry
    }
  }
  return 'failed';
}
```

- [ ] **Step 4: Run — verify all pass**

Run: `pnpm test tests/unit/components/shell/locale-persist.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck` → no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/shell/locale-persist.ts tests/unit/components/shell/locale-persist.test.ts
git commit -m "feat(i18n): runPreferredLocalePersist retry/abort policy"
```

---

## Task 4: `LocaleSwitcher` — `persistToAccount` wiring

Wire the opt-in prop to the persist policy with an abort-previous ref + timeout,
warn on `'failed'`, and update the now-stale file-header comment.

**Files:**
- Modify: `src/components/shell/locale-switcher.tsx`
- Test: `tests/unit/components/shell/locale-switcher.test.tsx` (extend)

**Interfaces:**
- Consumes: `runPreferredLocalePersist` (Task 3).
- Produces: `LocaleSwitcher` accepts `{ className?: string; persistToAccount?: boolean }`.

- [ ] **Step 1: Write the failing tests (extend the existing file)**

At the TOP of `tests/unit/components/shell/locale-switcher.test.tsx`, after the existing `vi.mock('next/navigation', …)` block, add:

```ts
vi.mock('@/components/shell/locale-persist', () => ({
  runPreferredLocalePersist: vi.fn(),
}));
```

Add to the import list:

```ts
import { waitFor } from '@testing-library/react';
import { runPreferredLocalePersist } from '@/components/shell/locale-persist';
```

Add below the existing `renderSwitcher` helper:

```ts
const persistMock = vi.mocked(runPreferredLocalePersist);

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
    persistMock.mockReset();
    persistMock.mockResolvedValue('ok');
    document.cookie = 'NEXT_LOCALE=; path=/; max-age=0';
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    cleanup();
    vi.useFakeTimers();
  });

  it('runs the persist policy with the chosen locale + an AbortSignal', async () => {
    renderWithPersist('en');
    await pickThai();
    await waitFor(() => expect(persistMock).toHaveBeenCalledTimes(1));
    expect(persistMock).toHaveBeenCalledWith('th', expect.any(AbortSignal));
  });

  it('warns once when the persist outcome is "failed"', async () => {
    persistMock.mockResolvedValue('failed');
    renderWithPersist('en');
    await pickThai();
    await waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
  });

  it('does not warn on a non-failed outcome (client_error)', async () => {
    persistMock.mockResolvedValue('client_error');
    renderWithPersist('en');
    await pickThai();
    await waitFor(() => expect(persistMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not persist when persistToAccount is absent (default cookie-only)', async () => {
    renderSwitcher('en'); // no persistToAccount
    await pickThai();
    await new Promise((r) => setTimeout(r, 30));
    expect(persistMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — verify the 4 new tests fail**

Run: `pnpm test tests/unit/components/shell/locale-switcher.test.tsx`
Expected: the 4 new tests FAIL (prop ignored, `persistMock` never called); the original 4 still pass.

- [ ] **Step 3: Implement the wiring**

In `src/components/shell/locale-switcher.tsx`:

**(a)** Change the React import to add `useRef`:

```ts
import { useRef, useTransition } from 'react';
```

**(b)** Add after the `@/lib/utils` import:

```ts
import { runPreferredLocalePersist } from '@/components/shell/locale-persist';
```

**(c)** Add a module-level const after the imports (before the component):

```ts
/** Abort a stuck preferred-locale sync after this long (captive-portal guard). */
const PERSIST_TIMEOUT_MS = 8000;
```

**(d)** Update the file-header comment: replace the sentence

```
 * Client-only, mirroring `ThemeToggle`. It does NOT touch
 * member `preferred_locale` (email language) — that stays an Account-settings
 * preference (see the design doc).
```

with

```
 * Client-only, mirroring `ThemeToggle`. By default it is cookie-only; when
 * `persistToAccount` is set (member portal), it ALSO best-effort persists the
 * choice to `members.preferred_locale` (email language) via
 * `runPreferredLocalePersist`. Staff/auth stay cookie-only.
```

**(e)** Change the signature to accept the prop:

```ts
export function LocaleSwitcher({
  className,
  persistToAccount = false,
}: {
  readonly className?: string;
  readonly persistToAccount?: boolean;
} = {}) {
```

**(f)** Add the abort ref after the `useTransition` line:

```ts
  const syncAbortRef = useRef<AbortController | null>(null);
```

**(g)** Add the persist wiring between the ref and `handleValueChange`:

```ts
  // Best-effort background write of preferred_locale for logged-in members.
  // Detached: never blocks the cookie-driven UI refresh. INVARIANT: no setState
  // / no toast here — only console.warn on a hard failure (a state update after
  // router.refresh() would be an orphaned-update bug). Abort-previous: a newer
  // pick supersedes an in-flight sync so a stale retry can't land out of order.
  const persistPreferredLocale = (locale: Locale): void => {
    syncAbortRef.current?.abort();
    const controller = new AbortController();
    syncAbortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), PERSIST_TIMEOUT_MS);
    void runPreferredLocalePersist(locale, controller.signal)
      .then((outcome) => {
        if (outcome === 'failed') {
          console.warn('[LocaleSwitcher] preferred_locale sync failed');
        }
      })
      .finally(() => clearTimeout(timer));
  };
```

**(h)** In `handleValueChange`, fire the persist after the cookie write, before the refresh:

```ts
    document.cookie = `${LOCALE_COOKIE_NAME}=${value}; path=/; max-age=31536000; samesite=lax`;
    if (persistToAccount) persistPreferredLocale(value); // value is Locale (isLocale guard above)
    startTransition(() => router.refresh());
```

- [ ] **Step 4: Run — verify all pass**

Run: `pnpm test tests/unit/components/shell/locale-switcher.test.tsx`
Expected: PASS (4 original + 4 new = 8).

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint` → no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/shell/locale-switcher.tsx tests/unit/components/shell/locale-switcher.test.tsx
git commit -m "feat(i18n): LocaleSwitcher persistToAccount wiring + abort ref"
```

---

## Task 5: Wire `persistToAccount` in the member layout

**Files:**
- Modify: `src/app/(member)/portal/layout.tsx` (the always-visible switcher, ~line 93)

- [ ] **Step 1: Pass the prop**

Change:

```tsx
            <LocaleSwitcher />
```

to:

```tsx
            <LocaleSwitcher persistToAccount />
```

(Staff layout + the 7 auth pages keep `<LocaleSwitcher />` → `persistToAccount` defaults `false`.)

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint` → no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(member)/portal/layout.tsx"
git commit -m "feat(i18n): member portal switcher persists preferred_locale"
```

---

## Task 6: E2E — member persists, staff does not

**Files:**
- Modify: `tests/e2e/locale-switcher.spec.ts`

**Interfaces:**
- Consumes: the existing `signIn(page, email, password, portal)` + `chooseLanguage(page, optionName)` helpers and the `ADMIN_*` / `MEMBER_*` env consts already in the spec.

- [ ] **Step 1: Add the two tests**

Inside the existing `test.describe('LocaleSwitcher @i18n', …)` block, add:

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

- [ ] **Step 2: Validate statically (live run deferred / done by controller)**

Run: `pnpm typecheck && pnpm test:e2e --grep "LocaleSwitcher" --list`
Expected: typecheck clean; `--list` collects the now-**5** tests × 3 projects with no compile/collection error.

> Do NOT attempt a live run that touches :3100 (the operator's dev server). The
> controller may run it live against a throwaway :3101 worktree server.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/locale-switcher.spec.ts
git commit -m "test(i18n): e2e — member persists preferred_locale, staff does not"
```

---

## Final verification (before opening the PR)

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- [ ] `git grep -n "fetch('/api/portal/preferred-locale'" src` returns **nothing** (all consumers go through the transport / the const).
- [ ] E2E live (controller, via a :3101 worktree server — never :3100): `pnpm exec playwright test --config=<:3101-override> --grep "LocaleSwitcher" --project=chromium --workers=1`.
- [ ] Open PR off `main`.
