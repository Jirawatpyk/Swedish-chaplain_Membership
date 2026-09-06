/**
 * 108 PR-C T077 (FR-022a, US3 AS9) — the success-toast description after a
 * broadcast submit, shared by the member compose form and the admin proxy
 * form.
 *
 * The submit response carries `recipientPreferenceExcluded`: how many
 * entries the resolver removed "by recipient preference" (a per-contact
 * opt-out on any segment; plus an unsubscribed address on a custom list or
 * the attendee segment). The sender is told the NUMBER — never which
 * addresses, never why beyond "recipient preference" (spec edge case
 * "Opted-out contact on a custom list").
 *
 * Pure so it is unit-testable in jsdom: the forms cannot be driven to a
 * submit without a live Tiptap editor. Defensive on the field: an older
 * server, a malformed body or a negative number all fall back to the plain
 * hint — a toast must never read "NaN addresses".
 */
export interface SubmitFeedbackBody {
  readonly recipientPreferenceExcluded?: unknown;
}

export interface SubmitFeedbackOptions<K extends string> {
  /**
   * Key of the line that always follows (the member form's review-SLA hint).
   * `null` = no trailing line (the admin proxy toast has none), in which case
   * the description is `undefined` at zero exclusions.
   */
  readonly hintKey?: K | null;
  /** Key of the "{count} excluded by recipient preference" line. */
  readonly countKey?: K;
}

/**
 * 108 PR-C T085 (FR-041 / FR-042) — interpolation values for a submit error.
 * The "audience too large" copy names the ceiling the server actually refused
 * against (`details.cap` on the 422 body — 5,000 or 50,000 depending on the
 * batching flag), so the message can never claim a limit the server did not
 * apply. Returns `undefined` for every other code, or when the body carries
 * no usable cap (an older server): the caller then renders the key without
 * values, which is the pre-108 behaviour.
 */
export function errorValues(
  code: string,
  details: Record<string, unknown> | undefined,
): Record<string, number> | undefined {
  if (code !== 'broadcast_audience_too_large') return undefined;
  const cap = details?.['cap'];
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap <= 0) return undefined;
  return { ceiling: cap };
}

export function excludedByPreference(body: SubmitFeedbackBody): number {
  const n = body.recipientPreferenceExcluded;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
}

export function submitSuccessDescription<K extends string>(
  t: (key: K, values?: Record<string, number>) => string,
  body: SubmitFeedbackBody,
  opts: SubmitFeedbackOptions<K> = {},
): string | undefined {
  const hintKey = opts.hintKey === undefined ? ('toast.submittedSlaHint' as K) : opts.hintKey;
  const countKey = opts.countKey ?? ('toast.preferenceExcluded' as K);
  const count = excludedByPreference(body);
  // Resolved in reading order: the preference line first, then the hint.
  const line = count === 0 ? undefined : t(countKey, { count });
  const hint = hintKey === null ? undefined : t(hintKey);
  if (line === undefined) return hint;
  return hint === undefined ? line : `${line} ${hint}`;
}
