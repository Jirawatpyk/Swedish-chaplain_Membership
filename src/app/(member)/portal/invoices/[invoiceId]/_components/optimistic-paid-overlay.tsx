'use client';

/**
 * R5 round-7 (2026-04-26) — Optimistic UI overlay for invoice status.
 *
 * Bridges the client-side `payState='success'` knowledge (from
 * <PaySheet>'s confirm-payment flow) to the server-rendered page
 * badge + Pay-now button — without lifting state into the page
 * component (which is a Server Component) AND without polling the
 * server (which dropped the auth session under multi-fire RSC
 * re-fetches).
 *
 * Pattern: a window-scoped CustomEvent + BroadcastChannel
 * (`swecham:invoice-paid` with `{ invoiceId }` detail). PaySheet
 * dispatches the event the moment Stripe SDK confirms the payment
 * client-side. This overlay listens for matching events on its own
 * invoice id and flips a local state flag, swapping a pre-rendered
 * "Paid" view in for the "Unpaid" view.
 *
 * Why JSX-prop pattern (not render-prop / children-fn):
 *   - The page is a React Server Component. Function children
 *     CANNOT cross the server→client boundary (Next.js error:
 *     "Functions are not valid as a child of Client Components").
 *   - JSX is serialisable; the server pre-renders BOTH variants
 *     and ships them as children of this client component, which
 *     picks one based on the local `optimisticallyPaid` flag.
 *
 * R7 follow-up fixes (chamber-os-ux-architect + software-engineer review):
 *   - 🔴 #1: aria-live="polite" announces the badge swap to SR users
 *     (WCAG 2.1 SC 4.1.3 Status Messages).
 *   - 🔴 #2: focus management — when `whenPaid={null}` removes the
 *     Pay-now button, focus is moved to `focusOnPaid` ref target so
 *     the keyboard user is not orphaned at <body> (WCAG 2.4.3 Focus
 *     Order).
 *   - 🟡 M1: BroadcastChannel('swecham-invoice-paid') sync — if the
 *     same invoice is open in two tabs, paying in tab A flips tab B
 *     too. Falls back gracefully on browsers without BC support.
 *   - 🟡 #5: 15-second auto-revert. If the server data has not flipped
 *     to `paid` within 15s of the optimistic flip (webhook dropped,
 *     dispute, refund), revert to `whenUnpaid` so the UI stops
 *     "lying". The router.refresh() in PaySheet's settled effect
 *     re-mounts the overlay with fresh server data well before this
 *     timer fires in the happy path.
 *
 * The flip is purely cosmetic — server data eventually catches up
 * via the settled-effect's `router.refresh()` and the Stripe
 * webhook → markPaid → revalidatePath chain.
 *
 * Why this is OK to "lie" briefly:
 *   - Stripe contract: a `succeeded` clientSecret resolution from
 *     `stripe.confirmPayment()` IS a guaranteed succeeded
 *     PaymentIntent. Webhook delivery is a separate side-effect
 *     channel; client knowledge is authoritative for UX purposes.
 *   - On the rare path where the webhook later flags the PI as
 *     non-succeeded (refund / dispute), the server data wins on
 *     the NEXT page navigation or refresh — AND the auto-revert
 *     timer kicks in within 15s as a safety net.
 *
 * Phase 9 polish:
 *   - Move F4 receipt-PDF generation off webhook hot-path
 *     (currently 5.2s) so server data is consistently fresh
 *     within ~1s. Once webhook latency p95 < 1s, this overlay
 *     becomes redundant + can be deleted.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const PAID_EVENT = 'swecham:invoice-paid';
const BROADCAST_CHANNEL_NAME = 'swecham-invoice-paid';
const AUTO_REVERT_MS = 15_000;

/**
 * Per-tab sender id used to suppress BroadcastChannel self-echo.
 * `dispatchInvoicePaid()` stamps every post with this id; overlay
 * listeners ignore messages bearing the same id (their own tab
 * already handled the in-tab CustomEvent + PaySheet's refresh).
 *
 * Lazy crypto.randomUUID() so SSR doesn't crash; only used in
 * client-side branches.
 */
