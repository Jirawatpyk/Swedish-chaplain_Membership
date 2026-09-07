/**
 * 108 PR-C T090 (Constitution VII; docs/observability.md § 22) —
 * `countRecipients` records `broadcasts_recipient_count_ms` on EVERY outcome
 * (ok, typed failure, throw) so the SLO-F7-011 histogram sees the slow
 * failures too, and maps the resolver Result to the numbers-only envelope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '@/lib/result';
import { broadcastsMetrics } from '@/lib/metrics';

const resolveMock = vi.fn();
vi.mock('@/modules/broadcasts', () => ({
  resolveSegmentRecipients: (...a: unknown[]) => resolveMock(...a),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { countRecipients } from '@/lib/broadcasts-recipient-count';

const deps = { tenant: { slug: 'test-tenant' }, audienceCeiling: 5000 } as never;
const input = { segment: { kind: 'all_members' as const }, requestingMemberId: 'm-1', correlationId: 'c-1' };

describe('countRecipients records the recipient-count histogram (108 PR-C T090)', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(broadcastsMetrics, 'recipientCountMs');
  });
  afterEach(() => {
    spy.mockRestore();
    resolveMock.mockReset();
  });

  it('ok → one observation for the tenant', async () => {
    resolveMock.mockResolvedValueOnce(ok({ recipients: [], estimatedCount: 3, orphans: [], droppedByPreference: 0 }));
    const r = await countRecipients(deps, input);
    expect(r).toEqual({ status: 'ok', body: { count: 3, ceiling: 5000, exceeds: false, orphans: 0, droppedByPreference: 0 } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('test-tenant', expect.any(Number));
  });

  it('a typed server error → unavailable, still observed', async () => {
    resolveMock.mockResolvedValueOnce(err({ kind: 'resolve.server_error', message: 'x' }));
    expect(await countRecipients(deps, input)).toEqual({ status: 'unavailable' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a throw → unavailable, still observed', async () => {
    resolveMock.mockRejectedValueOnce(new Error('contacts lookup down'));
    expect(await countRecipients(deps, input)).toEqual({ status: 'unavailable' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('countRecipients — a resolver that THROWS is unavailable (review 2026-09-07, pinned for the coverage floor)', () => {
  // The typed `resolve.server_error` path and the outer catch are two
  // different doors to the same answer; only the first had a case.
  it('resolver throws → { status: unavailable }, the histogram still observed', async () => {
    resolveMock.mockRejectedValueOnce(new Error('members-bridge.getContactsBySegment: repo.unexpected'));
    const r = await countRecipients(deps, {
      segment: { kind: 'all_members' },
      requestingMemberId: 'm-1',
      correlationId: 'corr-throw',
    });
    expect(r).toEqual({ status: 'unavailable' });
  });

  // Review 2026-09-07 (types MEDIUM) — a refusal never fabricates the
  // measured fields: `orphans` / `droppedByPreference` are ABSENT, not 0.
  it('too large → the TRUE count + exceeds, and no orphans / droppedByPreference at all', async () => {
    resolveMock.mockResolvedValueOnce(err({ kind: 'broadcast_audience_too_large', count: 5001, cap: 5000 }));
    const r = await countRecipients(deps, {
      segment: { kind: 'all_members' },
      requestingMemberId: 'm-1',
      correlationId: 'corr-large',
    });
    expect(r).toEqual({ status: 'ok', body: { count: 5001, ceiling: 5000, exceeds: true } });
  });

  it('empty → count 0, and no orphans / droppedByPreference at all', async () => {
    resolveMock.mockResolvedValueOnce(err({ kind: 'broadcast_empty_segment_blocked' }));
    const r = await countRecipients(deps, {
      segment: { kind: 'all_members' },
      requestingMemberId: 'm-1',
      correlationId: 'corr-empty',
    });
    expect(r).toEqual({ status: 'ok', body: { count: 0, ceiling: 5000, exceeds: false } });
  });

});
