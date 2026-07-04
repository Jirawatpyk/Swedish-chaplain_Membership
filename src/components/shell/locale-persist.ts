import { updatePreferredLocale } from '@/components/portal/preferred-locale-client';
import type { Locale } from '@/i18n/config';

export type PersistOutcome = 'ok' | 'client_error' | 'aborted' | 'failed';

/**
 * The LocaleSwitcher's best-effort persist policy for a member's preferred
 * locale: up to 2 attempts, retrying ONLY on network error / 5xx (a 4xx is
 * deterministic → stop). Stops immediately if `signal` is aborted: a
 * supersession (a newer pick) is benign → `'aborted'` (silent), but a timeout
 * (aborted with a `TimeoutError` reason) is a genuine sync failure → `'failed'`
 * (the caller warns). Never throws. The caller warns only on `'failed'`.
 */
export async function runPreferredLocalePersist(
  locale: Locale,
  signal: AbortSignal,
): Promise<PersistOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await updatePreferredLocale(locale, signal);
      if (res.ok) return 'ok';
      if (res.status < 500) return 'client_error'; // 4xx → deterministic, stop
      // 5xx → fall through to the one retry
    } catch {
      if (signal.aborted) {
        // Supersession (a newer pick called abort()) → benign, silent.
        // Timeout (abort() called with a TimeoutError reason) → a real failure
        // to sync, so surface it as 'failed' for the caller's warn.
        return (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
          ? 'failed'
          : 'aborted';
      }
      // network error → fall through to the one retry
    }
  }
  return 'failed';
}

/**
 * The LocaleSwitcher's detached persist wiring: abort any prior in-flight sync
 * held in `ref` (so a stale retry can't land out of order), bound this attempt
 * with a `TimeoutError`-tagged abort after `timeoutMs`, run the policy, and call
 * `onFailed` only on a `'failed'` outcome. Never awaited; the timer is always
 * cleared on completion. INVARIANT: `onFailed` must not `setState`/`toast` (it
 * fires after `router.refresh()` — an orphaned update). `run` is injectable for
 * tests.
 */
export function runAbortablePersist(
  ref: { current: AbortController | null },
  locale: Locale,
  timeoutMs: number,
  onFailed: () => void,
  run: (locale: Locale, signal: AbortSignal) => Promise<PersistOutcome> = runPreferredLocalePersist,
): void {
  ref.current?.abort();
  const controller = new AbortController();
  ref.current = controller;
  const timer = setTimeout(
    () => controller.abort(new DOMException('preferred_locale sync timed out', 'TimeoutError')),
    timeoutMs,
  );
  void run(locale, controller.signal)
    .then((outcome) => {
      if (outcome === 'failed') onFailed();
    })
    .finally(() => clearTimeout(timer));
}
