/**
 * 016 post-ship review finding #15 — `getCurrentSession` must be wrapped in
 * React `cache()`. Every /admin render ran it three times (layout
 * requireSession + CommandPaletteRoot requireSession + the page's
 * requirePagePermission): 9 Neon round-trips and 3 unthrottled
 * `last_seen_at` writes to the same row per page view.
 *
 * True per-render memoization only exists inside an RSC render (React's
 * cache store), which a vitest environment cannot honestly reproduce — so
 * this pins the two halves that CAN be pinned:
 *   1. a source tripwire that the export is `cache(`-wrapped (the repo's
 *      gate-reads-source idiom for render-only behavior), and
 *   2. the outside-render contract: with no cache store the wrap must be a
 *      passthrough — route handlers keep fresh per-call reads.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const findByIdSession = vi.fn(async (_id: unknown): Promise<unknown> => null);
const findByIdUser = vi.fn(async (_id: unknown): Promise<unknown> => null);
const updateLastSeen = vi.fn(async (_id: unknown, _now: unknown) => {});
const deleteSession = vi.fn(async (_id: unknown) => {});

vi.mock('@/lib/auth-cookies', () => ({
  getSessionIdFromCookie: async () => 'sess-1',
}));
vi.mock('@/modules/auth/infrastructure/db/session-repo', () => ({
  sessionRepo: {
    findById: (id: unknown) => findByIdSession(id),
    updateLastSeen: (id: unknown, now: unknown) => updateLastSeen(id, now),
    delete: (id: unknown) => deleteSession(id),
  },
}));
vi.mock('@/modules/auth/infrastructure/db/user-repo', () => ({
  userRepo: { findById: (id: unknown) => findByIdUser(id) },
}));

describe('getCurrentSession — React cache() wrap (finding #15)', () => {
  it('the export is cache()-wrapped (source tripwire)', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'lib', 'auth-session.ts'),
      'utf-8',
    );
    expect(src).toMatch(/import \{ cache \} from 'react';/);
    expect(src).toMatch(
      /export const getCurrentSession = cache\(async function getCurrentSession/,
    );
  });

  it('outside an RSC render the wrap is a passthrough — route handlers stay fresh', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    findByIdSession.mockResolvedValue({
      id: 'sess-1',
      userId: 'u-1',
      expiresAt: future,
      lastSeenAt: new Date(),
      createdAt: new Date(),
    });
    findByIdUser.mockResolvedValue({ id: 'u-1', status: 'active', role: 'admin' });

    const { getCurrentSession } = await import('@/lib/auth-session');
    await getCurrentSession();
    await getCurrentSession();
    // No cache store in a plain node context → two real lookups. This is the
    // contract Route Handlers rely on; per-render dedupe belongs to React.
    expect(findByIdSession).toHaveBeenCalledTimes(2);
    expect(updateLastSeen).toHaveBeenCalledTimes(2);
  });
});
