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
 * wire-up landed in Phase 3F.4 (see the "Phase 3F.4 (F-10 fix)" block
 * below — the per-tenant settings row is read INSIDE the loop, then
 * clamped via Domain `validateConcurrencyCap`). When the settings row
 * is absent or NULL, Domain DEFAULT_CONCURRENCY_CAP (4) is used — safe
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
import { broadcastsMetrics } from '@/lib/metrics';
import { errKind } from '@/lib/log-id';
import { verifyCronBearer } from '@/lib/cron-auth';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

// F7.1b B2 closure 2026-05-21 — composition-root dependencies now
// imported through the broadcasts barrel (closes ~12 of the 40
// `broadcasts-barrel.test.ts` KNOWN_BACKLOG entries for this route).
import {
  asBroadcastId,
  dispatchAllPendingBatches,
  eventAttendeesBridge,
  f71aUs1DisabledReason,
  f7AuditAdapter,
  isF71aUs1Enabled,
  makeDrizzleBatchManifestsRepo,
  makeDrizzleBroadcastsRepo,
  makeDrizzleMarketingUnsubscribesRepo,
  makeTickMemoizedMembersBridge,
  membersBridge,
  noOpAdvisoryLock,
  recipientSegmentFromPersisted,
  resendBroadcastsGateway,
  resolveSegmentRecipients,
  currentAudienceMode,
  configuredAudienceCeiling,
  systemClock,
  tenantDefaultLocaleFor,
} from '@/modules/broadcasts';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { asTenantContext } from '@/modules/tenants';

// Domain policy import — Domain types are barrel-pure but
// `DEFAULT_CONCURRENCY_CAP` + `validateConcurrencyCap` are Domain-internal
// constants not re-exported via the broadcasts barrel yet. Keep direct
// import. `validateConcurrencyCap` added 2026-05-22 to honor the
// `clamped via Domain` comment at line 297 (post-/code-review borderline #1).
import {
  DEFAULT_CONCURRENCY_CAP,
  validateConcurrencyCap,
} from '@/modules/broadcasts/domain/policies/batch-concurrency-policy';
import type {
  BroadcastContent,
  DispatchBroadcastBatchDeps,
} from '@/modules/broadcasts/application/use-cases/dispatch-broadcast-batch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// BUG-028: full function budget for the per-contact audience sync. Resend's
// account limit is 10 req/s, but `addContactsToAudience` is a serial `await`
// loop, so one worker reaches only `min(limit, 1/RTT)` ≈ 2.08 req/s at the
// measured `POST /contacts` latency (research.md § R9, CORRECTED block).
//
// This route's 300 s budget is per INVOCATION, and Phase 9b changed what that
// means. `batch-dispatcher.ts` now dispatches **one wave per invocation**: up
// to `concurrencyCap` batches (default 4) in flight, and the remainder is
// deferred to the next tick rather than started at ~240 s and killed at 300.
// Batches are sized at `DELIVERABLE_RECIPIENTS_PER_TICK`, so one wave fits the
// budget by construction — which is the point: before 9b a batch could hold up
// to RESEND_PER_AUDIENCE_CAP = 10,000 contacts, needing ≥ 1,000 s even at the
// full policy rate, so splitting did not escape the wall clock at all.
//
// This path is still rate-limit-bound rather than latency-bound where
// `dispatch-scheduled` is not: 4 concurrent workers × 2.08 ≈ 8.3 req/s sits
// just under the 10 req/s policy, so 429s and the gateway's reactive backoff
// are expected here. A tenant's `dispatch_concurrency_cap` above 4 exceeds the
// policy — see `docs/runbooks/broadcast-audience-build.md`.
export const maxDuration = 300;

