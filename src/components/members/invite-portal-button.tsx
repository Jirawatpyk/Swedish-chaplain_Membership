'use client';

/**
 * Invite-to-portal button — T056.
 *
 * Mounted on the member detail page next to a contact that has an
 * email address and is not yet linked to a portal user. POSTs to
 * `/api/members/[memberId]/contacts/[contactId]/invite-portal` and
 * surfaces the result via `sonner` toast. On success the page is
 * refreshed (Next.js router) so the button disappears (the contact
 * now has a `linkedUserId`).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MailPlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Props = {
  readonly memberId: string;
  readonly contactId: string;
};

export function InvitePortalButton({ memberId, contactId }: Props) {
  const t = useTranslations('admin.members.invitePortal');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function handleClick() {
    setSubmitting(true);
    try {
      const response = await fetch(
        `/api/members/${encodeURIComponent(memberId)}/contacts/${encodeURIComponent(contactId)}/invite-portal`,
        { method: 'POST' },
      );
      if (response.ok) {
        toast.success(t('success'));
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      switch (body.error?.code) {
        case 'already_linked':
          toast.error(t('errors.alreadyLinked'));
          break;
        case 'no_email':
          toast.error(t('errors.noEmail'));
          break;
        case 'invalid_email':
          toast.error(t('errors.invalidEmail'));
          break;
        case 'email_taken':
          toast.error(t('errors.emailTaken'));
          break;
        case 'not_found':
          toast.error(t('errors.notFound'));
          break;
        default:
          toast.error(t('errors.serverError'));
      }
    } catch {
      toast.error(t('errors.serverError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={submitting}
      className="gap-2"
    >
      <MailPlusIcon className="h-4 w-4" aria-hidden="true" />
      {submitting ? t('submitting') : t('label')}
    </Button>
  );
}
