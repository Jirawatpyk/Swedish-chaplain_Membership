'use client';

/**
 * Re-send-bounced-invite button — F3 spec § Edge Cases.
 *
 * Shown on the member detail page next to a contact whose invitation
 * email bounced (`inviteBouncedAt` is non-null). POSTs to the new
 * resend-invite route and surfaces the result via `sonner` toast.
 * On success the page is refreshed so the bounced badge disappears.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MailIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Props = {
  readonly memberId: string;
  readonly contactId: string;
};

export function ResendBouncedInviteButton({ memberId, contactId }: Props) {
  const t = useTranslations('admin.members.detail.inviteBounced');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function handleClick() {
    setSubmitting(true);
    try {
      const response = await fetch(
        `/api/members/${encodeURIComponent(memberId)}/contacts/${encodeURIComponent(contactId)}/resend-invite`,
        { method: 'POST' },
      );
      if (response.ok) {
        toast.success(t('resendSuccess'));
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
      };
      if (body.error === 'not_eligible') {
        switch (body.reason) {
          case 'not_bounced':
            toast.error(t('errors.notBounced'));
            break;
          case 'already_active':
            toast.error(t('errors.alreadyActive'));
            break;
          case 'no_linked_user':
            toast.error(t('errors.noLinkedUser'));
            break;
          default:
            toast.error(t('errors.serverError'));
        }
      } else if (body.error === 'not_found') {
        toast.error(t('errors.notFound'));
      } else {
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
      <MailIcon className="h-4 w-4" aria-hidden="true" />
      {submitting ? t('resendSubmitting') : t('resendLabel')}
    </Button>
  );
}
