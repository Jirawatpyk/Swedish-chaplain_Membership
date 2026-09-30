/**
 * Shared cell primitives for renewal cycle rows (AURA tables, 122 US7a).
 *
 * Used by both `pipeline-table.tsx` (active cycles) and
 * `lapsed-tab.tsx` (lapsed cycles). The Tier / Company /
 * Expires cells render identically in both surfaces, so they live
 * here to eliminate duplication.
 */
'use client';

import Link from 'next/link';
import { MailX } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { TierBadge } from './tier-badge';
// Client-safe sub-barrel — see `tier-filter-select.tsx` for rationale.
import type { TierBucket } from '@/modules/renewals/client';
import { formatDatePreset } from '@/lib/format-date-localised';

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
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Link
        href={`/admin/members/${memberId}`}
        className="font-medium text-[var(--aura-fg-primary)] hover:text-[var(--aura-fg-accent)] hover:underline"
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
            className="h-3.5 w-3.5 shrink-0 text-[var(--aura-fg-danger)]"
          />
        </span>
      ) : null}
    </span>
  );
}

export function CycleExpiresCell({ expiresAt }: { readonly expiresAt: string }) {
  const locale = useLocale();
  return (
    <time dateTime={expiresAt} className="tabular-nums text-[var(--aura-fg-primary)]">
      {formatDatePreset(expiresAt, locale, 'dateMedium')}
    </time>
  );
}
