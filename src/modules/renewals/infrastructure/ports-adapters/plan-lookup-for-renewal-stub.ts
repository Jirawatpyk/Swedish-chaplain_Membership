/**
 * F8 Phase 5 Wave B · T122 — `PlanLookupForRenewalPort` test-only stub.
 *
 * The production drizzle adapter ships in
 * `plan-lookup-for-renewal-drizzle.ts` (deep-imports F2 schema for
 * `renewal_tier_bucket`) and is wired into `renewals-deps.ts`. This
 * stub remains as a defence-in-depth fallback that loud-throws rather
 * than no-op'ing if test composition forgets to override; production
 * code paths CANNOT accidentally rely on it because the deps factory
 * selects the drizzle adapter directly.
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
