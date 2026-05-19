/**
 * Shared `fetch()` wrapper for admin client-side POST calls.
 *
 * Round 3 simplifier S-H3 — collapses the 11-line
 * `Content-Type + Idempotency-Key + body` block that
 * `webhook-config-wizard`, `rotate-secret-dialog`, and
 * `test-webhook-button` each carried verbatim. Co-locates with
 * `parseProblemDetail` + `parseRetryAfterSeconds` under
 * `src/lib/http/`.
 */
export async function adminPost(
  path: string,
  body: unknown = {},
): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
}
