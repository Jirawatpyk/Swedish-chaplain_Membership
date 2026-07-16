/**
 * 066-renewal-swecham-round2 §4.4(1)/§7 — `MembershipAccessPort` adapter
 * (F4 Invoicing). The 4th copy of the consumer-owns-port convention
 * (F3 members / F6 events / F7 broadcasts each ship an identical adapter).
 *
 * Composes F8's pure `deriveMembershipAccess` predicate with F8's
 * `findLatestCycleForMember` repo method at the F4 composition root, via
 * the SAME leaf-factory escape hatch the sibling adapters use — the
 * Infrastructure repo factory `makeDrizzleRenewalCycleRepo` is imported
 * directly rather than routed through F8's full `makeRenewalsDeps()`,
 * because:
 *
 *   1. `makeRenewalsDeps` wires ~20 adapters this port needs none of — a
 *      single repo factory is the minimal dependency surface.
 *   2. Depending on F8's OWN composition root risks an import cycle if F8
 *      ever wires an invoicing-side port back in. `makeDrizzleRenewalCycleRepo`
 *      is a leaf factory (no import back into `invoicing/**`) — confirmed
 *      via `pnpm typecheck`. The plan's Constitution Check §7 pre-declares
 *      this documented Principle III deviation.
 *
 * FAIL-OPEN consumer (design §4.4(1), F6 events precedent — NOT the
 * F3/F7 fail-closed one): `recordPayment` treats a lookup error as
 * access='full' so the money path stays available; the §4.4(2) heal-site
 * audit net is the backstop that records any payment that slips through.
 * The fail-open decision lives in the CONSUMER — this adapter only reports
 * `err` on failure, never throws.
 *
 * Clock: `deriveMembershipAccess` is a pure Domain predicate taking an
 * injected `now: Date`; only this Infrastructure adapter reads the wall
 * clock. Uses invoicing's own `systemClock` (`ClockPort.nowIso()`), a
 * same-module zero-import leaf.
 */
import { logger } from '@/lib/logger';
import { err, ok } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { deriveMembershipAccess } from '@/modules/renewals';
import { makeDrizzleRenewalCycleRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo';
import { systemClock } from '../application/ports/clock-port';
import type { MembershipAccessPort } from '../application/ports/membership-access-port';

export const membershipAccessBridge: MembershipAccessPort = {
  async getMembershipAccess(tenant: TenantContext, memberId: string) {
    try {
      const cyclesRepo = makeDrizzleRenewalCycleRepo(tenant);
      const cycle = await cyclesRepo.findLatestCycleForMember(tenant.slug, memberId);
      const { access, reason } = deriveMembershipAccess(
        cycle,
        new Date(systemClock.nowIso()),
      );
      return ok({ access, reason });
    } catch (e) {
      // Log before mapping to the opaque `lookup_error` kind so ops can
      // tell WHY the gate could not evaluate (DB timeout vs schema drift
      // vs bad id) — the consumer then fails OPEN. Lockstep with the
      // sibling adapters.
      logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          tenantSlug: tenant.slug,
          memberId,
        },
        '[invoicing/membership-access-bridge] access lookup failed — consumer will fail open',
      );
      return err({ kind: 'membership_access.lookup_error' as const });
    }
  },
};
