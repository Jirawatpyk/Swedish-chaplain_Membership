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

import {
  asBroadcastId,
  resolveSegmentRecipients,
  splitBroadcastIntoBatches,
  makeSplitBroadcastIntoBatchesDeps,
  isF71aUs1Enabled,
  f71aUs1DisabledReason,
} from '@/modules/broadcasts';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { asTenantContext } from '@/modules/tenants';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';

import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { makeDrizzleMarketingUnsubscribesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo';
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { eventAttendeesStub } from '@/modules/broadcasts/infrastructure/event-attendees-stub';

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
          eventAttendees: eventAttendeesStub,
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

      // 4e. Transition broadcast `approved → sending`. The dispatch-
      //     batches cron's eligible scan filters on pending batches,
      //     not on broadcast status — but transitioning here matches
      //     F7 MVP convention + lets `dispatch-scheduled` (F7 MVP)
      //     correctly skip rows we've claimed.
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
        summary.errors++;
        logger.error(
          {
            err: e instanceof Error ? e.message : String(e),
            tenantId: tenant.slug,
            broadcastId: row.broadcast_id,
            batchCount: splitResult.value.batchCount,
          },
          'cron.broadcasts.split_large.transition_failed',
        );
        continue;
      }

      summary.split++;
      logger.info(
        {
          tenantId: tenant.slug,
          broadcastId: row.broadcast_id,
          batchCount: splitResult.value.batchCount,
          resolvedCount,
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
