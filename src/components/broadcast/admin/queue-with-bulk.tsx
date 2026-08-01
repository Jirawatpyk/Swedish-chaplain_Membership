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
 * rows the admin no longer needs to act on. PR2 shipped the ACCEPTABLE
 * MINIMUM — clearing the whole selection, same as `onClear` — because
 * `QueueTableClient`'s prop surface at the time only supported "mirror out"
 * (`onSelectionChange`) and "reset to empty" (`clearSelectionNonce`), not
 * "set to these ids". Narrowing `selectedIds` here without also resetting
 * the table's actual `rowSelection` would have desynced the toolbar's
 * displayed count from the checkboxes.
 *
 * Task 6 (2026-08-02-broadcast-review-queue-pr3) closes that gap properly:
 * `QueueTableClient` now also accepts `reselectIds` + `reselectNonce`
 * (a controlled re-select, same nonce-bump shape as `clearSelectionNonce`).
 * `handlePartialFailure` below drives the failed id set into BOTH this
 * wrapper's own `selectedIds` mirror (belt-and-suspenders for the immediate
 * render) AND the table via `reselectIds`/`reselectNonce`. Because the table
 * re-applies `rowSelection` to exactly `failedIds`, its existing
 * `onSelectionChange` mirror effect re-fires and re-syncs `selectedIds` to
 * the same set — the desktop checkboxes, the mobile `QueueCardList` (same
 * shared `useReactTable` instance), and this toolbar's count can never
 * drift apart. This replaces PR2's "clear everything" minimum; retrying
 * now re-opens `BulkApproveConfirmDialog` scoped to only the rows that still
 * need action, and — because that dialog resets its own state on every
 * open — the schedule min-lead is re-validated against the current clock.
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
  const [reselectIds, setReselectIds] = useState<string[]>([]);
  const [reselectNonce, setReselectNonce] = useState(0);

  // The single clear path for both a full bulk-approve success and an
  // explicit Clear click — always drops the wrapper's mirror AND bumps the
  // nonce so the table's uncontrolled `rowSelection` resets to `{}` too.
  // Never clear one without the other (see the module docstring above for
  // why a mismatch between this state and the table's actual checkboxes
  // is the parity break the task brief warns against).
  const handleClear = (): void => {
    setSelectedIds([]);
    setClearNonce((n) => n + 1);
  };

  // Task 6 — controlled re-select to exactly the failed ids (see module
  // docstring). `setSelectedIds` here is belt-and-suspenders for the
  // immediate render; the table's `onSelectionChange` mirror re-fires once
  // `reselectNonce` bumps and re-syncs this to the same set regardless.
  const handlePartialFailure = (failedIds: string[]): void => {
    setSelectedIds(failedIds);
    setReselectIds(failedIds);
    setReselectNonce((n) => n + 1);
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
        reselectIds={reselectIds}
        reselectNonce={reselectNonce}
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
