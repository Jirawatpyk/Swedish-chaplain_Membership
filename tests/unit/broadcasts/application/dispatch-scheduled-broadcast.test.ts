/**
 * Unit tests for `dispatch-scheduled-broadcast.ts` cron worker (US2 Wave 1).
 *
 * Cron picks up rows where status='approved' AND scheduledFor <= now().
 * For each row:
 *   1. lockForUpdate (skip locked rows from concurrent ticks)
 *   2. Resolve final recipient list (resolve-segment-recipients +
 *      suppression filter at dispatch boundary, FR-016 + FR-017)
 *   3. Call Resend Broadcasts API (createAudience + addContacts +
 *      createBroadcast + sendBroadcast) with stable idempotency key
 *      `broadcast-{tenantId}-{broadcastId}` (FR-020)
 *   4. applyTransition('sending') + attachResendIds(audienceId, broadcastId)
 *   5. Audit broadcast_send_started
 *
 * On Resend 5xx → outbox row keeps retrying (cron tick re-attempts with
 * same idempotency key — Resend deduplicates).
 * On Resend 4xx (permanent) → applyTransition('failed_to_dispatch') +
 *   audit broadcast_failed_to_dispatch + member notification.
 *
 * Turns GREEN: T100 (Wave 1) + T104 (Wave 2 gateway).
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/dispatch-scheduled-broadcast.ts',
);

describe('dispatch-scheduled-broadcast — RED skeleton (T100/T104)', () => {
  it('use-case module exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // Happy path
  it.todo('happy: scheduledFor <= now → resolve recipients → Resend createAudience+addContacts+createBroadcast+sendBroadcast → applyTransition(sending) → audit broadcast_send_started');
  it.todo('attaches resendAudienceId + resendBroadcastId to row before sending');

  // Idempotency
  it.todo('uses stable idempotency key `broadcast-{tenantId}-{broadcastId}` (no attempt counter)');
  it.todo('cron retry after Resend success but DB write fail → re-uses same idempotency key (Resend dedupes)');

  // Concurrent ticks
  it.todo('lockForUpdate SKIP LOCKED — second cron tick skips already-processing row');

  // Resend failures
  it.todo('Resend 5xx (transient) → row stays in approved + outbox retries with backoff');
  it.todo('Resend 4xx (permanent — invalid audience/template) → applyTransition(failed_to_dispatch) + broadcast_failed_to_dispatch audit');
  it.todo('Resend timeout/network → retry counted; max 5 retries (1/2/4/8/16s)');

  // Recipient list resolution at dispatch
  it.todo('re-resolves segment at dispatch (members may have been added/removed since submit)');
  it.todo('applies suppression filter at dispatch (marketing_unsubscribes); not just submit-time count');
  it.todo('post-suppression empty list → applyTransition(failed_to_dispatch) with reason=audience_post_suppression_empty');

  // Audit
  it.todo('audit broadcast_send_started emitted with audience_id + recipient_count');

  // Member notification on failure
  it.todo('failed_to_dispatch enqueues member notification + admin alert');

  // Past-scheduled rows (e.g., cron paused for hours, now catching up)
  it.todo('happy: scheduledFor far in past still dispatches (no expiry on schedule)');

  // Eligibility gate — only `approved` status
  it.todo('skips status=submitted rows (not yet approved)');
  it.todo('skips status=sending/sent/rejected/cancelled/failed_to_dispatch rows');
});
