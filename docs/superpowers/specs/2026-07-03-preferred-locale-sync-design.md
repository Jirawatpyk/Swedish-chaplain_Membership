# Sync `preferred_locale` on member language switch — Design

**Date:** 2026-07-03
**Branch:** `worktree-preferred-locale-sync` (off `main` @ `f3082a1a`, the merged language switcher PR #146)
**Status:** Approved (brainstorming) — revised after specialist review (reliability / security / component-arch)

## Problem

PR #146 shipped a **cookie-only** language switcher: picking a locale writes the
`NEXT_LOCALE` cookie + `router.refresh()`. It deliberately did NOT touch a
member's `preferred_locale` — the per-member column (set in Account settings)
that drives **email / broadcast** language. Result: a logged-in member who
switches the UI to Thai still gets English emails, and their choice does not
follow them to another device/browser (the cookie is per-browser).

This follow-up closes that gap **for logged-in members only**.

## Goal

When a **logged-in member** changes the UI language via the header switcher,
also persist that locale to `members.preferred_locale`, so their UI language,
email language, and cross-device preference stay consistent — without changing
the cookie-only behavior on staff or the pre-login auth pages (which have no
`preferred_locale`).

Non-goals (YAGNI): changing the switcher on staff/auth surfaces; loading the
current `preferred_locale` into the switcher; a "revert to tenant default"
(null) path from the switcher (stays in the Account form); any **behavioral**
change to `/api/portal/preferred-locale` or the Account form (a mechanical
refactor of the form onto a shared transport helper IS in scope — see below).

## Existing endpoint (reused as-is)

`PATCH /api/portal/preferred-locale` (`src/app/api/portal/preferred-locale/route.ts`):

- Body: `{ preferredLocale: 'en' | 'th' | 'sv' | null }`.
- **Member-only** via `requireMemberContext` — 401 no session, 403 non-member,
  404 no linked member. Member resolved from the session (no `memberId` in the
  URL → no IDOR). The `persistToAccount` prop is only an optimization to avoid
  the call on staff/auth; the **endpoint** is the real authz boundary.
- **Idempotent** — same value → `200 {outcome:'unchanged'}` (no UPDATE, no
  audit); a real change → UPDATE + one audit event (`member_self_service`),
  all inside one `runInTenant` transaction.

The switcher only ever selects a concrete locale, so it always PATCHes
`'en' | 'th' | 'sv'` (never `null`; type-enforced — `Locale` excludes `null`).

### Security dependencies (callout — no code change needed, but do not regress)

- **CSRF**: `/api/portal/preferred-locale` sits under `/api/*` and is covered by
  the existing Origin allow-list in `src/proxy.ts` (`checkCsrf`) — a state-
  changing PATCH from a cross-origin attacker gets `origin-not-allowed` 403.
  `credentials: 'same-origin'` is correct. A future `proxy.ts` matcher /
  `EXEMPT_PATH_PREFIXES` refactor must not drop `/api/portal/*`.
- **Kill-switch**: the endpoint is behind `FEATURE_F3_MEMBERS`; if F3 is off the
  PATCH returns 503 → swallowed by the best-effort path (behavioral note, not a
  security issue).
- **Rate limiting (accepted pre-existing risk)**: the endpoint has **no** rate
  limit; the switcher's client guards are not a server control. An authenticated
  member could script rapid real changes → self-inflicted audit-log growth (one
  member, single-tenant, RLS-isolated, ~131 members). We are **not** modifying
  the endpoint in this follow-up, so this is accepted as-is; a light per-user
  limit on the endpoint is a separate backlog item.

## Approach

### Shared transport helper (new) — `src/components/portal/preferred-locale-client.ts`

Extract the endpoint's URL + request shape into ONE thin, exported transport so
neither the shared shell `LocaleSwitcher` nor the Account form hardcodes /
duplicates the member route:

```ts
export const PREFERRED_LOCALE_ENDPOINT = '/api/portal/preferred-locale';
export type PreferredLocale = 'en' | 'th' | 'sv' | null;

/** PATCH the member's preferred locale. Returns the raw Response so each
 *  caller applies its own policy (retry vs toast). Throws only on network
 *  error / abort — callers catch. */
export function updatePreferredLocale(
  preferredLocale: PreferredLocale,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(PREFERRED_LOCALE_ENDPOINT, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preferredLocale }),
    ...(signal ? { signal } : {}),
  });
}
```

- **`LocaleSwitcher`** (persist branch) calls it and keeps **its own** retry +
  abort policy (below).
- **`PreferredLocaleForm`** (`src/components/portal/preferred-locale-form.tsx`):
  its submit `fetch` is swapped for `updatePreferredLocale(value)` (keeps its own
  toast/announce, UX unchanged); its mount GET uses the `PREFERRED_LOCALE_ENDPOINT`
  const for the URL (drop the last magic-string copy). No behavioral change.

Transport owns URL/method/body; **policy stays at each call site**.

### `LocaleSwitcher` — new opt-in prop `persistToAccount?: boolean` (default `false`)

`src/components/shell/locale-switcher.tsx`. When `true`, after writing the
cookie (and alongside `router.refresh()`), fire a best-effort persist. Default
`false` keeps staff + auth placements byte-for-byte as they ship today.

```ts
if (persistToAccount) persistPreferredLocale(value); // value is Locale here (after isLocale guard)
startTransition(() => router.refresh());
```

`persistPreferredLocale` is a small in-component function (not exported). It is
**not awaited** — a detached background write that never blocks the visible
refresh (the UI already switched via the cookie).

**INVARIANT (comment it):** the detached persist path must do **no** `setState`
and **no** `toast` — only `console.warn`. A state update / toast fired from a
promise that resolves after `router.refresh()` is an orphaned-update bug. This
is also why there is no failure toast.

### Error handling — abort-previous, bounded timeout, retry-once (5xx/network only)

Two problems the naive fire-and-forget has, both fixed here:

1. **Out-of-order writes (the race the feature must not create).** A detached
   PATCH+retry can outlive its `router.refresh()` transition. On a slow link:
   select TH (retry pending) → refresh done → select EN → the stale TH write
   lands **after** EN → DB=`th` while UI/cookie=`en`, plus a misleading audit
   trail — exactly the divergence this feature exists to remove. **Fix:** hold
   the in-flight sync's `AbortController` in a `useRef`; each new selection
   `abort()`s the previous one before starting its own, so a superseded sync
   stops retrying and does not re-commit a stale value. (`useRef` identity
   survives the soft `router.refresh()` re-render.)
2. **Unbounded await.** A hung request (captive portal) would never reach the
   retry. **Fix:** bound each sync with a timeout that aborts it (~8s), via a
   `setTimeout(() => ac.abort(), …)` cleared on completion (broad browser
   compat; avoids `AbortSignal.timeout`/`any` support questions — the plan pins
   the exact form).

Shape:

```ts
const syncAbortRef = useRef<AbortController | null>(null);

function persistPreferredLocale(locale: Locale): void {
  syncAbortRef.current?.abort();           // supersede any older in-flight sync
  const ac = new AbortController();
  syncAbortRef.current = ac;
  void (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {   // one retry
      try {
        const res = await updatePreferredLocale(locale, ac.signal);
        if (res.ok || res.status < 500) return;       // ok, or deterministic 4xx → stop
        // 5xx → fall through to retry
      } catch {
        if (ac.signal.aborted) return;                // superseded / timed out
        // network error → fall through to retry
      }
    }
    console.warn('[LocaleSwitcher] preferred_locale sync failed');
  })();
}
```

- **Retry only on 5xx / network** — a 4xx (403/400/404) is deterministic;
  retrying it is guaranteed-wasted work (and 403 is exactly what a stray
  non-member call would get).
- **Silent to the member** (only `console.warn`) — deliberate. Consequence
  (accepted): if both attempts fail, the UI is correct (cookie) but the account/
  email language stays stale, **permanently and undetectably by the member**,
  until their next explicit save in Account settings. Best-effort by design;
  the Account form is the reliable, feedback-carrying path.
- **Residual limitation (documented, not further engineered):** abort-previous
  removes the common client-side race, but cannot guarantee server-side commit
  ordering if a superseded PATCH already reached the server. Acceptable for a
  best-effort preference; true ordering would need server sequencing (out of
  scope).

### Placement — member portal layout only

`src/app/(member)/portal/layout.tsx` (a Server Component guarded by
`requireSession('member')`, so the user is always a member) renders:

```tsx
<LocaleSwitcher persistToAccount />
```

A boolean literal is the correct prop shape here (NOT a callback): the layout is
a Server Component and cannot pass a non-serializable function across the RSC
boundary. Staff layout + the 7 auth pages pass nothing → `persistToAccount`
defaults `false` → unchanged. (First surface-mode boolean on the switcher; if
more accrete later, revisit toward a `MemberLocaleSwitcher` wrapper — YAGNI at
N=1.)

## Testing

### Unit — `tests/unit/components/shell/locale-switcher.test.tsx` (extend)

Mock the transport (`updatePreferredLocale`) or `fetch`. New cases (throw-paths
explicitly, per project discipline that mock-only suites miss them):
- With `persistToAccount`, selecting `'ไทย'` calls the transport once with
  `'th'`.
- **Recovery**: 1st attempt 500, 2nd ok → exactly 2 calls, **no** `console.warn`.
- **Both fail** (network reject ×2) → the detached call **resolves, never
  rejects** (no unhandled rejection from the `void` call) and `console.warn`
  fires exactly once (spy).
- **4xx no-retry**: 403 → exactly **1** call, no retry, no throw.
- **Superseded**: two rapid selections → the first sync is aborted (assert via
  the abort spy / that the stale value is not the last call to land).
- **Default off**: without `persistToAccount`, selecting a locale makes **no**
  transport/`fetch` call (staff/auth behavior preserved).

The existing 4 tests (cookie write, `aria-checked`, no-op re-select, endonym
trigger) stay green (default renders → no persist).

### Unit — transport helper (small)
`updatePreferredLocale('th')` issues a PATCH to `PREFERRED_LOCALE_ENDPOINT` with
body `{preferredLocale:'th'}` and `credentials:'same-origin'`; passes through an
`AbortSignal`.

### E2E — `tests/e2e/locale-switcher.spec.ts` (extend)
- **Member portal**: after member sign-in + language switch, assert
  `PATCH /api/portal/preferred-locale` fires (`page.waitForRequest`). No DB
  assertion (endpoint has its own contract tests).
- **Staff header**: switching fires **no** `preferred-locale` request (guards
  the opt-in boundary). `--workers=1`, serial, existing gating.

## Process / rollout

- Additive; no DB/migration, no new dependency, no new endpoint, no feature
  flag (default `false` = today's behavior).
- Presentation-only (Constitution III): the switcher + transport call an
  existing HTTP endpoint; neither imports `src/modules/*`.
- Touched files: new `preferred-locale-client.ts`; `locale-switcher.tsx`
  (+prop, +ref, +helper); `preferred-locale-form.tsx` (use the shared
  transport, no behavior change); `portal/layout.tsx` (pass the prop); unit +
  e2e tests.
- Ships as an independent PR off `main`.
