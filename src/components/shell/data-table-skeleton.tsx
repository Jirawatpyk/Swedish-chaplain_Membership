'use client';

/**
 * Spec 122 — a list table's loading skeleton: AURA's own `DataTable` in its
 * loading state with the real table's columns (keys, labels, sizes and
 * phone-card parts), edge to edge inside the list card (`bleed`) as the real
 * table is, so the grid that replaces it lands in the same place (CLS 0,
 * ux-standards § 2.1) and turns into cards below 640px like the real one.
 *
 * A route's `loading.tsx` is a Server Component and AURA's root is a client
 * module (`tests/unit/architecture/aura-server-imports.test.ts`), so the
 * route passes the translated labels in.
 *
 * AURA 5.28's loading rows are one fixed 48px line, and in cards they carry
 * no field labels and a thin bar where the real footer holds 44px buttons
 * (handoff #134). A route whose phone cards are much taller than that keeps
 * its own phone cards below 640px and passes `className="max-sm:hidden"`.
 *
 * `inert` with `aria-hidden`: a placeholder takes no keyboard focus; the
 * route's `PageSkeletonShell` announces the load.
 */
import { DataTable, type DataTableColumn } from '@jirawatpyk/aura-react';

type SkeletonColumn = Pick<DataTableColumn, 'key' | 'label' | 'width' | 'minWidth' | 'card' | 'align' | 'actions' | 'hideBelow' | 'pill'>;

interface DataTableSkeletonProps {
  /** The real table's accessible name. */
  readonly label: string;
  readonly columns: readonly SkeletonColumn[];
  readonly rows: number;
  /** The table is the card's last content (AURA `bleedEnd`), as on the real page. */
  readonly bleedEnd?: boolean;
  /** The leading checkbox column, when the page's main user gets one. */
  readonly selectable?: boolean;
  /** On the wrapper: `max-sm:hidden` where the route draws its own phone cards (see below). */
  readonly className?: string;
  readonly 'data-testid'?: string;
}

export function DataTableSkeleton({
  label,
  columns,
  rows,
  bleedEnd = false,
  selectable = false,
  className,
  'data-testid': testId,
}: DataTableSkeletonProps) {
  return (
    <div aria-hidden inert data-testid={testId} className={className}>
      <DataTable
        label={label}
        rows={[]}
        columns={[...columns]}
        rowKey="key"
        loading
        skeletonRows={rows}
        rowHeight="auto"
        stackBelow={640}
        bleed
        bleedEnd={bleedEnd}
        selectable={selectable}
      />
    </div>
  );
}
