/**
 * Shared TanStack Table cell primitives for renewal cycle rows.
 *
 * Used by both `pipeline-table.tsx` (active cycles, 8 columns) and
 * `lapsed-tab.tsx` (lapsed cycles, 5 columns). The Tier / Company /
 * Expires cells render identically in both surfaces, so they live
 * here to eliminate duplication.
 */
'use client';

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { TierBadge } from './tier-badge';
// Client-safe sub-barrel — see `tier-filter-select.tsx` for rationale.
import type { TierBucket } from '@/modules/renewals/client';

export function CycleTierCell({ tier }: { readonly tier: TierBucket }) {
  return <TierBadge tier={tier} />;
}

export function CycleCompanyCell({
  memberId,
  companyName,
}: {
  readonly memberId: string;
  readonly companyName: string;
}) {
  const t = useTranslations('admin.renewals.table');
  // Fall back to a localised "unknown" placeholder when companyName
  // is empty — never render the raw UUID as visible text (screen
  // readers announce UUIDs character-by-character).
  const display = companyName || t('unknownCompany');
  return (
    <Link
      href={`/admin/members/${memberId}`}
      className="font-medium text-foreground hover:text-primary hover:underline"
    >
      {display}
    </Link>
  );
}

export function CycleExpiresCell({
  expiresAt,
}: {
  readonly expiresAt: string;
}) {
  const fmt = useFormatter();
  return (
    <time
      dateTime={expiresAt}
      className="tabular-nums text-foreground/80"
    >
      {fmt.dateTime(new Date(expiresAt), {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })}
    </time>
  );
}
