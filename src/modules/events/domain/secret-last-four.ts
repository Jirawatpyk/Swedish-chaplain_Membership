/**
 * `SecretLastFour` — branded 4-character substring of a webhook secret
 * for masked display + audit payload use.
 *
 * Round-6 verify-fix 2026-05-13 (code-review #5 + #10 + type-design
 * C8) — replaces two duplicated `lastFour()` helpers (one in
 * `generate-webhook-secret.ts`, one in `rotate-webhook-secret.ts`) and
 * brands the return type so audit payloads can no longer accept a
 * "last 3" or "last 5" string by accident. Smart-constructor enforces
 * `length === 4`; production webhook secrets are always 32-byte
 * base64url (≥40 chars), so this invariant holds trivially.
 *
 * Pure Domain — no framework imports (Constitution Principle III).
 */
export type SecretLastFour = string & { readonly __brand: 'SecretLastFour' };

/**
 * Extract the last 4 characters of a webhook secret. Throws if the
 * input is shorter than 4 characters (programming error — production
 * secrets are always ≥40 chars; test fixtures must mint ≥4-char
 * secrets, which is trivially satisfied by all current fixtures).
 *
 * Throwing instead of silently slicing a shorter prefix prevents a
 * subtle regression class where a refactor shortens the secret factory
 * to 2 chars and the audit `secretLastFour` field silently becomes
 * 2 chars — an SRE dashboard pinned to "last 4 chars" would fail
 * exact-string matches without surfacing the cause.
 */
export function asSecretLastFour(secret: string): SecretLastFour {
  if (secret.length < 4) {
    throw new Error(
      `asSecretLastFour: secret must be ≥4 chars, got ${secret.length}`,
    );
  }
  return secret.slice(-4) as SecretLastFour;
}
