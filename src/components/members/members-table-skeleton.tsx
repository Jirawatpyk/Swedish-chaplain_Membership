/**
 * Shimmer skeleton for the members directory table.
 *
 * Renders the EXACT shape of the real table (same column count, same
 * row height, same grid) so the shell does NOT shift when the real
 * data lands — CLS 0 per ux-standards § 2.1.
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
  // Build a grid template where the select column (when present) is
  // narrow to match the real `size: 40` checkbox column — visual
  // alignment is closer to the live table than uniform fractions.
  const gridTemplate = withSelection
    ? '40px repeat(7, minmax(0, 1fr))'
    : 'repeat(7, minmax(0, 1fr))';

  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div
        className="grid gap-3 border-b bg-muted/40 px-4 py-3 text-xs font-medium text-muted-foreground"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-full" />
        ))}
      </div>
      {Array.from({ length: 8 }).map((_, r) => (
        <div
          key={r}
          className="grid gap-3 border-b px-4 py-3 last:border-b-0"
          style={{ gridTemplateColumns: gridTemplate }}
        >
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} className="h-5 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}
