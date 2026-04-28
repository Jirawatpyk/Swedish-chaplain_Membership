'use client';

/**
 * <SecurityFooter> — trust signals shown at the bottom of the PaySheet
 * drawer body. Addresses user-reported empty-space gap below the submit
 * button (T082 walk-through 2026-04-24) and the industry-standard
 * requirement that payment surfaces surface "Secured by Stripe" +
 * accepted-card badges + a terms-of-service link.
 */

import { useTranslations } from 'next-intl';
import { LockIcon, ShieldCheckIcon } from 'lucide-react';

export function SecurityFooter() {
  const t = useTranslations('portal.payment.security');

  return (
    <footer
      data-testid="pay-sheet-security-footer"
      className="mt-6 space-y-3 border-t border-border pt-4"
    >
      <div className="flex items-center gap-2 text-caption text-muted-foreground">
        <LockIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span>{t('encrypted')}</span>
      </div>
      <div className="flex items-center gap-2 text-caption text-muted-foreground">
        <ShieldCheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span>{t('stripeBadge')}</span>
      </div>
      <p className="text-caption text-muted-foreground">{t('cards')}</p>
      {/*
       * review-20260428-102639.md W1 closure — PDPA §23 / GDPR Art. 13
       * disclosure at point of collection. PromptPay sends member email
       * to Stripe (Ireland/US infrastructure); see `data-transfers.md
       * § 2`. Visible on every pay-sheet open so the disclosure is
       * contemporaneous with consent (not buried in a privacy policy).
       */}
      <p className="text-caption text-muted-foreground">
        {t.rich('privacyDisclosure', {
          stripeLink: (chunks) => (
            <a
              href="https://stripe.com/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              {chunks}
            </a>
          ),
        })}
      </p>
    </footer>
  );
}

export default SecurityFooter;
