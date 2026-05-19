/**
 * Parse the `Retry-After` response header to an integer-seconds value.
 *
 * Round 3 simplifier S-M1 — consolidates the 6-line parser duplicated
 * across `rotate-secret-dialog` and `test-webhook-button` after the
 * round-2 SF-LOW8 fix added the header read.
 *
 * Returns `null` (not `NaN`) for:
 *   - missing header
 *   - non-numeric value (RFC 7231 HTTP-date form — see Round 3
 *     M-err-4 for the forensic-only warn below)
 *   - zero / negative integer
 *
 * Round 3 M-err-4 — emits a single `console.warn` when the header is
 * present but cannot be parsed as integer seconds. Catches future
 * infrastructure surprises (Vercel WAF / Cloudflare injecting HTTP
 * date form) so SREs can see the surprise without instrumenting the
 * server-side rate-limit emit logic.
 */
export function parseRetryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get('Retry-After');
  if (raw === null || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      '[chamber-os] Retry-After header present but not integer-seconds — falling back to generic copy',
      { raw, parsed: n },
    );
    return null;
  }
  return n;
}
