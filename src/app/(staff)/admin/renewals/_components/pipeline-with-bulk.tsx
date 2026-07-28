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
 * Task 10 stubs the bulk action bar as `null` so this wrapper is
 * independently testable ahead of Task 11, which mounts the real
 * `PipelineBulkActionBar` in its place (wiring `selectedIds` + `onClear`).
 * Both are kept ready below (`_selectedIds`/`_handleClear`, underscore-
 * prefixed per this repo's ESLint convention for intentional
 * kept-for-API-stability placeholders — eslint.config.mjs's
 * `no-unused-vars` comment) so Task 11 only needs to mount the bar, not
 * touch this state.
 */
import { useCallback, useState } from 'react';
import { PipelineTable } from './pipeline-table';
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
  const [_selectedIds, setSelectedIds] = useState<string[]>([]);
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

  // Task 11 wires this to `PipelineBulkActionBar`'s "Clear selection". Kept
  // ready now (same shape as `directory-with-bulk.tsx`'s `handleClear`) so
  // Task 11 only needs to mount the bar, not touch this state.
  const _handleClear = useCallback(() => {
    setSelectedIds([]);
    setClearNonce((n) => n + 1);
  }, []);

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
      {/* Task 11 mounts <PipelineBulkActionBar selectedIds={selectedIds}
          onClear={handleClear} /> here. Stubbed as null so this wrapper
          renders and is independently testable ahead of that task. */}
      {null}
    </>
  );
}
