/**
 * F8-completion Slice 1 · Task 1.6 — F3 → F8 create-member onboarding
 * bridge.
 *
 * F8 listener registration for the F3 member-create event. A single
 * listener runs POST-COMMIT on every new member created via the admin
 * `createMember` use-case: it creates the member's INITIAL renewal cycle
 * (anchored at the member's `registration_date`, frozen at the resolved
 * plan price) so the new member enters the renewal pipeline.
 *
 * This is the **post-launch onboarding** arm only — the initial 131-member
 * SweCham cohort is cold-started by the import (Task 1.7), not by this
 * listener.
 *
 * Mirrors `f2-plan-change-bridge.ts:f8OnManualPlanChangeCallbacks`: the
 * factory builds the F8 deps via `makeRenewalsDeps(tenantId)`, and the
 * listener opens its OWN `runInTenant(deps.tenant, …)` tx (re-establishing
 * RLS) and calls the shared `createCycleInTx` helper.
 *
 * **Failure semantics — the listener DELIBERATELY does NOT swallow.**
 *
 * Unlike the plan-change bridge (whose `wrapListener` catches + counts
 * internally), this listener lets `createCycleInTx`'s throw propagate to
 * `createMember`'s post-commit invoke loop, which is the canonical swallow
 * site: it logs + bumps `renewalsMetrics.bootstrapCycleCreateFailed` +
 * returns `ok` (the member is already committed; see create-member.ts).
 * Routing the swallow through the use-case loop keeps a single best-effort
 * contract — a raw throwing listener and this factory listener behave
 * identically (the unit test exercises the raw path; the integration test
 * exercises this one). createCycleInTx is idempotent via
 * `findActiveForMemberInTx`, so a future replay (admin re-trigger) is a
 * safe no-op.
 *
 * Pure Infrastructure — only `@/lib/db` (runInTenant) + `createCycleInTx`
 * + `makeRenewalsDeps` + `node:crypto` + the cycle-id brand imports.
 */
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import type { CreateMemberListener } from '@/modules/members';
import { createCycleInTx } from '../../application/use-cases/create-cycle-in-tx';
import { asCycleId } from '../../domain/renewal-cycle';
import { makeRenewalsDeps } from '../renewals-deps';

/**
 * F8 onboarding-listener factory. Returns an array of best-effort
 * callbacks invoked by F3's `createMember` POST-COMMIT — after the member
 * + primary contact + audit rows have committed durably. The single
 * listener opens its OWN `runInTenant` tx and creates the member's initial
 * renewal cycle. The array shape matches `CreateMemberDeps.onboardingListeners`
 * (`ReadonlyArray<CreateMemberListener>`) so the route can spread it in.
 */
export function f8OnCreateMemberCallbacks(
  tenantId: string,
): ReadonlyArray<CreateMemberListener> {
  const deps = makeRenewalsDeps(tenantId);
  return [
    async (evt) => {
      await runInTenant(deps.tenant, async (tx) => {
        await createCycleInTx(
          {
            cyclesRepo: deps.cyclesRepo,
            planLookup: deps.planLookupForRenewal,
            auditEmitter: deps.auditEmitter,
            idFactory: { cycleId: () => asCycleId(randomUUID()) },
          },
          tx,
          {
            tenantId: evt.tenantId,
            memberId: evt.memberId,
            // The cycle is anchored at the member's registration_date.
            periodFrom: evt.registrationDate,
            planId: evt.planId,
            source: 'onboarding',
            actorUserId: null,
            actorRole: 'system',
            correlationId: evt.correlationId,
          },
        );
      });
    },
  ];
}
