/**
 * F8 → F2 plan-lookup port (Phase 5 Wave B — T122 plan-change branch).
 *
 * T122 confirm-renewal lets the member optionally pick a different F2
 * plan during the confirm flow (FR-025). The cycle's `frozen_plan_*`
 * columns must atomically update to the new plan's price/term/tier.
 *
 * This port narrows F2's `getPlan` to JUST the fields T122 needs:
 * tier-bucket + price + term + currency. Adapter composition wires
 * F2's full getPlan use-case in the production deps factory; tests
 * pass an in-memory mock returning the desired fields.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

export interface PlanFrozenFields {
  readonly tierBucket: 'thai_alumni' | 'start_up' | 'regular' | 'premium' | 'partnership';
  /** Decimal string mirroring the F2 `priceThb` column. */
  readonly priceTHB: string;
  readonly termMonths: number;
  readonly currency: 'THB' | 'SEK' | 'EUR' | 'USD';
}

export type PlanLookupForRenewalResult =
  | { readonly status: 'found'; readonly plan: PlanFrozenFields }
  | { readonly status: 'not_found' }
  | { readonly status: 'plan_inactive' };

export interface PlanLookupForRenewalPort {
  loadPlanFrozenFields(input: {
    readonly tenantId: string;
    readonly planId: string;
  }): Promise<PlanLookupForRenewalResult>;
}
