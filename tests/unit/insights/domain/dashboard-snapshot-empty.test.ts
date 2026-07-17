/**
 * `emptySnapshot` unit test — F9 dashboard-interactive-charts (067 T1).
 *
 * Pure Domain assertion: a fresh/zero-data tenant's snapshot must carry empty
 * `tierDistribution` + a zeroed `invoiceStatus` distribution (no framework,
 * no I/O — matches the Domain layer's zero-import rule).
 */
import { describe, expect, it } from 'vitest';
import { emptySnapshot } from '@/modules/insights/domain/dashboard-snapshot';

describe('emptySnapshot', () => {
  it('has an empty tierDistribution and a zeroed invoiceStatus', () => {
    const snap = emptySnapshot('2026-07-16T00:00:00.000Z');

    expect(snap.tierDistribution).toEqual([]);
    expect(snap.invoiceStatus).toEqual({ buckets: [], draftCount: 0 });
  });
});
