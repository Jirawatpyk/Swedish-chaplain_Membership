/**
 * 117 — `runIdempotent`: the reservation is released on every exit that did
 * not remember a response, and only on those.
 *
 * `@/lib/idempotency` is mocked (it builds an Upstash client at module load),
 * which is also how every route contract suite runs — so these are the same
 * spies the route tests assert on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/idempotency', () => ({
  rememberIdempotentResponse: vi.fn(async () => undefined),
  releaseIdempotencyRecord: vi.fn(async () => undefined),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const TENANT = { slug: 'test-swecham' } as never;
const RESERVATION = { key: 'idem-1', bodyHash: 'hash' };

async function spies() {
  const idem = await import('@/lib/idempotency');
  return {
    remember: vi.mocked(idem.rememberIdempotentResponse),
    release: vi.mocked(idem.releaseIdempotencyRecord),
  };
}

describe('runIdempotent', () => {
  afterEach(() => vi.clearAllMocks());

  it('remembers the response and does NOT release when the work remembers', async () => {
    const { runIdempotent } = await import('@/lib/idempotency-run');
    const out = await runIdempotent(TENANT, RESERVATION, async ({ remember }) => {
      await remember({ status: 200, body: { ok: true } });
      return 'answered';
    });
    const { remember, release } = await spies();
    expect(out).toBe('answered');
    expect(remember).toHaveBeenCalledWith(TENANT, 'idem-1', 'hash', {
      status: 200,
      body: { ok: true },
    });
    expect(release).not.toHaveBeenCalled();
  });

  it('releases when the work returns without remembering (a 404 this route does not cache)', async () => {
    const { runIdempotent } = await import('@/lib/idempotency-run');
    const out = await runIdempotent(TENANT, RESERVATION, async () => 404);
    const { remember, release } = await spies();
    expect(out).toBe(404);
    expect(remember).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(TENANT, 'idem-1');
  });

  it('releases and rethrows when the work throws', async () => {
    const { runIdempotent } = await import('@/lib/idempotency-run');
    await expect(
      runIdempotent(TENANT, RESERVATION, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { release } = await spies();
    expect(release).toHaveBeenCalledWith(TENANT, 'idem-1');
  });

  it('refuses to remember a 429 or a 5xx and releases instead', async () => {
    const { runIdempotent } = await import('@/lib/idempotency-run');
    for (const status of [429, 500, 503]) {
      vi.clearAllMocks();
      await runIdempotent(TENANT, RESERVATION, async ({ remember }) => {
        await remember({ status, body: { error: 'nope' } });
        return status;
      });
      const { remember, release } = await spies();
      expect(remember, `status ${status}`).not.toHaveBeenCalled();
      expect(release, `status ${status}`).toHaveBeenCalledWith(TENANT, 'idem-1');
    }
  });

  it('releases when remembering itself throws — the key must not be left burnt', async () => {
    const { remember: rememberSpy } = await spies();
    rememberSpy.mockRejectedValueOnce(new Error('redis exploded'));
    const { runIdempotent } = await import('@/lib/idempotency-run');
    await expect(
      runIdempotent(TENANT, RESERVATION, async ({ remember }) => {
        await remember({ status: 200, body: {} });
        return 'unreachable';
      }),
    ).rejects.toThrow('redis exploded');
    const { release } = await spies();
    expect(release).toHaveBeenCalledWith(TENANT, 'idem-1');
  });

  it('does nothing at all with a null reservation (the optional-key routes)', async () => {
    const { runIdempotent } = await import('@/lib/idempotency-run');
    const out = await runIdempotent(TENANT, null, async ({ remember }) => {
      await remember({ status: 200, body: {} });
      return 'no-key';
    });
    const { remember, release } = await spies();
    expect(out).toBe('no-key');
    expect(remember).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
