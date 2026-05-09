/**
 * Settings index — landing page for `/admin/settings/` that lists the
 * available setting categories. Currently:
 *
 *   - Invoice settings (`/admin/settings/invoicing`) — F4 invoicing
 *     domain (VAT %, currency, registration fee, sequential numbering
 *     reset window, etc.)
 *   - Reminder schedules (`/admin/settings/renewals/schedules`) — F8
 *     renewal reminder cadence per tier-bucket.
 *
 * Without an index page here, the breadcrumb segment "Settings" on
 * any nested setting page would 404 when clicked. Same for the
 * "renewals" segment under it (no page.tsx) — the breadcrumb-path
 * util rewrites that to `/admin/settings` via NON_ROUTE_BY_PARENT.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { FileCog2Icon, CalendarClockIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.settings.index');
  return { title: t('title'), description: t('subtitle') };
}

const CATEGORIES = [
  {
    titleKey: 'categories.invoicing.title',
    descriptionKey: 'categories.invoicing.description',
    href: '/admin/settings/invoicing',
    icon: FileCog2Icon,
  },
  {
    titleKey: 'categories.renewalSchedules.title',
    descriptionKey: 'categories.renewalSchedules.description',
    href: '/admin/settings/renewals/schedules',
    icon: CalendarClockIcon,
  },
] as const;

export default async function SettingsIndexPage() {
  await requireSession('staff');
  const t = await getTranslations('admin.settings.index');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="grid gap-4 sm:grid-cols-2">
        {CATEGORIES.map(({ titleKey, descriptionKey, href, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Card className="h-full transition-colors hover:border-primary/40">
              <CardHeader className="flex flex-row items-start gap-3 space-y-0">
                <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="flex flex-col gap-1">
                  <CardTitle className="text-base">{t(titleKey)}</CardTitle>
                  <CardDescription>{t(descriptionKey)}</CardDescription>
                </div>
              </CardHeader>
              <CardContent />
            </Card>
          </Link>
        ))}
      </div>
    </DetailContainer>
  );
}
