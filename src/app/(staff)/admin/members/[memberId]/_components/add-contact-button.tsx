'use client';

/**
 * "Add contact" on the member detail page's Contacts card (spec 122 US5b-1).
 * A client component so the dialog's trigger is built on the client: a
 * trigger element handed over from the server page arrived undefined when
 * the dialog cloned it (the AURA dialog has no trigger slot of its own).
 */
import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { buttonClass } from '@jirawatpyk/aura-react';
import { ContactFormDialog } from '@/components/members/contact-form-dialog';

export function AddContactButton({ memberId }: { readonly memberId: string }) {
  const t = useTranslations('admin.members.detail.contactActions');
  return (
    <ContactFormDialog
      memberId={memberId}
      mode="add"
      trigger={
        // On a phone a bare + (the board's ghost look); from 640px up the outlined button.
        <button type="button" className={buttonClass({ variant: 'secondary', size: 'sm', className: 'max-sm:border-transparent' })}>
          <PlusIcon className="size-4" aria-hidden="true" />
          {/* An icon button on a phone (board `Admin-member-detail-mobile`); the word stays its name. */}
          <span className="max-sm:sr-only">{t('add')}</span>
        </button>
      }
    />
  );
}
