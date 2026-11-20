/**
 * Spec 140 s3 review round 1 (R1-J) — `retryableSubKind` narrows a thrown
 * sub-kind against ONE list, typed two ways against `GatewayRetryableSubKind`,
 * so a new member of the port's union is a compile error rather than a
 * silent `unclassified` on the page-on-call `dispatch_budget_exhausted` series.
 */
import { describe, expect, it } from 'vitest';
import {
  GATEWAY_RETRYABLE_SUB_KINDS,
  classifyThrown,
  retryableSubKind,
} from '@/modules/broadcasts/application/use-cases/_classify-thrown';

describe('classifyThrown', () => {
  it('a throw with no `kind` is `unknown` carrying its class, never its text (#739 B3b)', () => {
    expect(classifyThrown(new TypeError('x is undefined — a@b.example'))).toEqual({ kind: 'unknown', reason: 'TypeError' });
    expect(classifyThrown('plain string')).toEqual({ kind: 'unknown', reason: 'unknown' });
  });
});

describe('retryableSubKind', () => {
  it.each([...GATEWAY_RETRYABLE_SUB_KINDS])('keeps the port sub-kind %s', (sub) => {
    expect(retryableSubKind(sub)).toBe(sub);
  });

  it.each([['an unknown string', 'quota'], ['no sub-kind', undefined]])('reads %s as unclassified', (_label, sub) => {
    expect(retryableSubKind(sub)).toBe('unclassified');
  });
});
