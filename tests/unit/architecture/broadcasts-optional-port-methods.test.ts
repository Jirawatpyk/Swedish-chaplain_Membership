/**
 * Architecture guard — production broadcasts repos MUST implement the
 * OPTIONAL port methods that use-cases fall back on (re-review #9/#10).
 *
 * Three port methods are declared OPTIONAL so the ~13 existing repo mocks
 * don't have to implement them:
 *   - `MarketingUnsubscribesRepo.upsertStandalone`      (batch-webhook suppression, bug #10)
 *   - `BroadcastsRepo.recheckMemberQuotaUnderLock`      (quota TOCTOU recheck, bug #4)
 *   - `BroadcastsRepo.referencedAudienceIdsForBroadcasts` (orphan-reclaim safety, bug #16)
 *
 * The optionality means a use-case takes a DEGRADED fallback path when the
 * method is absent (e.g. batch suppression is silently skipped — an
 * FR-027/FR-030 gap). That's fine for mocks, but a future refactor that
 * drops one of these methods from the PRODUCTION drizzle repo would ship a
 * silent no-op with no test failure. This guard converts that regression
 * into a loud failure: it instantiates the real drizzle repos and asserts
 * each method is present + callable. If a method is renamed/removed, this
 * test fails at build-gate time.
 *
 * Instantiating the factory is DB-free (it only captures the tenant slug +
 * builds method closures); no query runs, so this stays a pure unit test.
 */
import { describe, it, expect } from 'vitest';
import {
  makeDrizzleBroadcastsRepo,
  makeDrizzleMarketingUnsubscribesRepo,
} from '@/modules/broadcasts';

const TENANT = 'swecham';

describe('broadcasts optional port methods — production wiring guard (#9/#10)', () => {
  it('MarketingUnsubscribesRepo drizzle impl implements upsertStandalone', () => {
    const repo = makeDrizzleMarketingUnsubscribesRepo(TENANT);
    expect(typeof repo.upsertStandalone).toBe('function');
  });

  it('BroadcastsRepo drizzle impl implements recheckMemberQuotaUnderLock', () => {
    const repo = makeDrizzleBroadcastsRepo(TENANT);
    expect(typeof repo.recheckMemberQuotaUnderLock).toBe('function');
  });

  it('BroadcastsRepo drizzle impl implements referencedAudienceIdsForBroadcasts', () => {
    const repo = makeDrizzleBroadcastsRepo(TENANT);
    expect(typeof repo.referencedAudienceIdsForBroadcasts).toBe('function');
  });
});
