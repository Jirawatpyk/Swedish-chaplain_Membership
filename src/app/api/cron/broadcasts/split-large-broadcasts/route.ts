/**
 * Phase 3F.1 (F-17 fix, 2026-05-19) — POST `/api/cron/broadcasts/split-large-broadcasts`.
 *
 * Closes the F-17 PR-review CRITICAL finding: prior to this cron,
 * `splitBroadcastIntoBatches` (T044) had NO production caller, so
 * F7.1a US1 broadcasts (>10k recipients) shipped DARK even with the
 * flag ON — admin approve would set status='approved', then no
 * broadcast_batch_manifest rows were ever created, then the
 * dispatch-batches cron (T055) found nothing to dispatch.
 *
 * This cron closes the loop:
 *   1. Scan `broadcasts WHERE status='approved' AND estimated_recipient_count > 10000`
 *   2. For each: resolve recipients via segment resolver, call
 *      `splitBroadcastIntoBatches` (creates N batch_manifest rows in
 *      'pending'), then transition broadcast `approved → sending`
 *      (so subsequent ticks of dispatch-scheduled cron skip — F7 MVP
 *      single-audience path is irrelevant for F71A multi-batch broadcasts).
 *   3. T055 dispatch-batches cron picks up the pending batches on
 *      its next 5-min tick.
 *
 * Cron-job.org coordinator: every 5 min, Bearer auth via `CRON_SECRET`.
 * Operator setup deferred to ship-day per `docs/runbooks/cron-jobs.md`.
 *
 * Race-safety: eligible scan uses `FOR UPDATE SKIP LOCKED` on the
 * broadcasts row → only one cron tick can claim a given broadcast.
 * Dispatch-scheduled cron (F7 MVP) filters on status='approved' so
 * it skips rows already transitioned to 'sending' by us. Pin Node
 * runtime — Bearer + Drizzle + segment-resolver all require Node.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { verifyCronBearer } from '@/lib/cron-auth';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

// F7.1b B2 closure 2026-05-21 — consolidated barrel imports
// (closes ~5 of the 40 `broadcasts-barrel.test.ts` KNOWN_BACKLOG
// entries for this route).
import {
  asBroadcastId,
  BroadcastConcurrentMutationError,
  eventAttendeesBridge,
  f71aUs1DisabledReason,
  isF71aUs1Enabled,
  makeDrizzleBroadcastsRepo,
  makeDrizzleMarketingUnsubscribesRepo,
  makeSplitBroadcastIntoBatchesDeps,
  membersBridge,
  resolveSegmentRecipients,
  splitBroadcastIntoBatches,
} from '@/modules/broadcasts';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { asTenantContext } from '@/modules/tenants';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BROADCASTS_PER_TICK = 10;
// FR-001 + RESEND_PER_AUDIENCE_CAP — only broadcasts EXCEEDING the
// Resend per-audience cap need splitting. Smaller broadcasts go via
// the F7 MVP single-audience `dispatch-scheduled` path.
const SPLIT_THRESHOLD_RECIPIENTS = 10_000;

const eligibleRowSchema = z.object({
  broadcast_id: z.string().uuid(),
});

// Vercel-native Cron invokes each scheduled path with a GET; this handler's
// Bearer-gated logic lives in POST. Alias GET → POST so one handler serves
// both the Vercel cron (GET) and the legacy cron-job.org trigger (POST)
// during migration. POST is hoisted, so the forward ref is safe.
// See docs/runbooks/cron-jobs.md § "Migration path: Pro plan".
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Bearer auth.
  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  // 2. F71A US1 triple-flag gate. Returns 200 so cron-job.org doesn't
  //    retry-storm during dark-launch.
  if (!isF71aUs1Enabled()) {
    const tenantSlug = resolveTenantFromRequest(request).slug;
    const reason = f71aUs1DisabledReason() ?? 'unknown';
    logger.info(
      { tenantId: tenantSlug, reason },
      'cron.broadcasts.split_large.feature_disabled',
    );
    return NextResponse.json(
      { skipped: true, reason: `feature_disabled:${reason}` },
      { status: 200 },
    );
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const tenant = asTenantContext(tenantCtx.slug);

  // 3. Eligible scan — approved broadcasts whose estimated recipient
  //    count exceeds the Resend per-audience cap. FOR UPDATE SKIP
  //    LOCKED so concurrent ticks don't double-claim a broadcast.
  let eligible: ReadonlyArray<z.infer<typeof eligibleRowSchema>>;
  try {
    eligible = await runInTenant(tenant, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT broadcast_id::text AS broadcast_id
        FROM broadcasts
        WHERE tenant_id = ${tenant.slug}
          AND status = 'approved'
          AND scheduled_for IS NOT NULL
          AND scheduled_for <= now()
          AND estimated_recipient_count > ${SPLIT_THRESHOLD_RECIPIENTS}
        ORDER BY scheduled_for ASC
        LIMIT ${MAX_BROADCASTS_PER_TICK}
        FOR UPDATE SKIP LOCKED
      `)) as unknown as Array<{ broadcast_id: string }>;
      return rows.map((r) => eligibleRowSchema.parse(r));
    });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenant.slug,
      },
      'cron.broadcasts.split_large.eligible_query_failed',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' } },
      { status: 500 },
    );
  }

  if (eligible.length === 0) {
    return NextResponse.json(
      { processed: 0, split: 0, skipped: 0, errors: 0 },
      { status: 200 },
    );
  }

  const broadcastsRepo = makeDrizzleBroadcastsRepo(tenant.slug);
  const marketingUnsubscribes = makeDrizzleMarketingUnsubscribesRepo(
    tenant.slug,
  );
  const splitDeps = makeSplitBroadcastIntoBatchesDeps(tenant.slug);

  const summary = {
    processed: 0,
    split: 0,
    skipped: 0,
    errors: 0,
    // Phase 3F.11.9 (Round 3 HIGH-2 — dashboard distinguisher):
    // `orphanRecovered` separates the orphan-recovery fallthrough path
    // (broadcast already had committed batch_manifests from a prior
    // tick that failed transition) from genuine first-time splits.
    // Without this counter, ops dashboards aggregating `summary.split`
    // can't detect a recurring transition bug — they'd see "split: N"
    // and assume normal cron operation while orphan-recovery warns
    // pile up at a rate exceeding the SLO budget.
    orphanRecovered: 0,
    // Phase 3F.11.9 (Round 3 HIGH-1 — race narrowing): tracks the
    // benign race where two cron ticks simultaneously try to
    // transition the same broadcast and one loses on the
    // `expectedFromStatus='approved'` row-version race-guard.
    // Mutually exclusive with `errors` (the catch narrows on
    // BroadcastConcurrentMutationError → race_lost; everything else
    // → real error).
    raceLost: 0,
  };

  for (const row of eligible) {
    summary.processed++;
    const broadcastId = asBroadcastId(row.broadcast_id);

    try {
      // 4a. Load broadcast aggregate (re-read inside cron's window).
      const broadcast = await broadcastsRepo.findById(tenant.slug, broadcastId);
      if (broadcast === null) {
        summary.skipped++;
        logger.warn(
          { tenantId: tenant.slug, broadcastId: row.broadcast_id },
          'cron.broadcasts.split_large.broadcast_not_found',
        );
        continue;
      }

      // 4b. Resolve recipients via segment resolver — source of truth
      //     for the resolved count that splitBroadcastIntoBatches uses.
      const segment = buildSegmentFromBroadcast(broadcast);
      const requestingPrimary = await membersBridge.getMemberPrimaryContact(
        tenant,
        broadcast.requestedByMemberId,
      );
      const resolved = await resolveSegmentRecipients(
        {
          tenant,
          membersBridge,
          eventAttendees: eventAttendeesBridge,
          marketingUnsubscribes,
        },
        {
          segment,
          requestingMemberPrimaryEmail: requestingPrimary,
          customRecipients:
            broadcast.customRecipientEmails === null
              ? null
              : broadcast.customRecipientEmails.map((e) =>
                  unsafeBrandEmailLower(e.toLowerCase().trim()),
                ),
        },
      );
      if (!resolved.ok) {
        summary.errors++;
        logger.error(
          {
            tenantId: tenant.slug,
            broadcastId: row.broadcast_id,
            errorKind: resolved.error.kind,
          },
          'cron.broadcasts.split_large.recipient_resolution_failed',
        );
        continue;
      }

      const resolvedCount = resolved.value.recipients.length;

      // 4c. Recheck against the cap — if recipients dropped below the
      //     threshold between submit and dispatch (suppression-list
      //     trim, member archival), skip splitting + let F7 MVP
      //     dispatch-scheduled handle it on its next tick.
      if (resolvedCount <= SPLIT_THRESHOLD_RECIPIENTS) {
        summary.skipped++;
        logger.info(
          {
            tenantId: tenant.slug,
            broadcastId: row.broadcast_id,
            estimatedCount: broadcast.estimatedRecipientCount,
            resolvedCount,
          },
          'cron.broadcasts.split_large.resolved_count_under_threshold',
        );
        continue;
      }

      // 4d. Split into batches. The use case persists batch_manifest
      //     rows + emits `broadcast_dispatched_in_batches` audit.
      const splitResult = await splitBroadcastIntoBatches(splitDeps, {
        tenantId: tenant,
        broadcastId,
        resolvedRecipientCount: resolvedCount,
      });
      if (!splitResult.ok) {
        // Phase 3F.11.2 (H4 — Round 2 fix) — orphan recovery.
        // The two-tx structure (split = inner tx → transition = outer
        // tx) means a transient failure at the transition step can
        // leave the broadcast stuck in `approved` while manifests are
        // already committed. On the next tick, eligible scan re-finds
        // the broadcast → `splitBroadcastIntoBatches` returns
        // `BATCH_ALREADY_DISPATCHED` (unique-index collision on
        // manifests). Without recovery, this state persists forever
        // and dispatch-batches cron silently sends emails while the
        // admin UI shows the broadcast as `approved`.
        //
        // Recovery: on BATCH_ALREADY_DISPATCHED, fall through to the
        // transition block — the manifests exist, we just need to flip
        // the broadcast status. The applyTransition expectedFromStatus
        // guard ensures we only transition `approved` rows (race-safe).
        if (splitResult.error.kind !== 'BATCH_ALREADY_DISPATCHED') {
          summary.errors++;
          logger.error(
            {
              tenantId: tenant.slug,
              broadcastId: row.broadcast_id,
              errorKind: splitResult.error.kind,
            },
            'cron.broadcasts.split_large.split_failed',
          );
          continue;
        }
        // Log the orphan-recovery path so ops dashboards can alert if
        // it fires repeatedly (could indicate a deeper transition bug).
        logger.warn(
          {
            tenantId: tenant.slug,
            broadcastId: row.broadcast_id,
          },
          'cron.broadcasts.split_large.orphan_recovery_attempted',
        );
      }

      // 4e. Transition broadcast `approved → sending`. The dispatch-
      //     batches cron's eligible scan filters on pending batches,
      //     not on broadcast status — but transitioning here matches
      //     F7 MVP convention + lets `dispatch-scheduled` (F7 MVP)
      //     correctly skip rows we've claimed. Also reached via the
      //     orphan-recovery fallthrough above (H4 — Round 2 fix).
      try {
        await broadcastsRepo.withTx(async (tx) => {
          await broadcastsRepo.applyTransition(
            tx,
            tenant.slug,
            broadcastId,
            'sending',
            {
              sendingStartedAt: new Date(),
            },
            'approved', // expectedFromStatus — race-guard
          );
        });
      } catch (e) {
        // Phase 3F.11.9 (Round 3 HIGH-1): narrow the catch on
        // `BroadcastConcurrentMutationError` to distinguish benign
        // race-lost (another tick won the expectedFromStatus='approved'
        // guard) from real DB outage. Without this, ops dashboards
        // page on benign races at the same rate as real failures.
        if (e instanceof BroadcastConcurrentMutationError) {
          summary.raceLost++;
          logger.warn(
            {
              tenantId: tenant.slug,
              broadcastId: row.broadcast_id,
              batchCount: splitResult.ok ? splitResult.value.batchCount : null,
              orphanRecovery: !splitResult.ok,
            },
            'cron.broadcasts.split_large.transition_race_lost',
          );
          continue; // another tick won → broadcast already 'sending'
        }
        summary.errors++;
        logger.error(
          {
            err: e instanceof Error ? e.message : String(e),
            tenantId: tenant.slug,
            broadcastId: row.broadcast_id,
            batchCount: splitResult.ok ? splitResult.value.batchCount : null,
            orphanRecovery: !splitResult.ok,
          },
          'cron.broadcasts.split_large.transition_failed',
        );
        continue;
      }

      // Phase 3F.11.9 (Round 3 HIGH-2 — dashboard distinguisher):
      // track orphan-recovery separately from genuine first-time
      // splits, so ops can detect recurring transition bugs from
      // recovery warn-rate without confusion via `summary.split`.
      if (!splitResult.ok) {
        summary.orphanRecovered++;
      }
      summary.split++;
      logger.info(
        {
          tenantId: tenant.slug,
          broadcastId: row.broadcast_id,
          // H4 orphan-recovery: batchCount unknown in recovery path
          // (manifests pre-exist from earlier tick). Null is OK for
          // observability — the recovery log line above carries the signal.
          batchCount: splitResult.ok ? splitResult.value.batchCount : null,
          resolvedCount,
          orphanRecovery: !splitResult.ok,
        },
        'cron.broadcasts.split_large.broadcast_split_complete',
      );
    } catch (e) {
      summary.errors++;
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          tenantId: tenant.slug,
          broadcastId: row.broadcast_id,
        },
        'cron.broadcasts.split_large.broadcast_threw',
      );
    }
  }

  return NextResponse.json(summary, { status: 200 });
}

/**
 * Reconstruct the `RecipientSegment` discriminated-union from the
 * persisted broadcast row. Duplicated from
 * `dispatch-scheduled-broadcast.ts` (file-private helper) and from
 * `dispatch-batches/route.ts` — Phase 3F consolidation candidate.
 */
function buildSegmentFromBroadcast(b: Broadcast) {
  if (b.segmentType === 'all_members') return { kind: 'all_members' as const };
  if (b.segmentType === 'tier') {
    const tierCodes =
      (b.segmentParams as { tierCodes?: string[] } | null)?.tierCodes ?? [];
    return { kind: 'tier' as const, tierCodes };
  }
  if (b.segmentType === 'event_attendees_last_90d') {
    return { kind: 'event_attendees_last_90d' as const };
  }
  return {
    kind: 'custom' as const,
    emails: b.customRecipientEmails ?? [],
  };
}
