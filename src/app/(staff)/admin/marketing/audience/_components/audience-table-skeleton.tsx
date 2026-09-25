/**
 * 108 PR-D (FR-035b) — shimmer skeleton in the audience table's final shape
 * (ux-standards § 2.1, CLS 0).
 *
 * Shape = the real table (review H5 / a11y 9): a 44-px header band and
 * 44-px rows (`--table-row-height`, the same token `TableRow` uses), column
 * widths mirroring `AudienceTable`'s <colgroup>, and the 7-column (switch)
 * layout BY DEFAULT — admin / super_admin / marketing are the common case;
 * the read-only manager (6 columns) is the exception and passes `false`.
 */
import { Skeleton } from '@/components/ui/skeleton';

/**
 * px — mirrors `AUDIENCE_COLUMN_WIDTHS` in audience-table.tsx (a literal, not
 * an import: that module is `'use client'`, and this skeleton renders on the
 * server). The first track is Contact's MINIMUM — it flexes like the real
 * table's width-less <col>.
 */
const WIDTHS = [184, 184, 112, 168, 112, 152, 136] as const;

export function AudienceTableSkeleton({
  withSwitch = true,
}: {
  readonly withSwitch?: boolean;
} = {}) {
  const widths = withSwitch ? [...WIDTHS] : WIDTHS.filter((_, i) => i !== 2);
  const rows = 15;
  const gridTemplateColumns = widths
    .map((w, i) => (i === 0 ? `minmax(${w}px, 1fr)` : `${w}px`))
    .join(' ');
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <Skeleton className="h-5 w-56" />
      <div className="overflow-x-auto">
        <div
          data-slot="skeleton-body"
          className="w-full"
          style={{ minWidth: widths.reduce((a, b) => a + b, 0) }}
        >
          <div
            data-slot="skeleton-header"
            className="grid h-[var(--table-row-height)] items-center gap-x-4 border-b"
            style={{ gridTemplateColumns }}
          >
            {widths.map((_, i) => (
              <Skeleton key={`h-${i}`} className="h-3 w-20" />
            ))}
          </div>
          {Array.from({ length: rows }, (_, r) => (
            <div
              key={`r-${r}`}
              data-slot="skeleton-row"
              className="grid h-[var(--table-row-height)] items-center gap-x-4 border-b"
              style={{ gridTemplateColumns }}
            >
              {widths.map((_, c) => (
                <Skeleton key={`c-${r}-${c}`} className="h-5" />
              ))}
            </div>
          ))}
        </div>
      </div>
      <Skeleton className="h-9 w-72 self-end" />
    </div>
  );
}
