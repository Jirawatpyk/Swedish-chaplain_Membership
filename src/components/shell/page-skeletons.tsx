/**
 * Shared skeleton primitives for route-level `loading.tsx` files.
 *
 * All Server Components (no `'use client'`) — respects
 * `prefers-reduced-motion` purely via the shared `.skeleton-shimmer`
 * CSS utility in `globals.css` (shimmer gradient by default, automatic
 * pulse fallback under `prefers-reduced-motion: reduce`).
 *
 * Design alignment with F4 PageHeader + ContentContainer:
 * - CardSkeleton honours --card-padding / --card-radius / --card-shadow
 *   so skeleton cards are visually indistinguishable in dimensions from
 *   real Cards.
 * - TableSkeleton mirrors the shadcn Table grid so the initial row
 *   layout doesn't reflow when real data arrives.
 * - FormSkeleton mirrors the Input height + label spacing tokens.
 *
 * Accessibility:
 * - Container primitives (CardSkeleton, FormSkeleton, TableSkeleton,
 *   DetailSkeleton) self-announce with `role="status"` + `aria-busy`.
 * - `PageSkeletonShell` wraps a whole `loading.tsx` page to emit a
 *   single `aria-live="polite"` region with an i18n-driven label —
 *   screen readers hear "Loading…" on navigation.
 */
import { cn } from '@/lib/utils';

type SkeletonProps = React.ComponentProps<'div'>;

/**
 * Atomic skeleton block. Uses the shared `.skeleton-shimmer` utility
 * from `globals.css` (UX standards § 2.1) — horizontal gradient sweep
 * animation by default, automatic pulse fallback under
 * `prefers-reduced-motion: reduce`.
 */
export function SkeletonBlock({ className, ...props }: SkeletonProps) {
  return (
    <div
      data-slot="skeleton-block"
      className={cn('rounded-md skeleton-shimmer', className)}
      {...props}
    />
  );
}

/**
 * Mirror of shadcn <Card>: title + description + content rows. Honours
 * the F4 card tokens so dimensions match real Cards pixel-for-pixel.
 */
export function CardSkeleton({
  withDescription = true,
  rows = 3,
  className,
}: {
  withDescription?: boolean;
  rows?: number;
  className?: string;
}) {
  return (
    <div
      data-slot="card-skeleton"
      role="status"
      aria-busy="true"
      className={cn(
        'rounded-[var(--card-radius)] border border-border bg-card shadow-[var(--card-shadow)]',
        className,
      )}
    >
      <div className="flex flex-col gap-2 p-[var(--card-padding)]">
        <SkeletonBlock className="h-6 w-40" />
        {withDescription ? <SkeletonBlock className="h-4 w-64" /> : null}
      </div>
      <div className="flex flex-col gap-3 px-[var(--card-padding)] pb-[var(--card-padding)]">
        {Array.from({ length: rows }).map((_, i) => (
          <SkeletonBlock key={i} className="h-4 w-full" />
        ))}
      </div>
    </div>
  );
}

/**
 * Form skeleton. Two modes:
 *   - `withHeader: true` (default) — full Card-like shell with title +
 *     description + fields + footer. Use standalone.
 *   - `withHeader: false` — bare fields + optional footer; no outer
 *     chrome. Use when nested inside a real <Card> that already owns
 *     the title/description/padding.
 *
 * `footerButtons` controls the primary/secondary action count (default
 * 1 = submit-only; pass 0 to omit). Buttons render in left→right order
 * with the LAST one wider (primary submit) — mirrors real shadcn form
 * footers like `[Cancel (ghost)] [Submit (primary, wider)]`.
 */
export function FormSkeleton({
  fields = 4,
  footerButtons = 1,
  withHeader = true,
  className,
}: {
  fields?: number;
  footerButtons?: number;
  withHeader?: boolean;
  className?: string;
}) {
  const fieldRows = (
    <>
      {Array.from({ length: fields }).map((_, i) => (
        <div key={i} className="flex flex-col gap-[var(--field-label-gap)]">
          <SkeletonBlock className="h-4 w-24" />
          <SkeletonBlock className="h-[var(--input-height)] w-full" />
        </div>
      ))}
      {footerButtons > 0 ? (
        <div className="flex justify-end gap-2 pt-2">
          {Array.from({ length: footerButtons }).map((_, i) => (
            <SkeletonBlock
              key={i}
              className={
                i === footerButtons - 1 ? 'h-9 w-28' : 'h-9 w-20'
              }
            />
          ))}
        </div>
      ) : null}
    </>
  );

  if (!withHeader) {
    return (
      <div
        data-slot="form-skeleton"
        role="status"
        aria-busy="true"
        className={cn('flex flex-col gap-4', className)}
      >
        {fieldRows}
      </div>
    );
  }

  return (
    <div
      data-slot="form-skeleton"
      role="status"
      aria-busy="true"
      className={cn(
        'rounded-[var(--card-radius)] border border-border bg-card shadow-[var(--card-shadow)]',
        className,
      )}
    >
      <div className="flex flex-col gap-2 p-[var(--card-padding)]">
        <SkeletonBlock className="h-6 w-40" />
        <SkeletonBlock className="h-4 w-64" />
      </div>
      <div className="flex flex-col gap-4 px-[var(--card-padding)] pb-[var(--card-padding)]">
        {fieldRows}
      </div>
    </div>
  );
}

/**
 * Mirror of shadcn <Table>: header + rows with equal-width columns.
 * Row height matches --table-row-height; column widths use `flex-1` so
 * horizontal reflow stays bounded.
 */
export function TableSkeleton({
  rows = 8,
  columns = 5,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div
      data-slot="table-skeleton"
      role="status"
      aria-busy="true"
      className={cn('w-full overflow-hidden', className)}
    >
      <div className="border-b border-border bg-muted/30 flex h-[var(--table-row-height)] items-center gap-4 px-[var(--table-cell-padding-x)]">
        {Array.from({ length: columns }).map((_, i) => (
          <SkeletonBlock key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex h-[var(--table-row-height)] items-center gap-4 border-b border-border px-[var(--table-cell-padding-x)] last:border-b-0"
        >
          {Array.from({ length: columns }).map((_, c) => (
            <SkeletonBlock key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Detail-view skeleton: dl grid with dt (label) + dd (value) pairs.
 * Used for read-only pages like /admin/plans/[year]/[planId].
 */
export function DetailSkeleton({
  items = 4,
  columns = 2,
  className,
}: {
  items?: number;
  columns?: 1 | 2;
  className?: string;
}) {
  return (
    <dl
      data-slot="detail-skeleton"
      role="status"
      aria-busy="true"
      className={cn(
        'grid gap-4',
        columns === 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1',
        className,
      )}
    >
      {Array.from({ length: items }).map((_, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <SkeletonBlock className="h-3 w-24" />
          <SkeletonBlock className="h-6 w-32" />
        </div>
      ))}
    </dl>
  );
}

/**
 * Wraps the entire body of a `loading.tsx` so a screen reader hears a
 * single polite announcement ("Loading…") on navigation — `role="status"`
 * implies `aria-live="polite"` but we add it explicitly for older AT.
 * The label comes from the i18n `layout.loading*` keys and is mirrored
 * in an `sr-only` span so it's spoken even if the live region doesn't
 * auto-announce.
 */
export function PageSkeletonShell({
  ariaLabel,
  children,
}: {
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label={ariaLabel}>
      {children}
      <span className="sr-only">{ariaLabel}</span>
    </div>
  );
}
