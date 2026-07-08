/**
 * Rolling-anchor payment classification (spec 2026-07-08 rev 2 §1).
 * ONE source of truth consumed by: the unlinked-invoice on-paid hook,
 * markCycleCompleteInTx, mark-paid-offline, and the New-invoice form
 * preview. `'reminded'` is a declared-but-never-written status (no writer
 * in src/) — callers loading the open cycle treat it as 'upcoming'.
 */

export interface MembershipPaymentClassificationInput {
  /** ALL cycle rows the member has ever had, any status. */
  readonly cycleCountForMember: number;
  /** The member's open cycle (status upcoming|awaiting_payment), or null. */
  readonly openCycle: {
    readonly status: 'upcoming' | 'awaiting_payment';
    readonly anchoredAt: string | null;
  } | null;
  readonly memberErased: boolean;
}

export type MembershipPaymentClassification =
  | { readonly kind: 'first_payment' }
  | { readonly kind: 'renewal' }
  | { readonly kind: 'heal_no_cycle' }
  | { readonly kind: 'not_applicable'; readonly reason: 'erased' | 'terminal_only' };

export function classifyMembershipPayment(
  input: MembershipPaymentClassificationInput,
): MembershipPaymentClassification {
  if (input.memberErased) return { kind: 'not_applicable', reason: 'erased' };
  if (input.cycleCountForMember === 0) return { kind: 'heal_no_cycle' };
  if (input.openCycle === null) return { kind: 'not_applicable', reason: 'terminal_only' };
  if (input.cycleCountForMember === 1 && input.openCycle.anchoredAt === null) {
    return { kind: 'first_payment' };
  }
  return { kind: 'renewal' };
}
