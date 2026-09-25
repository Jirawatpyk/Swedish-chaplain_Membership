/**
 * F119 PR-A — which staff sentence a `failed_to_dispatch` E-Blast reads.
 *
 * `broadcasts.failure_reason` is free text by design: most writers store a
 * bounded token (`member_halted`, `audience_import_stuck`, …), but the legacy
 * dispatch leg stores two COMPOSITES (`retry_budget_exhausted_after_1h:<sub>:<msg>`
 * and `resend_resource_missing:<type>`) and, on its permanent arm, the
 * provider's own message. So the stored value is a lookup hint, never display
 * text: the part before the first `:` is the token, and anything that is not a
 * plain token answers `null`. The caller looks the token up under
 * `admin.broadcasts.review.failureReason` and falls back to `generic` when it
 * is `null` or has no sentence (`t.has`) — so the raw value never reaches the
 * page, and a provider message (which can echo an address) is never shown.
 *
 * The retry-budget composite's prefix, `retry_budget_exhausted_after_1h`, is
 * folded onto the import leg's `retry_budget_exhausted` token so both legs read
 * the same sentence for the same cause.
 */

const TOKEN = /^[a-z0-9_]+$/;

/** Stored prefixes that name the same cause as an existing token. */
const PREFIX_ALIASES: ReadonlyMap<string, string> = new Map([
  ['retry_budget_exhausted_after_1h', 'retry_budget_exhausted'],
]);

/** The reason token a stored `failure_reason` names, or `null` when it names none. */
export function failureReasonToken(stored: string | null): string | null {
  const prefix = (stored ?? '').split(':')[0] ?? '';
  const token = PREFIX_ALIASES.get(prefix) ?? prefix;
  return TOKEN.test(token) ? token : null;
}