const MAX_BROADCASTS_PER_TICK = 20;
const SWEEP_GRACE_SECONDS = 30;

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
      // Phase 3F.4 (F-05 fix) — lock parent `broadcasts` rows with
      // FOR UPDATE SKIP LOCKED so two simultaneous cron ticks cannot
      // both pick the same broadcast (cron-job.org 5xx retry storm
      // scenario). Previous SELECT DISTINCT on broadcast_batch_manifests
      // had no row-lock semantics → race-window where both ticks
      // dispatch the same batch. The EXISTS predicate filters parent
      // rows with ≥1 pending batch_manifest older than the grace
      // window. Idempotency-key UNIQUE index is the second-line guard
      // (Resend dedupe is the third), but the lock closes the race
      // at the source.
      const rows = (await tx.execute(sql`
        SELECT b.broadcast_id::text AS broadcast_id
        FROM broadcasts b
        WHERE b.tenant_id = ${tenant.slug}
          AND EXISTS (
            SELECT 1 FROM broadcast_batch_manifests bm
            WHERE bm.tenant_id = b.tenant_id
              AND bm.broadcast_id = b.broadcast_id
              AND bm.status = 'pending'
              AND bm.created_at < now() - (${SWEEP_GRACE_SECONDS}::int * INTERVAL '1 second')
          )
        ORDER BY b.broadcast_id ASC
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
    /**
     * Phase 9b (T138) — batches left `pending` because this invocation's wave
     * was full. Neither dispatched nor failed; they go out on the next tick.
     * Counted separately so a broadcast progressing normally across ticks is
     * distinguishable from one that is stuck.
     */
    batchesDeferred: 0,
    skipped: 0,
    errors: 0,
  };

  // /code-review 2026-09-07 (finding #3) — `dispatch-scheduled` has wrapped
  // its bridge in the per-tick memo since R6; this cron and
  // `split-large-broadcasts` never did, so N eligible rows on the same
  // segment each re-walked the identical audience. 108 PR-C made that walk a
  // full 1:N keyset paginate (N/5,000 F3 round trips) plus an opted-out
  // aggregate — the cost this route's own `maxDuration` comment cites. The
  // memo is also what pairs a tick's frozen audience with ONE opt-out count
  // (C18), so without it two rows on one segment got independently timed
  // audiences. Fresh Map per tick; tenant-keyed.
  const tickMembersBridge = makeTickMemoizedMembersBridge(membersBridge);

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
      // Review 2026-09-07 round 2 (C1/C2) — a tier row with no codes is a
      // permanent data defect: refused here, never resolved (the primary_only
      // read used to address EVERY member for it), and NOT counted as a
      // transient resolve failure, which would page for a retry that cannot
      // succeed. The row stays put; `stuck_sending_count` is its alarm.
      const segmentResult = recipientSegmentFromPersisted(broadcast);
      if (!segmentResult.ok) {
        summary.errors++;
        logger.error(
          {
            tenantId: tenant.slug,
            broadcastId: row.broadcast_id,
            errorKind: 'malformed_segment',
            detail: segmentResult.error.reason,
          },
          'cron.broadcasts.dispatch_batches.malformed_segment',
        );
        continue;
      }
      const segment = segmentResult.value;
      // Staff review A11 (closed by the 2026-09-07 review, errors HIGH-4): the
      // fail-closed bridge reads THROW; this cron used to let that fall to the
      // generic per-broadcast catch, so one outage was classified differently
      // per cron. Now every cron counts it in `dispatch_resolve_failed_total`
      // from the catch below — one signal, three crons.
      // 108 PR-C: self-exclusion is by MEMBER id (FR-022), so the requesting
      // member's primary email is no longer read here; the leg comes from
      // the same flag read the submit and dispatch paths use (SC-004).
      let resolved: Awaited<ReturnType<typeof resolveSegmentRecipients>>;
      try {
        resolved = await resolveSegmentRecipients(
        {
          tenant,
          membersBridge: tickMembersBridge,
          eventAttendees: eventAttendeesBridge,
          marketingUnsubscribes,
          audienceMode: currentAudienceMode(),
          // CONFIGURED, not the per-tick clamp — same reason as
          // `split-large-broadcasts` (T095 review, 2026-09-08): this route
          // dispatches batches of an audience that was deliberately split
          // BECAUSE it exceeds one tick, so clamping it to
          // DELIVERABLE_RECIPIENTS_PER_TICK would refuse every manifest it can
          // pick up and leave it `pending`, re-tried every tick, visible only
          // through `stuck_sending_count` at 24 h.
          audienceCeiling: configuredAudienceCeiling(),
        },
        {
          segment,
          phase: 'dispatch',
          requestingMemberId: broadcast.requestedByMemberId,
          customRecipients:
            broadcast.customRecipientEmails === null
              ? null
              : broadcast.customRecipientEmails.map((e) =>
                  unsafeBrandEmailLower(e.toLowerCase().trim()),
                ),
        },
        );
      } catch (e) {
        summary.errors++;
        // Review 2026-09-07 (errors HIGH-4) — the row stays where it is and
        // is retried next tick with no budget; the counter is the alarm.
        broadcastsMetrics.dispatchResolveFailedTotal(tenant.slug);
        logger.error(
          {
            tenantId: tenant.slug,
            broadcastId: row.broadcast_id,
            // /code-review 2026-09-07 (finding #7) — this said
            // `dispatch.server_error` for ANY throw. That kind belongs to a
            // DIFFERENT use case's error union — `dispatchScheduledBroadcast`
            // maps into it; this resolver's own union yields
            // `resolve.server_error` (handled below). A THROW is
            // either the fail-closed opt-out lookup or a programming error,
            // and the log has no way to tell. Stamping the typed name made
            // a TypeError read as a Neon outage to whoever follows
            // `broadcast-audience-build.md § C`. Same lesson as
            // check:actor-role-truth: record what you observed, never a
            // classification nobody established.
            errorKind: 'unclassified_throw',
            err: errKind(e),
          },
          'cron.broadcasts.dispatch_batches.recipient_resolution_failed',
        );
        continue;
      }
      if (!resolved.ok) {
        summary.errors++;
        if (resolved.error.kind === 'resolve.server_error') {
          broadcastsMetrics.dispatchResolveFailedTotal(tenant.slug);
        }
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

      // Round-2 finding 9: the per-broadcast drop count was logged only on the
      // `dispatchScheduledBroadcast` path, so a >5,000-recipient broadcast —
      // which travels split-large-broadcasts -> dispatch-batches and never
      // touches that path — remained unanswerable for exactly the broadcasts
      // where the gap is largest. Counts only, never an address (FR-053a).
      if (resolved.value.droppedByPreference > 0) {
        logger.info(
          {
            tenantId: tenant.slug,
            broadcastId: row.broadcast_id,
            droppedByPreference: resolved.value.droppedByPreference,
            recipientCount: resolved.value.recipients.length,
          },
          'cron.broadcasts.dispatch_batches.marketing_opt_out_dropped',
        );
      }

      const allRecipients = resolved.value.recipients.map((e) => ({
        emailLower: e as unknown as string,
      }));

      // 5d. Build BroadcastContent for the dispatcher service.
      // Phase 3F.7 (F-22 fix) — resolve proper tenant display name
      // instead of using raw slug ("swecham" → "Swedish Chamber of
      // Commerce"). Members see this in the Resend "from" header.
      const { resolveTenantDisplayName } = await import(
        '@/lib/broadcasts-route-helpers'
      );
      let tenantDisplayName: string;
      try {
        tenantDisplayName = await resolveTenantDisplayName(tenant.slug);
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e), tenantId: tenant.slug },
          'cron.broadcasts.dispatch_batches.tenant_display_name_lookup_failed',
        );
        tenantDisplayName = tenant.slug; // degraded fallback
      }

      const broadcastContent: BroadcastContent = {
        broadcastId,
        subject: broadcast.subject,
        bodyHtml: broadcast.bodyHtml,
        fromName: broadcast.fromName,
        fromEmail: env.broadcasts.fromEmail,
        replyToEmail: broadcast.replyToEmail,
        tenantDisplayName,
        locale: tenantDefaultLocaleFor(tenant.slug),
      };

      // Phase 3F.4 (F-10 fix) — read per-tenant
      // `dispatch_concurrency_cap` from `tenant_broadcast_settings`
      // per FR-002 ("tenant-configurable 1-8 range, default 4").
      // Falls back to DEFAULT_CONCURRENCY_CAP if no settings row
      // exists for this tenant (most tenants will rely on the
      // default; only those with elevated Resend account-tier limits
      // opt up via the future admin settings UI).
      //
      // Defence-in-depth (post-/code-review borderline #1, 2026-05-22):
      // even though migration 0165 has `CHECK BETWEEN 1 AND 8`, the value
      // is also clamped at the boundary via the Domain
      // `validateConcurrencyCap` policy. If the DB constraint is ever
      // relaxed or the column type changes, the cron still refuses
      // out-of-range values rather than handing them to
      // `dispatchAllPendingBatches` (where a 0 would silently stop
      // dispatch + a >8 would exceed the Resend account-tier limit).
      let concurrencyCap: number = DEFAULT_CONCURRENCY_CAP;
      try {
        const settingsRows = (await runInTenant(tenant, async (tx) =>
          tx.execute(sql`
            SELECT dispatch_concurrency_cap
            FROM tenant_broadcast_settings
            WHERE tenant_id = ${tenant.slug}
            LIMIT 1
          `),
        )) as unknown as Array<{ dispatch_concurrency_cap: number }>;
        if (settingsRows.length > 0) {
          const rawCap = settingsRows[0]!.dispatch_concurrency_cap;
          const validation = validateConcurrencyCap(rawCap);
          if (validation.ok) {
            concurrencyCap = rawCap;
          } else {
            // DB row had an out-of-range value (CHECK constraint bypass
            // via direct DB edit or a future migration mistake). Log
            // + fall back to default to keep dispatch healthy.
            logger.warn(
              {
                tenantId: tenant.slug,
                rawCap,
                error: validation.error,
              },
              'cron.broadcasts.dispatch_batches.concurrency_cap_out_of_range',
            );
          }
        }
      } catch (e) {
        logger.warn(
          {
            err: e instanceof Error ? e.message : String(e),
            tenantId: tenant.slug,
          },
          'cron.broadcasts.dispatch_batches.concurrency_cap_read_failed',
        );
        // Fall through with DEFAULT_CONCURRENCY_CAP — safer than failing
        // the whole tick on a settings-row read error.
      }

      // 5e. Dispatch all pending batches via the service (parallel + capped).
      const dispatchResult = await dispatchAllPendingBatches(dispatchDeps, {
        tenantId: tenant,
        broadcastContent,
        allRecipients,
        pendingBatches,
        concurrencyCap,
        requestId: null,
      });

      summary.broadcastsDispatched++;
      summary.batchesDispatched += dispatchResult.succeeded;
      summary.batchesFailed += dispatchResult.failed;
      summary.batchesDeferred += dispatchResult.deferredToNextTick;

      logger.info(
        {
          tenantId: tenant.slug,
          broadcastId: row.broadcast_id,
          totalBatches: dispatchResult.totalBatches,
          succeeded: dispatchResult.succeeded,
          failed: dispatchResult.failed,
          // Phase 9b (T138) — batches this invocation deliberately left
          // `pending` because the wave was full. Not an error: they go out on
          // the next tick, five minutes later. Worth logging because it is the
          // only way to tell "a large broadcast is progressing normally across
          // ticks" from "a broadcast is stuck", which otherwise look identical
          // until `stuck_sending_count` fires at 24 h.
          deferredToNextTick: dispatchResult.deferredToNextTick,
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

