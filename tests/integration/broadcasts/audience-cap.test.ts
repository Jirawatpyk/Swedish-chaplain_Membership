/**
 * T049 — Integration test for FR-016a / Q7 — 5,000 recipient hard cap.
 *
 * Seed live Neon with > 5,000 in-segment recipients (e.g., 5,001 members
 * on tier "all_members"). Submit broadcast → verify:
 *   - 422 response with broadcast_audience_too_large code
 *   - audit row emitted (`broadcast_audience_too_large`)
 *   - NO broadcast row inserted (no reservation leak)
 *
 * Tests the cap at BOTH submission boundary AND resolver boundary
 * (defence-in-depth per FR-016a). The estimated_recipient_count CHECK
 * constraint from migration 0064 is the DB-level guarantee.
 *
 * Turns GREEN: T066 (resolve-segment-recipients.ts) + T069 (submit-broadcast.ts)
 * + T076 (POST /api/broadcasts/submit route) land.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const submitUseCasePath = resolve(
  __dirname,
  '../../../src/modules/broadcasts/application/use-cases/submit-broadcast.ts',
);

describe('audience-cap integration — RED skeleton (T049 — turns GREEN at T066 + T069 + T076)', () => {
  it('submit-broadcast use-case exists', async () => {
    await expect(access(submitUseCasePath)).resolves.toBeUndefined();
  });

  // FR-016a / Q7 — 5,000 recipient hard cap
  it.todo('seed 5,001 members on all_members segment → submit returns 422 broadcast_audience_too_large');
  it.todo('seed 5,000 members exactly → submit succeeds (boundary)');
  it.todo('seed 4,999 members → submit succeeds');

  // Audit emission on rejection
  it.todo('rejection emits broadcast_audience_too_large audit row with member_id + segment_type + count');

  // No reservation leak on rejection
  it.todo('rejected submission does NOT insert broadcasts row (DB count unchanged)');
  it.todo('rejected submission does NOT increment members reserved quota count');

  // CHECK constraint defence-in-depth
  it.todo('attempting raw INSERT with estimated_recipient_count=5001 fails CHECK constraint');

  // Cleanup
  it.todo('afterAll deletes 5k+ seed members from test tenant');
});
