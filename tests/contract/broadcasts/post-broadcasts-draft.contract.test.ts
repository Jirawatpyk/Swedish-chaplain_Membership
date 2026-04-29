/**
 * T036 — Contract test: POST/PUT /api/broadcasts/draft.
 *
 * Spec authority: specs/010-email-broadcast/contracts/broadcasts-api.md § 1.1.
 *
 * Verifies:
 *   - Zod input schema validation on body
 *   - 201 / 200 response envelope shapes (create vs update)
 *   - Error code surface
 *
 * Turns GREEN: T073 (POST handler) + T074 (PUT handler) + T075 (DELETE
 * handler) + T068 (save-draft.ts use-case) all land.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const routePath = resolve(
  __dirname,
  '../../../src/app/api/broadcasts/draft/route.ts',
);
const useCasePath = resolve(
  __dirname,
  '../../../src/modules/broadcasts/application/use-cases/save-draft.ts',
);

describe('POST/PUT /api/broadcasts/draft — RED contract skeleton (T036 — turns GREEN at T073 + T074 + T068)', () => {
  it('route handler exists at app/api/broadcasts/draft/route.ts', async () => {
    await expect(access(routePath)).resolves.toBeUndefined();
  });

  it('save-draft use-case exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // POST /api/broadcasts/draft (create)
  it.todo('POST 201: returns { broadcastId, status: "draft", createdAt } envelope');
  it.todo('POST 400 invalid_input: zod validation fails on missing subject');
  it.todo('POST 400 invalid_input: subject > 200 chars rejected');
  it.todo('POST 400 invalid_input: body > 200 KB rejected');
  it.todo('POST 401: unauthenticated request rejected');
  it.todo('POST 403: member role required (admin can use proxy-submit instead)');
  it.todo('POST 503: FEATURE_F7_BROADCASTS=false returns feature_disabled');
  it.todo('POST 429: rate limit (60 saves / 5min) returns retry_after header');

  // PUT /api/broadcasts/draft (update)
  it.todo('PUT 200: returns { broadcastId, status: "draft", updatedAt } envelope');
  it.todo('PUT 404: broadcastId not found in tenant returns broadcast_not_found');
  it.todo('PUT 409: broadcast already submitted returns broadcast_immutable_after_submit');
  it.todo('PUT 403: cross-member edit attempt → broadcast_cross_member_probe (404 returned per FR-037)');

  // DELETE /api/broadcasts/draft/[id]
  it.todo('DELETE 204: removes draft row (no audit — drafts are scratch space)');
  it.todo('DELETE 409: cannot delete non-draft broadcast (use cancel instead)');

  // Kill-switch behaviour
  it.todo('kill-switch flipped mid-flight: DRAFT routes return 503 immediately');

  // Constitution Principle I
  it.todo('cross-tenant probe (broadcastId from other tenant) → 404 + broadcast_cross_tenant_probe audit');
});
