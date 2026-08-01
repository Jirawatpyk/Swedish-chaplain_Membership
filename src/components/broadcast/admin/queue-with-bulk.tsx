'use client';

/**
 * Task 6 (2026-08-01-broadcast-review-queue-pr2) — `QueueWithBulk`.
 *
 * Client wrapper that lifts row-selection OUT of `QueueTableClient` and
 * composes it with the fixed-bottom `QueueBulkActionBar` (Task 5) as
 * SIBLINGS — mirroring `admin/members/_components/directory-with-bulk.tsx`:
 * this component owns `selectedIds` (mirrored up from the table via
 * `onSelectionChange`) and a `clearNonce` counter that forces the table's
 * uncontrolled TanStack row-selection back to `{}` (via
 * `clearSelectionNonce`) whenever the bar clears or the whole bulk-approve
 * fan-out succeeds.
 *
 * `QueueTable` (the async Server Component) now renders THIS component
 * instead of `QueueTableClient` directly — same enriched-rows /
 * columnLabels / readOnly props, unchanged from the caller's point of view.
 * `QueueTableClient` and `QueueBulkActionBar` read the SAME `selectedIds`
 * mirror (not two independently-derived selection states), so the desktop
 * `<table>`, the mobile `QueueCardList` (which shares one `useReactTable`
 * instance with the desktop table — see `queue-table-client.tsx`'s Task 4
 * docstring), and this toolbar can never drift out of parity.
 *
 * CF-2 (Task 5 review carry-forward) — on a PARTIAL bulk-approve failure
 * (some ids succeeded, some didn't), leaving the ENTIRE original selection
 * intact would be misleading: a retry would re-fan the already-succeeded
 * ids too, and the toolbar's "N selected" count would silently include
 * rows the admin no longer needs to act on. The PREFERRED fix — narrow
 * `selectedIds` down to just the failed ids while leaving them checked —
 * would need the table's UNCONTROLLED `rowSelection` to be re-applied to
 * an arbitrary id set, a prop surface this task's contract doesn't include
 * (`enableSelection` / `onSelectionChange` / `clearSelectionNonce` only
 * support "mirror out" and "reset to empty", not "set to these ids").
 * Narrowing `selectedIds` here WITHOUT also resetting the table's actual
 * `rowSelection` would desync the toolbar's displayed count from the
 * checkboxes (all would show unchecked while the bar still claims N
 * selected) — the exact "shared-instance selection parity" break the task
 * brief calls out as a STOP condition. So this implements the brief's
 * documented ACCEPTABLE MINIMUM instead: a partial failure clears the
 * WHOLE selection (identical to `onClear`) and relies on the bar's
 * existing `partial` toast (ok/fail counts) to report the outcome; the
 * admin re-selects to retry. `onPartialFailure`'s `failedIds` argument is
 * accepted for interface completeness (a future iteration that adds a
 * "set to these ids" prop could use it) but is unused in this minimum
 * implementation.
 */
import { useState } from 'react';
import {
  QueueTableClient,
  type EnrichedQueueRow,
  type QueueTableClientProps,
} from './queue-table-client';
import { QueueBulkActionBar } from './queue-bulk-action-bar';

export interface QueueWithBulkProps {
  readonly rows: ReadonlyArray<EnrichedQueueRow>;
  readonly columnLabels: QueueTableClientProps['columnLabels'];
  readonly readOnly?: boolean;
}

export function QueueWithBulk({
  rows,
  columnLabels,
  readOnly = false,
}: QueueWithBulkProps): React.ReactElement {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [clearNonce, setClearNonce] = useState(0);

  // The single clear path for both a full bulk-approve success and an
  // explicit Clear click — always drops the wrapper's mirror AND bumps the
  // nonce so the table's uncontrolled `rowSelection` resets to `{}` too.
  // Never clear one without the other (see the CF-2 docstring above for
  // why a mismatch between this state and the table's actual checkboxes
  // is the parity break the task brief warns against).
  const handleClear = (): void => {
    setSelectedIds([]);
    setClearNonce((n) => n + 1);
  };

  // CF-2 — see module docstring: acceptable-minimum is "clear everything",
  // same mechanism as `handleClear`. `failedIds` is unused here.
  const handlePartialFailure = (_failedIds: string[]): void => {
    handleClear();
  };

  return (
    <>
      <QueueTableClient
        rows={rows}
        readOnly={readOnly}
        columnLabels={columnLabels}
        enableSelection={!readOnly}
        onSelectionChange={setSelectedIds}
        clearSelectionNonce={clearNonce}
      />
      <QueueBulkActionBar
        selectedIds={selectedIds}
        readOnly={readOnly}
        onClear={handleClear}
        onPartialFailure={handlePartialFailure}
        recipientByIdRows={rows.map((r) => ({
          broadcastId: r.broadcastId,
          recipientCount: r.recipientCount,
        }))}
      />
    </>
  );
}
