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
    // Phase 3F.1 (F-01 fix) — emit cross-tenant probe audit BEFORE
    // returning BROADCAST_NOT_FOUND. Constitution v1.4.0 Principle I
    // sub-clause 4 — every cross-tenant probe leaves a forensic
    // trail. Pattern mirrors `enforce-tenant-context.ts:60-78`.
    try {
      await deps.audit.emit(null, {
        tenantId: tenantSlug,
        eventType: 'broadcast_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Admin ${input.actorUserId} probed unknown broadcast ${input.broadcastId} (accept-partial path)`,
        payload: {
          broadcastId: input.broadcastId,
          probedBroadcastId: input.broadcastId,
          expectedTenantId: tenantSlug,
          useCase: 'accept-partial-delivery',
        },
        requestId: input.requestId ?? null,
      });
    } catch {
      // best-effort — never 5xx because audit failed
    }
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
  await deps.audit.emit(null, {
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
