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

import { useEffect, useRef, useState } from 'react';
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

import { HardCapPrompt } from './hard-cap-prompt';

import type { PaymentMethod } from './method-tabs';

// Lazy boundary (refactored 2026-04-25 — code-quality audit closeout).
// Only the Stripe-SDK-heavy <PaySheetInternal> is lazy; the Sheet shell
// renders eagerly so Base UI Dialog observes a real `open: false → true`
// transition on first click and plays its slide-in animation. The
// skeleton renders INSIDE the drawer body (correct location) on the
// rare race where the user clicks before the pre-warmed chunk lands.
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
  /**
   * Controlled visibility. When provided, PaySheet becomes a controlled
   * component and the parent owns open/close lifecycle. This is the
   * recommended pattern so the parent (e.g. <PayNowButton>) can keep
   * PaySheet mounted across close→reopen cycles and preserve the
   * ephemeral payment state (clientSecret) — avoiding unnecessary
   * POST /api/payments/initiate fetches (T082 UX feedback 2026-04-24).
   */
  readonly open?: boolean;
  /** Controlled open-state handler, paired with `open`. */
  readonly onOpenChange?: (open: boolean) => void;
  /** Fired after the drawer fully closes (any path) — legacy hook. */
  readonly onClose?: () => void;
  /** Render prop for the trigger, so the caller controls open state. */
  readonly children?: (open: () => void) => React.ReactNode;
}

