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
import { requirePagePermission, canPerform } from '@/lib/rbac';
import { EmptyState } from '@/components/shell/empty-state';
import { SettingsIcon } from 'lucide-react';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.settings.index');
  return { title: t('title'), description: t('subtitle') };
}

/**
 * Each card mirrors the permission its destination page guards on — same
 * contract as the sidebar (T063) and the ⌘K palette (T064).
 *
 * 016 review — this index was MISSED by T064 despite being named in the task,
 * and the miss was live on the ON leg: it admits anyone with `dashboard.view`,
 * so `marketing` opened it and saw two cards that both 404, and a plain admin
 * saw the invoicing card that D4 moved to super-admin-only. Each of those
 * clicks also writes a `permission_denied` row to an append-only audit log for
 * a user who did nothing wrong. Exactly the dead-link class the parity tests
 * exist to kill, on the one surface those tests did not cover.
 */
const CATEGORIES = [
  {
    titleKey: 'categories.invoicing.title',
    descriptionKey: 'categories.invoicing.description',
    href: '/admin/settings/invoicing',
    icon: FileCog2Icon,
    permission: 'settings.invoicing',
  },
  {
    titleKey: 'categories.renewalSchedules.title',
    descriptionKey: 'categories.renewalSchedules.description',
    href: '/admin/settings/renewals/schedules',
    icon: CalendarClockIcon,
    permission: 'settings.renewal_schedules',
  },
] as const;

export default async function SettingsIndexPage() {
  const { user } = await requirePagePermission('dashboard.view');
  const t = await getTranslations('admin.settings.index');
  const visible = CATEGORIES.filter((c) => canPerform(user.role, c.permission));

  // Every card gone: the viewer holds `dashboard.view` (so the index itself
  // opens) but no settings surface. Better than an empty grid, which reads as a
  // loading failure.
  if (visible.length === 0) {
    return (
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <EmptyState icon={SettingsIcon} title={t('empty')} />
      </DetailContainer>
    );
  }

  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="grid gap-4 sm:grid-cols-2">
        {visible.map(({ titleKey, descriptionKey, href, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring"
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
