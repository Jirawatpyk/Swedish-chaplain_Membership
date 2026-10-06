/**
 * Empty state for the `/admin/events` list (F6 US2 AS5 + CHK028).
 *
 * (a) !integrationConfigured           → "Set up EventCreate integration" CTA
 * (b) integrationConfigured && !everReceivedDelivery → "Waiting for first event…" hint
 * (c) items.length===0 && totalArchived>0 → "All events archived" with toggle
 * (d) hasFilters && items.length===0 → "No events match your filters" + clear
 *
 * (a) and (b) link to `/admin/settings/integrations/eventcreate`, gated on
 * `settings.integrations`. Manager and marketing read this list but lack
 * that key, so they get no links, and an admin-only hint in place of the
 * body copy that tells the viewer to act on the integration themselves.
 *
 * Spec 122 US9a (T901): each variant is the shared AURA `EmptyState`
 * (boards `Admin-state-events-no-integration`, `-waiting`), unbordered inside
 * the list card and not a live region: the filter bar's count announces the
 * list. Copy and links are unchanged.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArchiveIcon, CalendarIcon, InboxIcon, PlusIcon, SearchXIcon, SendIcon } from 'lucide-react';
import { buttonClass } from '@jirawatpyk/aura-react';
import { EmptyState } from '@/components/shell/empty-state';

export function EventsEmptyState({
  emptyContext,
  hasFilters,
  canManageIntegration,
}: {
  emptyContext: {
    integrationConfigured: boolean;
    everReceivedDelivery: boolean;
    totalArchived: number;
  };
  hasFilters: boolean;
  /** `canPerform(role, 'settings.integrations')` — the gate on the
   *  EventCreate settings page variants (a) and (b) link to. */
  canManageIntegration: boolean;
}) {
  const t = useTranslations('admin.events.list.emptyState');
  // Inside the list card: no frame of its own, and no second live region.
  const shared = { bordered: false, announce: false } as const;

  // Variant (d) — filters hide every event.
  if (hasFilters) {
    return (
      <EmptyState
        {...shared}
        icon={SearchXIcon}
        title={t('filteredEmpty')}
        action={
          <Link href="/admin/events" className={buttonClass({ variant: 'secondary' })}>
            {t('clearFilters')}
          </Link>
        }
      />
    );
  }

  // Variant (a) — no integration configured
  if (!emptyContext.integrationConfigured) {
    return (
      <EmptyState
        {...shared}
        icon={CalendarIcon}
        title={t('noIntegration.title')}
        description={canManageIntegration ? t('noIntegration.body') : t('noIntegration.adminOnlyHint')}
        action={
          canManageIntegration ? (
            <Link href="/admin/settings/integrations/eventcreate" className={buttonClass({ variant: 'primary' })}>
              <PlusIcon aria-hidden="true" className="size-4" />
              {t('noIntegration.cta')}
            </Link>
          ) : undefined
        }
      />
    );
  }

  // Variant (b) — configured but no deliveries yet: a primary "Send a test
  // event" (the `#test` fragment scrolls the wizard to its test step) and a
  // secondary link to the integration settings.
  if (!emptyContext.everReceivedDelivery) {
    return (
      <EmptyState
        {...shared}
        icon={InboxIcon}
        title={t('noDeliveries.title')}
        description={canManageIntegration ? t('noDeliveries.body') : t('noDeliveries.adminOnlyHint')}
        action={
          canManageIntegration ? (
            // On a phone the two actions stack at one full width.
            <div className="flex flex-wrap items-center justify-center gap-2 max-sm:flex-col max-sm:items-stretch">
              <Link href="/admin/settings/integrations/eventcreate#test" className={buttonClass({ variant: 'primary' })}>
                <SendIcon aria-hidden="true" className="size-4" />
                {t('noDeliveries.primaryCta')}
              </Link>
              <Link href="/admin/settings/integrations/eventcreate" className={buttonClass({ variant: 'secondary' })}>
                {t('noDeliveries.cta')}
              </Link>
            </div>
          ) : undefined
        }
      />
    );
  }

  // Variant (c) — all events archived
  if (emptyContext.totalArchived > 0) {
    return (
      <EmptyState
        {...shared}
        icon={ArchiveIcon}
        title={t('allArchived.title')}
        description={t('allArchived.body', { count: emptyContext.totalArchived })}
        action={
          <Link href="/admin/events?includeArchived=1" className={buttonClass({ variant: 'secondary' })}>
            {t('allArchived.cta', { count: emptyContext.totalArchived })}
          </Link>
        }
      />
    );
  }

  // Fallback — unusual combination (configured + delivered + no items
  // + no filters + 0 archived). Render the generic "no events found"
  // copy so the page never appears blank.
  return <EmptyState {...shared} icon={CalendarIcon} title={t('genericEmpty')} />;
}
