/**
 * F114 US6 (FR-033, FR-039; research R12) — `readPendingChangeRequests`, the
 * one server read behind the staff nav badge and the dashboard "Needs
 * attention" item.
 *
 * PR-3 review (reliability R-H2): the answer is a DISCRIMINATED result, not
 * `null` for everything. `null` collapsed "hidden by design" (flag off / no
 * `members.read`) into "the read faulted", and the dashboard's `n > 0` filter
 * then dropped the item — so a Neon blip rendered the all-clear empty state
 * while the FR-037 clock ran. `hidden` shows nothing; `unavailable` shows the
 * section-failure alert; only `ok` carries a count.
 *
 * Gates, in order: platform flag OFF → `hidden` without a query (FR-039);
 * viewer without `members.read` → `hidden` without a query (FR-026); only
 * then the indexed `count/min` query (R12 accepts one per render).
 *
 * PR-3 review (reliability R-H1): the NAV read is additionally bounded by
 * `readPendingChangeRequestsForNav` — the staff LAYOUT awaits it before the
 * nav config is built, so an unbounded read adds the pool's whole
 * `connect_timeout + statement_timeout` budget to the TTFB of every
 * `/admin/**` page. Past the deadline the badge is `unavailable` and ONE line
 * is logged under `M114.nav.badge_timed_out`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import {
  applyNavBadges,
  isNavGroup,
  staffNavConfig,
  type BadgeableNavHref,
  type NavBadgeCounts,
} from '@/config/nav';

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
vi.mock('@/lib/members-change-request-deps', () => ({ buildChangeRequestDeps: h.build }));
vi.mock('@/modules/members', () => ({ countPendingChangeRequests: h.count }));

import {
  NAV_BADGE_READ_TIMEOUT_MS,
  readPendingChangeRequests,
  readPendingChangeRequestsForNav,
} from '@/lib/pending-change-requests';

const TENANT = asTenantContext('tenant-a');
const DEPS = { tenant: TENANT };

beforeEach(() => {
  h.features.memberChangeApproval = true;
  h.count.mockReset();
  h.build.mockReset().mockReturnValue(DEPS);
  h.logError.mockReset();
});

describe('readPendingChangeRequests', () => {
  it('returns { kind: ok } for a members.read holder when the flag is on (one query, the CALLER tenant)', async () => {
    h.count.mockResolvedValue({ ok: true, value: { count: 3, oldestAgeSeconds: 259_200 } });
    await expect(readPendingChangeRequests(TENANT, 'manager', 'M114.test.x')).resolves.toEqual({
      kind: 'ok',
      summary: { count: 3, oldestAgeSeconds: 259_200 },
    });
    expect(h.count).toHaveBeenCalledTimes(1);
    expect(h.count).toHaveBeenCalledWith(DEPS);
    // SEC-4: the helper resolves no tenant of its own — it is handed the one
    // the page already resolved from the request headers.
    expect(h.build).toHaveBeenCalledWith(TENANT);
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('flag OFF → hidden and NO query (FR-039: nav and dashboard show no count)', async () => {
    h.features.memberChangeApproval = false;
    h.count.mockResolvedValue({ ok: true, value: { count: 3, oldestAgeSeconds: 10 } });
    await expect(readPendingChangeRequests(TENANT, 'admin', 'M114.test.x')).resolves.toEqual({ kind: 'hidden', reason: 'flag_off' });
    expect(h.count).not.toHaveBeenCalled();
    expect(h.build).not.toHaveBeenCalled();
  });

  it('a viewer without members.read → hidden and NO query', async () => {
    h.count.mockResolvedValue({ ok: true, value: { count: 3, oldestAgeSeconds: 10 } });
    await expect(readPendingChangeRequests(TENANT, 'member', 'M114.test.x')).resolves.toEqual({ kind: 'hidden', reason: 'not_permitted' });
    expect(h.count).not.toHaveBeenCalled();
  });

  /**
   * PR-3 review round 2 (C1) — the two `hidden` answers are the same SURFACE
   * (nothing rendered) but different FACTS: "the whole feature is dark" vs
   * "this viewer may not see the queue". Only the second one changes when a
   * role changes, and a flag-flip readiness check that cannot tell them apart
   * reads a manager's own `hidden` as proof the flag is off. The gates run in
   * that order, so the reason also states WHICH gate answered first.
   */
  it('the two hidden reasons are distinguishable, and the FLAG is checked first', async () => {
    h.features.memberChangeApproval = false;
    // a role that would be refused by the permission gate too: the flag wins
    await expect(readPendingChangeRequests(TENANT, 'member', 'M114.test.x')).resolves.toEqual({ kind: 'hidden', reason: 'flag_off' });
    h.features.memberChangeApproval = true;
    await expect(readPendingChangeRequests(TENANT, 'member', 'M114.test.x')).resolves.toEqual({ kind: 'hidden', reason: 'not_permitted' });
    expect(h.count).not.toHaveBeenCalled();
  });

  it('a Result error → unavailable (never hidden), logged once under the caller errorId', async () => {
    h.count.mockResolvedValue({ ok: false, error: { type: 'server_error', message: 'count-pending: unavailable' } });
    await expect(readPendingChangeRequests(TENANT, 'admin', 'M114.nav.badge_failed')).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(h.logError.mock.calls[0]![0]).toMatchObject({ errorId: 'M114.nav.badge_failed', tenantId: 'tenant-a' });
  });

  it('a thrown read → unavailable, logged once under the caller errorId (the page never 500s for a badge)', async () => {
    h.count.mockRejectedValue(new Error('neon down'));
    await expect(
      readPendingChangeRequests(TENANT, 'admin', 'M114.dashboard.pending_count_failed'),
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(h.logError.mock.calls[0]![0]).toMatchObject({ errorId: 'M114.dashboard.pending_count_failed' });
  });
});

