'use client';

/**
 * Spec 122 US9a (T901) — the events list header's "More actions" menu on a
 * phone (board `Admin-events-mobile`): "Erase by email" leaves the header row
 * for this menu, so "Import CSV" keeps the row to itself. From 640px the
 * header shows the link itself and this menu is hidden.
 */
import { useTranslations } from 'next-intl';
import { EraserIcon } from 'lucide-react';
import { DropdownMenu, IconButton } from '@jirawatpyk/aura-react';

export function EventsHeaderMenu({ eraseByEmailHref }: { readonly eraseByEmailHref: string }) {
  const t = useTranslations('admin.events');
  return (
    // `flex-none!`: the page header stretches every action on a phone; the menu
    // keeps its own width so Import CSV fills the row (as on the member page).
    <div className="flex-none! sm:hidden">
      <DropdownMenu
        label={t('list.moreActions')}
        trigger={<IconButton icon="ellipsis" label={t('list.moreActions')} touchHeight />}
        items={[{ label: t('erasure.discoverabilityCta'), icon: <EraserIcon aria-hidden />, href: eraseByEmailHref }]}
      />
    </div>
  );
}
