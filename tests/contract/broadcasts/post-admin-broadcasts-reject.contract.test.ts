/**
 * T094 — Contract test: POST /api/admin/broadcasts/[id]/reject.
 *
 * Spec authority: contracts/broadcasts-api.md § 2.3 + FR-012.
 *
 * Required: rejectionReason (≥1 non-whitespace char, ≤2000 chars).
 *
 * Audit row stores sha256(reason); raw reason goes verbatim to member email.
 *
 * Turns GREEN: T101 reject-broadcast.ts + T110 POST handler.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const routePath = resolve(
  __dirname,
  '../../../src/app/api/admin/broadcasts/[id]/reject/route.ts',
);
const useCasePath = resolve(
  __dirname,
  '../../../src/modules/broadcasts/application/use-cases/reject-broadcast.ts',
);

describe('POST /api/admin/broadcasts/[id]/reject — RED contract skeleton (T094 → T101 + T110)', () => {
  it('route handler exists', async () => {
    await expect(access(routePath)).resolves.toBeUndefined();
  });

  it('reject-broadcast use-case exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // Happy path
  it.todo('POST 200: { broadcastId, status: "rejected", rejectedAt, reservationReleased: true }');

  // Reason validation
  it.todo('POST 400: invalid_body when rejectionReason missing');
  it.todo('POST 400: invalid_body when rejectionReason is empty string');
  it.todo('POST 400: invalid_body when rejectionReason is whitespace-only');
  it.todo('POST 400: invalid_body when rejectionReason > 2000 chars');

  // Authz
  it.todo('POST 401: unauthenticated');
  it.todo('POST 403: member role attempting to reject');
  it.todo('POST 403: manager role attempting to reject');

  // State machine
  it.todo('POST 409: broadcast_invalid_state_transition when status != submitted');
  it.todo('POST 409: broadcast_concurrent_action_blocked race');

  // Audit + email
  it.todo('successful reject emits broadcast_rejected audit with rejection_reason_hash (sha256), NOT raw reason');
  it.todo('successful reject enqueues member notification with verbatim reason');
  it.todo('successful reject releases reserved quota slot (member can submit a new broadcast)');

  // Cross-tenant
  it.todo('POST 404: broadcast from another tenant returns broadcast_not_found');
});
