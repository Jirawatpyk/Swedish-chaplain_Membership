/**
 * #739 B3b — a Redis outage on reserve is `redis_unavailable` carrying the
 * error CLASS, never the client's message (it can quote the key or the host).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@upstash/redis', () => ({
  Redis: class {
    set = vi.fn(async () => {
      throw new Error('ECONNREFUSED redis.example — key idem:a@b.example');
    });
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('reserveIdempotencyRecord', () => {
  it('a Redis throw is redis_unavailable with the class only', async () => {
    const { reserveIdempotencyRecord } = await import('@/lib/idempotency');
    const r = await reserveIdempotencyRecord({ slug: 'test-swecham' } as never, 'idem-1', 'hash');
    expect(r).toEqual({ ok: false, error: { kind: 'redis_unavailable', message: 'Error' } });
    if (!r.ok) expect(JSON.stringify(r.error)).not.toContain('@');
  });
});
