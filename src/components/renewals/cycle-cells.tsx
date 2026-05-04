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
import { useFormatter } from 'next-intl';
import { TierBadge } from './tier-badge';
import type { TierBucket } from '@/modules/renewals';

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
  return (
    <Link
      href={`/admin/members/${memberId}`}
      className="font-medium text-foreground hover:text-primary hover:underline"
    >
      {companyName || memberId}
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
