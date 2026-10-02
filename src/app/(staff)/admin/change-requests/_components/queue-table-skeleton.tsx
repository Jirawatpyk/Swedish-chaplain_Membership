'use client';

/**
 * Spec 122 — the change-request queue table's loading skeleton: AURA's own
 * `Table`, laid out as `queue-table.tsx` (the same seven heads, cards below
 * 640px, centred rows) and edge to edge inside the list card (`bleed`), so
 * the table that replaces it lands in the same place (CLS 0, ux-standards
 * § 2.1). The route's `loading.tsx` is a Server Component and AURA's root is
 * a client module, so the route passes the translated heads in. `inert` with
 * `aria-hidden`: a placeholder takes no keyboard focus.
 */
import { Table, TBody, THead, Td, Th, Tr } from '@jirawatpyk/aura-react';
import { SkeletonBlock } from '@/components/shell/page-skeletons';

interface QueueTableSkeletonProps {
  readonly caption: string;
  /** Member, Submitter, Fields, Submitted, Waiting, Status, Actions. */
  readonly heads: readonly string[];
  readonly rows: number;
}

/** Two-line member and submitter cells, then one line each; Review last. */
function Cell({ index }: { readonly index: number }) {
  if (index < 2) {
    return (
      <span className="flex flex-col gap-1.5">
        <SkeletonBlock className={index === 0 ? 'h-5 w-40' : 'h-5 w-32'} />
        <SkeletonBlock className="h-3 w-16" />
      </span>
    );
  }
  const widths = ['w-12', 'w-36', 'w-16', 'w-20', 'w-20'];
  return <SkeletonBlock className={`h-5 ${widths[index - 2] ?? 'w-16'}`} />;
}

export function QueueTableSkeleton({ caption, heads, rows }: QueueTableSkeletonProps) {
  return (
    <div aria-hidden inert data-testid="queue-table-skeleton">
      <Table caption={caption} captionHidden stackBelow="sm" stackStyle="cards" align="middle" bleed>
        <THead>
          <Tr>
            {heads.map((head) => (
              <Th key={head}>{head}</Th>
            ))}
          </Tr>
        </THead>
        <TBody>
          {Array.from({ length: rows }, (_, row) => (
            <Tr key={row}>
              {heads.map((head, i) => (
                <Td key={head}>
                  <Cell index={i} />
                </Td>
              ))}
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
