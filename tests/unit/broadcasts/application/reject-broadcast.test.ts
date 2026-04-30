/**
 * T097 — Unit tests for `reject-broadcast.ts` Application use-case.
 *
 * FR-012: rejection requires non-empty reason; verbatim reason → member
 * email; sha256 hash → audit log.
 *
 * Turns GREEN: T101 reject-broadcast.ts.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/reject-broadcast.ts',
);

describe('reject-broadcast — RED skeleton (T097 → T101)', () => {
  it('use-case module exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // State machine
  it.todo('happy: lockForUpdate(submitted) → applyTransition(rejected, rejectedAt, rejectionReason)');
  it.todo('rejects when status=draft → broadcast_invalid_state_transition');
  it.todo('rejects when status=approved → broadcast_invalid_state_transition');
  it.todo('rejects when status=cancelled/sent/sending/rejected/failed → broadcast_invalid_state_transition');
  it.todo('rejects when broadcast not found → broadcast_not_found');

  // Reason validation
  it.todo('rejects empty rejectionReason → broadcast_rejection_reason_required');
  it.todo('rejects whitespace-only rejectionReason → broadcast_rejection_reason_required');
  it.todo('rejects rejectionReason > 2000 chars → broadcast_rejection_reason_too_long');
  it.todo('accepts rejectionReason at exactly 2000 chars boundary');

  // Audit FR-012 — sha256 hash, NOT raw reason
  it.todo('audit broadcast_rejected payload contains rejection_reason_hash (sha256) NOT rejectionReason');
  it.todo('rejection_reason_hash is deterministic — same reason produces same hash');

  // Side effects
  it.todo('member notification enqueued with VERBATIM rejection reason in context_data');
  it.todo('reservation released (status=rejected → derived counter excludes from reserved)');

  // Concurrency
  it.todo('applyTransition throws BroadcastConcurrentMutationError → broadcast_concurrent_action_blocked');

  // Server error catch-all
  it.todo('repo throw inside withTx → reject.server_error');
});
