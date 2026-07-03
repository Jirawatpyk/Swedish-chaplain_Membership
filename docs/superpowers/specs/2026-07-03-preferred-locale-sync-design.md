# Sync `preferred_locale` on member language switch — Design

**Date:** 2026-07-03
**Branch:** `worktree-preferred-locale-sync` (off `main` @ `f3082a1a`, the merged language switcher PR #146)
**Status:** Approved (brainstorming) — ready for implementation plan

## Problem

PR #146 shipped a **cookie-only** language switcher: picking a locale writes the
`NEXT_LOCALE` cookie + `router.refresh()`. It deliberately did NOT touch a
member's `preferred_locale` — the per-member column (set in Account settings)
that drives **email / broadcast** language. Result: a logged-in member who
switches the UI to Thai still gets English emails, and their choice does not
follow them to another device/browser (the cookie is per-browser).

This follow-up closes that gap **for logged-in members only**: switching the UI
language also persists it to their account.

## Goal

When a **logged-in member** changes the UI language via the header switcher,
also persist that locale to `members.preferred_locale`, so their UI language,
email language, and cross-device preference stay consistent — without changing
the cookie-only behavior anywhere else (staff, and the pre-login auth pages,
have no `preferred_locale` and stay cookie-only).

Non-goals (YAGNI): changing the switcher on staff/auth surfaces; loading the
current `preferred_locale` into the switcher; a "revert to tenant default"
(null) path from the switcher (that stays in the Account form); any change to
the existing `/api/portal/preferred-locale` endpoint or the Account form.

## Existing endpoint (reused as-is)

`PATCH /api/portal/preferred-locale` (`src/app/api/portal/preferred-locale/route.ts`):

- Body: `{ preferredLocale: 'en' | 'th' | 'sv' | null }`.
- **Member-only** — resolves the member from the session via
  `requireMemberContext` (no `memberId` in the URL → no IDOR); admin/manager
  get 403.
- **Idempotent** — same value → `200 {outcome: 'unchanged'}`; a real change →
  `200 {outcome: ...}` and **emits one audit event** (`member_self_service`
  actor). No audit noise on no-op.

The switcher only ever selects a concrete locale, so it always PATCHes
`'en' | 'th' | 'sv'` (never `null`).

## Approach

### `LocaleSwitcher` — new opt-in prop `persistToAccount?: boolean` (default `false`)

`src/components/shell/locale-switcher.tsx`. When `persistToAccount` is `true`,
after writing the cookie (and alongside `router.refresh()`), fire a
**best-effort** PATCH to `/api/portal/preferred-locale` with the selected
locale. Default `false` keeps staff + auth placements exactly as they ship
today (cookie-only, no network call).

Sketch (final code in the plan):

```ts
document.cookie = `${LOCALE_COOKIE_NAME}=${value}; path=/; max-age=31536000; samesite=lax`;
if (persistToAccount) void persistPreferredLocale(value);
startTransition(() => router.refresh());
```

`persistPreferredLocale` is a small helper (module-scope in the same file, not
exported) that is **not awaited** — it runs in parallel with the refresh and
never blocks the UI, which has already switched via the cookie.

### Error handling — retry once, then silent

```ts
async function persistPreferredLocale(locale: Locale): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('/api/portal/preferred-locale', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preferredLocale: locale }),
      });
      if (res.ok) return;
    } catch { /* fall through to retry / give up */ }
  }
  // Both attempts failed. The UI already switched via the cookie; the account
  // preference (email language) just didn't update. Non-critical — log only,
  // no toast (a failure toast next to a successful language change is
  // confusing, and Account settings remains the explicit path).
  console.warn('[LocaleSwitcher] preferred_locale sync failed');
}
```

- **One retry** (two total attempts): absorbs a transient blip without adding a
  backoff loop (Constitution X — Simplicity).
- No toast on failure; no `useTransition`/pending coupling — this is a detached
  background write, independent of the visible refresh.
- A 403 (would only happen if a non-member somehow rendered `persistToAccount`)
  is a non-`ok` response → swallowed the same way. Defence-in-depth only; the
  prop is passed only from the member layout.

### Placement — member portal layout only

`src/app/(member)/portal/layout.tsx` renders the member header, guarded by
`requireSession('member')`, so the user is always a member there. Change:

```tsx
<LocaleSwitcher persistToAccount />
```

Staff layout + the 7 auth pages pass nothing → `persistToAccount` defaults
`false` → unchanged cookie-only behavior.

### Why always-PATCH (no pre-read)

The switcher does not load the current `preferred_locale` before deciding to
PATCH. It doesn't need to: the endpoint is idempotent (no-op + no audit on an
unchanged value), and the switcher's existing guards
(`isPending || value === activeLocale` early-return) already prevent duplicate
and no-op fires. Fetching first would add a round-trip and a waterfall for no
benefit.

## Testing

### Unit — `tests/unit/components/shell/locale-switcher.test.tsx` (extend)

Mock `fetch`. New cases:
- With `persistToAccount`, selecting `'ไทย'` fires `PATCH
  /api/portal/preferred-locale` with body `{ preferredLocale: 'th' }` (once).
- With `persistToAccount`, if the first `fetch` rejects/returns non-ok, it
  **retries once** (two `fetch` calls total), then stops (no throw).
- **Without** `persistToAccount` (the default), selecting a locale makes **no**
  `fetch` call — the existing staff/auth behavior is preserved.

The existing 4 tests (cookie write, radio `aria-checked`, no-op re-select,
endonym trigger) stay green: they render the default (`persistToAccount`
absent) so no `fetch` is involved.

### E2E — `tests/e2e/locale-switcher.spec.ts` (extend)

- **Member portal**: after signing in as a member and switching language,
  assert the `PATCH /api/portal/preferred-locale` request fires
  (`page.waitForRequest`, matching method + URL). No DB assertion needed — the
  endpoint's persistence is already covered by its contract tests.
- **Staff header**: switching language fires **no** `preferred-locale` request
  (guards the opt-in boundary). Assert via a short negative check (no matching
  request within a small window).

Gated on the existing `E2E_ADMIN_*` / `E2E_MEMBER_*` env vars; `--workers=1`,
serial, per project convention.

## Process / rollout

- Small, additive UI change. No DB/migration, no new dependency, no new
  endpoint, no feature flag — additive and safe (default `false` = today's
  behavior).
- Presentation-only (Constitution III): the switcher already lives in
  presentation and calls an existing HTTP endpoint; it does not import
  `src/modules/*`.
- Touched files: `locale-switcher.tsx` (+ prop + helper), `portal/layout.tsx`
  (pass the prop), the unit test, the e2e spec.
- Ships as an independent PR off `main`.