let tabSenderId: string | null = null;
function getTabSenderId(): string {
  if (tabSenderId === null) {
    tabSenderId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `tab-${Math.random().toString(36).slice(2)}`;
  }
  return tabSenderId;
}

export interface OptimisticPaidOverlayProps {
  readonly invoiceId: string;
  /** Pre-rendered view for the un-paid (default) state. */
  readonly whenUnpaid: React.ReactNode;
  /** Pre-rendered view shown after `swecham:invoice-paid` fires. */
  readonly whenPaid: React.ReactNode;
  /**
   * Optional CSS selector for the element that should receive
   * keyboard focus when the optimistic flip happens. Use this when
   * `whenUnpaid` contains the currently-focused element (e.g. a
   * Pay-now button) and `whenPaid` removes or replaces it — without
   * this, focus falls back to `<body>` (WCAG 2.4.3 violation).
   *
   * Selector (not RefObject) so this prop works from a React Server
   * Component caller without needing a client wrapper.
   *
   * **Recommended pattern**: use a `data-*` attribute on the target
   * element (e.g. `data-pay-focus-target="download-pdf"`) and pass
   * the matching attribute selector here (e.g.
   * `[data-pay-focus-target="download-pdf"]`). `data-*` selectors
   * are namespaced + collision-resistant; raw global `id` selectors
   * are also accepted but invite cross-component clashes.
   *
   * If the resolved element is missing at flip time (e.g. a
   * conditional render keeps it out of the DOM), focus falls back
   * to the page's `<main>` landmark and finally to `<body>` so the
   * keyboard user is never left in a focus-orphan limbo.
   */
  readonly focusSelectorOnPaid?: string;
}

