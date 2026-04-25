'use client';

/**
 * <OnlinePaymentDisabledCard> — G4 T082 (FR-030 empty-state).
 *
 * Rendered by the invoice-detail page (T081) when any of these hold:
 *   - `tenantPaymentSettings.online_payment_enabled === false`
 *   - `FEATURE_F5_ONLINE_PAYMENT === false` (env kill-switch)
 *   - `tenantPaymentSettings` is incomplete (missing publishable key,
 *     processor account id, or an empty enabled-methods set)
 *
 * Anatomy follows `docs/ux-standards.md` § 3.1:
 *   - Card container wrapped by the page's DetailContainer (72rem).
 *   - Icon (lucide `CreditCardOff`, 48×48, muted-foreground) top-center.
 *   - Bilingual title + 1–2 line body (i18n-driven).
 *   - Primary CTA opens a `mailto:` to the tenant contact email with
 *     a prefilled subject referring to the invoice number. Falls
 *     through to a disabled button + inline help when the tenant has
 *     no `contactEmail` configured.
 *
 * PCI
 * ---
 * No payment state touches this component — it's the alternate branch
 * for when online payment is unavailable.
 */

import { useTranslations } from 'next-intl';
import { CreditCard, Slash } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Local `CreditCardOff` composite — G-Review Finding #4.
 *
 * The spec + FR-030 name this icon `CreditCardOff`, but the installed
 * `lucide-react@^0.468` build does not export it. Rather than upgrade
 * (infra change, outside G-Review scope) or revert to the unrelated
 * `Ban` glyph (off-brand for a payment surface), we compose the
 * spec-named semantic by layering `Slash` over `CreditCard`. The
 * composite is aria-hidden — the surrounding card title carries the
 * accessible name.
 */
function CreditCardOff({
  className,
  ...rest
}: React.SVGAttributes<SVGElement> & { className?: string }) {
  return (
    <span
      className={cn('relative inline-block', className)}
      aria-hidden={rest['aria-hidden'] ?? true}
      data-testid="credit-card-off"
    >
      <CreditCard className="size-full" aria-hidden="true" />
      <Slash
        className="absolute inset-0 size-full"
        aria-hidden="true"
      />
    </span>
  );
}

export interface OnlinePaymentDisabledCardProps {
  readonly invoiceNumber: string;
  readonly tenantContactEmail: string | null;
}

export function OnlinePaymentDisabledCard({
  invoiceNumber,
  tenantContactEmail,
}: OnlinePaymentDisabledCardProps) {
  const t = useTranslations('portal.payment.disabled');

  // Subject line is i18n-driven so Thai/Swedish members email Thai/
  // Swedish admins in the member's own language rather than a
  // hardcoded English string (audit 2026-04-25 finding #8).
  const mailtoHref = tenantContactEmail
    ? `mailto:${tenantContactEmail}?subject=${encodeURIComponent(
        t('mailSubject', { invoiceNumber }),
      )}`
    : null;

  return (
    <Card data-testid="online-payment-disabled-card">
      <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
        <CreditCardOff
          className="size-12 text-muted-foreground"
          aria-hidden="true"
        />
        <h2 className="text-h4 text-foreground">{t('title')}</h2>
        <p className="max-w-prose text-body text-muted-foreground">
          {t('body')}
        </p>
        {mailtoHref ? (
          <a
            href={mailtoHref}
            data-testid="online-payment-disabled-cta"
            className={cn(
              buttonVariants({ variant: 'default', size: 'sm' }),
              'min-h-11 px-4',
            )}
          >
            {t('contactAdminCta')}
          </a>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled
              data-testid="online-payment-disabled-cta"
              className="min-h-11 px-4"
            >
              {t('contactAdminCta')}
            </Button>
            <p
              data-testid="online-payment-disabled-no-email-help"
              className="text-caption text-muted-foreground"
            >
              {t('noContactEmail')}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default OnlinePaymentDisabledCard;
