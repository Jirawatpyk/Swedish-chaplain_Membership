/**
 * PR-3 review round 2 (B1) — `src/lib/change-request-attempt-bucket.ts`'s
 * INPUT type.
 *
 * The bucket used to take `{ key: string; max: number; windowSeconds: number }`,
 * so four things a caller could get wrong were all spelled `string` / `number`:
 *
 *   - the KEY. It is a Redis key with a fixed grammar
 *     (`f114:<route>-attempts:<tenant>:<user>`); a caller assembling it by
 *     hand and dropping the tenant segment would share ONE bucket across every
 *     tenant, and nothing would say so — the limiter would simply refuse
 *     tenant B because tenant A was noisy. `attemptBucketKey()` is now the one
 *     way to make one, and the branded return type means a raw string is a
 *     compile error at the call site;
 *   - the SIZE. `max` + `windowSeconds` were two independent numbers, so a
 *     fifth route could invent a 60 / 60 s bucket that matches no documented
 *     size. They are now one `size: 'submit' | 'probe'` resolved inside, which
 *     is also what the runbook and § 27.1 describe;
 *   - the errorIdPrefix, now shaped `M114.<surface>.<route>` at the type
 *     level, which is the shape `tests/unit/architecture/change-requests-error-id.test.ts`
 *     checks by parsing the source.
 *
 * The four production keys are asserted VERBATIM: they are live Redis keys, so
 * a "tidier" spelling silently empties every in-flight bucket.
 */
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_WINDOW_SECONDS,
  PROBE_ATTEMPTS_PER_WINDOW,
  SUBMIT_ATTEMPTS_PER_WINDOW,
  attemptBucketKey,
  attemptBucketSize,
} from '@/lib/change-request-attempt-bucket';

describe('attemptBucketKey', () => {
  it('builds the four production keys verbatim — the tenant and the user are both segments', () => {
    expect(attemptBucketKey('submit', 'swecham', 'u-1')).toBe('f114:submit-attempts:swecham:u-1');
    expect(attemptBucketKey('withdraw', 'swecham', 'u-1')).toBe('f114:withdraw-attempts:swecham:u-1');
    expect(attemptBucketKey('history-item', 'swecham', 'u-1')).toBe('f114:history-item-attempts:swecham:u-1');
    expect(attemptBucketKey('acknowledge', 'swecham', 'u-1')).toBe('f114:acknowledge-attempts:swecham:u-1');
  });

  it('two tenants never share a bucket, and neither do two users', () => {
    expect(attemptBucketKey('submit', 'a', 'u')).not.toBe(attemptBucketKey('submit', 'b', 'u'));
    expect(attemptBucketKey('submit', 'a', 'u1')).not.toBe(attemptBucketKey('submit', 'a', 'u2'));
    expect(attemptBucketKey('submit', 'a', 'u')).not.toBe(attemptBucketKey('withdraw', 'a', 'u'));
  });

  it('a raw string is not an AttemptBucketKey (the brand is the point)', () => {
    // @ts-expect-error — only `attemptBucketKey()` mints one; a hand-rolled
    // literal, however correct it looks, cannot be passed.
    const key: ReturnType<typeof attemptBucketKey> = 'f114:submit-attempts:swecham:u-1';
    expect(key).toBe('f114:submit-attempts:swecham:u-1');
  });
});

describe('attemptBucketSize', () => {
  it('the two documented sizes, and nothing else can be asked for', () => {
    expect(attemptBucketSize('submit')).toEqual({ max: SUBMIT_ATTEMPTS_PER_WINDOW, windowSeconds: ATTEMPT_WINDOW_SECONDS });
    expect(attemptBucketSize('probe')).toEqual({ max: PROBE_ATTEMPTS_PER_WINDOW, windowSeconds: ATTEMPT_WINDOW_SECONDS });
  });

  it('the numbers are the ones § 27.1 and the runbook state: 60 / 10 min and 10 / 10 min', () => {
    expect(attemptBucketSize('submit')).toEqual({ max: 60, windowSeconds: 600 });
    expect(attemptBucketSize('probe')).toEqual({ max: 10, windowSeconds: 600 });
  });
});
