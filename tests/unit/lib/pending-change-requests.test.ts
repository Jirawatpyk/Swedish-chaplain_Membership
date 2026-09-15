/**
 * F114 US6 (FR-033, FR-039; research R12) — `readPendingChangeRequests`, the
 * one server read behind the staff nav badge and the dashboard "Needs
 * attention" item. Both surfaces render on every staff page, so the read
 * must never take the page down: a fault degrades to `null` (no badge, no
 * item) and is logged ONCE under the CALLER's errorId — the shared helper
 * stamps no identity of its own (`M114.nav.badge_failed` vs
 * `M114.dashboard.pending_count_failed` stay distinguishable).
 *
 * Gates, in order: platform flag OFF → `null` without a query (FR-039);
 * viewer without `members.read` → `null` without a query (FR-026); only
 * then the indexed `count/min` query (R12 accepts one per render).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  features: { memberChangeApproval: true } as { memberChangeApproval: boolean },
  count: vi.fn(),
  build: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/env', () => ({ env: { features: h.features } }));
vi.mock('@/lib/logger', () => ({
  logger: { error: h.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth-session', () => ({ getCurrentSession: vi.fn() }));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromRequest: () => ({ slug: 'tenant-a' }) }));
vi.mock('@/lib/members-change-request-deps', () => ({ buildChangeRequestDeps: h.build }));
vi.mock('@/modules/members', () => ({ countPendingChangeRequests: h.count }));

import { readPendingChangeRequests } from '@/lib/pending-change-requests';

const DEPS = { tenant: { slug: 'tenant-a' } };

beforeEach(() => {
  h.features.memberChangeApproval = true;
  h.count.mockReset();
  h.build.mockReset().mockReturnValue(DEPS);
  h.logError.mockReset();
});

describe('readPendingChangeRequests', () => {
  it('returns the summary for a members.read holder when the flag is on (one query, the tenant deps)', async () => {
    h.count.mockResolvedValue({ ok: true, value: { count: 3, oldestAgeSeconds: 259_200 } });
    await expect(readPendingChangeRequests('manager', 'M114.test.x')).resolves.toEqual({
      count: 3,
      oldestAgeSeconds: 259_200,
    });
    expect(h.count).toHaveBeenCalledTimes(1);
    expect(h.count).toHaveBeenCalledWith(DEPS);
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('flag OFF → null and NO query (FR-039: nav and dashboard show no count)', async () => {
    h.features.memberChangeApproval = false;
    h.count.mockResolvedValue({ ok: true, value: { count: 3, oldestAgeSeconds: 10 } });
    await expect(readPendingChangeRequests('admin', 'M114.test.x')).resolves.toBeNull();
    expect(h.count).not.toHaveBeenCalled();
    expect(h.build).not.toHaveBeenCalled();
  });

  it('a viewer without members.read → null and NO query', async () => {
    h.count.mockResolvedValue({ ok: true, value: { count: 3, oldestAgeSeconds: 10 } });
    await expect(readPendingChangeRequests('member', 'M114.test.x')).resolves.toBeNull();
    expect(h.count).not.toHaveBeenCalled();
  });

  it('a Result error → null, logged once under the caller errorId', async () => {
    h.count.mockResolvedValue({ ok: false, error: { type: 'server_error', message: 'count-pending: unavailable' } });
    await expect(readPendingChangeRequests('admin', 'M114.nav.badge_failed')).resolves.toBeNull();
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(h.logError.mock.calls[0]![0]).toMatchObject({ errorId: 'M114.nav.badge_failed', tenantId: 'tenant-a' });
  });

  it('a thrown read → null, logged once under the caller errorId (the page never 500s for a badge)', async () => {
    h.count.mockRejectedValue(new Error('neon down'));
    await expect(readPendingChangeRequests('admin', 'M114.dashboard.pending_count_failed')).resolves.toBeNull();
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(h.logError.mock.calls[0]![0]).toMatchObject({ errorId: 'M114.dashboard.pending_count_failed' });
  });
});
