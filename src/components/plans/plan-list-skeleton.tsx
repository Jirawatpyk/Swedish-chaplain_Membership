'use client';

/**
 * T081 — Plan list skeleton (US1, UX standards § 2.1).
 *
 * Spec 122: AURA's own `Table`, laid out as the real `<PlansTable>` (the same
 * column heads, cards below 640px, centred rows) and edge to edge inside the
 * list card (`bleed`), so the table that replaces it lands in the same place
 * (CLS 0). The route's `loading.tsx` is a Server Component and AURA's root is
 * a client module, so the route passes the translated heads in.
 *
 * The heads include the admin's actions column, as the table most visitors
 * get (the skeleton runs before the role is known); each column takes its
 * share of the real table at a 1440px window, so the columns sit where the
 * real ones land. `inert` with `aria-hidden`:
 * a placeholder takes no keyboard focus; the route's `PageSkeletonShell`
 * announces the load. The pulse stops under reduced motion through the shared
 * skeleton utility (UX standards § 2.2).
 */
import { Table, TBody, THead, Td, Th, Tr } from '@jirawatpyk/aura-react';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
import { HIDE_IN_CARD } from './plans-table-card';

const DEFAULT_ROW_COUNT = 9; // matches the SweCham 2026 seed row count

export interface PlanListSkeletonProps {
  /** The real table's accessible name. */
  readonly caption: string;
  /** The real table's column heads, in order: name, category, annual fee, member type, year, status, actions. */
  readonly heads: readonly [string, string, string, string, string, string, string];
  readonly rowCount?: number;
}

/** Cell widths that read like a plan row: a name, a category pill, a fee, … */
const CELL_WIDTHS = ['w-40', 'w-24', 'w-20', 'w-24', 'w-12', 'w-16', 'w-20'] as const;
/** Each column's share of the real table at a 1440px window (AURA's static Table sizes columns to the content). */
const COLUMN_SHARES = ['21%', '14%', '17%', '14%', '10%', '13%', '11%'] as const;
/** The real row's phone-card parts: the name as the title, the year left out, the status pill beside the name. */
const CELL_PROPS = [
  { card: 'title' },
  {},
  { numeric: true },
  {},
  { className: HIDE_IN_CARD },
  { card: 'action', className: 'self-center' },
  { className: HIDE_IN_CARD },
] as const;

export function PlanListSkeleton({ caption, heads, rowCount = DEFAULT_ROW_COUNT }: PlanListSkeletonProps) {
  return (
    <div aria-hidden inert data-plan-list-skeleton="">
      <Table caption={caption} captionHidden stackBelow="sm" stackStyle="cards" align="middle" bleed>
        <THead>
          <Tr>
            {heads.map((head, i) => (
              <Th key={head} style={{ width: COLUMN_SHARES[i] }} {...(i === 2 ? { numeric: true } : {})}>
                {head}
              </Th>
            ))}
          </Tr>
        </THead>
        <TBody>
          {Array.from({ length: rowCount }, (_, row) => (
            <Tr key={row}>
              {CELL_WIDTHS.map((width, i) => (
                <Td key={i} {...CELL_PROPS[i]}>
                  {/* The admin's row actions are small buttons (28px); the rest one line of text. */}
                  <SkeletonBlock className={`inline-block max-w-full ${i === CELL_WIDTHS.length - 1 ? 'h-7' : 'h-5'} ${width}`} />
                </Td>
              ))}
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
