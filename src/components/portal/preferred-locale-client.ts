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
