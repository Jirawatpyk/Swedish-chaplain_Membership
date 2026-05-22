/**
 * T041 (F7.1a US1) — `BatchBoundary` Domain value object.
 *
 * Pure batch-split math for FR-001 + FR-002. Splits a recipient list
 * into N batches of ≤`perBatchCap` recipients each, preserving
 * recipient order and producing contiguous, gap-free ranges. The
 * default `perBatchCap` of 10,000 matches the Resend Broadcasts API
 * per-audience cap (research.md § 4).
 *
 * Invariants (enforced by T039 unit test):
 *   1. Sum of `recipients.length` across all batches = input.length
 *      (no recipient lost or duplicated)
 *   2. Every batch has `recipientRangeStart ≤ recipientRangeEnd`
 *   3. Batches are contiguous: batch[N+1].rangeStart = batch[N].rangeEnd + 1
 *   4. Last batch may be smaller than cap; all earlier batches are exactly cap
 *   5. No duplicate recipients ACROSS batches (input order preserved)
 *   6. batchIndex is 0-based, sequential, no gaps
 *   7. Empty input → 0 batches
 *   8. Input.length ≤ cap → exactly 1 batch
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */

export const RESEND_PER_AUDIENCE_CAP = 10_000 as const;

export interface BatchBoundary {
  readonly batchIndex: number;
  readonly recipientRangeStart: number;
  readonly recipientRangeEnd: number;
  readonly recipients: readonly string[];
}

/**
 * Split `recipients` into batches of ≤`perBatchCap`. The default cap
 * is `RESEND_PER_AUDIENCE_CAP` (10,000). Caller is responsible for
 * de-duplicating + ordering `recipients` before passing in — this fn
 * preserves whatever order the caller produced (members repo +
 * suppression filter already produce a deterministic order in F7 MVP).
 *
 * @throws never — for an empty input array returns an empty result.
 *   For `perBatchCap <= 0` returns an empty result (caller-bug protection
 *   to avoid infinite-loop risk; concurrency-cap policy at the
 *   Application boundary rejects cap < 1 with a typed error).
 */
export function splitIntoBatches(
  recipients: readonly string[],
  perBatchCap: number = RESEND_PER_AUDIENCE_CAP,
): readonly BatchBoundary[] {
  if (recipients.length === 0) return [];
  if (perBatchCap <= 0) return [];

  const batches: BatchBoundary[] = [];
  let batchIndex = 0;
  for (let start = 0; start < recipients.length; start += perBatchCap) {
    const end = Math.min(start + perBatchCap, recipients.length);
    batches.push({
      batchIndex,
      recipientRangeStart: start,
      recipientRangeEnd: end - 1,
      recipients: recipients.slice(start, end),
    });
    batchIndex += 1;
  }
  return batches;
}

/**
 * Count-only range shape — for use cases that need batch BOUNDARIES
 * but not the actual recipient list (e.g., `splitBroadcastIntoBatches`
 * use case creates batch_manifest rows that store only ranges + count;
 * the actual recipient list materialises later at dispatch time when
 * `dispatchBroadcastBatch` calls Resend Broadcasts API per batch).
 */
export interface BatchRange {
  readonly batchIndex: number;
  readonly recipientRangeStart: number;
  readonly recipientRangeEnd: number;
  readonly recipientCount: number;
}

/**
 * Count-only variant of {@link splitIntoBatches} — returns just the
 * ranges without materialising the recipient slices. Suitable for
 * 50,000-recipient broadcasts where building a 50k-length array per
 * batch would waste memory.
 *
 * Same invariants as `splitIntoBatches` (contiguous, gap-free, last-
 * batch-smaller, 0-based sequential `batchIndex`).
 */
export function computeBatchRanges(
  recipientCount: number,
  perBatchCap: number = RESEND_PER_AUDIENCE_CAP,
): readonly BatchRange[] {
  if (recipientCount === 0) return [];
  if (perBatchCap <= 0) return [];
  if (!Number.isInteger(recipientCount) || recipientCount < 0) return [];

  const ranges: BatchRange[] = [];
  let batchIndex = 0;
  for (let start = 0; start < recipientCount; start += perBatchCap) {
    const end = Math.min(start + perBatchCap, recipientCount);
    ranges.push({
      batchIndex,
      recipientRangeStart: start,
      recipientRangeEnd: end - 1,
      recipientCount: end - start,
    });
    batchIndex += 1;
  }
  return ranges;
}
