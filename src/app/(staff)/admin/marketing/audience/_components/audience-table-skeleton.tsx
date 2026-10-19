/**
 * 108 PR-D (FR-035b) — shimmer skeleton in the audience table's final shape
 * (ux-standards § 2.1, CLS 0).
 *
 * Shape = the real table (review H5 / a11y 9): a 44-px header band and
 * 44-px rows (`--table-row-height`, the same token `TableRow` uses), column
 * widths mirroring `AudienceTable`'s <colgroup>, and the 7-column (switch)
 * layout BY DEFAULT — admin / super_admin / marketing are the common case;
 * the read-only manager (6 columns) is the exception and passes `false`.
 *
 * Spec 122 US12a: drawn with the shared `SkeletonBlock`, and the filter
 * bar's placeholder lives here too, in the AURA bar's shape. Below 640 px the
 * table stacks into contact cards (UX M3), so the skeleton draws cards there
 * and the table shape from `sm` up; rules use the AURA border token (L6).
 */
import { SkeletonBlock } from '@/components/shell/page-skeletons';
import {
  AUDIENCE_COLUMNS_READ_ONLY,
  AUDIENCE_COLUMNS_WITH_SWITCH,
  audienceColumnFloor,
  isSharedColumn,
} from './audience-table-layout';

export function AudienceTableSkeleton({
  withSwitch = true,
}: {
  readonly withSwitch?: boolean;
} = {}) {
  // The real table's columns and floors (one module, so the two cannot drift):
  // Contact and Member share the spare width as the real width-less <col>s do.
  const columns = withSwitch ? AUDIENCE_COLUMNS_WITH_SWITCH : AUDIENCE_COLUMNS_READ_ONLY;
  const widths = columns.map(audienceColumnFloor);
  const rows = 15;
  const gridTemplateColumns = columns
    .map((key) => (isSharedColumn(key) ? `minmax(${audienceColumnFloor(key)}px, 1fr)` : `${audienceColumnFloor(key)}px`))
    .join(' ');
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <SkeletonBlock className="h-5 w-56" />
      <div className="flex flex-col gap-[var(--aura-space-3)] sm:hidden">
        {Array.from({ length: 5 }, (_, r) => (
          <div
            key={`card-${r}`}
            data-skeleton="audience-card"
            className="flex flex-col gap-3 rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] p-[var(--aura-space-4)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <SkeletonBlock className="h-4 w-2/5" />
                <SkeletonBlock className="h-3 w-3/5" />
              </div>
              {withSwitch ? <SkeletonBlock className="h-7 w-12" /> : null}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              {Array.from({ length: 6 }, (_, c) => (
                <SkeletonBlock key={`card-${r}-${c}`} className="h-3 w-20" />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="overflow-x-auto max-sm:hidden">
        <div
          data-slot="skeleton-body"
          className="w-full"
          style={{ minWidth: widths.reduce((a, b) => a + b, 0) }}
        >
          <div
            data-slot="skeleton-header"
            className="grid h-[var(--table-row-height)] items-center gap-x-4 border-b border-[var(--aura-border-default)]"
            style={{ gridTemplateColumns }}
          >
            {widths.map((_, i) => (
              <SkeletonBlock key={`h-${i}`} className="h-3 w-20" />
            ))}
          </div>
          {Array.from({ length: rows }, (_, r) => (
            <div
              key={`r-${r}`}
              data-slot="skeleton-row"
              className="grid h-[var(--table-row-height)] items-center gap-x-4 border-b border-[var(--aura-border-default)]"
              style={{ gridTemplateColumns }}
            >
              {widths.map((_, c) => (
                <SkeletonBlock key={`c-${r}-${c}`} className="h-5" />
              ))}
            </div>
          ))}
        </div>
      </div>
      <SkeletonBlock className="h-9 w-72 self-end" />
    </div>
  );
}

/**
 * The AURA filter bar's shape while it loads: on a phone the search and the
 * "Filters" button (44px); from 640px the search and the three filters (36px).
 */
export function AudienceFiltersSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-2" aria-hidden>
      <SkeletonBlock className="h-11 min-w-0 flex-1 sm:h-9" />
      <SkeletonBlock className="h-11 w-28 sm:hidden" />
      <SkeletonBlock className="h-9 w-44 max-sm:hidden" />
      <SkeletonBlock className="h-9 w-48 max-sm:hidden" />
      <SkeletonBlock className="h-9 w-52 max-sm:hidden" />
    </div>
  );
}
