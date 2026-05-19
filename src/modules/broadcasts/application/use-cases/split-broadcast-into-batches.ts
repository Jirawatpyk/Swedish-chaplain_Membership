/**
 * T044 (F7.1a US1) — `splitBroadcastIntoBatches` Application use case.
 *
 * Splits a resolved-recipient broadcast into N batch_manifest rows
 * (one per Resend audience), each ≤10,000 recipients (FR-001 / FR-002 /
 * data-model § 4). Idempotent via per-batch idempotency keys —
 * re-invocation with the same `broadcastId` returns
 * `BATCH_ALREADY_DISPATCHED` (BATCH_INSERT collision on unique index
 * `broadcasts_batch_manifests_idempotency_key_uniq` from migration 0163).
 *
 * **No broadcast aggregate load**: the cron handler (Phase 3 T055) is
 * responsible for resolving the broadcast + recipient count BEFORE
 * invoking this use case (so failed recipient-resolution returns its
 * own error code path; this use case stays focused on batch math +
 * persistence + audit). Tenant isolation is enforced at the port layer
 * via `runInTenant()` in the cron handler — the contract here trusts
 * that `input.tenantId` matches the broadcast's tenant.
 *
 * Contract test: tests/contract/broadcasts/batch-dispatch.test.ts (T032).
 * Spec contract: specs/014-email-broadcast-advance/contracts/batch-dispatch.md § 1.1.
 *
 * Pure orchestration — no framework imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import {
  computeBatchRanges,
  RESEND_PER_AUDIENCE_CAP,
} from '../../domain/value-objects/batch-boundary';
import type { AuditPort } from '../ports/audit-port';
import type {
  BatchManifestsPort,
  NewBatchManifestInput,
} from '../ports/batch-manifests-port';
import type { ClockPort } from '../ports/clock-port';

/**
 * Maximum recipient count enforced by the spec (FR-001). The zod schema
 * at the cron handler (Phase 3 T055) rejects > 50,000 BEFORE this use
 * case is called, but the defensive check here is cheap and catches
 * caller-bug regressions.
 */
const MAX_RECIPIENT_COUNT = 50_000;

export type SplitBroadcastIntoBatchesError =
  | {
      readonly kind: 'BATCH_OVER_RECIPIENT_CAP';
      readonly resolvedRecipientCount: number;
      readonly maxAllowed: number;
    }
  | {
      readonly kind: 'BATCH_ALREADY_DISPATCHED';
      readonly broadcastId: BroadcastId;
      readonly detail: 'idempotency_key_collision';
    }
  | {
      readonly kind: 'split_broadcast.server_error';
      readonly message: string;
    };

