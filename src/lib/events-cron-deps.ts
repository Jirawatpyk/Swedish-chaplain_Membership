/**
 * H6.2 — F6-specific cron coordinator gate factory.
 *
 * Wires the F6 metric counters (`cronAuditEmitFailed` +
 * `cronRedisFallback`) uniformly so all 4 F6 cron routes have
 * identical auth + observability behaviour. Replaces 4-line
 * boilerplate at the top of each cron route with a single call.
 */
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { eventcreateMetrics } from '@/lib/metrics';
import type { NextRequest, NextResponse } from 'next/server';

export async function gateF6Cron(
  request: NextRequest,
  route: string,
): Promise<NextResponse | null> {
  return gateCronBearerOrRespond(request, {
    route,
    metricsCounter: () => eventcreateMetrics.cronAuditEmitFailed(route),
    rateLimitFallbackCounter: () => eventcreateMetrics.cronRedisFallback(route),
  });
}
