/**
 * Shimmer skeleton for the members directory table.
 *
 * Approximates the real table's common-case shape (same column count, one
 * row height, same grid). Not an exact shape match: Plan/Status/Contact cells
 * can each wrap one line taller than this skeleton reserves (long plan name,
 * a stacked Lapsed/Suspended badge, or — since 057 badge-inline — a wrapped
 * portal/bounce badge row), so some rows settle one line taller once the real
 * data lands. See the inline comment below for why that tradeoff (smaller
 * aggregate CLS than over-reserving two lines for every row) is accepted.
 *
 * Round-10 ui-design-specialist C1 fix (2026-05-14): the skeleton
 * previously hard-coded 8 columns but the real table emits 9 (no
 * selection, manager view) or 10 (with selection, admin view). The
 * pre-fix layout shifted by 1-2 columns on every directory load.
 * `withSelection` matches the table's `enableSelection` prop — when
 * the page-level `loading.tsx` runs before auth resolves we cannot
 * know the role, so the page passes the role-derived value through.
 *
 * 056-members-table-compact: the directory was reduced to a lean 8-column
 * layout (Member No. · Company[flag+name] · Plan·Year · Contact · Status ·
 * Engagement · Last Activity, plus the optional leading select column).
 * The real table now emits 7 (no selection, manager view) or 8 (with
 * selection, admin view). Default is 7 (no selection — manager +
 * first-paint baseline) so a non-admin always sees CLS 0; admins see
 * at-most a 1-column shift (the narrow select column) on first paint.
 */

import { Skeleton } from '@/components/ui/skeleton';

interface MembersTableSkeletonProps {
  /**
   * Whether the real table will render the leading select-checkbox
   * column (admin view with bulk actions enabled). Defaults to `false`
   * so the skeleton matches manager + non-admin baselines.
   */
  readonly withSelection?: boolean;
}

export function MembersTableSkeleton({
  withSelection = false,
}: MembersTableSkeletonProps = {}) {
  const cols = withSelection ? 8 : 7;
  // Render enough shimmer rows to fill a typical viewport (was 8): a real page
  // holds up to PAGE_SIZE (50) rows, so a short skeleton let the content below
  // the table (pagination) jump up during load and back down when data landed —
  // a visible CLS. 15 rows fills most laptop viewports so that shift happens
  // below the fold (where it no longer counts toward CLS) without rendering all
  // 50 heavy shimmer rows.
  const skeletonRows = 15;
  // Build a grid template where the select column (when present) is
  // narrow to match the real `size: 40` checkbox column — visual
  // alignment is closer to the live table than uniform fractions.
  const gridTemplate = withSelection
    ? '40px repeat(7, minmax(0, 1fr))'
    : 'repeat(7, minmax(0, 1fr))';

  return (
    // #7 — fill the members page's flex column during load (min-h-0 so it can
    // shrink; overflow-hidden clips the shimmer rows that don't fit rather than
    // scrolling), matching the real table's flex-1 scroll region so the
    // skeleton→table swap doesn't shift layout.
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden"
      aria-hidden
    >
      <div
        className="grid gap-3 border-b bg-muted/40 px-4 py-3 text-xs font-medium text-muted-foreground"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-full" />
        ))}
      </div>
      {Array.from({ length: skeletonRows }).map((_, r) => (
        <div
          key={r}
          className="grid gap-3 border-b px-4 py-3 last:border-b-0"
          style={{ gridTemplateColumns: gridTemplate }}
        >
          {/* 057 badge-inline — the portal badge renders INLINE after the
              contact name (wrapping only when the column is too narrow), so the
              common row is a single line again. A one-line shimmer matches the
              majority of rows; the minority that wrap (long plan name, or a
              Lapsed/Suspended badge stacked in the Status cell) settle one line
              taller, which is a smaller aggregate CLS than over-reserving two
              lines for every row (ux-standards § 2.1). */}
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} className="h-5 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}
