'use client';

/**
 * Re-send-bounced-invite button — F3 spec § Edge Cases.
 *
 * Shown on the member detail page next to a contact whose invitation
 * email bounced (`inviteBouncedAt` is non-null). POSTs to the new
 * resend-invite route and surfaces the result via `sonner` toast.
 * On success the page is refreshed so the bounced badge disappears.
 *
 * Fix 10: delegates fetch/toast/refresh to useContactResendAction.
 * NOTE: this route has NO rate-limit — `on429` is intentionally omitted
 * to avoid referencing a missing `errors.rateLimited` key in the
 * `admin.members.detail.inviteBounced` namespace (MISSING_MESSAGE guard).
 */

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MailIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useContactResendAction } from './use-contact-resend-action';

type Props = {
  readonly memberId: string;
  readonly contactId: string;
};

export function ResendBouncedInviteButton({ memberId, contactId }: Props) {
  const t = useTranslations('admin.members.detail.inviteBounced');

  const { submitting, handleClick } = useContactResendAction({
    url: `/api/members/${encodeURIComponent(memberId)}/contacts/${encodeURIComponent(contactId)}/resend-invite`,
    onSuccess: () => {
      toast.success(t('resendSuccess'));
    },
    // On success the route clears invite_bounced_at, so the visible-gate
    // (inviteBouncedAt && linkedUserId) goes false and this button UNMOUNTS
    // after router.refresh() — keep it disabled until then to avoid a
    // re-enable flicker (no need to reset submitting).
    keepDisabledOnSuccess: true,
    // on429 intentionally omitted — the resend-invite route is not rate-limited
    // and the inviteBounced namespace has no rateLimited key.
    onError: (body) => {
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
    },
  });

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
