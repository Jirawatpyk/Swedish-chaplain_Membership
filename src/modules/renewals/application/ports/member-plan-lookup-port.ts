/**
 * F8-completion Slice 3 · Task 3.1 — F8 → F3 member-plan lookup port.
 *
 * The admin lapsed-comeback use-case (`admin-renew-lapsed-member`) must
 * resolve the member's CURRENT `plan_id` server-side — the frozen
 * §86/4 price is derived from the member's live plan, NEVER from a
 * request body (a renewal invoice is a price-tampering surface on a tax
 * document; same discipline as `confirm-renewal`'s `frozenPlanPriceThb`).
 *
 * This port narrows F3's `MemberRepo.findByIdInTx` to JUST the field the
 * admin-renew path needs: the member's `plan_id`. Keeping it a narrow
 * F8-owned port (rather than depending on the full F3 `Member`
 * aggregate) preserves Clean Architecture (Constitution Principle III):
 * the use-case stays free of F3 internals and the unit test mocks a
 * one-method interface.
 *
 * In-tx by design: the read participates in the caller's `runInTenant`
 * tx (tenant scope via the inherited GUC + RLS, NOT a WHERE clause —
 * same precedent as `findActiveForMemberInTx`) so the member lookup +
 * the cycle creation are atomic. Returns `null` when the member is
 * absent OR cross-tenant (RLS filters it) — the use-case maps `null` to
 * `member_not_found`.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';

export interface MemberPlanLookupResult {
  /** The member's current F2 plan id (drives the frozen §86/4 price). */
  readonly planId: string;
}

export interface MemberPlanLookupPort {
  /**
   * Resolve a member's current `plan_id` inside the caller's tx.
   * Returns `null` when the member does not exist in the current tenant
   * (absent OR cross-tenant — RLS makes both indistinguishable, which
   * is the desired no-oracle behaviour for an admin probe).
   */
  loadMemberPlanInTx(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<MemberPlanLookupResult | null>;
}
