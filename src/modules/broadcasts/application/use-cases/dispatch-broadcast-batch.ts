/**
 * T045 (F7.1a US1) — `dispatchBroadcastBatch` Application use case.
 *
 * Dispatches a SINGLE `broadcast_batch_manifest` row to Resend via
 * createAudience → addContactsToAudience → createBroadcast →
 * sendBroadcast (mirrors F7 MVP `dispatch-scheduled-broadcast.ts`
 * gateway sequence, but per-batch with batch-specific idempotency key
 * and audience name).
 *
 * Concurrency contract (plan.md § VIII Reliability):
 *   - Attempts `pg_try_advisory_xact_lock('broadcasts-batch:{tenant}:{broadcast}:{batchIndex}')`
 *     via `AdvisoryLockPort` BEFORE Resend calls. Namespace DISJOINT
 *     from `broadcasts-retry:` (Phase 3 T047) and F7 MVP
 *     `broadcasts:` lock. NOTE: production wires `noOpAdvisoryLock`
 *     because long-running gateway calls cannot sit inside a held tx
 *     — per-batch race is mitigated by cron-job.org tick spacing +
 *     T055 FOR UPDATE SKIP LOCKED + idempotency-key unique index
 *     (see `noop-advisory-lock.ts` header for full rationale).
 *   - Caller (T046 batch-dispatcher) is responsible for the
 *     concurrency cap; this use case dispatches one batch.
 *
 * Idempotency key per batch (data-model § 4):
 *   `broadcast-{broadcastId}-batch-{batchIndex}-attempt-{retryCount}`
 *
 * The manifest transitions:
 *   pending → sending  (set BEFORE gateway calls)
 *   sending → sending  (no-op; webhook later flips to sent)
 *   sending → failed   (set on gateway error, with failureReason)
 *
 * Note on broadcast-level status: this use case does NOT transition
 * the BROADCAST aggregate's status — that's the cron handler's
 * (T055) responsibility once all batches reach terminal states.
 *
 * Pure orchestration — no framework imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { broadcastsF71aMetrics } from '@/lib/metrics/broadcasts-f71a';
import { safeAuditEmit } from './_safe-audit-emit';
import { resendDashboardName } from '../format/resend-dashboard-name';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import type { AdvisoryLockPort } from '../ports/advisory-lock-port';
import type { AuditPort } from '../ports/audit-port';
import type {
  BatchManifest,
  BatchManifestsPort,
} from '../ports/batch-manifests-port';
import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';
import type { ClockPort } from '../ports/clock-port';

export type DispatchBroadcastBatchError =
  | { readonly kind: 'BATCH_NOT_FOUND'; readonly batchManifestId: string }
  | {
      readonly kind: 'INVALID_STATE_TRANSITION';
      readonly currentStatus: string;
      readonly expected: 'pending';
    }
  | {
      readonly kind: 'ALREADY_DISPATCHING_IN_PROGRESS';
      readonly batchManifestId: string;
      readonly lockKey: string;
    }
  | {
      readonly kind: 'GATEWAY_ERROR';
      readonly stage:
        | 'createAudience'
        | 'addContactsToAudience'
        | 'createBroadcast'
        | 'sendBroadcast';
      readonly detail: string;
    }
  | {
      readonly kind: 'dispatch_broadcast_batch.server_error';
      readonly message: string;
    };

export interface DispatchBroadcastBatchDeps {
  readonly batchManifests: BatchManifestsPort;
  readonly gateway: BroadcastsGatewayPort;
  readonly advisoryLock: AdvisoryLockPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

export interface BroadcastContent {
  readonly broadcastId: BroadcastId;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly fromName: string;
  readonly fromEmail: string;
  readonly replyToEmail: string;
  readonly tenantDisplayName: string;
  readonly locale: 'en' | 'th' | 'sv';
}

export interface DispatchBroadcastBatchInput {
  readonly tenantId: TenantContext;
  readonly batchManifestId: string;
  /** Full deduplicated recipient list — this use case slices it. */
  readonly allRecipients: ReadonlyArray<{ readonly emailLower: string }>;
  readonly broadcastContent: BroadcastContent;
  readonly requestId?: string | null;
}

export interface DispatchBroadcastBatchOutput {
  readonly providerAudienceId: string;
  readonly recipientCount: number;
  readonly batchIndex: number;
}

function makeBatchLockKey(
  tenantSlug: string,
  broadcastId: BroadcastId,
  batchIndex: number,
): string {
  return `broadcasts-batch:${tenantSlug}:${broadcastId}:${batchIndex}`;
}

