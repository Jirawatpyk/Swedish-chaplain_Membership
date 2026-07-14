/**
 * 059-membership-suspension Task 17 — `MembershipAccessPort` adapter (F6).
 *
 * Composes F8's pure `deriveMembershipAccess` predicate with F8's
 * `findLatestCycleForMember` repo method at the F6 composition root —
 * the SAME escape-hatch pattern already used by the F3 + F7 sibling
 * adapters (`src/modules/members/infrastructure/membership-access-bridge.ts`,
 * `src/modules/broadcasts/infrastructure/membership-access-bridge.ts`):
 * the Infrastructure repo factory is imported directly rather than
 * routed through F8's full `makeRenewalsDeps()` composition, because:
 *
 *   1. `makeRenewalsDeps` wires ~20 adapters this port needs none of — a
 *      single repo factory is the minimal dependency surface.
 *   2. Depending on `makeRenewalsDeps` (F8's OWN composition root) here
 *      risks an import cycle if F8 ever wires an events-side port back
 *      in. `makeDrizzleRenewalCycleRepo` is a leaf factory (no import
 *      back into `events/**`).
 *
 * Unlike the F3/F7 siblings — whose Application layer already carries a
 * `TenantContext` — F6's Application layer works in the tenant's raw
 * slug string (`TenantId`, F6's own branded alias; see `di.ts`'s
 * `asTenantContext(tenantId)` precedent). This Infrastructure adapter
 * (not the Application port) is the right place to do that string →
 * `TenantContext` conversion, keeping the port's own signature aligned
 * with every other F6 Application-layer port.
 *
 * Clock: `deriveMembershipAccess` is a pure Domain predicate that takes an
 * injected `now: Date` — only this Infrastructure adapter may read the
 * wall clock. Uses invoicing's `systemClock` (`ClockPort.nowIso()`) rather
 * than a raw `new Date()` — a zero-import leaf module, same cross-module
 * precedent as the F3/F7 sibling adapters.
 *
 * Every failure path (bad tenant/member id, DB error, malformed row) is
 * caught and mapped to `err({ kind: 'membership_access.lookup_error' })` —
 * never a throw — so the caller (`import-csv.ts`) can fail OPEN on the
 * warning (skip flagging the row rather than risk a false positive; the
 * attendance row is recorded either way — see the port's own doc comment).
 */
import { logger } from '@/lib/logger';
import { err, ok } from '@/lib/result';
import { systemClock } from '@/modules/invoicing/application/ports/clock-port';
import type { TenantId, MemberId } from '@/modules/members';
import { asTenantContext } from '@/modules/tenants';
import { deriveMembershipAccess } from '@/modules/renewals';
import { makeDrizzleRenewalCycleRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo';
import type { MembershipAccessPort } from '../application/ports/membership-access-port';

export const membershipAccessBridge: MembershipAccessPort = {
  async getMembershipAccess(tenantId: TenantId, memberId: MemberId) {
    try {
      const tenant = asTenantContext(tenantId);
      const cyclesRepo = makeDrizzleRenewalCycleRepo(tenant);
      const cycle = await cyclesRepo.findLatestCycleForMember(tenant.slug, memberId);
      const { access, reason } = deriveMembershipAccess(cycle, new Date(systemClock.nowIso()));
      return ok({ access, reason });
    } catch (e) {
      logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          tenantId,
          memberId,
        },
        '[F6 membership-access-bridge] access lookup failed for the CSV-import suspended-member check — no warning will be attached to this row',
      );
      return err({ kind: 'membership_access.lookup_error' as const });
    }
  },
};
