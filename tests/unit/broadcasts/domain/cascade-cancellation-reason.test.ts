/**
 * Spec 139 review round 1 CR#8 — the F7 cascade's cancellation reasons and the
 * members port's `SystemCancellationReason` are the same union. Members may not
 * import the broadcasts Domain, so the two are declared apart; this pins them
 * equal so neither can grow a value the other does not know.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CASCADE_CANCELLATION_REASONS,
  type CascadeCancellationReason,
} from '@/modules/broadcasts/domain/value-objects/cascade-cancellation-reason';
import type { SystemCancellationReason } from '@/modules/members/application/ports/broadcasts-cascade-port';

describe('CASCADE_CANCELLATION_REASONS (spec 139 CR#8)', () => {
  it('is the same union as the members port SystemCancellationReason', () => {
    expectTypeOf<CascadeCancellationReason>().toEqualTypeOf<SystemCancellationReason>();
  });

  it('lists each reason once', () => {
    expect(new Set(CASCADE_CANCELLATION_REASONS).size).toBe(CASCADE_CANCELLATION_REASONS.length);
  });
});
