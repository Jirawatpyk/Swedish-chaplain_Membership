'use client';

/**
 * Optimistic-paid signal for invoice surfaces — store + hook + dispatcher.
 *
 * Bridges client-side payment-success knowledge (Stripe SDK
 * `confirmPayment` succeeded) to the server-rendered badge + Pay-now
 * button without polling the server. Two consumption sites today
 * (`<OptimisticPaidBadge>` + `<PayNowButton>`); both go through the
 * same `useOptimisticPaid` hook so there's one BroadcastChannel and
 * one sessionStorage entry per invoice per tab.
 *
 * Storage layers:
 *   - `sessionStorage` (60 s TTL, invoiceId-keyed) — survives a
 *     manual refresh in the brief window between Stripe SDK
 *     `confirmPayment` succeeded and the webhook → DB → RSC catching
 *     up. PCI-safe: only an invoice UUID + timestamp is persisted.
 *   - `BroadcastChannel('swecham:invoice-paid')` — cross-tab sync
 *     so paying in tab A flips tab B too. Self-echo suppressed via
 *     a per-tab UUID `senderId`.
 *   - `window` CustomEvent — in-tab same-name notification for any
 *     subscribers mounted at the same time.
 *
 * Why `useSyncExternalStore`: SSR-safe storage subscription. Server
 * renders with `false`, client reads sessionStorage post-hydration.
 *
 * Disaster path (webhook never arrives): server-truth wins on next
 * mount once the 60 s TTL expires.
 *
 * Phase 9 polish target: once webhook latency p95 < 1 s (after F4
 * receipt-PDF generation moves off the webhook hot path), the entire
 * optimistic layer becomes redundant and can be deleted in one PR.
 */

import { useCallback, useSyncExternalStore } from 'react';

import { uuid } from '@/lib/uuid';

const PAID_EVENT = 'swecham:invoice-paid';
const SESSION_STORAGE_KEY_PREFIX = 'swecham:optimistic-paid:';
const SESSION_STORAGE_TTL_MS = 60_000;

interface BroadcastPayload {
  readonly invoiceId: string;
  readonly senderId: string;
}

let tabSenderId: string | null = null;
function getTabSenderId(): string {
  if (tabSenderId === null) {
    tabSenderId = uuid();
  }
  return tabSenderId;
}

/**
 * Lazily-initialised module-level BroadcastChannel for the dispatcher.
 * Earlier shape opened + closed a fresh channel per `dispatchInvoicePaid`
 * call, which races spec-compliant message delivery on Firefox/Safari/jsdom
 * (closing immediately after `postMessage` is allowed to drop the queued
 * task per HTML spec). Keeping one long-lived channel for the lifetime
 * of the tab sidesteps the race entirely.
 */
let dispatcherChannel: BroadcastChannel | null = null;
function getDispatcherChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (dispatcherChannel === null) {
    dispatcherChannel = new BroadcastChannel(PAID_EVENT);
  }
  return dispatcherChannel;
}

function storageKey(invoiceId: string): string {
  return `${SESSION_STORAGE_KEY_PREFIX}${invoiceId}`;
}

function readPaidFlag(invoiceId: string): boolean {
  // Pure read — no side effects. React's `useSyncExternalStore` calls
  // `getSnapshot` opportunistically (including tearing checks that
  // never commit), so any storage mutation here would violate the
  // snapshot purity contract. Stale entries are pruned on the next
  // `dispatchInvoicePaid` for the same key + naturally expire when
  // the tab closes (sessionStorage scope).
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.sessionStorage.getItem(storageKey(invoiceId));
    if (raw === null) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts <= SESSION_STORAGE_TTL_MS;
  } catch {
    return false;
  }
}

function writePaidFlag(invoiceId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(storageKey(invoiceId), String(Date.now()));
  } catch {
    // Quota exceeded / private mode — best-effort.
  }
}

function getServerSnapshot(): boolean {
  return false;
}

interface SubscribeOptions {
  readonly onChange: () => void;
  /**
   * Side-effect fired only when a DIFFERENT tab broadcasts a paid
   * signal. Used by `<OptimisticPaidBadge>` to call `router.refresh()`
   * so this tab's RSC tree catches up independently of the paying
   * tab. Self-echo (`senderId === myTabId`) is suppressed at the
   * source, so this never fires for the dispatching tab — preserves
   * the single-fire `router.refresh()` invariant that earlier
   * multi-fire polling violated.
   */
  readonly onCrossTabPaid?: (() => void) | undefined;
}

