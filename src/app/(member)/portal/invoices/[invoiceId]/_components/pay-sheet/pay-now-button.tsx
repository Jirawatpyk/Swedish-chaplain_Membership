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

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

import type { PaymentMethod } from './method-tabs';

// Lazy-load the drawer container so the Stripe SDK (pulled in by
// <PaySheetInternal>'s deeper dynamic import) stays out of the invoice-
// detail initial bundle. Loaded on first "Pay now" click; thereafter
// kept mounted so open/close cycles don't remount <PaySheetInternal>
// (which would re-fire the POST /api/payments/initiate fetch and burn
// through the rate-limit budget — T082 UX feedback 2026-04-24).
const PaySheet = dynamic(
  () => import('./index').then((m) => m.PaySheet),
  {
    ssr: false,
    // Null loading fallback (T082 UX feedback 2026-04-24): we
    // auto-mount PaySheet on PayNowButton render so the chunk is
    // normally fetched + parsed before the user ever clicks. A
    // visible skeleton here would appear at the page top (not
    // inside the drawer) because PaySheet is a sibling of the
    // invoice-detail content — producing a confusing loading
    // artifact. Returning null keeps it invisible.
    loading: () => null,
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

  const deepLinked = searchParams?.get('pay') === '1';

  // `mounted` — deferred-lazy-load flag. Flips to `true` on first
  // request (click or `?pay=1` deep link) and stays true so the
  // PaySheet tree survives open/close cycles (preserves ephemeral
  // payment state — PCI SAQ-A: state lives in React memory only).
  const [mounted, setMounted] = useState<boolean>(deepLinked);
  // `open` — controlled visibility. ALWAYS initialised to `false`,
  // including the deep-link case, so Base UI's Dialog primitive sees
  // a genuine `false → true` transition on first open and plays the
  // enter animation (T082 UX feedback 2026-04-24: without this, first
  // open skipped the slide animation while second open ran the full
  // 300ms — felt inconsistent + "second open is slower").
  const [open, setOpen] = useState<boolean>(false);
  // `pendingOpen` — queues an open request until after the first
  // render where `mounted=true` has committed. Without the queue we
  // would call `setOpen(true)` in the same render as `setMounted(true)`
  // and the Sheet would mount with open already true, again skipping
  // the enter animation.
  const [pendingOpen, setPendingOpen] = useState<boolean>(deepLinked);

  // Auto-mount PaySheet (closed) as soon as PayNowButton renders.
  // The lazy `next/dynamic` wrapper still defers the Stripe SDK chunk
  // until the browser's idle time, but the PaySheet React tree itself
  // lives in the DOM with `open=false` from the start. Consequence:
  // first click just flips `open` false→true and Base UI Dialog sees
  // a genuine state transition + plays the enter animation — matching
  // the second-and-subsequent opens (T082 UX feedback 2026-04-24:
  // "first open fast, second slow" — caused by PaySheet mounting +
  // opening in the same React commit + the lazy chunk's micro-task
  // delay, together collapsing Base UI's observable transition).
  useEffect(() => {
    if (!mounted) setMounted(true);
  }, [mounted]);

  useEffect(() => {
    // Deep-link (`?pay=1`) — open after PaySheet has committed once
    // so the enter animation plays.
    if (mounted && pendingOpen) {
      setOpen(true);
      setPendingOpen(false);
    }
  }, [mounted, pendingOpen]);

  const handleOpen = () => {
    // PaySheet is already auto-mounted on PayNowButton render — just
    // flip visibility. Falls back to the lazy-mount path for edge
    // cases where the auto-mount effect hasn't fired yet (extremely
    // short render window; unlikely in practice).
    if (!mounted) {
      setMounted(true);
      setPendingOpen(true);
    } else {
      setOpen(true);
    }
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    // Intentionally do NOT setMounted(false) — keeping PaySheet in the
    // tree preserves its ephemeral payment state (clientSecret) across
    // drawer close/reopen cycles. PCI SAQ-A is still satisfied because
    // state never leaves React memory + it's torn down on route change.
  };

  return (
    <>
      <Button
        type="button"
        variant="default"
        size="sm"
        onClick={handleOpen}
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
          open={open}
          onOpenChange={handleOpenChange}
        />
      ) : null}
    </>
  );
}

export default PayNowButton;
