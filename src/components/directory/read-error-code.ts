/**
 * F9 US5 — shared client helper to read the `{ error: { code } }` code from a
 * non-OK directory API response. Generic over the code union so each call site
 * keeps its exact typed code (e.g. `UpdateDirectoryListingError`) rather than a
 * bare `string`. A malformed/empty body resolves to `undefined` (the caller
 * then falls back to a generic toast).
 *
 * CONTRACT: the returned value is an UNCHECKED assertion — the body is untrusted
 * JSON, so an out-of-union `code` would be typed as `C` without validation. Only
 * `===`-compare it against known literals (every call site has a generic-toast
 * fallback for the no-match case); do NOT exhaustive-`switch` or index a `Record`
 * with it.
 */
export async function readErrorCode<C extends string = string>(
  res: Response,
): Promise<C | undefined> {
  return res
    .json()
    .then((b: { error?: { code?: C } }) => b?.error?.code)
    .catch(() => undefined);
}
