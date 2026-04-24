'use client';

/**
 * <PaySheet> — the member-portal "Pay invoice" drawer shell (G2 T074).
 *
 * Layout (FR-028h)
 * ----------------
 *   - Right-aligned <Sheet> on ≥ 640 px viewports
 *     (`sm:max-w-[480px] sm:h-auto`).
 *   - Full-screen on < 640 px viewports (`w-full h-full`).
 *   - Sticky header with <SheetTitle> (bilingual "Pay {invoiceNumber}")
 *     plus a close button whose tap target is ≥ 44 × 44 px (WCAG 2.5.5).
 *
 * Deep-linking (FR-025c)
 * ----------------------
 * When the route is opened with `?pay=1` (set on F8 invoice-reminder
 * email links), the drawer auto-opens on mount.
 *
 * Idle-watcher integration (FR-028c)
 * ----------------------------------
 * While open, the drawer calls `useIdleWarningSuppression(open)` which
 * broadcasts `swecham:pause-idle-timer` / `swecham:resume-idle-timer`
 * CustomEvents. Once the drawer has been open longer than
 * `PAY_SHEET_HARD_CAP_MS` (30 min) the hook flips `timeoutExceeded=true`;
 * G3/G4 will render the in-drawer "Are you still here?" prompt off that
 * signal (it is intentionally not wired in G2).
 *
 * PCI constraint (F5 PCI Group-G must-do)
 * ---------------------------------------
 * All payment state — most critically the Stripe `clientSecret` — lives
 * ONLY inside <PaySheetInternal>'s ephemeral React state. On drawer
 * close we unmount the internal subtree (because `{open && ...}`), which
 * guarantees the state tree is torn down. We do NOT write payment state
 * to any browser persistence store (localStorage, sessionStorage,
 * cookies, IndexedDB). A grep of this directory MUST return zero
 * references to `localStorage` or `sessionStorage`.
 *
 * G2 scope
 * --------
 * Shell + MethodTabs only. G3 wires the real card form + 3DS challenge
 * + confirmation panel + the hard-cap prompt.
 */

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { PaySheetSkeleton } from '@/components/payments/pay-sheet-skeleton';
import { useIdleWarningSuppression } from '@/hooks/use-idle-warning-suppression';

import type { PaymentMethod } from './method-tabs';

const PaySheetInternal = dynamic(
  () => import('./pay-sheet-internal').then((m) => m.PaySheetInternal),
  {
    ssr: false,
    loading: () => <PaySheetSkeleton />,
  },
);

export interface PaySheetInvoice {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly amountDue: number;
  readonly currency: string;
}

export interface PaySheetProps {
  readonly invoice: PaySheetInvoice;
  readonly enabledMethods: readonly PaymentMethod[];
  readonly tenantPublishableKey: string;
  /** Fired after the drawer fully closes (any path). */
  readonly onClose?: () => void;
  /** Render prop for the trigger, so the caller controls open state. */
  readonly children?: (open: () => void) => React.ReactNode;
}

export function PaySheet({
  invoice,
  enabledMethods,
  tenantPublishableKey,
  onClose,
  children,
}: PaySheetProps) {
  const t = useTranslations('portal.payment.drawer');
  const searchParams = useSearchParams();

  // FR-025c — deep link from F8 reminder emails. We derive the initial
  // open state from the URL directly (useState initializer) rather than
  // setting state inside a useEffect, which eslint's
  // `react-hooks/set-state-in-effect` (and React's own guidance) flags
  // as a cascading-render smell. Subsequent navigation does not re-open
  // the drawer automatically — that matches the product requirement
  // (the user explicitly closes it and may re-trigger via "Pay now").
  const [open, setOpen] = useState<boolean>(
    () => searchParams?.get('pay') === '1',
  );

  // FR-028c — pause the F1 idle-watcher while the drawer is open.
  useIdleWarningSuppression(open);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      onClose?.();
    }
  };

  return (
    <>
      {children?.(() => setOpen(true))}
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="sm:max-w-[480px] w-full h-full sm:h-auto"
          data-testid="pay-sheet-content"
        >
          <SheetHeader className="sticky top-0 z-10 flex flex-row items-center justify-between bg-popover border-b">
            <SheetTitle>
              {t('title', { invoiceNumber: invoice.invoiceNumber })}
            </SheetTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('close')}
              onClick={() => handleOpenChange(false)}
              // WCAG 2.5.5 — ≥ 44×44 px tap target on mobile.
              className="min-h-[44px] min-w-[44px]"
              data-testid="pay-sheet-close"
            >
              <XIcon className="size-5" />
            </Button>
          </SheetHeader>
          {/*
           * WCAG 2.4.11 (Focus Not Obscured) — G-Review Finding #8.
           * The sticky header overlaps native scroll-into-view when
           * the iOS soft keyboard pushes a focused Stripe input under
           * the header. `scroll-padding-top` offsets the scroll
           * anchor by the header height so the focused field remains
           * visible above the chrome.
           */}
          <div
            className="overflow-y-auto p-4"
            style={{ scrollPaddingTop: 'var(--pay-sheet-header-height, 64px)' }}
          >
            {open ? (
              <PaySheetInternal
                invoice={invoice}
                enabledMethods={enabledMethods}
                tenantPublishableKey={tenantPublishableKey}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export default PaySheet;
