/**
 * 059-membership-suspension Task 9 — `loadSettlementPreview` use-case.
 *
 * Read-only foundation for the future bulk "Mark paid" confirm dialog (⑨):
 * given a batch of `cycleIds`, returns each cycle's live linked-bill THB
 * total (or a non-previewable stub) plus the batch total. Pure query — no
 * writes, no lock.
 *
 * The repo (`RenewalCycleRepo.loadSettlementPreview`) already applies the
 * previewable gate (live `issued` invoice only — see
 * `SettlementPreviewRow.previewable`); this use-case's own job is just the
 * input-bounds guard + the truthful summation: ONLY previewable rows
 * contribute to `totalThbMinor`, so a stale/orphan link (already
 * paid/void/credited) can never inflate the bulk bank-transfer total an
 * operator is about to act on.
 *
 * Imports ONLY the port + `@/lib/result` (Constitution Principle III) — no
 * ORM/HTTP/framework import here.
 */
import { ok, err, type Result } from '@/lib/result';
import type { RenewalCycleRepo, SettlementPreviewRow } from '../ports/renewal-cycle-repo';

/** Caps a single bulk "Mark paid" preview batch. */
const MAX_CYCLES = 100;

export interface LoadSettlementPreviewInput {
  readonly tenantId: string;
  readonly cycleIds: ReadonlyArray<string>;
}
export interface SettlementPreviewResult {
  readonly items: ReadonlyArray<SettlementPreviewRow>;
  readonly totalThbMinor: number;
}
export type LoadSettlementPreviewError = { kind: 'invalid_input'; message: string };

export async function loadSettlementPreview(
  deps: { renewalCycleRepo: Pick<RenewalCycleRepo, 'loadSettlementPreview'> },
  input: LoadSettlementPreviewInput,
): Promise<Result<SettlementPreviewResult, LoadSettlementPreviewError>> {
  if (input.cycleIds.length === 0 || input.cycleIds.length > MAX_CYCLES) {
    return err({ kind: 'invalid_input', message: `cycleIds must be 1..${MAX_CYCLES}` });
  }
  const items = await deps.renewalCycleRepo.loadSettlementPreview({
    tenantId: input.tenantId,
    cycleIds: input.cycleIds,
  });
  // Review round 1 fix F — `total_thb_minor` asserts THB; require
  // `currency === 'THB'` alongside `previewable`/non-null as defence-in-
  // depth. Every live row today IS THB (the repo doesn't populate
  // non-THB currencies yet), so this guards a FUTURE non-THB invoice from
  // ever being summed as satang, not a bug reachable today.
  const totalThbMinor = items.reduce(
    (sum, r) =>
      r.previewable && r.amountThbMinor !== null && r.currency === 'THB'
        ? sum + r.amountThbMinor
        : sum,
    0,
  );
  return ok({ items, totalThbMinor });
}
