/**
 * Empty state for the `/admin/events` list (F6 US2 AS5 + CHK028).
 *
 * (a) !integrationConfigured           → "Set up EventCreate integration" CTA
 * (b) integrationConfigured && !everReceivedDelivery → "Waiting for first event…" hint
 * (c) items.length===0 && totalArchived>0 → "All events archived" with toggle
 * (d) hasFilters && items.length===0 → "No events match your filters" + clear
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { PlusIcon, InboxIcon, SendIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';

export function EventsEmptyState({
  emptyContext,
  hasFilters,
}: {
  emptyContext: {
    integrationConfigured: boolean;
    everReceivedDelivery: boolean;
    totalArchived: number;
  };
  hasFilters: boolean;
}) {
  const t = useTranslations('admin.events.list.emptyState');

  if (hasFilters) {
    return (
      <div className="py-12 text-center">
        <h2 className="text-muted-foreground">{t('filteredEmpty')}</h2>
        <Link
          href="/admin/events"
          className={buttonVariants({ variant: 'outline', className: 'mt-4' })}
        >
          {t('clearFilters')}
        </Link>
      </div>
    );
  }

  // Variant (a) — no integration configured
  if (!emptyContext.integrationConfigured) {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <h2 className="text-h3 font-semibold">{t('noIntegration.title')}</h2>
        <p className="max-w-md text-muted-foreground">
          {t('noIntegration.body')}
        </p>
        <Link
          href="/admin/settings/integrations/eventcreate"
          className={buttonVariants({ variant: 'default' })}
        >
          <PlusIcon aria-hidden="true" className="size-4" />
          {t('noIntegration.cta')}
        </Link>
      </div>
    );
  }

  // Variant (b) — configured but no deliveries yet.
  // P2 (round-10 ui-design-specialist) — promoted to a primary "Send a
  // test event" CTA + InboxIcon as illustration. The body copy already
  // alludes to the test-webhook escape hatch; the CTA now matches.
  // Secondary link lets admins jump to the integration-settings surface
  // without the test affordance. `#test` fragment lets Phase 5 wizard
  // scroll-to-phaseC when it lands (no-op when it doesn't, no
  // regression). Reduced-motion safe: no animation here — the parent
  // page-level fade-in (P4) already handles motion semantics.
  if (!emptyContext.everReceivedDelivery) {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        {/* Round-12 review fix — decorative icon only. The previously-
            adjacent `sr-only illustrationAlt` span was orphaned (no
            semantic link to the aria-hidden icon) and produced an
            "Empty inbox illustration" SR announcement disconnected
            from the surrounding state. Empty-state title + body
            already convey the meaning; the icon is purely visual. */}
        <InboxIcon
          aria-hidden="true"
          className="size-12 stroke-1 text-muted-foreground"
        />
        <h2 className="text-h3 font-semibold">{t('noDeliveries.title')}</h2>
        <p className="max-w-md text-muted-foreground">
          {t('noDeliveries.body')}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Link
            href="/admin/settings/integrations/eventcreate#test"
            className={buttonVariants({ variant: 'default' })}
          >
            <SendIcon aria-hidden="true" data-icon="inline-start" />
            {t('noDeliveries.primaryCta')}
          </Link>
          <Link
            href="/admin/settings/integrations/eventcreate"
            className={buttonVariants({ variant: 'outline' })}
          >
            {t('noDeliveries.cta')}
          </Link>
        </div>
      </div>
    );
  }

  // Variant (c) — all events archived
  if (emptyContext.totalArchived > 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <h2 className="text-h3 font-semibold">{t('allArchived.title')}</h2>
        <p className="max-w-md text-muted-foreground">
          {t('allArchived.body', { count: emptyContext.totalArchived })}
        </p>
        <Link
          href="/admin/events?includeArchived=1"
          className={buttonVariants({ variant: 'outline' })}
        >
          {t('allArchived.cta', { count: emptyContext.totalArchived })}
        </Link>
      </div>
    );
  }

  // Fallback — unusual combination (configured + delivered + no items
  // + no filters + 0 archived). Render the generic "no events found"
  // copy so the page never appears blank.
  return (
    <div className="py-12 text-center">
      <p className="text-muted-foreground">{t('genericEmpty')}</p>
    </div>
  );
}
