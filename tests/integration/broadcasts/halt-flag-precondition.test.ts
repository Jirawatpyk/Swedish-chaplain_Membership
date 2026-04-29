/**
 * T051 — Integration test for FR-002 precondition `k` (R3-NEW-1).
 *
 * Member with `broadcasts_halted_until_admin_review = true` attempts
 * submit → 422 with `broadcast_member_halted_pending_review` audit
 * code. NO row inserted, NO reservation leak.
 *
 * Q14 SC-005 (b) integration: this gate is the member-side enforcement
 * matching the per-broadcast >5% complaint-rate auto-halt; admin
 * clear-halt via `setMemberHalt(memberId, false)` releases the gate.
 *
 * Turns GREEN: T069 (submit-broadcast.ts) + T076 (POST submit route) +
 * T060 (members-bridge adapter wired with F3's getMembersHaltedInTenant /
 * setMemberHalt — F3 use-cases already exist from Batch C T029).
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const submitUseCasePath = resolve(
  __dirname,
  '../../../src/modules/broadcasts/application/use-cases/submit-broadcast.ts',
);

describe('halt-flag-precondition integration — RED skeleton (T051 — turns GREEN at T069 + T076 + T060)', () => {
  it('submit-broadcast use-case exists', async () => {
    await expect(access(submitUseCasePath)).resolves.toBeUndefined();
  });

  // FR-002 precondition `k` (R3-NEW-1)
  it.todo('seed member with broadcasts_halted_until_admin_review=true → submit returns 422 broadcast_member_halted_pending_review');
  it.todo('rejected submission does NOT insert broadcasts row');
  it.todo('rejected submission does NOT consume reserved quota slot');
  it.todo('audit broadcast_member_halted_pending_review emitted with member_id');

  // Halt clearance flow (Q14 admin action)
  it.todo('halted=true → admin clears via setMemberHalt(memberId, false) → next submit succeeds');
  it.todo('halted=true → manager-role attempts clear → 403 (member_halt.unauthorised)');

  // Self-isolation
  it.todo('halted member can still SELECT own broadcast history (read not blocked)');
  it.todo('halted member portal /portal/broadcasts/new returns banner explaining halt');

  // Cleanup
  it.todo('afterAll resets halt flag + cleans test tenant');
});
