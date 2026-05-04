/**
 * F8 Phase 3 Wave H4 (verify-fix C1) — `TierFilterSelect` client component.
 *
 * URL-driven tier filter for the renewal pipeline (FR-046 / spec.md
 * AS2). Adds a `?tier=<bucket>` query param + clears the cursor so the
 * paginator restarts at page 1 on filter change. The "All tiers"
 * option deletes the param entirely.
 */
'use client';

import { useCallback, useTransition } from 'react';
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

  return (
    <Select value={current} onValueChange={pushUrl}>
      <SelectTrigger
        aria-label={t('aria_label')}
        className="w-full sm:w-[14rem]"
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
  );
}