export function OptimisticPaidOverlay({
  invoiceId,
  whenUnpaid,
  whenPaid,
  focusSelectorOnPaid,
}: OptimisticPaidOverlayProps) {
  const [optimisticallyPaid, setOptimisticallyPaid] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const router = useRouter();

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ invoiceId?: string }>).detail;
      if (detail?.invoiceId === invoiceId) {
        setOptimisticallyPaid(true);
      }
    };
    window.addEventListener(PAID_EVENT, handler);

    // M1 — cross-tab sync via BroadcastChannel. The same invoice
    // open in another tab will flip in lockstep with the paying
    // tab. Stripe rejects double-confirmPayment against the same
    // PI, so the cross-tab Pay-now button MUST hide to prevent a
    // confusing failed second attempt.
    //
    // The receiver-tab also calls `router.refresh()` so its server-
    // rendered RSC catches up independently. Without this, the 15s
    // auto-revert (below) would flip the receiver back to "Issued"
    // because the receiver's RSC tree never re-fetched. A single
    // refresh here is safe — the multi-fire polling that dropped
    // sessions earlier was 4-12 calls in rapid succession, not one.
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      const myTabId = getTabSenderId();
      channel.addEventListener('message', (e: MessageEvent) => {
        const data = e.data as
          | { invoiceId?: string; senderId?: string }
          | null;
        if (data?.invoiceId !== invoiceId) return;
        // Suppress self-echo: dispatching tab already handled the
        // in-tab CustomEvent + PaySheet's `router.refresh()`. A
        // second refresh from this listener would reproduce the
        // multi-fire session-drop pattern.
        if (data.senderId === myTabId) return;
        setOptimisticallyPaid(true);
        router.refresh();
      });
    }

    return () => {
      window.removeEventListener(PAID_EVENT, handler);
      channel?.close();
    };
  }, [invoiceId, router]);

  // 🔴 #2 — focus management. When the optimistic flip swaps
  // `whenUnpaid` (containing focused Pay-now button) for
  // `whenPaid` (often null), move keyboard focus to the safe
  // target supplied by the caller. Guarded so we only steal focus
  // if it was inside our own container — we never yank focus from
  // an unrelated element.
  useEffect(() => {
    if (!optimisticallyPaid) return;
    const active = document.activeElement;
    const wasInsideOverlay =
      active instanceof Element &&
      containerRef.current?.contains(active);
    // Only steal focus if it was inside our own subtree (we are
    // about to unmount the focused element) or already orphaned at
    // <body>. We never yank focus from an unrelated element.
    if (!wasInsideOverlay && active !== document.body) return;

    // Focus fallback chain (graceful degradation for WCAG 2.4.3):
    //   1. Caller-supplied `focusSelectorOnPaid` element if present + in DOM
    //   2. Page's <main> landmark — always present in Chamber-OS
    //      DetailContainer/PageHeader layout
    //   3. <body> as last resort — better than null but a screen
    //      reader will read from page top, so we prefer (1) or (2).
    let primary: Element | null = null;
    if (focusSelectorOnPaid) {
      try {
        primary = document.querySelector(focusSelectorOnPaid);
      } catch (err) {
        // Defensive: an invalid selector throws SyntaxError.
        // Treat as "not found" + fall through to <main> fallback.
        // Surface in dev so the caller fixes the selector before
        // shipping; production silently degrades to the fallback
        // chain so users never see a focus-orphan.
        if (process.env.NODE_ENV !== 'production') {
          console.warn(
            `[OptimisticPaidOverlay] invalid focusSelectorOnPaid: ${focusSelectorOnPaid}`,
            err,
          );
        }
        primary = null;
      }
    }
    const target = primary ?? document.querySelector('main') ?? document.body;
    // <main> + <body> aren't focusable by default; ensure tabindex
    // before .focus() so the focus actually lands.
    if (target instanceof HTMLElement && !target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
    }
    (target as HTMLElement).focus();
  }, [optimisticallyPaid, focusSelectorOnPaid]);

  // 🟡 #5 — auto-revert safety net. If the server data has not
  // re-mounted us with `whenPaid` baked in within AUTO_REVERT_MS,
  // assume the webhook was dropped / disputed and revert. In the
  // happy path, the page-level `router.refresh()` re-renders this
  // overlay with `whenPaid` ALREADY containing the paid badge —
  // the optimistic flag becomes irrelevant before this timer fires.
  useEffect(() => {
    if (!optimisticallyPaid) return;
    const timer = setTimeout(() => {
      setOptimisticallyPaid(false);
    }, AUTO_REVERT_MS);
    return () => clearTimeout(timer);
  }, [optimisticallyPaid]);

  // 🔴 #1 — aria-live="polite" announces the swap to AT users.
  // `aria-atomic="true"` ensures the entire badge label is read,
  // not just the diffed text node.
  return (
    <span
      ref={containerRef}
      aria-live="polite"
      aria-atomic="true"
    >
      {optimisticallyPaid ? whenPaid : whenUnpaid}
    </span>
  );
}

/**
 * Imperative dispatcher — call from any client surface (PaySheet,
 * 3DS poll success handler, etc.) to flip the optimistic flag for
 * a given invoice. Fires both the in-tab CustomEvent AND a
 * cross-tab BroadcastChannel post so siblings stay in sync.
 *
 * BroadcastChannel echo note: the HTML spec only suppresses delivery
 * back to the SAME channel instance that posted. We open a fresh
 * `new BroadcastChannel(...)` here for the post, so the overlay's
 * listener channel (a DIFFERENT instance in the same tab) WOULD
 * receive its own broadcast. To prevent the dispatching tab from
 * double-firing `router.refresh()` (which earlier dropped the auth
 * session under multi-fire), we stamp every post with a per-tab
 * `senderId` and the listener ignores matches with its own id.
 */
export function dispatchInvoicePaid(invoiceId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(PAID_EVENT, { detail: { invoiceId } }),
  );
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    try {
      channel.postMessage({ invoiceId, senderId: getTabSenderId() });
    } finally {
      channel.close();
    }
  }
}
