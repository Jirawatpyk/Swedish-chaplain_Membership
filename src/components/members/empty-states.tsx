'use client';

/**
 * FR-034 — three distinct empty states for the members directory.
 *
 * (a) zero-members — onboarding CTA "Add your first member" + illustration
 * (b) filtered — "No members match these filters" + Clear-filters CTA
 * (c) server-error — retry + localized message
 *
 * ARIA live-region on the error state so screen readers announce the
 * failure without a page change (ux-standards § 7.3).
 */

import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  BuildingIcon,
  SearchXIcon,
  AlertTriangleIcon,
  PlusIcon,
  XIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';

export function MembersZeroState() {
  const t = useTranslations('admin.members.emptyStates.zero');
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-10 text-center"
      role="status"
    >
      <div
        className="flex size-14 items-center justify-center rounded-full bg-muted"
        aria-hidden
      >
        <BuildingIcon className="size-7 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h2 className="text-h3 text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <Link
        href="/admin/members/new"
        className={buttonVariants({ size: 'sm' })}
      >
        <PlusIcon className="size-4" />
        {t('cta')}
      </Link>
    </div>
  );
}

export function MembersFilteredEmptyState() {
  const t = useTranslations('admin.members.emptyStates.filtered');
  const router = useRouter();
  const pathname = usePathname();
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-10 text-center"
      role="status"
    >
      <div
        className="flex size-14 items-center justify-center rounded-full bg-muted"
        aria-hidden
      >
        <SearchXIcon className="size-7 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h2 className="text-h3 text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => router.replace(pathname)}
      >
        <XIcon className="size-4" />
        {t('cta')}
      </Button>
    </div>
  );
}

export function MembersErrorState() {
  const t = useTranslations('admin.members.emptyStates.error');
  const router = useRouter();
  return (
    <div
      // role="alert" implies aria-live="assertive" — explicit aria-live="polite" removed (contradictory).
      className="flex flex-col items-center justify-center gap-4 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center"
      role="alert"
    >
      <div
        className="flex size-14 items-center justify-center rounded-full bg-destructive/15"
        aria-hidden
      >
        <AlertTriangleIcon className="size-7 text-destructive" />
      </div>
      <div className="space-y-1">
        <h2 className="text-h3 text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => router.refresh()}
      >
        <RefreshCwIcon className="size-4" />
        {t('cta')}
      </Button>
    </div>
  );
}
