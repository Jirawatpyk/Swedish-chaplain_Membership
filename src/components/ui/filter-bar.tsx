import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

/**
 * `<FilterBar>` — canonical container for search + filter + action rows
 * that live above data tables (members directory, invoices list,
 * credit-notes list, users list, plans list).
 *
 * Responsive behaviour is owned by this primitive + the paired
 * mobile-only rule in `globals.css`:
 *
 *   Mobile (<640px)
 *   ─ Stack vertical, every DIRECT child is forced to `width: 100%`
 *     via an unlayered `@media (max-width: 639.98px)` rule that beats
 *     Tailwind's base `w-fit` (etc.) through cascade-layer precedence.
 *     No `!important` needed.
 *
 *   Desktop (≥640px)
 *   ─ Horizontal row. There is NO rule from us at this breakpoint —
 *     Tailwind utilities (`sm:w-36`, `sm:w-[180px]`, `sm:flex-1`,
 *     `w-fit`, …) apply naturally. Callers declare desktop widths
 *     inline; we do not fight them.
 *
 * Call-site pattern (never hardcode the container flex classes, and
 * never add `w-full sm:w-auto` — both are redundant):
 *
 *   <FilterBar>
 *     <div className="relative sm:flex-1">       ← search input grows
 *       <Input type="search" ... />
 *     </div>
 *     <SelectTrigger className="sm:w-36">        ← desktop width only
 *       ...
 *     </SelectTrigger>
 *     <Button>Clear</Button>                     ← mobile 100%, desktop auto
 *   </FilterBar>
 *
 * Gotcha: the mobile rule only targets DIRECT children of the
 * `data-slot="filter-bar"` element. Don't wrap interactive controls
 * in extra `<div>`s — they break the rule and force you to re-apply
 * `w-full` manually. If you must group (e.g. 2-column mobile grid),
 * re-apply `w-full` on the grandchildren explicitly.
 */
export function FilterBar({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="search"
      data-slot="filter-bar"
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
