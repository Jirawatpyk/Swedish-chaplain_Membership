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
import { cn } from '@/lib/utils';
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
  linkClassName,
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
  /**
   * Task 12 review round 1 (FIX 4a / M-3) — extra classes appended to the
   * company-name `<Link>`. `PipelineCardList` passes `truncate` so a long
   * single-word company name ellipsizes instead of hard-clipping against
   * the card's bounded width; the table (which has more horizontal room
   * and no reported clipping) omits this and keeps its existing rendering.
   * Absent (undefined) preserves the pre-existing behaviour everywhere.
   */
  readonly linkClassName?: string;
}) {
  const t = useTranslations('admin.renewals.table');
  // Fall back to a localised "unknown" placeholder when companyName
  // is empty — never render the raw UUID as visible text (screen
  // readers announce UUIDs character-by-character).
  const display = companyName || t('unknownCompany');
  const unverifiedHint = t('emailUnverifiedHint');
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Link
        href={`/admin/members/${memberId}`}
        className={cn(
          'font-medium text-foreground hover:text-primary hover:underline',
          linkClassName,
        )}
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
  label,
}: {
  readonly expiresAt: string;
  /**
   * Task 12 review round 1 (FIX 3 / I-2, WCAG 1.3.1) — optional visible
   * label rendered before the `<time>`. In the `<table>`, the "Expires"
   * meaning comes from the column `<th>`; a card has no such header
   * association, so `PipelineCardList` passes
   * `admin.renewals.table.columns.expires` here to give the date a label
   * for sighted-mobile AND screen-reader users. Absent (undefined, the
   * table's usage) preserves the exact pre-existing bare-`<time>` output.
   */
  readonly label?: string;
}) {
  const fmt = useFormatter();
  const time = (
    <time dateTime={expiresAt} className="tabular-nums text-foreground/80">
      {fmt.dateTime(new Date(expiresAt), 'dateMedium')}
    </time>
  );
  if (label === undefined) {
    return time;
  }
  return (
    <p className="text-sm text-muted-foreground">
      <span className="mr-1">{label}</span>
      {time}
    </p>
  );
}
