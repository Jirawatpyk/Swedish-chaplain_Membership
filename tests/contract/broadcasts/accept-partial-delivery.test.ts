/**
 * T034 — Contract test: `acceptPartialDelivery` use case (US1 / FR-008c).
 *
 * Authored RED 2026-05-19 per Constitution II NON-NEG TDD. Phase 3
 * Cluster B implements at:
 *   src/modules/broadcasts/application/use-cases/accept-partial-delivery.ts
 *
 * Contract spec: specs/014-email-broadcast-advance/contracts/batch-dispatch.md § 1.4
 *
 * Pre-condition: Broadcast must be in `partially_sent` state.
 * Post-condition: state transitions to `partial_delivery_accepted` (TERMINAL).
 *
 * Cases covered:
 *   - Accept from `partially_sent` → state transitions + audit emit
 *   - Optional reason ≤500 chars persisted to broadcast row
 *   - Reason >500 chars → input validation rejection
 *   - Accept from any other state → INVALID_STATE_TRANSITION
 *   - Once accepted, subsequent retry attempt → INVALID_STATE_TRANSITION
 *     (terminal state — handled by retry-failed-batches contract T033,
 *     but cross-verified here by checking the broadcast row update
 *     surfaces partial_delivery_accepted_at + by_user_id).
 */
import { describe, expect, it } from 'vitest';

import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { acceptPartialDelivery } from '@/modules/broadcasts/application/use-cases/accept-partial-delivery';

/**
 * Phase 3 Cluster B GREEN (2026-05-19) — T048 use case landed at
 *   src/modules/broadcasts/application/use-cases/accept-partial-delivery.ts
 *
 * Earlier RED variant imported via `new Function('m','return import(m)')`
 * to bypass Vite's static alias resolution. Static import now.
 */
async function importAcceptUseCase(): Promise<{
  acceptPartialDelivery: (
    deps: unknown,
    input: unknown,
  ) => ReturnType<typeof acceptPartialDelivery>;
}> {
  return {
    acceptPartialDelivery: (deps, input) =>
      acceptPartialDelivery(deps as never, input as never),
  };
}

const tenant = asTenantContext('test-tenant');
const broadcastId = asBroadcastId('33333333-3333-3333-3333-333333333333');
const actorUserId = 'admin-user-2';

function makeStubDeps(initialStatus: 'partially_sent' | 'sent' | 'draft'): {
  emits: Array<{ eventType: string; payload?: unknown }>;
  finalState: () => {
    status: string;
    partialDeliveryAcceptedAt: Date | null;
    partialDeliveryAcceptedByUserId: string | null;
  };
  deps: unknown;
} {
  const emits: Array<{ eventType: string; payload?: unknown }> = [];
  let status = initialStatus as string;
  let partialDeliveryAcceptedAt: Date | null = null;
  let partialDeliveryAcceptedByUserId: string | null = null;

  return {
    emits,
    finalState: () => ({
      status,
      partialDeliveryAcceptedAt,
      partialDeliveryAcceptedByUserId,
    }),
    deps: {
      audit: {
        async emit(_tx: unknown, e: { eventType: string; payload?: unknown }) {
          emits.push(e);
        },
      },
      broadcasts: {
        async findById(_t: unknown, _id: unknown) {
          return { tenantId: 'test-tenant', broadcastId, status };
        },
        async acceptPartial(
          _t: unknown,
          _id: unknown,
          input: { acceptedAt: Date; acceptedByUserId: string },
        ) {
          if (status !== 'partially_sent') {
            return {
              ok: false,
              error: { kind: 'INVALID_STATE_TRANSITION' as const },
            };
          }
          status = 'partial_delivery_accepted';
          partialDeliveryAcceptedAt = input.acceptedAt;
          partialDeliveryAcceptedByUserId = input.acceptedByUserId;
          return { ok: true, value: { acceptedAt: input.acceptedAt } };
        },
      },
      clock: { now: () => new Date('2026-06-15T05:00:00Z') },
    },
  };
}

describe('acceptPartialDelivery contract (T034)', () => {
  it('partially_sent → succeeds; state transitions; audit emitted', async () => {
    const { acceptPartialDelivery } = await importAcceptUseCase();
    const { deps, emits, finalState } = makeStubDeps('partially_sent');

    const result = await acceptPartialDelivery(deps, {
      tenantId: tenant,
      broadcastId,
      actorUserId,
      reason: 'Resend account rate-limit not clearing this week',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const after = finalState();
    expect(after.status).toBe('partial_delivery_accepted');
    expect(after.partialDeliveryAcceptedAt).toEqual(new Date('2026-06-15T05:00:00Z'));
    expect(after.partialDeliveryAcceptedByUserId).toBe(actorUserId);
    const acceptEvent = emits.find((e) => e.eventType === 'broadcast_partial_delivery_accepted');
    expect(acceptEvent).toBeDefined();
  });

  it('partially_sent without reason → succeeds (reason is optional)', async () => {
    const { acceptPartialDelivery } = await importAcceptUseCase();
    const { deps, finalState } = makeStubDeps('partially_sent');

    const result = await acceptPartialDelivery(deps, {
      tenantId: tenant,
      broadcastId,
      actorUserId,
    });

    expect(result.ok).toBe(true);
    expect(finalState().status).toBe('partial_delivery_accepted');
  });

  it('reason >500 chars → input validation rejection', async () => {
    const { acceptPartialDelivery } = await importAcceptUseCase();
    const { deps } = makeStubDeps('partially_sent');

    const result = await acceptPartialDelivery(deps, {
      tenantId: tenant,
      broadcastId,
      actorUserId,
      reason: 'x'.repeat(501),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect((result.error as { kind: string }).kind).toMatch(/invalid_input|reason_too_long/);
  });

  it('from sent (terminal) → INVALID_STATE_TRANSITION', async () => {
    const { acceptPartialDelivery } = await importAcceptUseCase();
    const { deps, finalState } = makeStubDeps('sent');

    const result = await acceptPartialDelivery(deps, {
      tenantId: tenant,
      broadcastId,
      actorUserId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect((result.error as { kind: string }).kind).toBe('INVALID_STATE_TRANSITION');
    // No state mutation on rejection
    expect(finalState().status).toBe('sent');
  });

  it('from draft → INVALID_STATE_TRANSITION', async () => {
    const { acceptPartialDelivery } = await importAcceptUseCase();
    const { deps, finalState } = makeStubDeps('draft');

    const result = await acceptPartialDelivery(deps, {
      tenantId: tenant,
      broadcastId,
      actorUserId,
    });

    expect(result.ok).toBe(false);
    expect(finalState().status).toBe('draft');
  });
});
