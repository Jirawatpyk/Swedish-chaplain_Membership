/**
 * Spec 140 s3 review round 1 (R1-J) — `retryableSubKind` narrows a thrown
 * sub-kind against ONE list, typed two ways against `GatewayRetryableSubKind`,
 * so a new member of the port's union is a compile error rather than a
 * silent `unclassified` on the page-on-call `dispatch_budget_exhausted` series.
 */
import { describe, expect, it } from 'vitest';
import {
  GATEWAY_RETRYABLE_SUB_KINDS,
  retryableSubKind,
} from '@/modules/broadcasts/application/use-cases/_classify-thrown';

describe('retryableSubKind', () => {
  it.each([...GATEWAY_RETRYABLE_SUB_KINDS])('keeps the port sub-kind %s', (sub) => {
    expect(retryableSubKind(sub)).toBe(sub);
  });

  it.each([['an unknown string', 'quota'], ['no sub-kind', undefined]])('reads %s as unclassified', (_label, sub) => {
    expect(retryableSubKind(sub)).toBe('unclassified');
  });
});
