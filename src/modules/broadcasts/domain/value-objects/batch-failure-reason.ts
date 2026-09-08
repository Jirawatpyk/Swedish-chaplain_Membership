/**
 * Phase 9b (T130 / T139) — carrying a batch failure's CLASSIFICATION on the
 * existing free-text `batch_manifests.failure_reason` column.
 *
 * The gateway already distinguishes the two cases that matter:
 * `classifyResendError` throws a `GatewayThrowable` whose `kind` is
 * `'permanent'` (a 4xx — the request itself is unacceptable) or `'retryable'`
 * (429 / 5xx / network — the request was fine, the moment was not). That
 * distinction was thrown away at the boundary: `dispatchBroadcastBatch` caught
 * the throwable and persisted only `"${stage}: ${message}"`, so
 * `autoRetryFailedBatch` — which has a five-attempt budget — could not tell
 * them apart and re-queued everything.
 *
 * Five automatic retries of a 4xx cannot succeed by definition, and the
 * archetypal 4xx here is Resend refusing at the account contact cap (1,000 on
 * the Free plan). Each retry creates a fresh ephemeral audience and pushes a
 * full batch of contacts into it, so the retries consume the very resource
 * whose exhaustion caused the failure.
 *
 * **A prefix rather than a column.** `failure_reason` is already free text and
 * already truncated by its writer; a migration would buy a cleaner shape for a
 * value only two use cases exchange. The important property is the fallback:
 * an unparseable or absent reason answers `'unknown'`, and `'unknown'` is
 * treated as retryable, so every row written before this shipped keeps behaving
 * exactly as it did.
 *
 * Pure Domain — no imports. The gateway's error union lives on the Application
 * port; this takes the plain literal.
 */

/** How a batch failure should be treated by the retry machinery. */
export type BatchFailureKind = 'permanent' | 'retryable' | 'unknown';

const PREFIX_SEPARATOR = '/';

/**
 * Build the `failure_reason` value persisted on a failed batch manifest.
 *
 * Shape: `"<kind>/<stage>: <detail>"`, e.g.
 * `"permanent/addContactsToAudience: You have reached your contact limit"`.
 * The stage and the provider's own message both survive — they are what an
 * operator reads in the admin retry queue, and the prefix must not be bought
 * with them.
 *
 * Truncation stays with the caller, which knows the column's budget.
 */
export function formatBatchFailureReason(input: {
  readonly kind: 'permanent' | 'retryable';
  readonly stage: string;
  readonly detail: string;
}): string {
  return `${input.kind}${PREFIX_SEPARATOR}${input.stage}: ${input.detail}`;
}

/**
 * Read the classification back off a persisted `failure_reason`.
 *
 * Answers `'unknown'` for null, for anything written before Phase 9b, and for
 * anything that does not carry a recognised prefix. Callers MUST treat
 * `'unknown'` as retryable: an unclassified throw is not evidence of
 * permanence — a bug in our own code reaches the same catch block — and
 * treating it as permanent would strand every batch in flight at deploy time.
 */
export function parseBatchFailureKind(
  failureReason: string | null | undefined,
): BatchFailureKind {
  if (failureReason === null || failureReason === undefined) return 'unknown';
  const separatorAt = failureReason.indexOf(PREFIX_SEPARATOR);
  if (separatorAt <= 0) return 'unknown';
  const prefix = failureReason.slice(0, separatorAt);
  if (prefix === 'permanent') return 'permanent';
  if (prefix === 'retryable') return 'retryable';
  return 'unknown';
}
