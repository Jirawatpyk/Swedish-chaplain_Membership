/**
 * F9 US3 (review-run R2-4) — `member_timeline_v` discriminant guard.
 *
 * The repo throws if the view emits a `source`/`actor_kind` outside the known
 * unions (migration drift) — the throw must be caught and surfaced as
 * `repo.unexpected`, never an invalid `TimelineEvent` flowing downstream. We
 * mock the db layer so a single unknown-source row reaches the map guard.
 */
import { describe, expect, it, vi } from 'vitest';

// Fake tenant tx: execute() returns the count row, then a page row whose
// `source` is outside `TIMELINE_SOURCES`.
const executeMock = vi
  .fn()
  .mockResolvedValueOnce([{ n: 1 }]) // count query
  .mockResolvedValueOnce([
    {
      ref_id: 'r1',
      occurred_at_iso: '2026-01-01 00:00:00+00',
      source: 'unknown_future_source',
      actor_kind: 'staff',
      // payload:null is intentional → keeps `uuidActorIds` empty so the repo
      // skips the outer-`db` users lookup (which `db: {}` below doesn't stub);
      // the source guard fires before any actor/plan resolution.
      payload: null,
    },
  ]); // page query

vi.mock('@/lib/db', () => ({
  runInTenant: (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ execute: executeMock }),
  db: {},
}));
vi.mock('@/lib/metrics', () => ({
  insightsMetrics: { timelineQueryDurationMs: vi.fn() },
}));

import { drizzleTimelineRepo } from '@/modules/members/infrastructure/timeline/drizzle-timeline-repo';
import type { TenantContext } from '@/modules/tenants';

describe('drizzleTimelineRepo — ViewRow discriminant guard (R2-4)', () => {
  it('an unknown view `source` → repo.unexpected (caught, not an invalid union)', async () => {
    const r = await drizzleTimelineRepo.listByMember(
      { slug: 'test-tenant' } as unknown as TenantContext,
      { memberId: '00000000-0000-4000-8000-000000000001', limit: 50 },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('repo.unexpected');
  });
});
