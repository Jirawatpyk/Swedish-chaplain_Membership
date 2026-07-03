import { updatePreferredLocale } from '@/components/portal/preferred-locale-client';
import type { Locale } from '@/i18n/config';

export type PersistOutcome = 'ok' | 'client_error' | 'aborted' | 'failed';

/**
 * The LocaleSwitcher's best-effort persist policy for a member's preferred
 * locale: up to 2 attempts, retrying ONLY on network error / 5xx (a 4xx is
 * deterministic → stop). Stops immediately if `signal` is aborted (superseded
 * by a newer selection, or timed out). Never throws. The caller warns only on
 * `'failed'`.
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
      if (signal.aborted) return 'aborted'; // superseded / timed out
      // network error → fall through to the one retry
    }
  }
  return 'failed';
}
