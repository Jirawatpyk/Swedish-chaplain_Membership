'use client';

/**
 * Spec 122 US8 (T809) — the invoice list's Export CSV… action, and on a
 * phone the ⋯ menu that holds it with Tax registers. From sm up the export
 * button shows in the header row as before; below 640px "New invoice" keeps
 * the row and these two move into the menu (the US5a members header and the
 * US5b-1 member-detail ⋯ menu). One component owns the dialog's open state
 * so the menu item can open the same export dialog.
 */
import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { DropdownMenu, IconButton, type MenuItem } from '@jirawatpyk/aura-react';
import { CsvExportDialog } from './csv-export-dialog';

const MORE_TRIGGER_ID = 'invoices-header-more';

export function InvoicesExportActions({ showRegisters }: { readonly showRegisters: boolean }) {
  const t = useTranslations('admin.invoices');
  const [csvOpen, setCsvOpen] = useState(false);
  const [openedFromMenu, setOpenedFromMenu] = useState(false);

  // Opened from the menu, the dialog's own trigger is hidden, so focus goes
  // back to the ⋯ (WCAG 2.4.3); otherwise AURA returns it to the trigger.
  const finalFocus = useCallback(
    (): HTMLElement | null => (openedFromMenu ? document.getElementById(MORE_TRIGGER_ID) : null),
    [openedFromMenu],
  );

  const items: MenuItem[] = [
    ...(showRegisters
      ? [{ label: t('registers.entry'), href: '/admin/invoices/registers', icon: 'file-text' } satisfies MenuItem]
      : []),
    {
      label: t('csvExport.trigger'),
      icon: 'download',
      onSelect: () => {
        setOpenedFromMenu(true);
        setCsvOpen(true);
      },
    },
  ];

  return (
    <>
      <CsvExportDialog
        open={csvOpen}
        onOpenChange={(next) => {
          if (next) setOpenedFromMenu(false);
          setCsvOpen(next);
        }}
        triggerClassName="max-sm:hidden"
        finalFocus={finalFocus}
      />
      <span className="contents sm:hidden">
        <DropdownMenu
          label={t('list.actions.moreHeaderAria')}
          trigger={
            <IconButton id={MORE_TRIGGER_ID} icon="ellipsis" touchHeight label={t('list.actions.moreHeaderAria')} />
          }
          items={items}
        />
      </span>
    </>
  );
}
