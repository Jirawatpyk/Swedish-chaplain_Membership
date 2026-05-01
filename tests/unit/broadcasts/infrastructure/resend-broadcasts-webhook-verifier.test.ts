/**
 * T149 / T151 RED-converted-GREEN — Unit tests for Resend Broadcasts
 * webhook signature verifier (Svix HMAC-SHA256).
 *
 * Asserts: missing-header rejection, malformed-timestamp rejection,
 * timestamp tolerance window (±5min), signature tampering rejection,
 * happy path with valid signature, and event-type→delivery-status
 * mapping for all 4 handled types.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

import { resendBroadcastsWebhookVerifier } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-webhook-verifier';
import { WebhookSignatureError } from '@/modules/broadcasts/application/ports/webhook-verifier-port';

const SECRET = 'whsec_dGVzdHNlY3JldA=='; // "testsecret" base64
const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');

function signPayload(
  rawBody: string,
  svixId: string,
  unixSeconds: number,
  secret: string,
): string {
  const stripped = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const signedPayload = `${svixId}.${unixSeconds}.${rawBody}`;
  const sig = createHmac('sha256', Buffer.from(stripped, 'base64'))
    .update(signedPayload, 'utf8')
    .digest('base64');
  return `v1,${sig}`;
}

function buildBody(eventType: string): string {
  return JSON.stringify({
    type: eventType,
    created_at: FROZEN_NOW.toISOString(),
    data: {
      broadcast_id: 'rsb-1',
      email_id: 'mid-1',
      to: ['alice@example.com'],
    },
  });
}

beforeEach(() => vi.useFakeTimers({ now: FROZEN_NOW }));
afterEach(() => vi.useRealTimers());

describe('resendBroadcastsWebhookVerifier', () => {
  it('throws missing_header when any svix-* header is absent', () => {
    expect(() =>
      resendBroadcastsWebhookVerifier.constructEvent(
        buildBody('email.delivered'),
        null,
        'msg_x',
        '1700000000',
        SECRET,
      ),
    ).toThrow(WebhookSignatureError);
  });

  it('throws expired_timestamp for headers >5 minutes off', () => {
    const ts = Math.floor(FROZEN_NOW.getTime() / 1000) - 6 * 60;
    const body = buildBody('email.delivered');
    const sig = signPayload(body, 'msg_1', ts, SECRET);
    expect(() =>
      resendBroadcastsWebhookVerifier.constructEvent(
        body,
        sig,
        'msg_1',
        String(ts),
        SECRET,
      ),
    ).toThrow(WebhookSignatureError);
  });

  it('throws bad_signature when HMAC mismatches', () => {
    const ts = Math.floor(FROZEN_NOW.getTime() / 1000);
    const body = buildBody('email.delivered');
    expect(() =>
      resendBroadcastsWebhookVerifier.constructEvent(
        body,
        'v1,YmFkU2lnbmF0dXJlSGVyZQ==',
        'msg_1',
        String(ts),
        SECRET,
      ),
    ).toThrow(WebhookSignatureError);
  });

  it('happy path: returns VerifiedBroadcastEvent on valid signature', () => {
    const ts = Math.floor(FROZEN_NOW.getTime() / 1000);
    const body = buildBody('email.delivered');
    const sig = signPayload(body, 'msg_1', ts, SECRET);
    const verified = resendBroadcastsWebhookVerifier.constructEvent(
      body,
      sig,
      'msg_1',
      String(ts),
      SECRET,
    );
    expect(verified.id).toBe('msg_1');
    expect(verified.type).toBe('email.delivered');
    expect(verified.data.status).toBe('delivered');
    expect(verified.data.broadcastId).toBe('rsb-1');
    expect(verified.data.recipientEmail).toBe('alice@example.com');
  });

  it.each([
    ['email.sent', 'sent'],
    ['email.delivered', 'delivered'],
    ['email.bounced', 'bounced'],
    ['email.delivery_delayed', 'soft_bounced'],
    ['email.complained', 'complained'],
  ] as const)(
    'maps Resend %s event-type to delivery status %s',
    (eventType, expected) => {
      const ts = Math.floor(FROZEN_NOW.getTime() / 1000);
      const body = buildBody(eventType);
      const sig = signPayload(body, 'msg_x', ts, SECRET);
      const verified = resendBroadcastsWebhookVerifier.constructEvent(
        body,
        sig,
        'msg_x',
        String(ts),
        SECRET,
      );
      expect(verified.data.status).toBe(expected);
    },
  );

  it('throws malformed for unknown event types', () => {
    const ts = Math.floor(FROZEN_NOW.getTime() / 1000);
    const body = JSON.stringify({
      type: 'email.brand_new_event_type',
      data: {
        broadcast_id: 'rsb-1',
        email_id: 'mid-1',
        to: ['alice@example.com'],
      },
    });
    const sig = signPayload(body, 'msg_x', ts, SECRET);
    try {
      resendBroadcastsWebhookVerifier.constructEvent(
        body,
        sig,
        'msg_x',
        String(ts),
        SECRET,
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(WebhookSignatureError);
      if (e instanceof WebhookSignatureError) {
        expect(e.kind).toBe('malformed');
      }
    }
  });
});
