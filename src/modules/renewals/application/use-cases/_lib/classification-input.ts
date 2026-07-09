/**
 * FIX-8(a) (PR #173 review, 2026-07-09) — shared `classifyMembershipPayment`
 * input loader.
 *
 * Every settlement site (confirm-renewal, mark-paid-offline,
 * mark-cycle-complete-from-invoice-paid, resolve-unlinked-membership-payment
 * ×2, admin-renew-lapsed-member) plus the New-invoice form's advisory read
 * (member-renewal-context.ts) repeated the SAME two-read shape immediately
 * before calling `classifyMembershipPayment`:
 *
 *   1. `cyclesRepo.countCyclesForMemberInTx` — ALL cycles ever (used only to
 *      distinguish `heal_no_cycle` from "has at least one cycle row").
 *   2. `cyclesRepo.countSettledCyclesForMemberInTx` — completed-OR-ever-
 *      anchored predecessor count (F2 fix) — but ONLY when an open cycle
 *      exists; `classifyMembershipPayment` never consults it otherwise
 *      (the `heal_no_cycle` / `terminal_only` branches return before
 *      reaching the settled-count check), so callers with a possibly-null
 *      open cycle skip the second read entirely rather than wasting a
 *      round-trip.
 *
 * Extracted here as a pure orchestration helper (no behaviour change) so
 * that shape lives in exactly one place.
 *
 * Pure Application — orchestrates Domain via port interfaces only. No
 * ORM / HTTP / framework / React imports (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';
import type { RenewalCycleRepo } from '../../ports/renewal-cycle-repo';

export type ClassificationCountsDeps = {
  readonly cyclesRepo: Pick<
    RenewalCycleRepo,
    'countCyclesForMemberInTx' | 'countSettledCyclesForMemberInTx'
  >;
};

export interface ClassificationCounts {
  readonly cycleCountForMember: number;
  readonly settledCycleCountForMember: number;
}

/**
 * `openCycleId` — the member's current open cycle's id, or `null` when the
 * caller does not yet know whether an open cycle exists (in which case the
 * settled-history read is skipped — see module docstring).
 */
export async function loadClassificationCounts(
  deps: ClassificationCountsDeps,
  tx: TenantTx,
  tenantId: string,
  memberId: string,
  openCycleId: string | null,
): Promise<ClassificationCounts> {
  const cycleCountForMember = await deps.cyclesRepo.countCyclesForMemberInTx(
    tx,
    tenantId,
    memberId,
  );
  const settledCycleCountForMember = openCycleId
    ? await deps.cyclesRepo.countSettledCyclesForMemberInTx(
        tx,
        tenantId,
        memberId,
        openCycleId,
      )
    : 0;
  return { cycleCountForMember, settledCycleCountForMember };
}
