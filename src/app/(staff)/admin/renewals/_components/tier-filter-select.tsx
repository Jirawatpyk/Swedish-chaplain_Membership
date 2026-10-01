/**
 * F8 Phase 3 Wave H4 (verify-fix C1) — `TierFilterSelect` client component.
 *
 * URL-driven tier filter for the renewal pipeline (FR-046 / spec.md
 * AS2). Adds a `?tier=<bucket>` query param + clears the cursor so the
 * paginator restarts at page 1 on filter change. The "All tiers"
 * option deletes the param entirely.
 *
 * 122 US7a (T703): an AURA `Select` named "Tier". On a phone it shows the
 * label above it, beside the Urgency select (board `Admin-renewals-mobile`);
 * on a desktop it sits at the end of the stage tabs with no visible label
 * (maintainer, 1 Oct: "All tiers" already says what it filters, and the label
 * row widened the gap above the tabs), its name kept for screen readers.
 */
'use client';

import { useCallback, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Select } from '@jirawatpyk/aura-react';
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
  const tTable = useTranslations('admin.renewals.table');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const pushUrl = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === ALL) {
        params.delete('tier');
      } else {
        params.set('tier', next);
      }
      params.delete('cursor');
      params.delete('month'); // mutually-exclusive lens — changing tier exits the month lens
      params.delete('nowIso'); // drop the pagination-session anchor (leaves with cursor)
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname, {
          scroll: false,
        });
      });
    },
    [searchParams, router, pathname],
  );

  const options = [
    { value: ALL, label: t('all') },
    ...TIER_BUCKETS.map((bucket) => ({ value: bucket, label: tBadge(bucket) })),
  ];
  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => pushUrl(e.target.value);
  const label = tTable('columns.tier');

  return (
    <>
      <div className="w-full sm:hidden">
        <Select label={label} value={current} options={options} onChange={onChange} />
      </div>
      <div className="hidden sm:block sm:w-[14rem]">
        <Select aria-label={label} value={current} options={options} onChange={onChange} />
      </div>
    </>
  );
}
