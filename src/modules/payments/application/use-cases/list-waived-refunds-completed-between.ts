/**
 * Spec 124 (D-p) — listWaivedRefundsCompletedBetween use-case.
 *
 * The refunds settled with NO §86/10 credit note (the §105 waiver) that
 * completed on a Bangkok-local day in `[from, to]`, for the paid-invoices CSV
 * export: each becomes a negative row in its own month, the way a credit note
 * does, so the file no longer shows a refunded receipt as money kept.
 *
 * A thin Application facade over `RefundsRepo.listWaivedCompletedBetween`, so
 * the invoicing composition root never imports a Repo port (Constitution
 * Principle III).
 */
import { ok, type Result } from '@/lib/result';
import type { RefundsRepo, WaivedRefundExportRow } from '../ports/refunds-repo';

export interface ListWaivedRefundsCompletedBetweenInput {
  readonly tenantId: string;
  /** Inclusive `YYYY-MM-DD` Bangkok-local. */
  readonly from: string;
  /** Inclusive `YYYY-MM-DD` Bangkok-local. */
  readonly to: string;
}

export type ListWaivedRefundsCompletedBetweenOutput = readonly WaivedRefundExportRow[];
export type ListWaivedRefundsCompletedBetweenError = never;

export interface ListWaivedRefundsCompletedBetweenDeps {
  readonly refundsRepo: RefundsRepo;
}

export async function listWaivedRefundsCompletedBetween(
  deps: ListWaivedRefundsCompletedBetweenDeps,
  input: ListWaivedRefundsCompletedBetweenInput,
): Promise<
  Result<ListWaivedRefundsCompletedBetweenOutput, ListWaivedRefundsCompletedBetweenError>
> {
  return ok(
    await deps.refundsRepo.listWaivedCompletedBetween(input.tenantId, {
      from: input.from,
      to: input.to,
    }),
  );
}
