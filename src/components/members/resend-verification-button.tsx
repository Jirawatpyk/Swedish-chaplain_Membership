'use client';

/**
 * DV-11 — re-send verification email button (FR-012c).
 * Shown on the member detail page next to a portal-linked contact whose email
 * is still unverified. Mirrors ResendBouncedInviteButton.
 *
 * Submitting resets on success (the hook default) so the admin can re-send
 *   again — resending only re-issues a verification token; the email stays
 *   unverified so this button stays mounted (its gate does not clear). The
 *   3/hr route rate-limiter (DV-11) is the double-click backstop. (DV
 *   code-review fix: the old always-no-reset left the button stuck disabled
 *   "Sending…" forever after one resend.)
 * Fix 10: delegates fetch/toast/refresh to useContactResendAction.
 */
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MailCheckIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useContactResendAction } from './use-contact-resend-action';

type Props = { readonly memberId: string; readonly contactId: string };

export function ResendVerificationButton({ memberId, contactId }: Props) {
  const t = useTranslations('admin.members.detail.resendVerification');

  const { submitting, handleClick } = useContactResendAction({
    url: `/api/members/${encodeURIComponent(memberId)}/contacts/${encodeURIComponent(contactId)}/resend-verification`,
    onSuccess: () => {
      toast.success(t('resendSuccess'));
    },
    on429: () => {
      toast.error(t('errors.rateLimited'));
    },
    onError: (body) => {
      if (body.error === 'not_eligible') {
        toast.error(
          body.reason === 'email_verified'
            ? t('errors.emailVerified')
            : t('errors.noLinkedUser'),
        );
      } else if (body.error === 'not_found') {
        toast.error(t('errors.notFound'));
      } else {
        toast.error(t('errors.serverError'));
      }
    },
  });

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleClick} disabled={submitting} className="gap-2">
      <MailCheckIcon className="h-4 w-4" aria-hidden="true" />
      {submitting ? t('resendSubmitting') : t('resendLabel')}
    </Button>
  );
}
