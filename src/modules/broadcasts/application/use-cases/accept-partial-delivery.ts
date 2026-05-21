/**
 * T048 (F7.1a US1) — `acceptPartialDelivery` Application use case.
 *
 * Admin action: terminate a `partially_sent` broadcast at its
 * current dispatch state (some batches succeeded, some failed past
 * retry budget). FR-008c: persists `partial_delivery_accepted_at` +
 * `..._by_user_id` and transitions the broadcast to the TERMINAL
 * `partial_delivery_accepted` state.
 *
 * Once accepted the broadcast cannot be retried (terminal state — the
 * Domain state transition matrix in `broadcast-status-transitions.ts`
 * has zero outbound edges from `partial_delivery_accepted`).
 *
 * Contract test: T034 accept-partial-delivery.test.ts.
 * Contract spec: specs/014-email-broadcast-advance/contracts/batch-dispatch.md § 1.4.
 *
 * No advisory lock needed — the underlying SQL is `UPDATE ... WHERE
 * status = 'partially_sent'`, so a concurrent admin click serialises
 * via the DB row-lock and one of the two requests gets
 * INVALID_STATE_TRANSITION (`0 rows updated`).
 *
 * Pure orchestration — no framework imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import { emitCrossTenantProbe } from './_emit-cross-tenant-probe';
import { safeAuditEmit } from './_safe-audit-emit';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsRetryRepo } from '../ports/broadcasts-retry-repo';
import type { ClockPort } from '../ports/clock-port';

export const MAX_REASON_LENGTH = 500 as const;

export type AcceptPartialDeliveryError =
  | { readonly kind: 'BROADCAST_NOT_FOUND'; readonly broadcastId: BroadcastId }
  | {
      readonly kind: 'INVALID_STATE_TRANSITION';
      readonly currentStatus: string;
      readonly expected: 'partially_sent';
    }
  | {
      readonly kind: 'invalid_input.reason_too_long';
      readonly length: number;
      readonly maxAllowed: typeof MAX_REASON_LENGTH;
    }
  | { readonly kind: 'accept_partial_delivery.server_error'; readonly message: string };

export interface AcceptPartialDeliveryDeps {
  readonly broadcasts: BroadcastsRetryRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

export interface AcceptPartialDeliveryInput {
  readonly tenantId: TenantContext;
  readonly broadcastId: BroadcastId;
  readonly actorUserId: string;
  /** Optional admin-supplied reason, persisted to audit payload. */
  readonly reason?: string;
  readonly requestId?: string | null;
}

export interface AcceptPartialDeliveryOutput {
  readonly acceptedAt: Date;
}

export async function acceptPartialDelivery(
  deps: AcceptPartialDeliveryDeps,
  input: AcceptPartialDeliveryInput,
): Promise<Result<AcceptPartialDeliveryOutput, AcceptPartialDeliveryError>> {
  // 1. Input validation (reason length).
  if (input.reason !== undefined && input.reason.length > MAX_REASON_LENGTH) {
    return err({
      kind: 'invalid_input.reason_too_long',
      length: input.reason.length,
      maxAllowed: MAX_REASON_LENGTH,
    });
  }

  const tenantSlug = input.tenantId.slug;

  // 2. Pre-validate state via a cheap read. The persistence call below
  //    has its own `WHERE status = 'partially_sent'` guard so this is
  //    defence-in-depth (and lets us surface a cleaner error code on
  //    obvious bad input — admin clicked accept on a `draft` row).
  const snapshot = await deps.broadcasts.findById(
    tenantSlug,
    input.broadcastId,
  );
  if (snapshot === null) {
    // Phase 3F.1 (F-01 fix) + simplifier H1 migration 2026-05-21: emit
    // cross-tenant probe audit BEFORE returning BROADCAST_NOT_FOUND via
    // the canonical `emitCrossTenantProbe` helper. Constitution Principle
    // I sub-clause 4 — every cross-tenant probe leaves a forensic trail.
    // Helper wraps `safeAuditEmit` which auto-increments
    // `broadcasts_audit_emit_failed_total` on transient audit-port
    // failures (SRE alert per docs/observability.md § 22.2). Best-effort
    // post-commit emit (no tx — the findById was unbound).
    await emitCrossTenantProbe({
      audit: deps.audit,
      tenantId: tenantSlug,
      actorUserId: input.actorUserId,
      requestId: input.requestId ?? null,
      surface: {
        kind: 'broadcast',
        broadcastId: input.broadcastId,
        useCase: 'accept-partial-delivery',
      },
    });
    return err({ kind: 'BROADCAST_NOT_FOUND', broadcastId: input.broadcastId });
  }
  if (snapshot.status !== 'partially_sent') {
    return err({
      kind: 'INVALID_STATE_TRANSITION',
      currentStatus: snapshot.status,
      expected: 'partially_sent',
    });
  }

  // 3. Atomic state transition + accepted_at/by_user_id persistence.
  const now = deps.clock.now();
  const transitionResult = await deps.broadcasts.acceptPartial(
    tenantSlug,
    input.broadcastId,
    {
      acceptedAt: now,
      acceptedByUserId: input.actorUserId,
    },
  );

  if (!transitionResult.ok) {
    if (transitionResult.error.kind === 'INVALID_STATE_TRANSITION') {
      return err({
        kind: 'INVALID_STATE_TRANSITION',
        currentStatus: snapshot.status,
        expected: 'partially_sent',
      });
    }
    if (transitionResult.error.kind === 'not_found') {
      return err({
        kind: 'BROADCAST_NOT_FOUND',
        broadcastId: input.broadcastId,
      });
    }
    return err({
      kind: 'accept_partial_delivery.server_error',
      message: transitionResult.error.detail,
    });
  }

  // 4. Emit `broadcast_partial_delivery_accepted` audit event with
  //    the admin's optional reason payload.
  //
  // H2 Round 2 fix 2026-05-21 (silent-failure-hunter H-2 closure):
  // wrapped in `safeAuditEmit` to preserve the post-commit best-effort
  // contract. Pre-fix the raw `audit.emit(null, ...)` would propagate
  // a transient audit-port failure as 5xx to the admin while the
  // broadcast row IS in the immutable terminal `partial_delivery_accepted`
  // state — admin retry would get `INVALID_STATE_TRANSITION` instead
  // of the expected confirmation. Best-effort + counter-emit aligns
  // with the established pattern across F7.1a post-commit emits.
  await safeAuditEmit(deps.audit, null, {
    tenantId: tenantSlug,
    eventType: 'broadcast_partial_delivery_accepted',
    actorUserId: input.actorUserId,
    summary: `Admin ${input.actorUserId} accepted partial delivery on broadcast ${input.broadcastId}`,
    payload: {
      broadcastId: input.broadcastId,
      acceptedAt: transitionResult.value.acceptedAt.toISOString(),
      reason: input.reason ?? null,
    },
    requestId: input.requestId ?? null,
  });

  return ok({ acceptedAt: transitionResult.value.acceptedAt });
}