export interface SplitBroadcastIntoBatchesDeps {
  readonly batchManifests: BatchManifestsPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

export interface SplitBroadcastIntoBatchesInput {
  readonly tenantId: TenantContext;
  readonly broadcastId: BroadcastId;
  /**
   * Total deduplicated, suppression-filtered recipient count resolved
   * by the cron handler before this use case is invoked.
   */
  readonly resolvedRecipientCount: number;
  /** Optional retry attempt — defaults to 0 (initial split). */
  readonly attempt?: number;
  readonly requestId?: string | null;
}

export interface SplitBroadcastIntoBatchesOutput {
  readonly batchManifestIds: readonly string[];
  readonly batchCount: number;
}

/**
 * Build the deterministic idempotency key for batch `i` on attempt `a`
 * per plan.md § VIII (Reliability) + the `BatchManifestsPort.NewBatchManifestInput`
 * port docs. Format: `broadcast-{uuid}-batch-{i}-attempt-{a}`.
 * On auto-retry path (T056) key is rotated via `-autoretry-{n}` suffix
 * to defeat Resend's deduper (Phase 3F.1 F-04 fix).
 */
function makeIdempotencyKey(
  broadcastId: BroadcastId,
  batchIndex: number,
  attempt: number,
): string {
  return `broadcast-${broadcastId}-batch-${batchIndex}-attempt-${attempt}`;
}

export async function splitBroadcastIntoBatches(
  deps: SplitBroadcastIntoBatchesDeps,
  input: SplitBroadcastIntoBatchesInput,
): Promise<Result<SplitBroadcastIntoBatchesOutput, SplitBroadcastIntoBatchesError>> {
  if (input.resolvedRecipientCount > MAX_RECIPIENT_COUNT) {
    return err({
      kind: 'BATCH_OVER_RECIPIENT_CAP',
      resolvedRecipientCount: input.resolvedRecipientCount,
      maxAllowed: MAX_RECIPIENT_COUNT,
    });
  }

  const attempt = input.attempt ?? 0;
  const ranges = computeBatchRanges(
    input.resolvedRecipientCount,
    RESEND_PER_AUDIENCE_CAP,
  );

  if (ranges.length === 0) {
    // resolvedRecipientCount === 0 — spec zod min(1) prevents this,
    // but the defensive check keeps the use case total.
    return err({
      kind: 'split_broadcast.server_error',
      message: 'resolvedRecipientCount must be >= 1',
    });
  }

  const inserts: NewBatchManifestInput[] = ranges.map((r) => ({
    broadcastId: input.broadcastId,
    batchIndex: r.batchIndex,
    recipientCount: r.recipientCount,
    recipientRangeStart: r.recipientRangeStart,
    recipientRangeEnd: r.recipientRangeEnd,
    idempotencyKey: makeIdempotencyKey(
      input.broadcastId,
      r.batchIndex,
      attempt,
    ),
  }));

  const insertResult = await deps.batchManifests.bulkInsert(
    input.tenantId.slug,
    inserts,
  );

  if (!insertResult.ok) {
    if (
      insertResult.error.kind === 'duplicate_idempotency_key' ||
      insertResult.error.kind === 'duplicate_batch_index'
    ) {
      return err({
        kind: 'BATCH_ALREADY_DISPATCHED',
        broadcastId: input.broadcastId,
        detail: 'idempotency_key_collision',
      });
    }
    return err({
      kind: 'split_broadcast.server_error',
      message:
        insertResult.error.kind === 'storage_error'
          ? insertResult.error.detail
          : `bulkInsert returned ${insertResult.error.kind}`,
    });
  }

  const now = deps.clock.now();
  // Phase 3F.4 (F-7 silent-fail fix) — wrap audit emit in try/catch.
  // The batch_manifest rows ARE the source of truth; an audit-port
  // throw post-commit shouldn't fail the use case (the rows are
  // committed, and dispatch-batches cron will pick them up next tick).
  try {
    await deps.audit.emit(null, {
      tenantId: input.tenantId.slug,
      eventType: 'broadcast_dispatched_in_batches',
      actorUserId: 'system',
      summary: `Split broadcast ${input.broadcastId} into ${inserts.length} batches (${input.resolvedRecipientCount} recipients)`,
      payload: {
        broadcastId: input.broadcastId,
        batchCount: inserts.length,
        resolvedRecipientCount: input.resolvedRecipientCount,
        attempt,
        dispatchedInBatchesAt: now.toISOString(),
        perBatchRanges: ranges.map((r) => ({
          batchIndex: r.batchIndex,
          rangeStart: r.recipientRangeStart,
          rangeEnd: r.recipientRangeEnd,
          recipientCount: r.recipientCount,
        })),
      },
      requestId: input.requestId ?? null,
    });
  } catch (auditErr) {
    logger.error(
      {
        err: auditErr instanceof Error ? auditErr.message : String(auditErr),
        tenantId: input.tenantId.slug,
        broadcastId: input.broadcastId,
        batchCount: inserts.length,
      },
      'broadcasts.split.dispatched_in_batches_audit_emit_failed',
    );
  }

  return ok({
    batchManifestIds: insertResult.value.map((b) => b.id),
    batchCount: inserts.length,
  });
}
