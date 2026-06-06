/**
 * F8 Phase 5 Wave C · T133 + T134 spec — `checkLapsedPortalScope`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  checkLapsedPortalScope,
  isLapsedAllowedRoute,
  LAPSED_PORTAL_ALLOWED_PREFIXES,
} from '@/lib/lapsed-portal-scope';
import type { LapsedPortalScopeDeps } from '@/lib/lapsed-portal-scope';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import { buildCycle as buildCycleShared } from '../renewals/_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const MEMBER_ID = 'mem-133';
const CYCLE_UUID = '00000000-0000-0000-0000-0000000c1330';

function buildCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return buildCycleShared({
    tenantId: TENANT_ID,
    cycleId: asCycleId(CYCLE_UUID),
    memberId: MEMBER_ID,
    status: 'lapsed',
    ...overrides,
  });
}

function fakeDeps(args: {
  activeCycle?: RenewalCycle | null;
  emitImpl?: () => Promise<void>;
}): {
  deps: LapsedPortalScopeDeps;
  emitMock: ReturnType<typeof vi.fn>;
  findActiveMock: ReturnType<typeof vi.fn>;
} {
  const findActiveMock = vi.fn(async () => args.activeCycle ?? null);
  const emitMock = vi.fn(args.emitImpl ?? (async () => {}));
  const deps: LapsedPortalScopeDeps = {
    cyclesRepo: { findActiveForMember: findActiveMock as never },
    auditEmitter: { emit: emitMock as never },
  };
  return { deps, emitMock, findActiveMock };
}

const baseCtx = {
  tenantId: TENANT_ID,
  memberId: MEMBER_ID,
  actorUserId: 'user-1',
  correlationId: 'corr-1',
};

describe('checkLapsedPortalScope (T133 + T134)', () => {
  it('whitelisted /portal/renewal/* → allowed without DB lookup', async () => {
    const cycle = buildCycle();
    const { deps, findActiveMock } = fakeDeps({ activeCycle: cycle });
    const r = await checkLapsedPortalScope(deps, {
      ...baseCtx,
      pathname: '/portal/renewal/abc',
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.reason).toBe('route_whitelisted');
    expect(findActiveMock).not.toHaveBeenCalled();
  });

  it('whitelisted /portal/preferences/renewals → allowed', async () => {
    const { deps } = fakeDeps({ activeCycle: buildCycle() });
    const r = await checkLapsedPortalScope(deps, {
      ...baseCtx,
      pathname: '/portal/preferences/renewals',
    });
    expect(r.allowed).toBe(true);
  });

  it('whitelisted /api/portal/renewal/* → allowed', async () => {
    const { deps } = fakeDeps({ activeCycle: buildCycle() });
    const r = await checkLapsedPortalScope(deps, {
      ...baseCtx,
      pathname: '/api/portal/renewal/abc/confirm',
    });
    expect(r.allowed).toBe(true);
  });

  it('non-whitelisted + no active cycle → allowed (not lapsed)', async () => {
    const { deps } = fakeDeps({ activeCycle: null });
    const r = await checkLapsedPortalScope(deps, {
      ...baseCtx,
      pathname: '/portal/dashboard',
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.reason).toBe('not_lapsed');
  });

  it('non-whitelisted + active cycle awaiting_payment → allowed (not lapsed)', async () => {
    const { deps } = fakeDeps({
      activeCycle: buildCycle({ status: 'awaiting_payment' }),
    });
    const r = await checkLapsedPortalScope(deps, {
      ...baseCtx,
      pathname: '/portal/billing',
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.reason).toBe('not_lapsed');
  });

  it('non-whitelisted + active cycle lapsed → blocked + emits audit', async () => {
    const cycle = buildCycle({ status: 'lapsed' });
    const { deps, emitMock } = fakeDeps({ activeCycle: cycle });
    const r = await checkLapsedPortalScope(deps, {
      ...baseCtx,
      pathname: '/portal/dashboard',
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toBe('lapsed_route_blocked');
      expect(r.cycleId).toBe(cycle.cycleId);
    }
    expect(emitMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'lapsed_member_action_blocked',
      payload: { blocked_route: '/portal/dashboard' },
    });
  });

  it('audit emit failure does not mask blocked decision', async () => {
    const cycle = buildCycle({ status: 'lapsed' });
    const { deps } = fakeDeps({
      activeCycle: cycle,
      emitImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    const r = await checkLapsedPortalScope(deps, {
      ...baseCtx,
      pathname: '/portal/dashboard',
    });
    expect(r.allowed).toBe(false);
  });
});

describe('isLapsedAllowedRoute (T134 helper)', () => {
  it.each([
    ['/portal/renewal/abc', true],
    ['/portal/renewal/abc/success', true],
    ['/portal/preferences/renewals', true],
    ['/api/portal/renewal/abc/confirm', true],
    ['/portal/dashboard', false],
    ['/portal/billing', false],
    ['/portal/broadcasts', false],
    ['/api/portal/billing', false],
    // Suggestion review-fix (Phase 5 / US3 backlog close): the bare
    // `startsWith` previously treated `/portal/renewal-evil` as a
    // whitelisted prefix-match. The hardened `matchesScopePrefix`
    // requires the next char to be `/` or `?` (or the strings are
    // equal), so confusable substrings get rejected.
    ['/portal/renewal-evil', false],
    ['/portal/renewal-admin/foo', false],
    ['/portal/preferences-other', false],
    ['/api/portal/preferences/renewals?next=/x', true],
    ['/portal/renewal', true],
    ['/portal/renewal?cycle=1', true],
    // 058 D2: the consolidated Account hub hosts the FR-016 renewal opt-out
    // + GDPR data export — both must stay reachable for a lapsed member.
    // `isLapsedAllowedRoute` matches the PATHNAME only; the `#renewal-prefs`
    // hash the redirect appends never reaches the server, so we assert the
    // bare pathname. The data-export child route is covered by prefix match.
    ['/portal/account', true],
    ['/portal/account/data-export', true],
    // Precision: a confusable substring like /portal/account-settings must
    // NOT match the /portal/account prefix.
    ['/portal/account-settings', false],
  ])('isLapsedAllowedRoute(%s) === %s', (path, expected) => {
    expect(isLapsedAllowedRoute(path)).toBe(expected);
  });

  it('LAPSED_PORTAL_ALLOWED_PREFIXES is non-empty', () => {
    expect(LAPSED_PORTAL_ALLOWED_PREFIXES.length).toBeGreaterThan(0);
  });
});
