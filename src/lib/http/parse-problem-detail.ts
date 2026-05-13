/**
 * `parseProblemDetail` — extract RFC 7807 `detail` from a non-2xx
 * Response. Falls back to the supplied fallback string when the
 * response body is missing, malformed, or has no `detail` field.
 *
 * Round 2 simplifier P1 — centralises the 9-11 line ladder previously
 * duplicated across three F6 UI handlers. Co-located with
 * `problem-response.ts` (server side) and `admin-post.ts` /
 * `parse-retry-after.ts` (client side) under `src/lib/http/`.
 *
 * Round 3 M-err-3 — accepts a `surface` label and emits a single
 * `console.warn` when the response body is non-JSON or missing
 * `detail`. Captures `res.status` + `content-type` so DevTools shows
 * the upstream-returned-HTML pattern (Vercel 502, framework crash
 * before serialiser, etc.) without instrumenting every call site.
 *
 * Caller responsibility: pass an i18n-translated fallback so the UI
 * never surfaces an English-only "Server error" to TH/SV locales.
 */
export async function parseProblemDetail(
  res: Response,
  fallback: string,
  surface?: string,
): Promise<string> {
  const problem = await res
    .clone()
    .json()
    .catch(() => null);
  if (problem && typeof problem === 'object' && 'detail' in problem) {
    const detail = (problem as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.length > 0) return detail;
  }
  // Body was non-JSON or missing `detail`. Emit a forensic-only
  // breadcrumb so SREs see "server returned HTML instead of JSON"
  // without having to grep every call site.
  console.warn(
    '[chamber-os] parseProblemDetail fallback used',
    {
      surface: surface ?? 'unknown',
      status: res.status,
      contentType: res.headers.get('content-type'),
    },
  );
  return fallback;
}
