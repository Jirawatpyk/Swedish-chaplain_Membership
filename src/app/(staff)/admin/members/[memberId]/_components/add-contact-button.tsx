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
        // The word at every width, like the page's other card-head buttons,
        // though the phone board draws a bare + (maintainer, 29 Sep).
        <button type="button" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
          <PlusIcon className="size-4" aria-hidden="true" />
          {t('add')}
        </button>
      }
    />
  );
}
