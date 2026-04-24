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

import { useEffect, useState } from 'react';
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

  // FR-028h — mobile full-screen vs desktop auto-height via matchMedia
  // (see SheetContent style prop below for why Tailwind class overrides
  // were unreliable against the shadcn primitive's `data-[side=right]:h-full`
  // cascade even with matching variant prefix + trailing `!`).
  //
  // T082 empirical E2E discovery #3 (2026-04-24): initialising the
  // state lazily from `window.matchMedia` (synchronous on client, and
  // PaySheet ships via `next/dynamic({ssr: false})` so SSR is never
  // entered) avoids the first-render flash where mobile viewports
  // render with desktop styles (`height: auto`) before `useEffect`
  // swaps them. Playwright's `networkidle` wait + `.boundingBox()`
  // was catching the flash frame + reporting 1087 px (content height)
  // instead of 568 px.
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 639.98px)').matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 639.98px)');
    const handler = (e: MediaQueryListEvent) => setIsMobileViewport(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

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
          // T082 empirical E2E discovery (2026-04-24): shadcn
          // `<SheetContent side="right">` ships with default variants
          // `data-[side=right]:w-3/4` (75 %) + `data-[side=right]:sm:max-w-[var(--modal-max-width-md)]`
          // (= 32 rem = 512 px). Both Tailwind class overrides AND
          // matching `data-[side=right]:` prefix overrides failed to
          // defeat the primitive cascade reliably — the drawer
          // rendered at 612 px on a 320 px iPhone viewport, which
          // violates FR-028h. Override via a scoped CSS variable:
          // `--modal-max-width-md` pins the sm-and-up max-width, and
          // a compound `data-[side=right]:` utility pins the mobile
          // width to 100 %. Inline style is a belt-and-braces
          // guarantee against future primitive changes.
          style={{
            // `--modal-max-width-md: 30rem` (= 480 px) pins the sm-and-up
            // max-width via the CSS var the primitive reads.
            ['--modal-max-width-md' as string]: '30rem',
            // `width` + `height` via runtime matchMedia (see
            // `isMobileViewport` below). Inline-style beats any CSS
            // rule from the shadcn primitive regardless of specificity
            // or !important, guaranteeing FR-028h literal compliance:
            //   < 640 px  → 100% × 100% (full-screen)
            //   ≥ 640 px  → width from CSS var (≤ 480 px), auto height
            width: '100%',
            // Use `100vh` (viewport-relative) on mobile instead of `100%`
            // (parent-relative). Inside Radix Dialog's Portal the
            // containing-block can resolve to the body element when
            // `isMobile: true` emulation is active — body scrollHeight
            // (e.g. 1087 px on portal detail page) would then be the
            // reference instead of viewport (568 px on iPhone SE).
            // `100vh` ties height to the viewport unconditionally.
            // T082 empirical E2E discovery #4 (2026-04-24).
            height: isMobileViewport ? '100vh' : 'auto',
            // T082 empirical E2E discovery #2 (2026-04-24): the primitive
            // applies `data-[side=right]:inset-y-0` (= top: 0 + bottom: 0)
            // which together with `position: fixed` STRETCHES the element
            // to full viewport height regardless of declared `height:
            // auto`. Clear `bottom` on desktop so the right-drawer sits
            // top-aligned at its content height. On mobile keep the
            // primitive behaviour (full-viewport stretch is intentional).
            bottom: isMobileViewport ? undefined : 'auto',
          }}
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
            // T082 empirical E2E discovery (2026-04-24): SC 2.4.11
            // Focus-Not-Obscured requires focused element top >
            // stickyHeader.bottom + 24 px. The previous `p-4` gave
            // only 16 px of padding-top, so the first interactive
            // element (method tabs) landed 16 px below the sticky
            // header — 8 px short of the buffer. `pt-10` (= 40 px)
            // provides 24 px + 16 px breathing room for the focus
            // ring to sit comfortably below the header chrome.
            className="overflow-y-auto px-4 pt-10 pb-4"
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
