'use client';

/**
 * Task 10 (US3 scaffolding) — `PipelineWithBulk` client wrapper.
 *
 * Pass-through wrapper around `<PipelineTable>` that additionally wires row
 * selection: forwards every prop the page already passes to `PipelineTable`
 * (`sort`/`sortHrefs`/`resultCount`/`monthKind`/`monthLabel`) unchanged, and
 * layers `canMutate={isAdmin}` + `enableSelection={isAdmin}` +
 * `onSelectionChange` + `clearSelectionNonce` on top.
 *
 * Mirrors `directory-with-bulk.tsx`'s `selectedIds`/`clearNonce`/"adjust
 * state during render" shape, MINUS the cross-page "select all N matching"
 * fetch (`matching` state + `/api/members/ids`) — that is a members-only
 * feature (FR-040). This wrapper is the simpler per-page-only shape: only
 * what is checked on the CURRENT page is ever the bulk target.
 *
 * Manager (`isAdmin=false`) gets NO selection wiring at all — `PipelineTable`
 * itself already hides the admin-only row mutation affordances via
 * `canMutate`, and `enableSelection={false}` additionally hides the
 * checkbox column entirely (read-only surface, matching
 * `DirectoryWithBulk`'s FR-018 AS5 precedent).
 *
 * Task 11 mounts the real `PipelineBulkActionBar` here (wiring `selectedIds`
 * + `onClear`, both already prepared by Task 10). `selectedCompanyNames` is
 * resolved from the CURRENT PAGE's rows by cycleId — the same `Map`-lookup
 * shape `directory-with-bulk.tsx` uses for `selectedCompanyNames`, minus its
 * `.filter(Boolean)` drop: this wrapper has no cross-page "select all
 * matching" set, so every selected id always resolves to a row on the
 * current page, and dropping misses would silently break the index-parity
 * `PipelineBulkActionBar` relies on to attribute a fan-out outcome back to
 * a company name (Decision 5's "kept visible" results panel). `totalMatching`
 * is `rows.length` (the current page count) rather than a server-side total
 * across all pages — there is no such total here (see the module docstring).
 */
import { useCallback, useMemo, useState } from 'react';
import { PipelineTable } from './pipeline-table';
import { PipelineBulkActionBar } from './pipeline-bulk-action-bar';
import type { PipelineRow, PipelineSort } from '@/modules/renewals/client';

type Props = {
  readonly rows: ReadonlyArray<PipelineRow>;
  readonly isAdmin: boolean;
  /** Task 8 — the ACTIVE server-side sort. Forwarded unchanged to `PipelineTable`. */
  readonly sort?: PipelineSort;
  /** Task 8 — precomputed header sort links. Forwarded unchanged. */
  readonly sortHrefs?: Record<'expires' | 'tier', string>;
  /** Sighted result-count node. Forwarded unchanged. */
  readonly resultCount?: React.ReactNode;
  /** Renewals-by-month lens discriminator. Forwarded unchanged. */
  readonly monthKind?: 'overdue' | 'later' | 'month';
  /** Renewals-by-month lens label. Forwarded unchanged. */
  readonly monthLabel?: string;
};

export function PipelineWithBulk({
  rows,
  isAdmin,
  sort,
  sortHrefs,
  resultCount,
  monthKind,
  monthLabel,
}: Props) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Bumped to command PipelineTable to reset its (uncontrolled) TanStack
  // row-selection — the parent can't reach the checkbox state otherwise.
  const [clearNonce, setClearNonce] = useState(0);

  // Reset the selection whenever a fresh server render arrives (a new
  // filter/urgency-tab/month/sort, or a router.refresh after a mutation):
  // both the parent mirror AND PipelineTable's own row-selection (via the
  // nonce) — so a selection made under one filter can never carry over and
  // let a bulk action hit cycles that are no longer visible. React's
  // documented "adjust state during render" pattern (NOT an effect) — same
  // as `directory-with-bulk.tsx`: it drops the stale selection before this
  // render commits and avoids the cascading-render an effect would cause.
  const [rowsSnapshot, setRowsSnapshot] = useState(rows);
  if (rows !== rowsSnapshot) {
    setRowsSnapshot(rows);
    setSelectedIds([]);
    setClearNonce((n) => n + 1);
  }

  const handleSelectionChange = useCallback((cycleIds: string[]) => {
    setSelectedIds(cycleIds);
  }, []);

  // Wired to `PipelineBulkActionBar`'s "Clear selection" (same shape as
  // `directory-with-bulk.tsx`'s `handleClear`).
  const handleClear = useCallback(() => {
    setSelectedIds([]);
    setClearNonce((n) => n + 1);
  }, []);

  // Staff-review SS-1 precedent (`directory-with-bulk.tsx`) — memoise so
  // this doesn't recompute on every unrelated re-render. Index-PARALLEL to
  // `selectedIds` (see module docstring for why this wrapper does NOT
  // `.filter(Boolean)` a miss away like the members wrapper does).
  const selectedCompanyNames = useMemo(() => {
    const byId = new Map<string, string>();
    for (const row of rows) byId.set(row.cycleId, row.companyName);
    return selectedIds.map((id) => byId.get(id) ?? '');
  }, [rows, selectedIds]);

  return (
    <>
      <PipelineTable
        rows={rows}
        canMutate={isAdmin}
        {...(sort !== undefined ? { sort } : {})}
        {...(sortHrefs !== undefined ? { sortHrefs } : {})}
        {...(resultCount !== undefined ? { resultCount } : {})}
        {...(monthKind !== undefined ? { monthKind } : {})}
        {...(monthLabel !== undefined ? { monthLabel } : {})}
        enableSelection={isAdmin}
        {...(isAdmin ? { onSelectionChange: handleSelectionChange } : {})}
        clearSelectionNonce={clearNonce}
      />
      {isAdmin && (
        <PipelineBulkActionBar
          selectedCycleIds={selectedIds}
          selectedCompanyNames={selectedCompanyNames}
          totalMatching={rows.length}
          onClear={handleClear}
        />
      )}
    </>
  );
}
