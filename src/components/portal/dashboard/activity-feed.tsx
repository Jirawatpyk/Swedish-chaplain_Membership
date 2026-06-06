'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { LucideIcon } from 'lucide-react';
import { RelativeTime } from '@/components/ui/relative-time';
import { cn } from '@/lib/utils';

/**
 * ActivityFeed — a compact recent-activity preview for the member
 * dashboard (icon + text + relative time). The dashboard resolves the
 * source-specific icon + already-localised text AND applies the
 * member-permission event filter (spec S-2 — member-relevant events
 * only); this primitive is pure presentation.
 *
 * Mandatory empty/first-run state (spec §4.1): ~131 launch invitees
 * land on an empty dashboard, so a friendly localised empty state is
 * required, never a blank list.
 *
 * Client component: `RelativeTime` needs a `NextIntlClientProvider`
 * ancestor and `useTranslations` resolves the section/empty copy.
 * Section title is a real `<h2>` (spec a11y-6).
 */
export interface ActivityFeedItem {
  readonly id: string;
  readonly icon: LucideIcon;
  /** Already-localised one-line description of the event. */
  readonly text: string;
  /** ISO 8601 UTC timestamp (BE display handled by RelativeTime for `th`). */
  readonly iso: string;
}

export interface ActivityFeedProps {
  readonly items: readonly ActivityFeedItem[];
  /** "View all" destination (e.g. /portal/timeline). */
  readonly viewAllHref: string;
  readonly className?: string;
}

export function ActivityFeed({
  items,
  viewAllHref,
  className,
}: ActivityFeedProps) {
  const t = useTranslations('portal.dashboard.activity');
  const isEmpty = items.length === 0;

  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-heading text-base font-medium leading-snug">
          {t('title')}
        </h2>
        {!isEmpty ? (
          <Link
            href={viewAllHref}
            className="text-caption text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {t('viewAll')}
          </Link>
        ) : null}
      </div>

      {isEmpty ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-body font-medium">{t('empty.title')}</p>
          <p className="mt-1 text-caption text-muted-foreground">
            {t('empty.body')}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.id} className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground"
                >
                  <Icon className="size-3.5" />
                </span>
                <div className="flex flex-col gap-0.5">
                  <span className="text-body">{item.text}</span>
                  <RelativeTime
                    iso={item.iso}
                    className="text-caption text-muted-foreground"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
