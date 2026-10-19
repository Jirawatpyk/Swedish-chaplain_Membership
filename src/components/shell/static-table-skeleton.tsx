'use client';

/**
 * Spec 122 — the loading skeleton for a list drawn with AURA's static `Table`
 * (the counterpart of `DataTableSkeleton` for a `DataTable`). It is AURA's
 * own `Table`, edge to edge in the list card (`bleed`) and stacked into
 * cards below 640px as the real table is, and each column takes its share of
 * the real table, so the columns sit where the real ones land at any width
 * (CLS 0, ux-standards § 2.1). A static `Table` sizes its columns to their
 * content, so the shares come from the real table at a 1440px window.
 *
 * A route's `loading.tsx` is a Server Component and AURA's root is a client
 * module, so the route passes the translated labels in. `inert` with
 * `aria-hidden`: a placeholder takes no keyboard focus; the route's
 * `PageSkeletonShell` announces the load.
 */
import { Table, TBody, THead, Td, Th, Tr } from '@jirawatpyk/aura-react';
import { SkeletonBlock } from '@/components/shell/page-skeletons';

export interface StaticTableSkeletonColumn {
  readonly label: string;
  /** The column's share of the table, e.g. `'22%'`. */
  readonly share: string;
  /** Text lines in the real cell (two for a value over its caption). */
  readonly lines?: number;
  /** The real cell's phone-card part; `action` draws a button-sized block. */
  readonly card?: 'title' | 'action';
}

interface StaticTableSkeletonProps {
  /** The real table's accessible name. */
  readonly caption: string;
  readonly columns: readonly StaticTableSkeletonColumn[];
  readonly rows: number;
  readonly 'data-testid'?: string;
}

export function StaticTableSkeleton({ caption, columns, rows, 'data-testid': testId }: StaticTableSkeletonProps) {
  return (
    <div aria-hidden inert data-testid={testId}>
      <Table caption={caption} captionHidden stackBelow="sm" stackStyle="cards" align="middle" bleed>
        <THead>
          <Tr>
            {columns.map((column) => (
              <Th key={column.label} style={{ width: column.share }}>
                {column.label}
              </Th>
            ))}
          </Tr>
        </THead>
        <TBody>
          {Array.from({ length: rows }, (_, row) => (
            <Tr key={row}>
              {columns.map((column) => (
                <Td key={column.label} {...(column.card ? { card: column.card } : { label: column.label })}>
                  {column.card === 'action' ? (
                    // The row's small button: 32px, 44px on a phone card.
                    <SkeletonBlock className="h-11 w-full sm:h-8 sm:w-24" />
                  ) : (
                    <span className="flex flex-col gap-1.5">
                      {Array.from({ length: column.lines ?? 1 }, (__, line) => (
                        <SkeletonBlock key={line} className={line === 0 ? 'h-4 w-4/5' : 'h-3 w-3/5'} />
                      ))}
                    </span>
                  )}
                </Td>
              ))}
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