describe('readPendingChangeRequestsForNav — the layout read is time-boxed (R-H1)', () => {
  it('a read that resolves INSIDE the deadline answers the summary, and no timeout is logged', async () => {
    h.count.mockResolvedValue({ ok: true, value: { count: 4, oldestAgeSeconds: 60 } });
    const read = readPendingChangeRequestsForNav(TENANT, 'admin');
    await vi.advanceTimersByTimeAsync(NAV_BADGE_READ_TIMEOUT_MS - 1);
    await expect(read).resolves.toEqual({ kind: 'ok', summary: { count: 4, oldestAgeSeconds: 60 } });
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('a read still running at the deadline → unavailable (no badge) + ONE M114.nav.badge_timed_out line', async () => {
    h.count.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, value: { count: 9, oldestAgeSeconds: 10 } }), 8_000);
        }),
    );
    const read = readPendingChangeRequestsForNav(TENANT, 'admin');
    await vi.advanceTimersByTimeAsync(NAV_BADGE_READ_TIMEOUT_MS + 1);
    await expect(read).resolves.toEqual({ kind: 'unavailable' });
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(h.logError.mock.calls[0]![0]).toMatchObject({
      errorId: 'M114.nav.badge_timed_out',
      tenantId: 'tenant-a',
      timeoutMs: NAV_BADGE_READ_TIMEOUT_MS,
    });
  });

  it('a gate that answers without a query is not time-boxed into a fault: flag OFF stays hidden', async () => {
    h.features.memberChangeApproval = false;
    await expect(readPendingChangeRequestsForNav(TENANT, 'admin')).resolves.toEqual({ kind: 'hidden', reason: 'flag_off' });
    expect(h.count).not.toHaveBeenCalled();
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('a read FAULT inside the deadline is the read-failed id, not the timeout id', async () => {
    h.count.mockRejectedValue(new Error('neon down'));
    await expect(readPendingChangeRequestsForNav(TENANT, 'admin')).resolves.toEqual({ kind: 'unavailable' });
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(h.logError.mock.calls[0]![0]).toMatchObject({ errorId: 'M114.nav.badge_failed' });
  });
});

/**
 * PR-3 review round 2 (B13) — the staff layout's badge SEAM, tested as the
 * composition it is.
 *
 * An RSC test of `layout.tsx` itself would be a test of `requireSession` +
 * `cookies()` + `<StaffShell>`, none of which is the property in question.
 * The property is: whichever of the three kinds the read answers, what
 * `badgeCount` reaches the rendered nav? The layout's own line is
 * `kind === 'ok' ? summary.count : 0`, so this pipes all three through the
 * same expression into the real `applyNavBadges` over the real
 * `staffNavConfig` — the two pure halves the reviewer wanted joined.
 */
describe('the staff layout seam: read kind → applyNavBadges → badgeCount', () => {
  const CHANGE_REQUESTS: BadgeableNavHref = '/admin/change-requests';

  /** The staff layout's own line (`src/app/(staff)/admin/layout.tsx`). */
  function navBadgeCounts(read: Awaited<ReturnType<typeof readPendingChangeRequestsForNav>>): NavBadgeCounts {
    return { [CHANGE_REQUESTS]: read.kind === 'ok' ? read.summary.count : 0 };
  }

  function badgeCountFor(config: ReturnType<typeof applyNavBadges>): number | undefined {
    const leaves = config.sections.flatMap((s) => s.items.flatMap((i) => (isNavGroup(i) ? i.children : [i])));
    return leaves.find((i) => i.href === CHANGE_REQUESTS)?.badgeCount;
  }

  it('ok with a count badges it; ok at 0, hidden and unavailable all render NO badge', async () => {
    h.count.mockResolvedValue({ ok: true, value: { count: 7, oldestAgeSeconds: 60 } });
    const ok = await readPendingChangeRequestsForNav(TENANT, 'admin');
    expect(badgeCountFor(applyNavBadges(staffNavConfig, navBadgeCounts(ok)))).toBe(7);

    h.count.mockResolvedValue({ ok: true, value: { count: 0, oldestAgeSeconds: null } });
    const empty = await readPendingChangeRequestsForNav(TENANT, 'admin');
    expect(badgeCountFor(applyNavBadges(staffNavConfig, navBadgeCounts(empty)))).toBeUndefined();

    // `hidden` and `unavailable` are DIFFERENT facts and the SAME badge: a
    // count we do not have is never rendered as a zero (the layout's comment).
    h.features.memberChangeApproval = false;
    const hidden = await readPendingChangeRequestsForNav(TENANT, 'admin');
    expect(hidden.kind).toBe('hidden');
    expect(badgeCountFor(applyNavBadges(staffNavConfig, navBadgeCounts(hidden)))).toBeUndefined();

    h.features.memberChangeApproval = true;
    h.count.mockRejectedValue(new Error('neon down'));
    const unavailable = await readPendingChangeRequestsForNav(TENANT, 'admin');
    expect(unavailable.kind).toBe('unavailable');
    expect(badgeCountFor(applyNavBadges(staffNavConfig, navBadgeCounts(unavailable)))).toBeUndefined();
  });
});
