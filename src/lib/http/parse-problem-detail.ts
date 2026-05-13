/**
 * `parseProblemDetail` — extract RFC 7807 `detail` from a non-2xx
 * Response. Falls back to the supplied fallback string when the
 * response body is missing, malformed, or has no `detail` field.
 *
 * Round 2 simplifier P1 (2026-05-13) — extracted from three F6 UI
 * handlers (`webhook-config-wizard`, `rotate-secret-dialog`,
 * `test-webhook-button`) that each carried an identical 9-11 line
 * ladder doing the same defensive parse + type-guard. Centralising
 * here also fixes the implicit "preserve the response body" contract
 * via `res.clone()` so callers can still consume the original stream.
 *
 * Behaviour:
 *   - `res.clone()` to preserve the original body for downstream use
 *   - `.json().catch(() => null)` — never throws
 *   - Type-guard `typeof detail === 'string' && detail.length > 0`
 *   - Otherwise returns `fallback` verbatim
 *
 * Caller responsibility: pass an i18n-translated fallback string so
 * the UI never surfaces an English-only "Server error" to TH/SV
 * locales when the route fails to emit `detail` (defence-in-depth
 * for routes that don't yet ship a problem-body).
 */
export async function parseProblemDetail(
  res: Response,
  fallback: string,
): Promise<string> {
  const problem = await res
    .clone()
    .json()
    .catch(() => null);
  if (problem && typeof problem === 'object' && 'detail' in problem) {
    const detail = (problem as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.length > 0) return detail;
  }
  return fallback;
}
