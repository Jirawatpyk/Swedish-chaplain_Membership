/**
 * URL-scheme safety helpers for user-supplied `website` values.
 *
 * Why this exists: zod's `.url()` accepts ANY scheme that `new URL()` can
 * parse — including `javascript:` and `data:` — so a value that passed
 * validation can still be a stored-XSS payload the moment it is rendered as
 * an `<a href>`. A member can even reach the sink without the form: the
 * portal self-update PATCH accepts `website` as a plain bounded string, so a
 * forged `website: "javascript:…"` is stored and later executes in a staff
 * user's origin when an admin clicks the member's website link.
 *
 * Defence-in-depth:
 *   - `safeExternalHref` at every `<a href>` sink is the DEFINITIVE guard —
 *     an allowlist that emits an href only for absolute http(s) URLs, so no
 *     stored value (however it got there, including obfuscations like
 *     `java\tscript:` that browsers normalise) can ever become a live link.
 *   - `hasDangerousUrlScheme` at the write boundaries rejects the obvious
 *     hostile schemes early with a clear error, while still allowing http(s)
 *     and scheme-less input.
 *
 * Pure module — no framework imports — so it is importable from presentation,
 * application use-case schemas, and the import scripts alike.
 */

/** True iff `value` is an absolute http(s) URL (after trimming surrounding space). */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/**
 * True iff `value` begins with a scheme known to execute or smuggle content
 * when placed in an `href`/`src` (`javascript:`, `data:`, `vbscript:`,
 * `file:`). Leading whitespace is tolerated because browsers ignore it before
 * scheme resolution. Best-effort early rejection only — `safeExternalHref` is
 * the guarantee at the render sink.
 */
export function hasDangerousUrlScheme(value: string): boolean {
  return /^\s*(javascript|data|vbscript|file):/i.test(value);
}

/**
 * Returns `url` only when it is a safe external link (absolute http/https),
 * otherwise `undefined` — so an `<a href>` sink never emits `javascript:` /
 * `data:` / a scheme-relative or relative URL. When this returns `undefined`,
 * render the raw value as escaped text (not a link) rather than a broken or
 * dangerous anchor.
 */
export function safeExternalHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  return isHttpUrl(trimmed) ? trimmed : undefined;
}
