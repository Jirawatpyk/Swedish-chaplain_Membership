'use client';

/**
 * <PayNowButton> — G4 T072.
 *
 * Thin client wrapper around the G2 <PaySheet> drawer:
 *   1. Renders a shadcn `<Button>` trigger visible on the invoice detail
 *      page. The parent page (T081) gates on `invoice.status === 'issued'`
 *      + `enabledMethods.length > 0`; this component renders the button
 *      unconditionally when instantiated.
 *   2. Auto-opens the drawer when the route carries `?pay=1` so F8
 *      reminder-email deep links land directly on the payment form
 *      (FR-025c).
 *
 * Architecture (refactored 2026-04-25 — code-quality audit closeout)
 * ------------------------------------------------------------------
 * The previous implementation lazy-loaded the entire <PaySheet> via
 * `next/dynamic` AND ran a `mounted` + `pendingOpen` two-commit state
 * machine to coax Base UI Dialog into playing its enter animation
 * (the lazy chunk + open transition collapsing into one commit
 * skipped the slide-in — T082 "first open fast, second slow"). Both
 * workarounds tripped React 19's `set-state-in-effect` lint rule.
 *
 * Root-cause fix: lazy boundary moved INWARD into <PaySheet>. The
 * Sheet primitive shell now renders eagerly (Base UI Dialog is small,
 * ~3-5 KB) and observes a real `open: false → true` transition on
 * first click → animation plays naturally. The expensive Stripe SDK +
 * <PaySheetInternal> chunk is still lazy, gated on `hasOpened` inside
 * <PaySheet>. Net effect: -60 lines, 0 ESLint suppressions, 0 effects.
 *
 * PCI / persistence
 * -----------------
 * No `localStorage`, `sessionStorage`, cookies, or any store that
 * outlives this component's state tree. The Stripe `clientSecret` is
 * owned by <PaySheetInternal> (lazy-loaded inside <PaySheet>) and
 * torn down on route change via React unmount of the page subtree.
 *
 * Barrel compliance (Constitution Principle III)
 * ----------------------------------------------
 * No cross-module reach-ins: this file only imports sibling G2/G3
 * components and shared UI primitives.
 */

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

import { PaySheet } from './index';
import type { PaymentMethod } from './method-tabs';

export interface PayNowButtonProps {
  readonly invoice: {
    readonly id: string;
    readonly invoiceNumber: string;
    readonly amountDue: number;
    readonly currency: string;
    readonly status: string;
  };
  readonly enabledMethods: readonly PaymentMethod[];
  readonly tenantPublishableKey: string;
}

export function PayNowButton({
  invoice,
  enabledMethods,
  tenantPublishableKey,
}: PayNowButtonProps) {
  const t = useTranslations('portal.payment');
  const searchParams = useSearchParams();

  const deepLinked = searchParams?.get('pay') === '1';
  const [open, setOpen] = useState<boolean>(deepLinked);

  return (
    <>
      <Button
        type="button"
        variant="default"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="pay-now-button"
        className="min-h-11 px-4"
      >
        {t('payNow')}
      </Button>
      <PaySheet
        invoice={{
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          amountDue: invoice.amountDue,
          currency: invoice.currency,
        }}
        enabledMethods={enabledMethods}
        tenantPublishableKey={tenantPublishableKey}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

export default PayNowButton;
