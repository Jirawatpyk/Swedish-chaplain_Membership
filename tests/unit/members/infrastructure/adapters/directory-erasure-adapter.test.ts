/**
 * `directoryErasureAdapter` — F3 member erasure → F9 directory footprint erase
 * (COMP-1 / GDPR Art.17). Bridges to the insights barrel
 * `eraseMemberInsightsFootprint`; a throw must translate to `outcome: 'failed'`
 * (+ a hygienic log), never propagate — so the erasure cascade records the
 * directory cascade as incomplete and the US2d reconciler re-drives.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const footprintMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/insights', () => ({ eraseMemberInsightsFootprint: footprintMock }));
const loggerError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({
  logger: { error: loggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { directoryErasureAdapter } from '@/modules/members/infrastructure/adapters/directory-erasure-adapter';

const tenant = { slug: 't-1' } as never;
const meta = { actorUserId: 'a-1', requestId: 'r-1' };

beforeEach(() => {
  footprintMock.mockReset();
  loggerError.mockReset();
});

describe('directoryErasureAdapter', () => {
  it('erases the footprint (row + logo blob) and returns ok', async () => {
    footprintMock.mockResolvedValue(undefined);
    const r = await directoryErasureAdapter.eraseForMember(tenant, 'm-1' as never, meta);
    expect(r).toEqual({ outcome: 'ok' });
    expect(footprintMock).toHaveBeenCalledWith(tenant, 'm-1');
  });

  it('translates a throw to outcome:failed (never propagates) + logs errKind only', async () => {
    footprintMock.mockRejectedValue(new Error('blob del 500 secret@pii.com'));
    const r = await directoryErasureAdapter.eraseForMember(tenant, 'm-1' as never, meta);
    expect(r).toEqual({ outcome: 'failed' });
    expect(loggerError).toHaveBeenCalledTimes(1);
    // Forbidden-log hygiene: the raw message (which can embed PII) must not be logged.
    const logged = JSON.stringify(loggerError.mock.calls[0]?.[0]);
    expect(logged).not.toContain('secret@pii.com');
    expect(logged).toContain('Error'); // errKind = constructor name
  });
});
