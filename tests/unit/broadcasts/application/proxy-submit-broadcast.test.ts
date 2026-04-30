/**
 * T098 — Unit tests for `proxy-submit-broadcast.ts` Application use-case.
 *
 * Q12 admin-on-behalf-of-member submission. Mirrors `submit-broadcast.ts`
 * but with admin actor + bypass quota check.
 *
 * Persisted broadcast row carries:
 *   - requestedByMemberId = <proxied member>
 *   - submittedByUserId   = <admin>
 *   - actorRole           = 'admin_proxy'
 *
 * Audit `broadcast_submitted` with actorRole='admin_proxy' + both ids.
 *
 * Turns GREEN: T102 proxy-submit-broadcast.ts.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/proxy-submit-broadcast.ts',
);

describe('proxy-submit-broadcast — RED skeleton (T098 → T102)', () => {
  it('use-case module exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // Q12 dual-actor
  it.todo('persisted row: requestedByMemberId = proxiedMemberId (NOT admin id)');
  it.todo('persisted row: submittedByUserId = admin.userId');
  it.todo('persisted row: actorRole = "admin_proxy"');
  it.todo('audit broadcast_submitted carries actorRole="admin_proxy" + both ids');

  // Quota bypass (Q12)
  it.todo('admin proxy bypasses quota check even when proxied member at full quota');
  it.todo('admin proxy bypasses quota check when proxied member at over-cap (rare invariant violation)');

  // Halt-state check still applies (R3-NEW-1)
  it.todo('proxied member halted → 422 broadcast_member_halted_pending_review (admin can NOT bypass halt)');

  // Member existence
  it.todo('rejects when proxied member not found → broadcast_member_not_found');

  // Standard FR-002 preconditions still enforced
  it.todo('subject too long → broadcast_subject_too_long');
  it.todo('body unsafe HTML → broadcast_body_unsafe_html');
  it.todo('body too large → broadcast_body_too_large');
  it.todo('reply-to derivation fails (proxied member missing primary contact) → broadcast_member_missing_primary_contact_email');
  it.todo('empty segment → broadcast_empty_segment_blocked');
  it.todo('audience too large → broadcast_audience_too_large');
  it.todo('custom recipient unknown → broadcast_custom_recipient_unknown');

  // Atomicity
  it.todo('happy path: insertDraft + applyTransition(submitted) + audit emit are atomic in single tx');
  it.todo('rejection does NOT insert row (no reservation leak)');

  // Server error catch-all
  it.todo('repo throw inside withTx → submit.server_error');

  // NO rate-limit on admin-proxy path (Q12 emergency correction)
  it.todo('admin proxy bypasses rate-limit check (10/24h applies to member-self only)');
});
