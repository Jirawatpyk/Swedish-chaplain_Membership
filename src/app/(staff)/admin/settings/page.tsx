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
 *
 * Spec 122 US10c (T1021; boards `Admin-settings`, `-mobile`,
 * `Admin-state-settings-none`): one AURA card per category, two up from md.
 * The whole card is the target: its title link stretches over it, so each
 * card is one tab stop named by its title. The empty state sits in a card.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  FileCog2Icon,
  CalendarClockIcon,
  ClipboardCheckIcon,
  Settings2Icon,
  PaletteIcon,
  PlugZapIcon,
  ChevronRightIcon,
  SettingsIcon,
} from 'lucide-react';
import { Card } from '@jirawatpyk/aura-react/server';
import { env } from '@/lib/env';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { requirePagePermission, canPerform } from '@/lib/rbac';
import { EmptyState } from '@/components/shell/empty-state';

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
export const CATEGORIES = [
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
  // F114 US6 (FR-031) — the per-tenant member-change approval switch. Third,
  // like its sidebar row (`nav.staff.settingsMemberChanges`) — the hub mirrors
  // the sidebar in ORDER as well as in set / permission / flag / label / icon.
  // `members.write` mirrors the page guard AND the PATCH route (an admin
  // surface: manager / marketing never see it). Flag-aware like the two
  // above: the page `notFound()`s while FEATURE_MEMBER_CHANGE_APPROVAL is off.
  {
    titleKey: 'categories.memberChanges.title',
    descriptionKey: 'categories.memberChanges.description',
    href: '/admin/settings/member-changes',
    icon: ClipboardCheckIcon,
    permission: 'members.write',
    visibilityFlag: 'memberChangeApproval',
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
  // F119 T029 — the chamber brand page, directly under its allow-list sibling
  // (the hub mirrors the sidebar in ORDER as well as in set / permission /
  // flag / label / icon). Same `settings.broadcasts` key and same F7 flag as
  // that sibling: the page 404s on the flag, so a card behind it would be a
  // dead end.
  {
    titleKey: 'categories.eblastBrand.title',
    descriptionKey: 'categories.eblastBrand.description',
    href: '/admin/settings/broadcasts/brand',
    icon: PaletteIcon,
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
  // Same flag names the staff shell resolves for the sidebar (layout.tsx).
  const flags = {
    broadcastsEnabled: env.features.f7Broadcasts,
    eventsEnabled: env.features.f6EventCreate,
    memberChangeApproval: env.features.memberChangeApproval,
  } as const;
  const visible = CATEGORIES.filter(
    (c) =>
      !('visibilityFlag' in c && !flags[c.visibilityFlag]) &&
      canPerform(user.role, c.permission),
  );

  return renderSettingsHubView(visible);
}

/**
 * The hub for a list of categories the viewer may open, shared with the
 * /test-fixtures/aura-admin preview (spec 122 US10c).
 */
export async function renderSettingsHubView(
  visible: readonly (typeof CATEGORIES)[number][],
): Promise<React.JSX.Element> {
  const t = await getTranslations('admin.settings.index');
  // Every card gone: the viewer holds `dashboard.view` (so the index itself
  // opens) but no settings surface. Better than an empty grid, which reads as a
  // loading failure.
  if (visible.length === 0) {
    return (
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card>
          <EmptyState icon={SettingsIcon} title={t('empty')} bordered={false} />
        </Card>
      </DetailContainer>
    );
  }

  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <ul className="grid gap-[var(--aura-space-4)] md:grid-cols-2">
        {visible.map(({ titleKey, descriptionKey, href, icon: Icon }) => (
          <Card
            key={href}
            as="li"
            interactive
            className="relative has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-[var(--aura-focus-ring)]"
          >
            <div className="flex items-start gap-[var(--aura-space-4)]">
              <span
                aria-hidden
                className="grid size-10 shrink-0 place-items-center rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-canvas)] text-[var(--aura-fg-secondary)]"
              >
                <Icon className="size-5" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-[var(--aura-space-1)]">
                <h2 className="aura-text-body font-semibold text-[var(--aura-fg-primary)]">
                  <Link
                    href={href}
                    className="outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-['']"
                  >
                    {t(titleKey)}
                  </Link>
                </h2>
                <p className="aura-text-sm text-[var(--aura-fg-secondary)]">{t(descriptionKey)}</p>
              </div>
              <ChevronRightIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--aura-fg-secondary)]" />
            </div>
          </Card>
        ))}
      </ul>
    </DetailContainer>
  );
}
