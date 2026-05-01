/**
 * Unit test — `reduceDeliveryAggregateRows` schema-drift guard.
 *
 * Round-2 review MED-tests-2: when a future enum value is added to
 * `broadcast_delivery_status` (e.g. `queued`, `opened`,
 * `unsubscribed`), the aggregator MUST emit `logger.warn` so the gap
 * is observable in ops. A regression that drops the warn would
 * silently undercount totals.
 */
import { describe, expect, it, vi } from 'vitest';
import { reduceDeliveryAggregateRows } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logger';

const ctx = { tenantId: 'test-tenant', broadcastId: 'broadcast-1' };

describe('reduceDeliveryAggregateRows', () => {
  it('zero-initialises every status when input is empty', () => {
    const out = reduceDeliveryAggregateRows([], ctx);
    expect(out).toEqual({
      delivered: 0,
      bounced: 0,
      softBounced: 0,
      complained: 0,
      sent: 0,
    });
  });

  it('aggregates known statuses correctly', () => {
    const out = reduceDeliveryAggregateRows(
      [
        { status: 'delivered', count: 128 },
        { status: 'bounced', count: 1 },
        { status: 'complained', count: 0 },
        { status: 'soft_bounced', count: 2 },
        { status: 'sent', count: 5 },
      ],
      ctx,
    );
    expect(out).toEqual({
      delivered: 128,
      bounced: 1,
      softBounced: 2,
      complained: 0,
      sent: 5,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('emits logger.warn on unknown status (schema-drift guard)', () => {
    vi.mocked(logger.warn).mockClear();
    const out = reduceDeliveryAggregateRows(
      [
        { status: 'delivered', count: 1 },
        { status: 'queued', count: 4 }, // ← future enum value
        { status: 'opened', count: 2 }, // ← future enum value
      ],
      ctx,
    );
    // Known status counted; unknowns dropped from totals (NaN-free)
    expect(out.delivered).toBe(1);
    expect(out).toMatchObject({
      bounced: 0,
      softBounced: 0,
      complained: 0,
      sent: 0,
    });
    expect(out).not.toHaveProperty('soft_bounced');
    // logger.warn fires once per unknown row with the canonical msg key
    expect(logger.warn).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(logger.warn).mock.calls;
    expect(calls[0]?.[1]).toBe('broadcasts.delivery_aggregate.unknown_status');
    expect(calls[1]?.[1]).toBe('broadcasts.delivery_aggregate.unknown_status');
    // Payload includes tenant + broadcast for ops triage
    expect(calls[0]?.[0]).toMatchObject({
      tenantId: 'test-tenant',
      broadcastId: 'broadcast-1',
      status: 'queued',
      count: 4,
    });
  });
});
