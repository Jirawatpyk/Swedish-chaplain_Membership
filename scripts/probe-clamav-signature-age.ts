/**
 * ClamAV signature-age probe — emits the
 * `broadcasts.clamav_signature_age_hours{}` observable gauge metric.
 *
 * Created 2026-05-21 closing review finding code-reviewer-full M-3 /
 * comment-analyzer M-3: `docs/runbooks/clamav-signature-stale.md` +
 * `src/lib/metrics/broadcasts-f71a.ts` both referenced this script as
 * the gauge source but it did not exist. The runbook claim was
 * unactionable + the gauge alert (>48h critical) would never fire.
 *
 * Designed for cron-job.org hourly cadence — exits 0 on success
 * (gauge observed), exits 1 on connectivity failure, exits 2 on
 * "scanner not configured" (distinguishes pre-deploy from
 * post-deploy-broken per the `verify-clamav-connectivity.ts` exit-
 * code convention).
 *
 * Run: `pnpm tsx scripts/probe-clamav-signature-age.ts`
 *
 * Required env (`.env.local` or Vercel production env):
 *   CLAMAV_HOST     # "<app>.internal" on Fly.io OR "localhost" in dev
 *   CLAMAV_PORT=3310
 *   CLAMAV_TIMEOUT_MS=30000
 *
 * Side effects:
 *   - Emits `broadcasts.clamav_signature_age_hours` via the
 *     OpenTelemetry meter (no labels — shared cross-tenant infra).
 *   - Prints the computed age to stdout for cron-job.org log capture.
 *
 * Mechanism: opens a TCP connection to clamd's command port, sends
 * `VERSION\0`, parses the response `ClamAV 1.x.y/<sig_version>/<build_time>`.
 * The build_time is an RFC-2822-ish timestamp from the signature DB
 * release. Age = now() - build_time. Bounded by the longest reasonable
 * staleness (90 days) so a clock-skew or signature-rollback doesn't
 * report negative or hours-since-epoch.
 */
import { connect } from 'node:net';

import { broadcastsF71aMetrics } from '../src/lib/metrics/broadcasts-f71a';
import { env } from '../src/lib/env';

const TIMEOUT_MS = Number(process.env.CLAMAV_TIMEOUT_MS ?? 30_000);
const MAX_REASONABLE_AGE_HOURS = 24 * 90; // 90 days; clamp upper bound

/**
 * Parse the clamd VERSION response into a signature build-time Date.
 * Format examples observed in `clamav/clamav:stable` (Aug 2024+):
 *   "ClamAV 1.3.2/27495/Mon Sep  2 09:42:08 2024"
 *   "ClamAV 1.0.5/27381/Tue Jul 30 04:50:11 2024"
 * The third segment (split on '/') is an RFC-2822-ish timestamp;
 * `Date.parse` handles it natively. Returns null if parsing fails.
 */
function parseSignatureBuildTime(versionResponse: string): Date | null {
  // Strip leading/trailing whitespace + the `\0` socket sentinel
  const cleaned = versionResponse.replace(/\0/g, '').trim();
  const segments = cleaned.split('/');
  if (segments.length < 3) return null;
  const buildTimeRaw = segments.slice(2).join('/').trim();
  const timestamp = Date.parse(buildTimeRaw);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp);
}

/**
 * Open a clamd connection + send VERSION command. Returns the raw
 * response. Times out after `TIMEOUT_MS` to avoid hanging the cron
 * tick on a partially-up daemon.
 */
async function clamdVersion(host: string, port: number): Promise<string> {
  return new Promise((res, rej) => {
    const socket = connect(port, host);
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      rej(new Error(`clamd VERSION timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    socket.on('connect', () => {
      // LOW1 Round 2 fix 2026-05-21 (silent-failure-hunter LOW): guard
      // the sync write — if `write` throws (broken-pipe pre-flush, very
      // rare but possible on a half-open socket), reject the promise +
      // clear the timer instead of letting the throw escape to Node's
      // `unhandledRejection` (where the timer fires 30s later anyway).
      try {
        socket.write('VERSION\0');
      } catch (e) {
        clearTimeout(timeout);
        socket.destroy();
        rej(e);
      }
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    socket.on('end', () => {
      clearTimeout(timeout);
      res(response);
    });
    socket.on('error', (e) => {
      clearTimeout(timeout);
      rej(e);
    });
  });
}

async function main(): Promise<void> {
  const host = env.clamav.host;
  const port = env.clamav.port;

  if (!host || host === '') {
    console.error(
      '[probe-clamav-signature-age] CLAMAV_HOST not configured — skipping. ' +
        'Run after `infra/clamav/` deploys per qa/ship-day-checklist.md § A.1.',
    );
    process.exit(2);
  }

  let response: string;
  try {
    response = await clamdVersion(host, port);
  } catch (e) {
    console.error(
      `[probe-clamav-signature-age] FAIL — clamd unreachable at ${host}:${port}: ${(e as Error).message}`,
    );
    process.exit(1);
  }

  const buildTime = parseSignatureBuildTime(response);
  if (!buildTime) {
    console.error(
      `[probe-clamav-signature-age] FAIL — unrecognised VERSION response: "${response.replace(/\n/g, '\\n').slice(0, 200)}"`,
    );
    process.exit(1);
  }

  const ageMs = Date.now() - buildTime.getTime();
  let ageHours = Math.max(0, Math.round(ageMs / (60 * 60 * 1000)));
  if (ageHours > MAX_REASONABLE_AGE_HOURS) {
    console.warn(
      `[probe-clamav-signature-age] clamping ageHours=${ageHours} → ${MAX_REASONABLE_AGE_HOURS} (clock skew or signature rollback suspected)`,
    );
    ageHours = MAX_REASONABLE_AGE_HOURS;
  }

  broadcastsF71aMetrics.clamavSignatureAgeHours(ageHours);

  console.log(
    `[probe-clamav-signature-age] OK — buildTime=${buildTime.toISOString()} ` +
      `ageHours=${ageHours} (alert threshold: >48h critical per docs/observability.md § 22.10)`,
  );
}

main().catch((e) => {
  console.error(
    `[probe-clamav-signature-age] crashed: ${(e as Error).message}`,
  );
  process.exit(1);
});
