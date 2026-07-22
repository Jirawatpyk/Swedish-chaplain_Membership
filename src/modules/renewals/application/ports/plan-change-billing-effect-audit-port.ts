/**
 * Plan-change -> billing remediation (Package A) — narrow renewals-owned
 * audit port for the `member_plan_change_billing_effect` event.
 *
 * The event type is OWNED by F3 members (`F3AuditEventType` union), but the
 * `seed_fallback_plan_unresolvable` variant is decided at the F8 renewals
 * seed seams (`create-next-cycle-on-paid` + `resolve-unlinked-membership-
 * payment` renewalComplete). Renewals cannot import the members `AuditPort`
 * (Clean Architecture, Constitution Principle III — Application orchestrates
 * its OWN ports), so this narrow renewals-owned port lets those use-cases
 * emit the shared pgEnum value; its Drizzle adapter writes `audit_log`
 * directly (same mechanism as the F8 `RenewalAuditEmitter`). It is
 * DELIBERATELY separate from `RenewalAuditEmitter` — that port's
 * `F8_AUDIT_EVENT_TYPES` tuple is compile-pinned at exactly 70, and this is
 * not an F8 event.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';

/**
 * All billing-effect outcomes recorded by `member_plan_change_billing_effect`.
 * Package A emits `seed_fallback_plan_unresolvable` (from the next-cycle seed
 * seams); the F8 tier-upgrade apply emits `tier_upgrade_target_unresolvable`
 * (see below); the members change-plan operation emits the remaining variants
 * (a later package). The full union is registered here so the payload shape is
 * documented in one place.
 *
 * `effect` is a free JSONB payload field (no DB CHECK / pgEnum backing — the
 * `member_plan_change_billing_effect` audit_event_type is the only enum value,
 * shipped in migration 0270), so adding a variant here is a pure TS change.
 */
export type PlanChangeBillingEffect =
  | 'applied_to_open_cycle'
  | 'deferred_invoice_already_issued'
  | 'deferred_term_length_change'
  | 'deferred_immediate_not_enabled'
  | 'no_open_cycle'
  | 'seed_fallback_plan_unresolvable'
  /**
   * The F8 tier-upgrade apply (`applyPendingTierUpgradeInTx` →
   * `flipMemberPlanForUpgradeInTx`) SKIPPED the `members.plan_id` flip because
   * the accepted upgrade's target plan is unresolvable for the applied cycle's
   * fiscal year (the exact-year OFFER lookup returned a non-`found` status, or
   * threw). The member is left on the prior/lower plan — never over-billed —
   * but the paid upgrade did NOT take effect, so an operator must reconcile
   * (fix the plan-year catalogue then replay). Kept DISTINCT from
   * `seed_fallback_plan_unresolvable` (the next-cycle SEED path) so forensic
   * queries can tell the two "plan unresolvable" scenarios apart.
   */
  | 'tier_upgrade_target_unresolvable';

export interface PlanChangeBillingEffectAuditContext {
  readonly tenantId: string;
  /** Actor user id, or null for a system/webhook-driven emit. */
  readonly actorUserId: string | null;
  /** Correlation id (doubles as `request_id` when none is supplied). */
  readonly correlationId: string;
}

/** Payload fields — English keys per repo convention (see the members audit-port union). */
export interface PlanChangeBillingEffectInput {
  readonly memberId: string;
  readonly oldPlanId: string;
  readonly newPlanId: string;
  readonly cycleId: string | null;
  readonly effect: PlanChangeBillingEffect;
  readonly oldPriceThb: string | null;
  readonly newPriceThb: string | null;
  readonly effectiveFrom: string | null;
  readonly blockingInvoiceId: string | null;
  readonly blockingSource: 'linked' | 'member_scoped' | null;
}

export interface PlanChangeBillingEffectAuditPort {
  /**
   * Write the `member_plan_change_billing_effect` row inside the caller's tx
   * so state + audit commit atomically (Constitution Principle VIII). THROWS
   * on any failure so the caller's tx rolls back — never fire-and-forget.
   */
  emitInTx(
    tx: TenantTx,
    ctx: PlanChangeBillingEffectAuditContext,
    input: PlanChangeBillingEffectInput,
  ): Promise<void>;
}
