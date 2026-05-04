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
import { TIER_BUCKETS, type TierBucket } from '@/modules/renewals';

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
  return (
    <div className="flex w-full sm:w-[14rem] flex-col">
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
        <SelectContent>
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
