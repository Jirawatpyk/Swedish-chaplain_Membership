/**
 * T055 (F7.1a US1) — POST `/api/cron/broadcasts/dispatch-batches`.
 *
 * Triggered every 5 min by cron-job.org. Finds broadcasts that have
 * been split into batch_manifests (Phase 3 T044
 * `splitBroadcastIntoBatches`) and dispatches every still-pending
 * batch to Resend via the per-batch `dispatchBroadcastBatch` use case
 * (T045), orchestrated by the `dispatchAllPendingBatches` service
 * (T046) with the tenant's `dispatch_concurrency_cap` (1-8, default
 * 4 per FR-002 + Clarifications round-1 Q1).
 *
 * Auth: Bearer token via `CRON_SECRET` — matches the existing F7 MVP
 * dispatch-scheduled cron pattern + F4 outbox + F5 sweep.
 *
 * Kill-switch: respects `env.features.f7Broadcasts` (the F7 master
 * flag — F71A is an extension and ships dark when F7 itself is off).
 *
 * Sweep window: pending batches must be older than 30 seconds — this
 * gives the splitter's tx + audit-emit a moment to commit before the
 * dispatcher races in (cosmetic — the per-batch advisory lock would
 * serialise anyway, but the 30s window avoids unnecessary lock churn).
 *
 * NOTE: per-tenant `tenant_broadcast_settings.dispatch_concurrency_cap`
 * wire-up is closed in Phase 3F.4 (see line 254 read). Until that
 * commit, this cron uses Domain DEFAULT_CONCURRENCY_CAP (4) — safe
 * default for shared Resend account-tier limits per FR-002.
 *
 * Pin Node runtime — Bearer check + Drizzle + advisory locks all
 * require Node APIs.
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
  tenantDefaultLocaleFor,
  isF71aUs1Enabled,
  f71aUs1DisabledReason,
} from '@/modules/broadcasts';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { asTenantContext } from '@/modules/tenants';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';

// F7.1a Phase 3 Cluster B + 3C — composition imports (Application + Infra)
import { DEFAULT_CONCURRENCY_CAP } from '@/modules/broadcasts/domain/policies/batch-concurrency-policy';
import { dispatchAllPendingBatches } from '@/modules/broadcasts/application/services/batch-dispatcher';
import type {
  BroadcastContent,
  DispatchBroadcastBatchDeps,
} from '@/modules/broadcasts/application/use-cases/dispatch-broadcast-batch';
import { makeDrizzleBatchManifestsRepo } from '@/modules/broadcasts/infrastructure/drizzle-batch-manifests-repo';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { makeDrizzleMarketingUnsubscribesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo';
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { eventAttendeesStub } from '@/modules/broadcasts/infrastructure/event-attendees-stub';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';
import { noOpAdvisoryLock } from '@/modules/broadcasts/infrastructure/noop-advisory-lock';
import { systemClock } from '@/modules/broadcasts/infrastructure/broadcasts-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BROADCASTS_PER_TICK = 20;
const SWEEP_GRACE_SECONDS = 30;

const eligibleRowSchema = z.object({
  broadcast_id: z.string().uuid(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Bearer auth — constant-time check.
  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  // 2. Feature kill-switch — F7 master + F71A master + US1 sub-flag
  //    must ALL be on (T061). Returns 200 so cron-job.org does not
  //    retry-storm during dark-launch.
  if (!isF71aUs1Enabled()) {
    const tenantSlug = resolveTenantFromRequest(request).slug;
    const reason = f71aUs1DisabledReason() ?? 'unknown';
    logger.info(
      { tenantId: tenantSlug, reason },
      'cron.broadcasts.dispatch_batches.feature_disabled',
    );
    return NextResponse.json(
      { skipped: true, reason: `feature_disabled:${reason}` },
      { status: 200 },
    );
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const tenant = asTenantContext(tenantCtx.slug);

  // 3. Eligible scan — distinct broadcast_ids that have ≥1 pending
  //    batch manifest older than the grace window.
  let eligible: ReadonlyArray<z.infer<typeof eligibleRowSchema>>;
  try {
    eligible = await runInTenant(tenant, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT DISTINCT broadcast_id::text AS broadcast_id
        FROM broadcast_batch_manifests
        WHERE tenant_id = ${tenant.slug}
          AND status = 'pending'
          AND created_at < now() - (${SWEEP_GRACE_SECONDS}::int * INTERVAL '1 second')
        ORDER BY broadcast_id ASC
        LIMIT ${MAX_BROADCASTS_PER_TICK}
      `)) as unknown as Array<{ broadcast_id: string }>;
      return rows.map((r) => eligibleRowSchema.parse(r));
    });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenant.slug,
      },
      'cron.broadcasts.dispatch_batches.eligible_query_failed',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' } },
      { status: 500 },
    );
  }

  if (eligible.length === 0) {
    return NextResponse.json(
      {
        processed: 0,
        broadcastsDispatched: 0,
        batchesDispatched: 0,
        batchesFailed: 0,
      },
      { status: 200 },
    );
  }

  // 4. Build shared dependency bundle (per tick).
  const batchManifestsRepo = makeDrizzleBatchManifestsRepo(tenant.slug);
  const broadcastsRepo = makeDrizzleBroadcastsRepo(tenant.slug);
  const marketingUnsubscribes = makeDrizzleMarketingUnsubscribesRepo(
    tenant.slug,
  );

  const dispatchDeps: DispatchBroadcastBatchDeps = {
    batchManifests: batchManifestsRepo,
    gateway: resendBroadcastsGateway,
    advisoryLock: noOpAdvisoryLock,
    audit: f7AuditAdapter,
    clock: systemClock,
  };

  const summary = {
    processed: 0,
    broadcastsDispatched: 0,
    batchesDispatched: 0,
    batchesFailed: 0,
    skipped: 0,
    errors: 0,
  };

  // 5. Per-broadcast: load + resolve recipients + dispatch all pending batches.
  for (const row of eligible) {
    summary.processed++;
    const broadcastId = asBroadcastId(row.broadcast_id);

    try {
      // 5a. Load broadcast aggregate.
      const broadcast = await broadcastsRepo.findById(tenant.slug, broadcastId);
      if (broadcast === null) {
        summary.skipped++;
        logger.warn(
          { tenantId: tenant.slug, broadcastId: row.broadcast_id },
          'cron.broadcasts.dispatch_batches.broadcast_not_found',
        );
        continue;
      }

      // 5b. Find still-pending batches at the moment of dispatch.
      const pendingBatches = await batchManifestsRepo.findPendingByBroadcast(
        tenant.slug,
        broadcastId,
      );
      if (pendingBatches.length === 0) {
        // Race with another tick / webhook flipped statuses — fine.
        summary.skipped++;
        continue;
      }

      // 5c. Resolve recipients (segment + suppression + dedupe).
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
          'cron.broadcasts.dispatch_batches.recipient_resolution_failed',
        );
        continue;
      }

      const allRecipients = resolved.value.recipients.map((e) => ({
        emailLower: e as unknown as string,
      }));

      // 5d. Build BroadcastContent for the dispatcher service.
      const broadcastContent: BroadcastContent = {
        broadcastId,
        subject: broadcast.subject,
        bodyHtml: broadcast.bodyHtml,
        fromName: broadcast.fromName,
        fromEmail: env.broadcasts.fromEmail,
        replyToEmail: broadcast.replyToEmail,
        tenantDisplayName: tenant.slug, // F12 white-label scope — degraded default
        locale: tenantDefaultLocaleFor(tenant.slug),
      };

      // 5e. Dispatch all pending batches via the service (parallel + capped).
      const dispatchResult = await dispatchAllPendingBatches(dispatchDeps, {
        tenantId: tenant,
        broadcastContent,
        allRecipients,
        pendingBatches,
        concurrencyCap: DEFAULT_CONCURRENCY_CAP,
        requestId: null,
      });

      summary.broadcastsDispatched++;
      summary.batchesDispatched += dispatchResult.succeeded;
      summary.batchesFailed += dispatchResult.failed;

      logger.info(
        {
          tenantId: tenant.slug,
          broadcastId: row.broadcast_id,
          totalBatches: dispatchResult.totalBatches,
          succeeded: dispatchResult.succeeded,
          failed: dispatchResult.failed,
          elapsedMs: dispatchResult.elapsedMs,
        },
        'cron.broadcasts.dispatch_batches.broadcast_complete',
      );
    } catch (e) {
      summary.errors++;
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          tenantId: tenant.slug,
          broadcastId: row.broadcast_id,
        },
        'cron.broadcasts.dispatch_batches.broadcast_threw',
      );
    }
  }

  return NextResponse.json(summary, { status: 200 });
}

/**
 * Reconstruct the `RecipientSegment` discriminated-union from the
 * persisted broadcast row. Mirrors the helper in
 * `dispatch-scheduled-broadcast.ts` — duplicated here so the cron
 * handler doesn't depend on a private helper not exported by the F7
 * MVP use case file.
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
