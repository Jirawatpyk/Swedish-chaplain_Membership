/**
 * F8 Phase 5 Wave B · T122 — `PlanLookupForRenewalPort` stub.
 *
 * Production adapter wraps F2's `getPlan` use-case + adapts its
 * return shape to `PlanFrozenFields` — wiring lands when the public
 * renewal confirm POST route (T130) is built. Test composition uses
 * in-memory mocks per spec.
 */
import type {
  PlanLookupForRenewalPort,
  PlanLookupForRenewalResult,
} from '../../application/ports/plan-lookup-for-renewal';

export const planLookupForRenewalStub: PlanLookupForRenewalPort = {
  async loadPlanFrozenFields(_input: {
    readonly tenantId: string;
    readonly planId: string;
  }): Promise<PlanLookupForRenewalResult> {
    throw new Error(
      'planLookupForRenewalStub.loadPlanFrozenFields was called — wire the ' +
        'real adapter via `makeRenewalsDeps` before invoking T122 plan-change branch.',
    );
  },
};
