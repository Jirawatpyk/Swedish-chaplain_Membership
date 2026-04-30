/**
 * T093 — Contract test: POST /api/admin/broadcasts/[id]/approve.
 *
 * Spec authority: contracts/broadcasts-api.md § 2.2.
 *
 * Two body variants:
 *   - { decision: 'send_now' }                 → 200, status='approved' (cron flips to 'sending' within 60s)
 *   - { decision: 'schedule', scheduledFor }   → 200, status='approved' with scheduledFor set
 *
 * Error responses:
 *   - 403 manager role attempt
 *   - 409 broadcast_invalid_state_transition (broadcast not in 'submitted')
 *   - 409 broadcast_concurrent_action_blocked (another admin acted first)
 *   - 422 invalid scheduledFor (< now+5min)
 *
 * Turns GREEN: T100 approve-broadcast.ts + T109 POST handler.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const routePath = resolve(
  __dirname,
  '../../../src/app/api/admin/broadcasts/[id]/approve/route.ts',
);
const useCasePath = resolve(
  __dirname,
  '../../../src/modules/broadcasts/application/use-cases/approve-broadcast.ts',
);

describe('POST /api/admin/broadcasts/[id]/approve — RED contract skeleton (T093 → T100 + T109)', () => {
  it('route handler exists at app/api/admin/broadcasts/[id]/approve/route.ts', async () => {
    await expect(access(routePath)).resolves.toBeUndefined();
  });

  it('approve-broadcast use-case exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // Happy paths
  it.todo('POST 200 send_now: returns { broadcastId, status: "approved", approvedAt, scheduledFor: now }');
  it.todo('POST 200 schedule: returns { broadcastId, status: "approved", approvedAt, scheduledFor: <future> }');

  // Body validation
  it.todo('POST 400: invalid_body when decision missing');
  it.todo('POST 422: scheduledFor < now+5min rejected');

  // Authz
  it.todo('POST 401: unauthenticated request');
  it.todo('POST 403: member role attempting to approve');
  it.todo('POST 403: manager role attempting to approve');

  // State machine
  it.todo('POST 409: broadcast_invalid_state_transition when status=draft');
  it.todo('POST 409: broadcast_invalid_state_transition when status=approved (already approved)');
  it.todo('POST 409: broadcast_concurrent_action_blocked when another admin acts first');

  // Cross-tenant
  it.todo('POST 404: broadcast from another tenant returns broadcast_not_found');

  // Side effects
  it.todo('successful approve emits broadcast_approved audit with actor + decision + scheduledFor');
  it.todo('successful approve enqueues notifications_outbox row broadcast_dispatch_pending');
  it.todo('successful approve enqueues member notification (broadcast_approved_notification)');

  // Kill-switch
  it.todo('POST 503: FEATURE_F7_BROADCASTS=false');
});
