/**
 * 059-membership-suspension — shared, request-cached read of a member's
 * single most-recent renewal cycle (across ALL statuses, including
 * `lapsed`/`cancelled`, via F8's `findLatestCycleForMember`).
 *
 * Both presentation membership-access reads on an SSR portal page key off the
 * SAME `(tenantId, memberId)` cycle:
 *   - `enforcePortalPageAccess` (layout SSR chokepoint, `portal-page-access.ts`)
 *     → `checkPortalAccess` → the cycle read.
 *   - `loadMembershipAccess` (benefits page / command-palette-root / broadcasts
 *     compose page / admin benefit surfaces) → the raw tri-state.
 * Before this helper the two used DIFFERENT composition paths
 * (`buildPortalAccessDeps`'s direct repo vs `makeRenewalsDeps`), so React's
 * `cache()` could not collapse them and every SSR portal page did TWO
 * identical single-row reads. Routing both through this ONE `cache()`-wrapped
 * function makes it one read per request.
 *
 * Cache scope is a single RSC render — use this ONLY from Server Components
 * (the layout chokepoint + the pages above), never from a route handler. The
 * always-on `requireMemberContext` API gate and the Task-7b bespoke routes
 * (directory / logo / timeline) keep the uncached `buildPortalAccessDeps`
 * repo: each does exactly one read per request, so there is nothing to
 * dedupe there and no reliance on request-scoped `cache()` semantics outside
 * RSC.
 *
 * Uses the lightweight leaf factory `makeDrizzleRenewalCycleRepo` rather than
 * `makeRenewalsDeps` (~20 adapters) — the same escape-hatch the
 * `membershipAccess` bridge adapters use. `src/lib/**` is the exempt
 * composition layer (`eslint.config.mjs`), so the deep infra import is
 * allowed here.
 */
import { cache } from 'react';
import { asTenantContext } from '@/modules/tenants';
import { type RenewalCycle } from '@/modules/renewals';
import { makeDrizzleRenewalCycleRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo';

export const loadLatestCycleForMember = cache(
  async (tenantId: string, memberId: string): Promise<RenewalCycle | null> => {
    return makeDrizzleRenewalCycleRepo(
      asTenantContext(tenantId),
    ).findLatestCycleForMember(tenantId, memberId);
  },
);