function subscribePaidFlag(
  invoiceId: string,
  opts: SubscribeOptions,
): () => void {
  if (typeof window === 'undefined') return () => {};

  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ invoiceId?: string }>).detail;
    if (detail?.invoiceId === invoiceId) opts.onChange();
  };
  window.addEventListener(PAID_EVENT, handler);

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(PAID_EVENT);
    const myTabId = getTabSenderId();
    channel.addEventListener('message', (e: MessageEvent) => {
      const data = e.data as Partial<BroadcastPayload> | null;
      if (data?.invoiceId !== invoiceId) return;
      if (data.senderId === myTabId) return;
      writePaidFlag(invoiceId);
      opts.onChange();
      opts.onCrossTabPaid?.();
    });
  }

  return () => {
    window.removeEventListener(PAID_EVENT, handler);
    channel?.close();
  };
}

export interface UseOptimisticPaidOptions {
  /**
   * Optional callback fired when a different tab broadcasts a paid
   * signal — typically `router.refresh()` from the consumer. Wire
   * only on ONE consumer per page to preserve the single-fire RSC
   * re-fetch invariant.
   */
  readonly onCrossTabPaid?: (() => void) | undefined;
}

// R2-fix I4 (2026-04-26): dev-mode guard for the "wire ONE consumer
// per page" contract above. Module-level Set tracks which invoice ids
// have an active `onCrossTabPaid` subscriber; a duplicate registration
// triggers a console warning so the cross-tab refresh doesn't fire
// twice silently. Production (NODE_ENV='production') skips the
// instrumentation to avoid the Set-allocation cost.
const _crossTabPaidSubscribers =
  process.env.NODE_ENV !== 'production' ? new Set<string>() : null;

export function useOptimisticPaid(
  invoiceId: string,
  options: UseOptimisticPaidOptions = {},
): boolean {
  const { onCrossTabPaid } = options;
  const subscribe = useCallback(
    (onChange: () => void) => {
      // R3-fix Imp#3 (2026-04-26): atomic check + add inside the
      // subscribe callback itself. The previous shape split check
      // (render body) and add (subscribe callback), so two concurrent
      // renders both saw `has(id)===false` and silently registered
      // before either added — losing the duplicate warning. Moving
      // both steps into the callback (which React serialises) makes
      // the check atomic. Production (NODE_ENV='production') skips
      // the entire instrumentation via the null-Set guard above.
      if (_crossTabPaidSubscribers && onCrossTabPaid) {
        if (_crossTabPaidSubscribers.has(invoiceId)) {
          // eslint-disable-next-line no-console
          console.warn(
            `[useOptimisticPaid] duplicate onCrossTabPaid subscriber for invoice ${invoiceId}. ` +
              'router.refresh() will fire twice on cross-tab paid signals. ' +
              'Wire onCrossTabPaid on ONE consumer per page (typically PayNowButton).',
          );
        }
        _crossTabPaidSubscribers.add(invoiceId);
      }
      const unsubscribe = subscribePaidFlag(invoiceId, {
        onChange,
        onCrossTabPaid,
      });
      return () => {
        if (_crossTabPaidSubscribers && onCrossTabPaid) {
          _crossTabPaidSubscribers.delete(invoiceId);
        }
        unsubscribe();
      };
    },
    [invoiceId, onCrossTabPaid],
  );
  const getSnapshot = useCallback(() => readPaidFlag(invoiceId), [invoiceId]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Imperative entry point — call from any client surface (PaySheet
 * settled-effect, 3DS poll success handler) when the Stripe SDK
 * resolves a paid PaymentIntent. Persists + fans out to in-tab and
 * cross-tab subscribers.
 */
export function dispatchInvoicePaid(invoiceId: string): void {
  if (typeof window === 'undefined') return;
  // Persist FIRST so a subscriber that re-reads in response to the
  // CustomEvent below sees `true`.
  writePaidFlag(invoiceId);
  window.dispatchEvent(
    new CustomEvent(PAID_EVENT, { detail: { invoiceId } }),
  );
  const channel = getDispatcherChannel();
  if (channel !== null) {
    const payload: BroadcastPayload = {
      invoiceId,
      senderId: getTabSenderId(),
    };
    channel.postMessage(payload);
  }
}
