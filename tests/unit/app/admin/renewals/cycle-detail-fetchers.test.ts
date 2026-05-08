/**
 * F8 Phase 6 review-round 2 A2 — unit coverage for cycle-detail
 * display-data fetchers. Pins:
 *   - C4 error semantics: null on member/plan-not-found, throw on
 *     infrastructure error
 *   - TD1 zod parse: malformed JSONB returns null + warn (not crash)
 *   - locale fallback: th → th, sv → sv, anything else → en
 *
 * Stubs the Drizzle path via the runner-injection pattern so the
 * test runs without booting the DB.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  fetchMemberDisplay,
  fetchPlanDisplay,
  type FetchMemberDeps,
  type PlanDisplayRunner,
} from '@/app/(staff)/admin/renewals/[cycleId]/_lib/cycle-detail-fetchers';

const TENANT_SLUG = 'tenanta';
const MEMBER_UUID = '00000000-0000-0000-0000-00000000a201';

describe('fetchMemberDisplay (Phase 6 review-round 2 A2)', () => {
  // Round-3 type-design TD1 reviewed + reverted: typed
  // `vi.fn<typeof memberRepo.findById>()` would catch signature drift
  // on the production repo, but at the cost of either (a) constructing
  // a 17-field `Member` fixture in every test, or (b) scattering
  // `as Member` casts across return values. Per CLAUDE.md "no premature
  // abstraction" and the round-3 review's "BORDERLINE" rating, the
  // localised `as unknown as` cast on the assembled deps object is
  // the lower-cost shape that matches existing project test patterns.
  function makeDeps(opts: {
    findById?: ReturnType<typeof vi.fn>;
    getPrimary?: ReturnType<typeof vi.fn>;
  }): FetchMemberDeps {
    return {
      memberRepo: {
        findById: opts.findById ?? vi.fn(),
      } as unknown as FetchMemberDeps['memberRepo'],
      getPrimaryContact: (opts.getPrimary ??
        vi.fn()) as unknown as FetchMemberDeps['getPrimaryContact'],
    };
  }

  it('returns memberDisplay when member + primary contact resolve', async () => {
    const deps = makeDeps({
      findById: vi.fn(async () =>
        ok({
          memberId: MEMBER_UUID,
          tenantId: TENANT_SLUG,
          companyName: 'Acme Co',
        }),
      ),
      getPrimary: vi.fn(async () => ok('admin@acme.example')),
    });
    const result = await fetchMemberDisplay(
      {
        tenantSlug: TENANT_SLUG,
        memberId: MEMBER_UUID,
        actorUserId: 'u1',
        requestId: 'r1',
      },
      deps,
    );
    expect(result).toEqual({
      companyName: 'Acme Co',
      primaryContact: 'admin@acme.example',
    });
  });

  it('returns null when memberRepo.findById returns Result.err with code repo.not_found', async () => {
    const deps = makeDeps({
      findById: vi.fn(async () => err({ code: 'repo.not_found' as const })),
      getPrimary: vi.fn(),
    });
    const result = await fetchMemberDisplay(
      {
        tenantSlug: TENANT_SLUG,
        memberId: MEMBER_UUID,
        actorUserId: 'u1',
        requestId: 'r1',
      },
      deps,
    );
    expect(result).toBeNull();
    expect(deps.getPrimaryContact).not.toHaveBeenCalled();
  });

  // Round-3 silent-failure C1 regression guardrail: production
  // `f3DrizzleMemberRepo.findById` wraps connection drops / RLS
  // rejects in `Result.err({ code: 'repo.unexpected', cause })`
  // rather than throwing. Without the C1 fix the fetcher silently
  // returned null and the page rendered "—" with no SRE signal.
  it('throws on findById Result.err with code repo.unexpected (infra error)', async () => {
    const cause = new Error('connection lost');
    const deps = makeDeps({
      findById: vi.fn(async () =>
        err({ code: 'repo.unexpected' as const, cause }),
      ),
      getPrimary: vi.fn(),
    });
    await expect(
      fetchMemberDisplay(
        {
          tenantSlug: TENANT_SLUG,
          memberId: MEMBER_UUID,
          actorUserId: 'u1',
          requestId: 'r1',
        },
        deps,
      ),
    ).rejects.toThrow(/member lookup failed: repo\.unexpected/);
    expect(deps.getPrimaryContact).not.toHaveBeenCalled();
  });

  it('returns memberDisplay with null contact when getPrimaryContact returns Result.err', async () => {
    const deps = makeDeps({
      findById: vi.fn(async () =>
        ok({
          memberId: MEMBER_UUID,
          tenantId: TENANT_SLUG,
          companyName: 'No-Contact Co',
        }),
      ),
      getPrimary: vi.fn(async () => err({ kind: 'no_primary_contact' })),
    });
    const result = await fetchMemberDisplay(
      {
        tenantSlug: TENANT_SLUG,
        memberId: MEMBER_UUID,
        actorUserId: 'u1',
        requestId: 'r1',
      },
      deps,
    );
    expect(result).toEqual({
      companyName: 'No-Contact Co',
      primaryContact: null,
    });
  });

  it('throws on findById infrastructure error (caller logs via Promise.allSettled)', async () => {
    const deps = makeDeps({
      findById: vi.fn(async () => {
        throw new Error('connection lost');
      }),
    });
    await expect(
      fetchMemberDisplay(
        {
          tenantSlug: TENANT_SLUG,
          memberId: MEMBER_UUID,
          actorUserId: 'u1',
          requestId: 'r1',
        },
        deps,
      ),
    ).rejects.toThrow('connection lost');
  });
});

describe('fetchPlanDisplay (Phase 6 review-round 2 A2)', () => {
  it('returns localised name (en fallback) when JSONB has only en', async () => {
    const runner: PlanDisplayRunner = vi.fn(async () => [
      { planName: { en: 'Premium Corporate' } },
    ]);
    const result = await fetchPlanDisplay(
      { tenantSlug: TENANT_SLUG, planId: 'premium', locale: 'en' },
      runner,
    );
    expect(result).toEqual({ localisedName: 'Premium Corporate' });
  });

  it('returns th-localised name when locale=th and JSONB has th', async () => {
    const runner: PlanDisplayRunner = vi.fn(async () => [
      { planName: { en: 'Premium Corporate', th: 'พรีเมียม คอร์ปอเรท' } },
    ]);
    const result = await fetchPlanDisplay(
      { tenantSlug: TENANT_SLUG, planId: 'premium', locale: 'th' },
      runner,
    );
    expect(result).toEqual({ localisedName: 'พรีเมียม คอร์ปอเรท' });
  });

  it('returns sv-localised name when locale=sv and JSONB has sv', async () => {
    const runner: PlanDisplayRunner = vi.fn(async () => [
      { planName: { en: 'Premium', sv: 'Premium Företag' } },
    ]);
    const result = await fetchPlanDisplay(
      { tenantSlug: TENANT_SLUG, planId: 'premium', locale: 'sv' },
      runner,
    );
    expect(result).toEqual({ localisedName: 'Premium Företag' });
  });

  it('falls back to en when th locale requested but JSONB lacks th', async () => {
    const runner: PlanDisplayRunner = vi.fn(async () => [
      { planName: { en: 'Premium' } },
    ]);
    const result = await fetchPlanDisplay(
      { tenantSlug: TENANT_SLUG, planId: 'premium', locale: 'th' },
      runner,
    );
    expect(result).toEqual({ localisedName: 'Premium' });
  });

  // Round-3 test-coverage TestQ1 fix: planNameSchema accepts empty
  // string for th/sv (no `.min(1)` on the optional fields). Verify
  // the OR-fallback expression treats `''` as falsy and falls
  // through to `en` so a malformed-empty TH translation doesn't
  // render as a blank pill.
  it('falls back to en when th locale requested and JSONB has empty-string th', async () => {
    const runner: PlanDisplayRunner = vi.fn(async () => [
      { planName: { en: 'Premium', th: '' } },
    ]);
    const result = await fetchPlanDisplay(
      { tenantSlug: TENANT_SLUG, planId: 'premium', locale: 'th' },
      runner,
    );
    expect(result).toEqual({ localisedName: 'Premium' });
  });

  it('returns null when no row matches the planId', async () => {
    const runner: PlanDisplayRunner = vi.fn(async () => []);
    const result = await fetchPlanDisplay(
      { tenantSlug: TENANT_SLUG, planId: 'gone', locale: 'en' },
      runner,
    );
    expect(result).toBeNull();
  });

  it('returns null when JSONB shape fails zod parse (TD1 — silent degradation, not crash)', async () => {
    const runner: PlanDisplayRunner = vi.fn(async () => [
      { planName: { th: 'orphan th-only without en' } },
    ]);
    const result = await fetchPlanDisplay(
      { tenantSlug: TENANT_SLUG, planId: 'malformed', locale: 'en' },
      runner,
    );
    expect(result).toBeNull();
  });

  it('throws on runner infrastructure error (caller logs via Promise.allSettled)', async () => {
    const runner: PlanDisplayRunner = vi.fn(async () => {
      throw new Error('rls denied');
    });
    await expect(
      fetchPlanDisplay(
        { tenantSlug: TENANT_SLUG, planId: 'premium', locale: 'en' },
        runner,
      ),
    ).rejects.toThrow('rls denied');
  });
});
