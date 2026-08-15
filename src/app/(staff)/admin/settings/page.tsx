/**
 * Settings index — landing page for `/admin/settings/` that lists the
 * available setting categories, mirroring ALL FOUR sidebar Settings
 * entries (016 post-ship review closed the 2-of-4 gap):
 *
 *   - Invoice settings (`/admin/settings/invoicing`) — F4 invoicing
 *     domain (VAT %, currency, registration fee, sequential numbering
 *     reset window, etc.). Super-admin-only since D4.
 *   - Reminder schedules (`/admin/settings/renewals/schedules`) — F8
 *     renewal reminder cadence per tier-bucket.
 *   - Broadcast settings (`/admin/settings/broadcasts`) — F7.1a
 *     inline-image source allowlist. Hidden when F7 is off.
 *   - EventCreate integration (`/admin/settings/integrations/
 *     eventcreate`) — F6 webhook + import config. Hidden when F6 is off.
 *
 * Without an index page here, the breadcrumb segment "Settings" on
 * any nested setting page would 404 when clicked. Same for the
 * "renewals" segment under it (no page.tsx) — the breadcrumb-path
 * util rewrites that to `/admin/settings` via NON_ROUTE_BY_PARENT.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  FileCog2Icon,
  CalendarClockIcon,
  Settings2Icon,
  PlugZapIcon,
} from 'lucide-react';
import { env } from '@/lib/env';
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
  // 016 post-ship review (below-cap): the index claimed "same contract as the
  // sidebar (T063)" while listing 2 of the sidebar's 4 Settings entries — a
  // super_admin arriving via the breadcrumb from /admin/settings/broadcasts
  // saw an index that omitted the very surface they came from. The two cards
  // below mirror the sidebar entries exactly, INCLUDING the feature-flag
  // dimension (`visibilityFlag`, same vocabulary as nav.ts): a switched-off
  // feature must not surface a dead card.
  {
    titleKey: 'categories.broadcasts.title',
    descriptionKey: 'categories.broadcasts.description',
    href: '/admin/settings/broadcasts',
    icon: Settings2Icon,
    permission: 'settings.broadcasts',
    visibilityFlag: 'broadcastsEnabled',
  },
  {
    titleKey: 'categories.integrationsEventcreate.title',
    descriptionKey: 'categories.integrationsEventcreate.description',
    href: '/admin/settings/integrations/eventcreate',
    icon: PlugZapIcon,
    permission: 'settings.integrations',
    visibilityFlag: 'eventsEnabled',
  },
] as const;

export default async function SettingsIndexPage() {
  const { user } = await requirePagePermission('dashboard.view');
  const t = await getTranslations('admin.settings.index');
  // Same flag names the staff shell resolves for the sidebar (layout.tsx).
  const flags = {
    broadcastsEnabled: env.features.f7Broadcasts,
    eventsEnabled: env.features.f6EventCreate,
  } as const;
  const visible = CATEGORIES.filter(
    (c) =>
      !('visibilityFlag' in c && !flags[c.visibilityFlag]) &&
      canPerform(user.role, c.permission),
  );

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
