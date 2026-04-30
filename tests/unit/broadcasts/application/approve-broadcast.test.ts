/**
 * T096 — Unit tests for `approve-broadcast.ts` Application use-case.
 *
 * Two paths:
 *   - mode='send_now':  status flip to 'approved' + scheduledFor=now()
 *                       + outbox enqueue 'broadcast_dispatch_pending'
 *                       (cron picks up + flips to 'sending')
 *   - mode='schedule':  status flip to 'approved' + scheduledFor=<future>
 *                       (cron picks up at scheduledFor)
 *
 * Audit `broadcast_approved` with actor + decision + scheduledFor.
 * Member notification enqueued via outbox 'broadcast_approved_notification'.
 *
 * Turns GREEN: T100 approve-broadcast.ts.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/approve-broadcast.ts',
);

describe('approve-broadcast — RED skeleton (T096 → T100)', () => {
  it('use-case module exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // State machine
  it.todo('happy send_now: lockForUpdate(submitted) → applyTransition(approved, scheduledFor=now)');
  it.todo('happy schedule: applyTransition(approved, scheduledFor=<future>)');
  it.todo('rejects when status=draft → broadcast_invalid_state_transition');
  it.todo('rejects when status=approved (already approved) → broadcast_invalid_state_transition');
  it.todo('rejects when status=sending/sent → broadcast_invalid_state_transition');
  it.todo('rejects when status=cancelled/rejected/failed_to_dispatch → broadcast_invalid_state_transition');
  it.todo('rejects when broadcast not found → broadcast_not_found');

  // Concurrency
  it.todo('applyTransition throws BroadcastConcurrentMutationError → returns broadcast_concurrent_action_blocked');

  // Side effects (atomicity)
  it.todo('happy send_now: outbox enqueue broadcast_dispatch_pending atomic in tx');
  it.todo('happy send_now: outbox enqueue broadcast_approved_notification atomic in tx');
  it.todo('happy schedule: NO broadcast_dispatch_pending enqueued (cron polls scheduledFor)');
  it.todo('happy schedule: still emits broadcast_approved_notification');

  // Audit
  it.todo('audit broadcast_approved emitted with actorUserId + decision + scheduledFor + broadcastId');
  it.todo('rejection path emits NO broadcast_approved audit (only state-transition error)');

  // Schedule validation
  it.todo('rejects scheduledFor < now+5min → broadcast_invalid_state_transition (server defence)');

  // Server error catch-all
  it.todo('repo throw inside withTx → approve.server_error');
  it.todo('repo throw with non-Error value → approve.server_error with "unknown error"');
});