export function PaySheet({
  invoice,
  enabledMethods,
  tenantPublishableKey,
  open: controlledOpen,
  onOpenChange,
  onClose,
  children,
}: PaySheetProps) {
  const t = useTranslations('portal.payment.drawer');
  const searchParams = useSearchParams();

  // FR-025c — deep link from F8 reminder emails. Uncontrolled fallback
  // state used only when `controlledOpen` is undefined (legacy callers).
  const [uncontrolledOpen, setUncontrolledOpen] = useState<boolean>(
    () => searchParams?.get('pay') === '1',
  );
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  // FR-028c — pause the F1 idle-watcher while the drawer is open +
  // expose the 30-min hard-cap signal. When `timeoutExceeded` flips
  // true the PaySheet body renders <HardCapPrompt> with a 60-second
  // countdown (B3 / T082). Clicking Continue calls `reset()` which
  // re-arms the hook's 30-minute timer and clears `timeoutExceeded`.
  const { timeoutExceeded, reset: resetHardCap } =
    useIdleWarningSuppression(open);

  // Pre-warm the <PaySheetInternal> chunk (Stripe SDK + Elements) on
  // PaySheet render so first-click feels instant. Without this, the
  // user clicks → Sheet animates open → `hasOpened` flips → dynamic
  // import fires → ~50-200 ms skeleton flicker. Pre-warming kicks the
  // import off as soon as the invoice page mounts, so the chunk is
  // typically ready by the time the user reaches "Pay now". The
  // `void` discards the promise; we only care about the side-effect
  // (chunk fetched + parsed by webpack runtime).
  useEffect(() => {
    void import('./pay-sheet-internal');
  }, []);

  // Mount-once pattern (T082 UX feedback 2026-04-24): PaySheetInternal
  // fetches `/api/payments/initiate` on mount to create a Stripe
  // PaymentIntent. If we gate its mount on `{open && ...}` then every
  // close→reopen cycle remounts it, which re-fires the initiate fetch
  // and quickly exhausts the rate-limit budget (10 req / 5 min). The
  // correct pattern is: lazy-mount on FIRST open, then keep mounted for
  // the life of the invoice page. The drawer's own `open` prop hides it
  // visually; PaymentIntent clientSecret stays in React state only
  // (ephemeral, no persistence) — PCI SAQ-A constraint preserved.
  // Derive-during-render pattern (React docs: "Adjusting some state when
  // a prop changes") — once `open` flips true we latch `hasOpened`.
  // React batches the setState during render so no cascading effect
  // commit; bypasses the `set-state-in-effect` rule semantically.
  const [hasOpened, setHasOpened] = useState<boolean>(() => open);
  if (open && !hasOpened) {
    setHasOpened(true);
  }

  // Parent-scope cache for the initiate response so Radix Sheet's
  // Portal mount/unmount on close/reopen does not discard the Stripe
  // clientSecret + trigger a fresh POST /api/payments/initiate every
  // cycle. Stored in React state (ephemeral) — NEVER persisted to
  // localStorage / sessionStorage / cookies / IndexedDB (PCI SAQ-A).
  // See `CachedInitiate` in pay-sheet-internal.tsx for the shape.
  const [cachedInitiate, setCachedInitiate] = useState<
    import('./pay-sheet-internal').CachedInitiate | null
  >(null);

  // Track whether the payment reached a terminal state (success or
  // failure). When the drawer is dismissed WHILE a PaymentIntent is
  // still pending (kind: 'card-form' | 'initiating' | 'requires-action'),
  // we fire POST /api/payments/{id}/cancel so the stale intent does
  // NOT linger for Stripe's ~1-hour auto-expiry (FR-025c / W2).
  // Transitions to terminal are signalled by PaySheetInternal via
  // `onPaymentSettled`.
  const [paymentSettled, setPaymentSettled] = useState<boolean>(false);

  // Preserve the latest cache + settled flag in refs so the
  // cancel-on-unmount cleanup (below) can read the final values
  // without re-creating the effect on every state change.
  const cachedInitiateRef = useRef<
    import('./pay-sheet-internal').CachedInitiate | null
  >(null);
  const paymentSettledRef = useRef<boolean>(false);
  useEffect(() => {
    cachedInitiateRef.current = cachedInitiate;
  }, [cachedInitiate]);
  useEffect(() => {
    paymentSettledRef.current = paymentSettled;
  }, [paymentSettled]);

  // Explicit-cancel helper. Shared by:
  //   (a) unmount backstop — fires on page navigate-away
  //   (b) user-initiated cancel — ProcessingPanel / 3DS "Cancel payment"
  //       buttons + HardCapPrompt 60-second auto-cancel
  // Called with a `reason` that ends up in the audit trail so ops can
  // distinguish abandon patterns (navigated away vs deliberately
  // clicked cancel vs idle-timeout).
  const firePaymentCancel = (
    reason: 'user_navigated_away' | 'user_clicked_cancel' | 'hard_cap_timeout',
  ) => {
    const cache = cachedInitiateRef.current;
    const settled = paymentSettledRef.current;
    if (cache === null || settled) return;
    void fetch(`/api/payments/${cache.paymentDbId}/cancel`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
      keepalive: true,
    }).catch(() => {
      // Stripe's 1-hour PI auto-expiry is the backstop.
    });
    cachedInitiateRef.current = null;
    setCachedInitiate(null);
  };

  // FR-025c — cancel stale PaymentIntent on PAGE navigation away
  // (true unmount), NOT on every drawer open/close cycle.
  //
  // Previous behaviour (audit 2026-04-25 "4-5 open-close ชน limit"):
  // every close fired /cancel + cleared cache → every reopen fetched
  // a fresh /initiate. With Upstash rate-limits at 10 initiates /
  // 5 min and dev-mode React StrictMode double-invoking each fetch,
  // the user hit the rate-limit ceiling after ~5 open-close cycles.
  //
  // New behaviour: cache persists across open/close cycles so a
  // reopen reuses the existing PaymentIntent + clientSecret. A
  // PaymentIntent is only cancelled when (a) the containing PaySheet
  // unmounts (member navigates away from the invoice detail page), or
  // (b) the member explicitly clicks "Cancel payment" inside the
  // drawer. Stripe's own 1-hour PaymentIntent auto-expiry catches any
  // remaining edge case (browser tab abruptly closed, etc).
  useEffect(() => {
    return () => {
      firePaymentCancel('user_navigated_away');
    };
     
  }, []);

  const handleOpenChange = (next: boolean) => {
    if (isControlled) {
      onOpenChange?.(next);
    } else {
      setUncontrolledOpen(next);
    }
    if (!next) {
      onClose?.();
    }
  };

  // Wired to PaySheetInternal's explicit-cancel paths (ProcessingPanel
  // "Cancel payment", 3DS "Cancel payment", HardCapPrompt auto-cancel).
  // Unlike a plain drawer close, these invocations cancel the PI
  // server-side AND clear the cache so a subsequent reopen initiates
  // a fresh PaymentIntent.
  const handleExplicitCancel = (
    origin: 'user_clicked_cancel' | 'hard_cap_timeout',
  ) => {
    firePaymentCancel(origin);
    if (isControlled) onOpenChange?.(false);
    else setUncontrolledOpen(false);
    onClose?.();
  };

  return (
    <>
      {children?.(() => handleOpenChange(true))}
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
            // FR-028h (revised 2026-04-24): drawer pinned top-to-bottom
            // (100vh) on both mobile and desktop — Stripe Dashboard /
            // Linear side-panel pattern. Rationale: the payment flow has
            // multiple states (card form → 3DS → confirmation) with
            // different natural heights; auto-height would cause the
            // drawer to jump as state transitions. Full-viewport height
            // gives a stable container and lets the sticky header +
            // scrollable body work as designed.
            //   < 640 px  → 100% × 100vh (full-screen)
            //   ≥ 640 px  → width from --modal-max-width-md (≤ 480 px) × 100vh
            // `100vh` (viewport-relative) avoids Radix Portal containing-
            // block resolving to body.scrollHeight under mobile emulation
            // (T082 empirical E2E discovery #4, 2026-04-24).
            width: '100%',
            height: '100vh',
          }}
          // Smooth slide-in (T082 UX feedback 2026-04-24): the default
          // Sheet primitive slides in only 2.5rem (40 px) which reads as
          // an abrupt "pop". Override to slide the full drawer width from
          // off-screen right — matches Stripe Dashboard / Linear pattern.
          // `ease-out` + 300 ms duration feels more deliberate than the
          // default linear 200 ms. Tailwind v4 `!` is a suffix, not prefix.
          //
          // FR-028g reduced-motion fallback: `motion-reduce:duration-0`
          // collapses the slide to instant + opacity-only (the primitive's
          // own `data-ending-style:opacity-0` / `data-starting-style:opacity-0`
          // continues to run even at duration-0 so the sheet fades
          // without sliding).
          className="duration-300! ease-out data-[side=right]:data-starting-style:translate-x-full! data-[side=right]:data-ending-style:translate-x-full! motion-reduce:duration-0!"
          data-testid="pay-sheet-content"
        >
          <SheetHeader className="sticky top-0 z-10 flex flex-row items-start justify-between bg-popover border-b">
            <div className="min-w-0">
              <SheetTitle className="text-h4">{t('title')}</SheetTitle>
              <p className="text-caption text-muted-foreground truncate">
                {t('subtitle', { invoiceNumber: invoice.invoiceNumber })}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('close')}
              onClick={() => handleOpenChange(false)}
              // WCAG 2.5.5 — ≥ 44×44 px tap target on mobile.
              className="min-h-[44px] min-w-[44px] shrink-0"
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
            // shadcn `<SheetContent>` applies `gap-4` (16 px) between
            // flex children, so the header↔body gap is already 16 px
            // before we add ANY body padding. Keep `px-4 pb-4` for side
            // + bottom, but DROP padding-top to avoid the 32 px "tab
            // floating" double-gap (user UX feedback 2026-04-24). SC
            // 2.4.11 Focus-Not-Obscured is satisfied via
            // `scroll-padding-top` below for soft-keyboard scroll.
            className="overflow-y-auto px-4 pb-4"
            style={{ scrollPaddingTop: 'var(--pay-sheet-header-height, 64px)' }}
          >
            {hasOpened && timeoutExceeded ? (
              // FR-028c (B3): 30-min hard-cap prompt replaces the
              // pay-sheet body so the user MUST decide — continue
              // (re-arm timer) OR auto-cancel in 60s. The prompt is
              // rendered instead of, not over, PaySheetInternal so
              // focus + tab order cannot leak back into the card form
              // under it.
              <HardCapPrompt
                onContinue={() => resetHardCap()}
                onCancel={() => handleExplicitCancel('hard_cap_timeout')}
              />
            ) : hasOpened ? (
              <PaySheetInternal
                invoice={invoice}
                enabledMethods={enabledMethods}
                tenantPublishableKey={tenantPublishableKey}
                initialInitiate={cachedInitiate}
                onInitiateResolved={(result) => {
                  setCachedInitiate(result);
                  // New PaymentIntent created — this one is not yet
                  // settled. Reset the settlement flag so the
                  // close-with-stale-cleanup path (FR-025c) runs for
                  // the NEW PI if the user dismisses before paying.
                  setPaymentSettled(false);
                }}
                // Clear the cached initiate response once the
                // PaymentIntent reaches a terminal state (success or
                // failure) so a subsequent open of the drawer creates
                // a fresh PaymentIntent instead of re-using the
                // terminal clientSecret — Stripe rejects the latter
                // with a 400 on `elements/sessions` (T082 empirical
                // submit test 2026-04-24).
                onPaymentSettled={() => {
                  // Success OR failure — payment has reached a
                  // terminal state. Skip the stale-cleanup cancel
                  // path on subsequent close (FR-025c W2) AND
                  // invalidate the cached initiate so next open
                  // creates a fresh PaymentIntent.
                  setPaymentSettled(true);
                  setCachedInitiate(null);
                }}
                onRequestClose={() => handleOpenChange(false)}
                onExplicitCancel={() =>
                  handleExplicitCancel('user_clicked_cancel')
                }
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export default PaySheet;
