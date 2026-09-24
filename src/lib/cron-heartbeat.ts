/**
 * Dead-man's-switch ping for a cron (healthchecks.io-style URL).
 *
 * A cron that stops running cannot report its own absence — every in-app
 * metric simply stays flat. So the cron pings an EXTERNAL check after each
 * pass; the external service alerts when the pings stop arriving.
 *
 * Protocol (healthchecks.io, also accepted by most compatible services):
 *   - success → GET `<url>`
 *   - failure → GET `<url>/fail` (alerts immediately, not after the grace)
 *
 * Never throws and never delays the cron by more than `PING_TIMEOUT_MS`: a
 * monitoring hiccup must not fail the work it monitors. No-op when `url` is
 * unset (local / preview / not yet configured).
 */
import { logger } from '@/lib/logger';

export const PING_TIMEOUT_MS = 5_000;

export async function pingCronHeartbeat(
  url: string | undefined,
  outcome: 'success' | 'fail',
  context: { readonly cron: string },
): Promise<void> {
  if (!url) return;
  const target = outcome === 'fail' ? `${url.replace(/\/+$/, '')}/fail` : url;
  try {
    const res = await fetch(target, {
      method: 'GET',
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) {
      logger.warn({ cron: context.cron, outcome, status: res.status }, 'cron.heartbeat.ping_rejected');
    }
  } catch (e) {
    logger.warn(
      { cron: context.cron, outcome, errName: e instanceof Error ? e.name : 'UnknownError' },
      'cron.heartbeat.ping_failed',
    );
  }
}
