/**
 * T037 — Contract test: POST /api/broadcasts/submit.
 *
 * Spec authority: specs/010-email-broadcast/contracts/broadcasts-api.md § 1.2.
 *
 * Covers all 11 FR-002 precondition error codes (a–k) including
 * `broadcast_member_halted_pending_review` (R3-NEW-1).
 *
 * Turns GREEN: T076 (POST submit handler) + T069 (submit-broadcast.ts
 * use-case) all land.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const routePath = resolve(
  __dirname,
  '../../../src/app/api/broadcasts/submit/route.ts',
);
const useCasePath = resolve(
  __dirname,
  '../../../src/modules/broadcasts/application/use-cases/submit-broadcast.ts',
);

describe('POST /api/broadcasts/submit — RED contract skeleton (T037 — turns GREEN at T076 + T069)', () => {
  it('route handler exists at app/api/broadcasts/submit/route.ts', async () => {
    await expect(access(routePath)).resolves.toBeUndefined();
  });

  it('submit-broadcast use-case exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // Happy path
  it.todo('POST 200: returns { broadcastId, submittedAt, estimatedRecipientCount, reservedQuotaSlot: true, reviewSlaTargetHours: 48 }');

  // 11 FR-002 precondition error codes (a–k) — 100% branch coverage required
  it.todo('FR-002(a): plan does not include broadcasts → 422 broadcast_not_in_plan');
  it.todo('FR-002(b): quota exhausted → 422 broadcast_quota_blocked with details {used, reserved, cap}');
  it.todo('FR-002(c): subject > 200 chars → 422 broadcast_subject_too_long');
  it.todo('FR-002(d): body > 200 KB → 422 broadcast_body_too_large');
  it.todo('FR-002(e): unsafe HTML detected after sanitisation → 422 broadcast_body_unsafe_html');
  it.todo('FR-002(f): segment empty (0 recipients) → 422 broadcast_empty_segment_blocked');
  it.todo('FR-002(g): audience > 5,000 → 422 broadcast_audience_too_large');
  it.todo('FR-002(h): custom recipients unknown → 422 broadcast_custom_recipient_unknown {unknownEmails: [...]}');
  it.todo('FR-002(i): member missing primary contact email → 422 broadcast_member_missing_primary_contact_email');
  it.todo('FR-002(j): reply-to derivation fails → 422 broadcast_member_missing_primary_contact_email');
  it.todo('FR-002(k): member halted (R3-NEW-1) → 422 broadcast_member_halted_pending_review');

  // Rate limit (FR-002d)
  it.todo('rate limit (10/24h) → 429 broadcast_rate_limit_exceeded with retry_after header');

  // Authz
  it.todo('401 unauthenticated request');
  it.todo('403 manager-role attempt (member or admin proxy only)');

  // Kill-switch
  it.todo('503 FEATURE_F7_BROADCASTS=false');

  // Cross-tenant
  it.todo('cross-tenant probe → 404 + broadcast_cross_tenant_probe audit');

  // Reservation invariant
  it.todo('successful submit increments reserved count (visible via /api/broadcasts/quota)');
  it.todo('rejected submit does NOT change reserved count (atomicity)');

  // Audit emission
  it.todo('successful submit emits broadcast_submitted audit with actor + segment + estimated_count');

  // Admin proxy (Q12)
  it.todo('admin proxy: POST /api/admin/broadcasts/proxy-submit emits broadcast_submitted with actor_role=admin_proxy');
});