export async function dispatchBroadcastBatch(
  deps: DispatchBroadcastBatchDeps,
  input: DispatchBroadcastBatchInput,
): Promise<Result<DispatchBroadcastBatchOutput, DispatchBroadcastBatchError>> {
  const tenantSlug = input.tenantId.slug;

  // 1. Load manifest + cheap pre-validate state.
  const allManifests = await deps.batchManifests.findByBroadcast(
    tenantSlug,
    input.broadcastContent.broadcastId,
  );
  const manifest: BatchManifest | undefined = allManifests.find(
    (m) => m.id === input.batchManifestId,
  );
  if (manifest === undefined) {
    return err({
      kind: 'BATCH_NOT_FOUND',
      batchManifestId: input.batchManifestId,
    });
  }

  if (manifest.status !== 'pending') {
    return err({
      kind: 'INVALID_STATE_TRANSITION',
      currentStatus: manifest.status,
      expected: 'pending',
    });
  }

  // 2. Acquire per-batch advisory lock.
  const lockKey = makeBatchLockKey(
    tenantSlug,
    input.broadcastContent.broadcastId,
    manifest.batchIndex,
  );
  // Phase 3E 2026-05-19 — `acquire(tx, lockKey)` signature. T045
  // is NOT yet tx-wrapped (gateway calls inside a held tx would be
  // an anti-pattern); cron handler wires `noOpAdvisoryLock` here so
  // null tx is acceptable for the stub. Phase 3E.2 hardening for
  // T045 would require splitting the use case body across
  // pre-gateway-lock-tx + gateway + post-gateway-update-tx.
  const lock = await deps.advisoryLock.acquire(null, lockKey);
  if (!lock.acquired) {
    return err({
      kind: 'ALREADY_DISPATCHING_IN_PROGRESS',
      batchManifestId: input.batchManifestId,
      lockKey,
    });
  }

  // 2b. Bug #6 fix (2026-07-10, revised after code-review) — recipient-set
  //     drift observability. The split cron and the dispatch cron resolve
  //     recipients INDEPENDENTLY at different ticks, so the audience can drift
  //     between them. Do NOT fail the whole broadcast on drift: routine
  //     unsubscribe/bounce/membership churn in the inter-tick window is expected
  //     and would strand EVERY batch (the same allRecipients is fed to all of
  //     them). Two cases:
  //       - GROW (resolved > split coverage): recipients past the last batch's
  //         range are in NO manifest and would be dropped SILENTLY while the
  //         broadcast rolls up to a clean 'sent'. That silent loss is the actual
  //         bug — surface it (log) and dispatch the covered set.
  //       - SHRINK (resolved < coverage): the straddling batch's slice comes up
  //         short and is caught per-batch by the recipientSlice length check
  //         below (only that batch fails; earlier batches still send). No
  //         whole-broadcast abort.
  //     The full auto-heal (snapshot the resolved set at split time, or re-split
  //     the drifted tail) remains the follow-up.
  const splitTimeCoverage = allManifests.reduce(
    (sum, m) => sum + m.recipientCount,
    0,
  );
  // GROW is a broadcast-level fact identical for every batch, but the dropped
  // tail sits immediately past the LAST batch's range. Warn only from that
  // last batch (`recipientRangeEnd + 1 === splitTimeCoverage`) so the log fires
  // ONCE per broadcast, from the batch adjacent to the loss — not N× across
  // every batch dispatch (re-review finding #12).
  const isLastBatch = manifest.recipientRangeEnd + 1 === splitTimeCoverage;
  if (input.allRecipients.length > splitTimeCoverage && isLastBatch) {
    logger.warn(
      {
        tenantId: tenantSlug,
        broadcastId: input.broadcastContent.broadcastId,
        batchManifestId: manifest.id,
        batchIndex: manifest.batchIndex,
        resolvedCount: input.allRecipients.length,
        splitTimeCoverage,
        excludedTail: input.allRecipients.length - splitTimeCoverage,
      },
      'broadcasts.batch.recipient_set_grew_tail_excluded',
    );
    // #11 — surface drift as a counter (not just a log) so ops can alert/trend.
    // Emitted once per broadcast (gated on isLastBatch), matching the warn.
    broadcastsF71aMetrics.recipientSetDriftCount(tenantSlug);
  }

  // 3. Slice recipients for this batch from the full list. The
  //    [start, end+1) window matches Domain `computeBatchRanges`
  //    semantics (inclusive start, inclusive end).
  const sliceStart = manifest.recipientRangeStart;
  const sliceEnd = manifest.recipientRangeEnd + 1;
  const recipientSlice = input.allRecipients.slice(sliceStart, sliceEnd);

  if (recipientSlice.length !== manifest.recipientCount) {
    return err({
      kind: 'dispatch_broadcast_batch.server_error',
      message: `recipient slice length ${recipientSlice.length} != manifest.recipientCount ${manifest.recipientCount} for batch ${manifest.batchIndex}`,
    });
  }

  // 4. Mark manifest sending BEFORE gateway calls — so concurrent
  //    dispatchers see in-flight state (defensive; advisory lock
  //    above is the primary serialisation).
  const dispatchedAt = deps.clock.now();
  const markSending = await deps.batchManifests.updateStatus(
    tenantSlug,
    manifest.id,
    {
      status: 'sending',
      dispatchedAt,
    },
  );
  if (!markSending.ok) {
    return err({
      kind: 'dispatch_broadcast_batch.server_error',
      message: `pre-dispatch updateStatus failed: ${markSending.error.kind}`,
    });
  }

  // 5. Gateway calls — external, non-rollback. On error: transition
  //    manifest sending → failed and emit audit. Order mirrors F7 MVP
  //    `dispatch-scheduled-broadcast.ts`.
  const audienceName = `broadcast-${tenantSlug}-${input.broadcastContent.broadcastId}-batch-${manifest.batchIndex}`;
  const idempotencyKey = manifest.idempotencyKey;

  let providerAudienceId = '';
  let resendBroadcastId = '';
  let gatewayStage:
    | 'createAudience'
    | 'addContactsToAudience'
    | 'createBroadcast'
    | 'sendBroadcast' = 'createAudience';

  try {
    gatewayStage = 'createAudience';
    const audienceResult = await deps.gateway.createAudience(audienceName);
    providerAudienceId = audienceResult.audienceId;

    gatewayStage = 'addContactsToAudience';
    await deps.gateway.addContactsToAudience(
      providerAudienceId,
      recipientSlice.map((r) => ({ emailLower: r.emailLower })),
    );

    gatewayStage = 'createBroadcast';
    const createResult = await deps.gateway.createBroadcast({
      audienceId: providerAudienceId,
      subject: input.broadcastContent.subject,
      htmlBody: input.broadcastContent.bodyHtml,
      fromName: input.broadcastContent.fromName,
      fromEmail: input.broadcastContent.fromEmail,
      replyToEmail: input.broadcastContent.replyToEmail,
      broadcastNameForResendDashboard: resendDashboardName(
        input.broadcastContent.fromName,
        `batch ${manifest.batchIndex + 1}`,
      ),
      tenantDisplayName: input.broadcastContent.tenantDisplayName,
      locale: input.broadcastContent.locale,
    });
    resendBroadcastId = createResult.broadcastId;

    gatewayStage = 'sendBroadcast';
    await deps.gateway.sendBroadcast(resendBroadcastId, idempotencyKey);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // Mark manifest failed + emit audit. Best-effort — if this UPDATE
    // also fails, the reconcile-stuck-sending sweep (Phase 3 T056)
    // will catch it on the next tick.
    // Phase 3F.4 (F-3 silent-fail fix): destructure Result + log on
    // !ok so a DB write failure on the status flip surfaces in ops
    // logs (not silently dropped). Audit emit wrapped in try/catch
    // (F-7 sibling fix) so an audit-port throw doesn't cascade into
    // a Result discard.
    const failedAt = deps.clock.now();
    const failedUpdate = await deps.batchManifests.updateStatus(
      tenantSlug,
      manifest.id,
      {
        status: 'failed',
        failedAt,
        failureReason: `${gatewayStage}: ${detail.slice(0, 500)}`,
      },
    );
    if (!failedUpdate.ok) {
      logger.error(
        {
          tenantId: tenantSlug,
          batchManifestId: manifest.id,
          updateError: failedUpdate.error.kind,
          gatewayStage,
          originalError: detail.slice(0, 500),
        },
        'broadcasts.batch.failed_transition_db_write_failed',
      );
    }
    // simplifier H2 migration 2026-05-21: post-commit best-effort emit via
    // `safeAuditEmit` — auto-emits `broadcasts_audit_emit_failed_total`
    // counter for SRE alerting. H1 Round 2 closure 2026-05-21: extraContext
    // preserves the per-site forensic fields (batchManifestId + batchIndex +
    // gatewayStage) in the pino log line on audit-emit failure, so SIEM
    // queries that pivot on `batchManifestId` keep working during an
    // audit-rail outage.
    await safeAuditEmit(
      deps.audit,
      null,
      {
        tenantId: tenantSlug,
        eventType: 'broadcast_failed_to_dispatch',
        actorUserId: 'system',
        summary: `Batch ${manifest.batchIndex} of broadcast ${input.broadcastContent.broadcastId} failed at ${gatewayStage}`,
        payload: {
          broadcastId: input.broadcastContent.broadcastId,
          batchManifestId: manifest.id,
          batchIndex: manifest.batchIndex,
          gatewayStage,
          detail: detail.slice(0, 500),
          failedAt: failedAt.toISOString(),
        },
        requestId: input.requestId ?? null,
      },
      {
        broadcastId: input.broadcastContent.broadcastId,
        batchManifestId: manifest.id,
        batchIndex: manifest.batchIndex,
        gatewayStage,
      },
    );
    return err({
      kind: 'GATEWAY_ERROR',
      stage: gatewayStage,
      detail,
    });
  }

  // 6. Persist providerAudienceId + providerBroadcastId on success.
  //    Status remains 'sending' — webhook (Phase 3 T057) flips to
  //    'sent' on `email.sent` event for the last recipient. The
  //    `providerBroadcastId` IS the routing key for the webhook
  //    (`BatchManifestsPort.findBatchByProviderBroadcastIdBypassRls`).
  const persistAudience = await deps.batchManifests.updateStatus(
    tenantSlug,
    manifest.id,
    {
      status: 'sending',
      providerAudienceId,
      providerBroadcastId: resendBroadcastId,
    },
  );
  if (!persistAudience.ok) {
    // Provider IDs lost — log via audit so on-call can backfill from
    // Resend dashboard. The send already happened externally; the
    // webhook will NOT be able to route events back to this batch
    // until ops manually patches the row.
    // Phase 3F.11.1 (C4 — Round 2 fix): wrap audit emit in try/catch.
    // Without the wrap, a DB-down audit-port throw on the success
    // path propagates to the worker pool and synthesises `failed`
    // outcomes even though Resend already delivered — the F-7 failure
    // path wrap (lines 273-298) had this protection but the success
    // path did not. Mirror that pattern exactly.
    // simplifier H2 + H1 Round 2: extraContext preserves per-site
    // forensic fields for SIEM pivot during audit-rail outage.
    await safeAuditEmit(
      deps.audit,
      null,
      {
        tenantId: tenantSlug,
        eventType: 'broadcast_resend_resource_missing',
        actorUserId: 'system',
        summary: `Batch ${manifest.batchIndex} dispatched to Resend but provider id persist failed`,
        payload: {
          broadcastId: input.broadcastContent.broadcastId,
          batchManifestId: manifest.id,
          batchIndex: manifest.batchIndex,
          providerAudienceId,
          resendBroadcastId,
          persistError: persistAudience.error.kind,
        },
        requestId: input.requestId ?? null,
      },
      {
        broadcastId: input.broadcastContent.broadcastId,
        batchManifestId: manifest.id,
        batchIndex: manifest.batchIndex,
        providerAudienceId,
        resendBroadcastId,
      },
    );
  }

  // 7. Success audit — emits `broadcast_send_started` per-batch with
  //    batchIndex in payload (matches F7 MVP webhook update path that
  //    expects this event type to flag dispatch ACK).
  // Phase 3F.11.1 (C4 — Round 2 fix): same wrap rationale as above.
  // Resend already accepted the send; the use case MUST return ok even
  // if this final audit emit throws. Without the wrap, batch-dispatcher's
  // worker catches the throw and synthesises `failed` → ops dashboards
  // misreport the dispatch state.
  // simplifier H2 + H1 Round 2: extraContext preserves per-site forensic
  // fields. Resend already accepted the send; audit failure MUST NOT
  // propagate (would synthesise `failed` + misreport dispatch).
  await safeAuditEmit(
    deps.audit,
    null,
    {
      tenantId: tenantSlug,
      eventType: 'broadcast_send_started',
      actorUserId: 'system',
      summary: `Batch ${manifest.batchIndex} of broadcast ${input.broadcastContent.broadcastId} dispatched to Resend (${manifest.recipientCount} recipients)`,
      payload: {
        broadcastId: input.broadcastContent.broadcastId,
        batchManifestId: manifest.id,
        batchIndex: manifest.batchIndex,
        providerAudienceId,
        resendBroadcastId,
        recipientCount: manifest.recipientCount,
        idempotencyKey,
        dispatchedAt: dispatchedAt.toISOString(),
      },
      requestId: input.requestId ?? null,
    },
    {
      broadcastId: input.broadcastContent.broadcastId,
      batchManifestId: manifest.id,
      batchIndex: manifest.batchIndex,
      providerAudienceId,
      resendBroadcastId,
    },
  );

  return ok({
    providerAudienceId,
    recipientCount: manifest.recipientCount,
    batchIndex: manifest.batchIndex,
  });
}
