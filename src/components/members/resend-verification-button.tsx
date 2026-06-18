'use client';

/**
 * DV-11 — re-send verification email button (FR-012c).
 * Shown on the member detail page next to a portal-linked contact whose email
 * is still unverified. Mirrors ResendBouncedInviteButton.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MailCheckIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Props = { readonly memberId: string; readonly contactId: string };

export function ResendVerificationButton({ memberId, contactId }: Props) {
  const t = useTranslations('admin.members.detail.resendVerification');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function handleClick() {
    setSubmitting(true);
    try {
      const response = await fetch(
        `/api/members/${encodeURIComponent(memberId)}/contacts/${encodeURIComponent(contactId)}/resend-verification`,
        { method: 'POST' },
      );
      if (response.ok) {
        toast.success(t('resendSuccess'));
        router.refresh();
        return;
      }
      if (response.status === 429) {
        toast.error(t('errors.rateLimited'));
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { error?: string; reason?: string };
      if (body.error === 'not_eligible') {
        toast.error(body.reason === 'email_verified' ? t('errors.emailVerified') : t('errors.noLinkedUser'));
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
    <Button type="button" variant="outline" size="sm" onClick={handleClick} disabled={submitting} className="gap-2">
      <MailCheckIcon className="h-4 w-4" aria-hidden="true" />
      {submitting ? t('resendSubmitting') : t('resendLabel')}
    </Button>
  );
}
