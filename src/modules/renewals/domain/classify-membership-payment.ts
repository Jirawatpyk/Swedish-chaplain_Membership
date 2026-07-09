/**
 * Rolling-anchor payment classification (spec 2026-07-08 rev 2 §1).
 * ONE source of truth consumed by: the unlinked-invoice on-paid hook,
 * markCycleCompleteInTx, mark-paid-offline, and the New-invoice form
 * preview. `'reminded'` is a declared-but-never-written status (no writer
 * in src/) — callers loading the open cycle treat it as 'upcoming'.
 */

export interface MembershipPaymentClassificationInput {
  /**
   * ALL cycle rows the member has ever had, any status. Used ONLY to
   * distinguish `heal_no_cycle` (zero rows ever) from "has at least one
   * cycle row" — NOT the first_payment/renewal discriminator (see
   * `settledCycleCountForMember` below).
   */
  readonly cycleCountForMember: number;
  /**
   * Count of the member's cycles — EXCLUDING the current open cycle —
   * that represent a SETTLED renewal: status `'completed'` OR
   * `anchored_at IS NOT NULL`. A member whose only prior cycles are
   * cancelled/lapsed WITHOUT ever anchoring (i.e. they never actually
   * paid) has `settledCycleCountForMember === 0`, so their first real
   * payment still classifies `first_payment` even though
   * `cycleCountForMember > 0` (F2 fix, final-review 2026-07-09 — closes a
   * bug where a cancelled-only-history member's comeback payment was
   * misclassified `renewal`, skipping the re-anchor and completing
   * against a stale provisional period the member never actually paid
   * for).
   */
  readonly settledCycleCountForMember: number;
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
  if (input.settledCycleCountForMember === 0 && input.openCycle.anchoredAt === null) {
    return { kind: 'first_payment' };
  }
  return { kind: 'renewal' };
}
