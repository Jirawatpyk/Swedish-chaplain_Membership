/**
 * F8 Phase 3 Wave H4 (verify-fix C1) — `TierFilterSelect` client component.
 *
 * URL-driven tier filter for the renewal pipeline (FR-046 / spec.md
 * AS2). Adds a `?tier=<bucket>` query param + clears the cursor so the
 * paginator restarts at page 1 on filter change. The "All tiers"
 * option deletes the param entirely.
 */
'use client';

import { useCallback, useId, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
// Use the client-safe sub-barrel (`@/modules/renewals/client`).
// Importing the full F8 barrel from a client component drags every
// server-only use-case (cancel-cycle → @/lib/db → postgres → fs) into
// the client bundle under Turbopack 16's eager re-export walking.
import { TIER_BUCKETS, type TierBucket } from '@/modules/renewals/client';

const ALL = 'all' as const;

export interface TierFilterSelectProps {
  readonly current: TierBucket | typeof ALL;
}

export function TierFilterSelect({ current }: TierFilterSelectProps) {
  const t = useTranslations('admin.renewals.tierFilter');
  const tBadge = useTranslations('admin.renewals.tierBadge');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  // useId() per-instance — guarantees uniqueness if the component is
  // ever rendered twice on the same page (e.g. in a modal filter bar).
  const labelId = `tier-filter-label-${useId()}`;

  const pushUrl = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === null || next === ALL) {
        params.delete('tier');
      } else {
        params.set('tier', next);
      }
      params.delete('cursor');
      params.delete('month'); // mutually-exclusive lens — changing tier exits the month lens
      params.delete('nowIso'); // drop the pagination-session anchor (leaves with cursor)
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [searchParams, router, pathname],
  );

  // Use aria-labelledby + a visually-hidden label. `aria-label` would
  // replace the trigger's accessible *name* (the label text) and most
  // SR comboboxes pair name + value when announcing — pointing at a
  // hidden span via aria-labelledby keeps both the label and the
  // current SelectValue audible (WCAG 4.1.2 Name, Role, Value).
  //
  // UX R5 / Mobile S5: wrapper drops `flex-col` — single visible child
  // (the Select); `sr-only` span is out of visual flow. Width sizing
  // (`w-full sm:w-[14rem]`) is the only structural class needed.
  return (
    <div className="w-full sm:w-[14rem]">
      <span id={labelId} className="sr-only">
        {t('aria_label')}
      </span>
      <Select value={current} onValueChange={pushUrl}>
        <SelectTrigger
          aria-labelledby={labelId}
          className="w-full"
        >
          <TranslatedSelectValue
            translate={(value) => {
              if (!value || value === ALL) return t('all');
              return tBadge(value as TierBucket);
            }}
          />
        </SelectTrigger>
        {/* `align="end"` anchors the popup to the trigger's right edge
            so it doesn't overflow the viewport — this trigger sits on
            the right side of the filter row, and the default
            `align="start"` (left-edge) pushed the popup off-screen and
            obscured the pipeline table's INVOICE column header. */}
        <SelectContent align="end">
          <SelectItem value={ALL}>{t('all')}</SelectItem>
          {TIER_BUCKETS.map((bucket) => (
            <SelectItem key={bucket} value={bucket}>
              {tBadge(bucket)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
