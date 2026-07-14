/**
 * 059-membership-suspension Task 4 — `MembershipAccessPort` adapter (F7).
 *
 * Composes F8's pure `deriveMembershipAccess` predicate (Task 1) with F8's
 * `findLatestCycleForMember` repo method (Task 2) at the F7 composition
 * root — same escape-hatch pattern documented in `plans-bridge.ts` (F2 →
 * F7): the Infrastructure repo factory is imported directly rather than
 * routed through F8's full `makeRenewalsDeps()` composition, because:
 *
 *   1. `makeRenewalsDeps` wires ~20 adapters (email gateway, at-risk
 *      scorer, tier-upgrade repos, …) this port needs none of — a single
 *      repo factory is the minimal dependency surface.
 *   2. `makeRenewalsDeps` is F8's OWN composition root; a future task is
 *      very likely to wire `membershipAccessBridge` back INTO F8's or
 *      F7's composition root (e.g. `broadcasts-deps.ts`) as a dependency
 *      of some other use-case. Depending on `makeRenewalsDeps` (or on
 *      `broadcasts-deps.ts`'s own `systemClock` export) here would set up
 *      exactly that import cycle. `makeDrizzleRenewalCycleRepo` is a leaf
 *      factory (no import back into `broadcasts/**`) — confirmed via
 *      `pnpm typecheck`.
 *
 * Clock: `deriveMembershipAccess` is a pure Domain predicate that takes an
 * injected `now: Date` — only this Infrastructure adapter may read the
 * wall clock. Uses invoicing's `systemClock` (`ClockPort.nowIso()`) rather
 * than a raw `new Date()` — it is a zero-import leaf module (no risk of
 * pulling in another module's composition root) with existing cross-module
 * precedent at `src/lib/invoicing-cert-prune-deps.ts`.
 *
 * Every failure path (bad tenant/member id, DB error, malformed row) is
 * caught and mapped to `err({ kind: 'membership_access.lookup_error' })` —
 * never a throw — so callers can fail CLOSED (treat a lookup failure as
 * non-full access) instead of accidentally granting access on an
 * unexpected error.
 */
import { logger } from '@/lib/logger';
import { err, ok } from '@/lib/result';
import { systemClock } from '@/modules/invoicing/application/ports/clock-port';
import type { TenantContext } from '@/modules/tenants';
import { deriveMembershipAccess } from '@/modules/renewals';
import { makeDrizzleRenewalCycleRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo';
import type { MembershipAccessPort } from '../application/ports/membership-access-port';

export const membershipAccessBridge: MembershipAccessPort = {
  async getMembershipAccess(tenant: TenantContext, memberId: string) {
    try {
      const cyclesRepo = makeDrizzleRenewalCycleRepo(tenant);
      const cycle = await cyclesRepo.findLatestCycleForMember(tenant.slug, memberId);
      const { access, reason } = deriveMembershipAccess(cycle, new Date(systemClock.nowIso()));
      return ok({ access, reason });
    } catch (e) {
      // SHOULD-FIX (Slice-1 whole-branch review, observability): log before
      // mapping to the opaque `lookup_error` kind so ops can tell WHY a
      // write use-case (F7 submit, F3 invite) failed CLOSED — DB timeout vs
      // schema drift vs bad tenant — instead of a silent fail-closed. Kept
      // in lockstep with the F3 sibling adapter
      // (`src/modules/members/infrastructure/membership-access-bridge.ts`).
      logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          tenantSlug: tenant.slug,
          memberId,
        },
        '[membership-access-bridge] access lookup failed — failing closed',
      );
      return err({ kind: 'membership_access.lookup_error' as const });
    }
  },
};
