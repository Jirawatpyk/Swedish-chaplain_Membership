/**
 * 059-membership-suspension Task 6 — `MembershipAccessPort` adapter (F3).
 *
 * Composes F8's pure `deriveMembershipAccess` predicate with F8's
 * `findLatestCycleForMember` repo method at the F3 composition root — the
 * SAME escape-hatch pattern already used by F7's sibling adapter
 * (`src/modules/broadcasts/infrastructure/membership-access-bridge.ts`,
 * 059-membership-suspension Task 4): the Infrastructure repo factory is
 * imported directly rather than routed through F8's full
 * `makeRenewalsDeps()` composition, because:
 *
 *   1. `makeRenewalsDeps` wires ~20 adapters this port needs none of — a
 *      single repo factory is the minimal dependency surface.
 *   2. Depending on `makeRenewalsDeps` (F8's OWN composition root) here
 *      risks an import cycle if F8 ever wires a members-side port back in.
 *      `makeDrizzleRenewalCycleRepo` is a leaf factory (no import back
 *      into `members/**`) — confirmed via `pnpm typecheck`.
 *
 * F3 defines its OWN copy of this adapter rather than importing F7's
 * `membershipAccessBridge` — Task 6's explicit constraint is "F3 must NOT
 * depend on F7", and reusing an Infrastructure export across module
 * boundaries at the composition root would also violate Constitution
 * Principle III ("Presentation… never touches… Infrastructure directly" —
 * `members-deps.ts`, the real composition root exercised by
 * `tests/integration/members/invite-orphan-followup.test.ts`, lives
 * INSIDE the members module, so importing `@/modules/broadcasts/
 * infrastructure/**` there would be a genuine F3→F7 coupling). This F3
 * adapter's only cross-module dependency is F3→F8 (renewals), which is
 * already an established crossing point in this module (see
 * `./infrastructure/adapters/renewals-cascade-adapter.ts`).
 *
 * Clock: `deriveMembershipAccess` is a pure Domain predicate that takes an
 * injected `now: Date` — only this Infrastructure adapter may read the
 * wall clock. Uses invoicing's `systemClock` (`ClockPort.nowIso()`) rather
 * than a raw `new Date()` — a zero-import leaf module, same cross-module
 * precedent as the F7 sibling adapter.
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
import type {
  MembershipAccessPort,
  MembershipAccessSummary,
} from '../application/ports/membership-access-port';

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
      // in lockstep with the F7 sibling adapter
      // (`src/modules/broadcasts/infrastructure/membership-access-bridge.ts`).
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

  async getMembershipAccessMany(tenant: TenantContext, memberIds: readonly string[]) {
    try {
      if (memberIds.length === 0) {
        return ok(new Map() as ReadonlyMap<string, MembershipAccessSummary>);
      }
      const cyclesRepo = makeDrizzleRenewalCycleRepo(tenant);
      // ONE `DISTINCT ON (member_id)` query, ordered created_at DESC +
      // cycle_id DESC — the SAME "latest" key the singular
      // `findLatestCycleForMember` uses, so this batched path and the
      // suspension gate can never disagree about which cycle is latest
      // (documented invariant on the repo port).
      const cycles = await cyclesRepo.findLatestCyclesForMembers(tenant.slug, memberIds);
      const byMember = new Map(cycles.map((c) => [c.memberId, c]));

      // Read the clock ONCE for the whole batch so every member in a
      // single request is classified against the same instant — a
      // per-member `now` could straddle a grace-expiry boundary and
      // classify two identical members differently.
      const now = new Date(systemClock.nowIso());
      const result = new Map<string, MembershipAccessSummary>();
      for (const memberId of memberIds) {
        // `?? null` is load-bearing: members with no cycle are ABSENT
        // from the query result, and `deriveMembershipAccess(null, now)`
        // is defined to return `full` — so they must be classified, not
        // dropped from the map.
        const { access, reason } = deriveMembershipAccess(
          byMember.get(memberId) ?? null,
          now,
        );
        result.set(memberId, { access, reason });
      }
      return ok(result as ReadonlyMap<string, MembershipAccessSummary>);
    } catch (e) {
      logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          tenantSlug: tenant.slug,
          memberCount: memberIds.length,
        },
        '[membership-access-bridge] batched access lookup failed — failing closed',
      );
      // Fail closed for the WHOLE batch — never a partial map, so a
      // caller cannot mistake an unresolved member for a permitted one.
      return err({ kind: 'membership_access.lookup_error' as const });
    }
  },
};
