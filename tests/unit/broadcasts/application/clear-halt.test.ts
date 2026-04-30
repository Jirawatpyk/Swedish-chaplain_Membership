/**
 * Unit tests for `clear-halt.ts` Application use-case (T114).
 *
 * Q14 / R3-NEW-3 — admin clear-halt action when a member's
 * `broadcasts_halted_until_admin_review = true` flag is set.
 *
 * Calls F3 `setMemberHalt(memberId, false)` via `MembersBridge` +
 * emits `broadcast_member_dispatch_resumed` audit event.
 *
 * Manager role denied (admin-only); RBAC at route layer + use-case
 * boundary (defence in depth).
 *
 * Turns GREEN: T114 clear-halt.ts.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/clear-halt.ts',
);

describe('clear-halt — RED skeleton (T114)', () => {
  it('use-case module exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // Happy path
  it.todo('happy: setMemberHalt(memberId, false) called → broadcast_member_dispatch_resumed audit emitted');
  it.todo('audit payload contains memberId + cleared_by_user_id + cleared_at');

  // Member existence
  it.todo('rejects when member not found in tenant → member_not_found');

  // Authz
  it.todo('rejects when actor role is "manager" → forbidden');
  it.todo('admin role allowed');

  // Idempotency
  it.todo('clear-halt on already-not-halted member is idempotent (no error, possibly emits audit anyway)');

  // Server error catch-all
  it.todo('membersBridge.setMemberHalt throws → clear_halt.server_error');
});
