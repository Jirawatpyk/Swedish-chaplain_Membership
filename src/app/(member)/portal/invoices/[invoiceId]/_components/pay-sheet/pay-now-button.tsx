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
 * PCI / persistence
 * -----------------
 * No `localStorage`, `sessionStorage`, cookies, or any store that
 * outlives this component's state tree. The Stripe `clientSecret` is
 * owned by <PaySheetInternal> (lazy-loaded inside <PaySheet>) and torn
 * down on drawer close via React unmount.
 *
 * Barrel compliance (Constitution Principle III)
 * ----------------------------------------------
 * No cross-module reach-ins: this file only imports sibling G2/G3
 * components and shared UI primitives.
 */

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { PaySheetSkeleton } from '@/components/payments/pay-sheet-skeleton';

import type { PaymentMethod } from './method-tabs';

// Lazy-load the drawer container so the Stripe SDK (pulled in by
// <PaySheetInternal>'s deeper dynamic import) stays out of the invoice-
// detail initial bundle.
const PaySheet = dynamic(
  () => import('./index').then((m) => m.PaySheet),
  {
    ssr: false,
    loading: () => <PaySheetSkeleton />,
  },
);

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

  // Derived from the URL on first render. When `?pay=1` is present we
  // mount the drawer immediately so the F8 email deep-link lands on
  // the payment form directly. We use the lazy initializer form so
  // React reads `searchParams` exactly once on mount — avoiding the
  // `react-hooks/set-state-in-effect` cascading-render smell (same
  // pattern as <PaySheet> itself, G2 T074).
  const [mounted, setMounted] = useState<boolean>(
    () => searchParams?.get('pay') === '1',
  );

  const handleClose = () => {
    // Once closed, unmount the entire drawer subtree so the Stripe
    // state tree (including any in-flight clientSecret) is released.
    setMounted(false);
  };

  return (
    <>
      <Button
        type="button"
        variant="default"
        size="sm"
        onClick={() => setMounted(true)}
        data-testid="pay-now-button"
        className="min-h-11 px-4"
      >
        {t('payNow')}
      </Button>
      {mounted ? (
        <PaySheet
          invoice={{
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            amountDue: invoice.amountDue,
            currency: invoice.currency,
          }}
          enabledMethods={enabledMethods}
          tenantPublishableKey={tenantPublishableKey}
          onClose={handleClose}
        />
      ) : null}
    </>
  );
}

export default PayNowButton;
