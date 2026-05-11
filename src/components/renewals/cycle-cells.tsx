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
import { MailX } from 'lucide-react';
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
  emailUnverified = false,
}: {
  readonly memberId: string;
  readonly companyName: string;
  /**
   * J4-H13 (smart-feature #2): when true, render an inline
   * `MailX` indicator next to the company link so admins see at
   * a glance that the primary contact email has hit a bounce
   * threshold and reminders are paused (Gate 6 in `dispatchOneCycle`).
   * Defaults to false so existing call sites without the prop keep
   * rendering unchanged.
   */
  readonly emailUnverified?: boolean;
}) {
  const t = useTranslations('admin.renewals.table');
  // Fall back to a localised "unknown" placeholder when companyName
  // is empty — never render the raw UUID as visible text (screen
  // readers announce UUIDs character-by-character).
  const display = companyName || t('unknownCompany');
  const unverifiedHint = t('emailUnverifiedHint');
  return (
    <span className="inline-flex items-center gap-1.5">
      <Link
        href={`/admin/members/${memberId}`}
        className="font-medium text-foreground hover:text-primary hover:underline"
      >
        {display}
      </Link>
      {emailUnverified ? (
        // `title` attr drives the native browser tooltip for sighted
        // pointer users; `aria-label` exposes the same hint to screen
        // readers (which ignore `title` on inline icons reliably). The
        // surrounding `<span role="img">` gives SR users an explicit
        // landmark instead of announcing "graphic" generically.
        <span
          role="img"
          aria-label={unverifiedHint}
          title={unverifiedHint}
          className="inline-flex"
        >
          <MailX
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-destructive"
          />
        </span>
      ) : null}
    </span>
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
