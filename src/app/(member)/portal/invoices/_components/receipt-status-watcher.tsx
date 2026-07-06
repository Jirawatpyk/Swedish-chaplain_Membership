'use client';

/**
 * 088 T066a (FR-019) — member-facing async receipt-PDF state.
 *
 * Mounted on the portal invoice LIST rows + DETAIL page ONLY while a paid
 * invoice's `receiptPdfStatus === 'pending'` (the §86/4 RC tax-receipt PDF is
 * rendering asynchronously at payment). It does two things:
 *
 *   1. ANNOUNCES the in-progress state to assistive tech via an `aria-live`
 *      polite `role="status"` region ("your tax receipt is being generated") —
 *      SR parity, not a colour/visual-only spinner. The `block` variant also
 *      carries reassurance copy (why it takes a moment; the receipt is safe).
 *
 *   2. AUTO-REFRESHES: polls the lightweight status endpoint on a bounded
 *      backoff schedule and calls `router.refresh()` the moment the async
 *      worker flips the row to `'rendered'` (reveals the receipt download) OR
 *      `'failed'` (reveals the graceful support-path state) — WITHOUT a manual
 *      refresh. Polling STOPS on any terminal status and after
 *      {@link RECEIPT_POLL_MAX_ATTEMPTS} attempts (give-up cap: the reconcile
 *      cron is the last-resort recovery, and a later page load will resolve).
 *
 * Reduced-motion: the only motion is the spinner icon, gated by `motion-safe:`
 * (SC 2.3.3). The endpoint returns ONLY the status enum — no PII — and is
 * auth-guarded to the owning member (see the route).
 */
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** First poll delay (ms) — inside the 5–10s window the spec calls for. */
const POLL_BASE_MS = 5_000;
/** Ceiling for the widening backoff interval (ms). */
const POLL_MAX_MS = 10_000;
/**
 * Give-up cap. ~18 polls over the widening schedule ≈ 2.5–3 minutes, after
 * which the reconcile cron (last-resort re-enqueue) + a later page load take
 * over. Exported so the unit test pins the exact bound.
 */
export const RECEIPT_POLL_MAX_ATTEMPTS = 18;

type Variant = 'inline' | 'block';

export function ReceiptStatusWatcher({
  invoiceId,
  variant = 'inline',
  className,
}: {
  readonly invoiceId: string;
  readonly variant?: Variant;
  readonly className?: string;
}): React.ReactElement {
  const t = useTranslations('portal.invoices');
  const router = useRouter();
  const attemptsRef = useRef(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    attemptsRef.current = 0;

    const stop = () => {
      active = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const scheduleNext = () => {
      if (!active) return;
      if (attemptsRef.current >= RECEIPT_POLL_MAX_ATTEMPTS) {
        stop();
        return;
      }
      // Widening backoff, capped at POLL_MAX_MS.
      const delay = Math.min(
        POLL_BASE_MS + attemptsRef.current * 1_000,
        POLL_MAX_MS,
      );
      timer = setTimeout(poll, delay);
    };

    const poll = async () => {
      if (!active) return;
      attemptsRef.current += 1;
      let status: string | null = null;
      try {
        const res = await fetch(
          `/api/portal/invoices/${invoiceId}/receipt/status`,
          { headers: { accept: 'application/json' }, cache: 'no-store' },
        );
        if (!active) return;
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as {
            status?: string | null;
          } | null;
          status = body?.status ?? null;
        }
        // A non-2xx (e.g. transient 500) is treated as "still pending" — keep
        // polling within the cap rather than surfacing a scary error.
      } catch {
        // Network hiccup — swallow, keep polling within the cap.
      }
      if (!active) return;
      if (status === 'rendered' || status === 'failed') {
        stop();
        // Re-fetch the RSC so the server reveals the receipt download
        // ('rendered') or the graceful support-path state ('failed').
        router.refresh();
        return;
      }
      scheduleNext();
    };

    scheduleNext();
    return stop;
  }, [invoiceId, router]);

  const spinner = (
    <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
  );

  if (variant === 'block') {
    return (
      <section
        role="status"
        aria-live="polite"
        aria-busy="true"
        data-testid="receipt-status-watcher"
        className={cn(
          'rounded-md border border-border border-l-4 border-l-primary bg-card p-3',
          className,
        )}
      >
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          {spinner}
          {t('receiptStatus.generating')}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('receiptStatus.reassurance')}
        </p>
      </section>
    );
  }

  // Inline (list rows) — compact aria-live affordance styled like the download
  // button it sits beside. The reassurance copy is SR-available so a screen
  // reader hears the full message even on the compact surface.
  return (
    <span
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="receipt-status-watcher"
      className={cn(
        buttonVariants({ variant: 'outline', size: 'sm' }),
        // 088 B3 (revised) — the VISIBLE label is now the SHORT "Generating…"
        // chip, so it stays one compact line in BOTH the desktop invoice-table
        // actions cell (the full sentence + whitespace-normal previously wrapped
        // to a tall multi-line chip — "ขึ้นยาว", unlike the admin table's compact
        // "Generating…") AND the 320px portal card (short label doesn't clip, so
        // the whitespace-normal wrap workaround is no longer needed). The full
        // sentence + reassurance ride in the sr-only span → SR parity unchanged.
        'min-h-11 gap-1 px-3 cursor-progress',
        className,
      )}
    >
      {spinner}
      {/* Visible chip = SHORT label; aria-hidden so the SR hears the full
          sentence (sr-only below) once, not "Generating…" + the full sentence. */}
      <span aria-hidden="true">{t('receiptStatus.generatingShort')}</span>
      <span className="sr-only">{t('receiptStatus.generating')}</span>
      <span className="sr-only">{t('receiptStatus.reassurance')}</span>
    </span>
  );
}
