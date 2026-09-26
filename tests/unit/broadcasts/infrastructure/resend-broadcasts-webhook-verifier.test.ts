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

  // Single-Resend-account setup (live 2026-07-30): the account hosts BOTH
  // the transactional and broadcasts webhook endpoints, and Resend fires
  // every email event to every endpoint. Transactional emails (reset
  // password, renewal reminders, invitations) therefore reach this
  // verifier with a valid signature + known event type + `email_id` but
  // NO `broadcast_id`. They are another product's events — the verifier
  // must throw the ack-able `not_broadcast_email` kind, NOT `malformed`
  // (which the route 401s → Svix retry storm + audit spam).
  describe('non-broadcast (transactional) email events', () => {
    function buildTransactionalBody(overrides: {
      broadcast_id?: string;
      email_id?: string;
    }): string {
      return JSON.stringify({
        type: 'email.delivered',
        created_at: FROZEN_NOW.toISOString(),
        data: {
          ...('broadcast_id' in overrides && {
            broadcast_id: overrides.broadcast_id,
          }),
          ...('email_id' in overrides && { email_id: overrides.email_id }),
          to: ['alice@example.com'],
        },
      });
    }

    function constructSigned(body: string) {
      const ts = Math.floor(FROZEN_NOW.getTime() / 1000);
      const sig = signPayload(body, 'msg_tx', ts, SECRET);
      return () =>
        resendBroadcastsWebhookVerifier.constructEvent(
          body,
          sig,
          'msg_tx',
          String(ts),
          SECRET,
        );
    }

    function expectKind(body: string, expectedKind: string): void {
      try {
        constructSigned(body)();
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(WebhookSignatureError);
        if (e instanceof WebhookSignatureError) {
          expect(e.kind).toBe(expectedKind);
        }
      }
    }

    it('signed payload with valid email_id but NO broadcast_id → not_broadcast_email (NOT malformed)', () => {
      expectKind(
        buildTransactionalBody({ email_id: 'mid-tx-1' }),
        'not_broadcast_email',
      );
    });

    it('signed payload with EMPTY broadcast_id → not_broadcast_email', () => {
      expectKind(
        buildTransactionalBody({ broadcast_id: '', email_id: 'mid-tx-1' }),
        'not_broadcast_email',
      );
    });

    it('signed payload missing email_id (broadcast_id present) stays malformed', () => {
      expectKind(buildTransactionalBody({ broadcast_id: 'rsb-1' }), 'malformed');
    });

    it('signed payload missing BOTH ids stays malformed (missing email_id wins)', () => {
      expectKind(buildTransactionalBody({}), 'malformed');
    });
  });

  it('throws unknown_event_type for unknown event types (R7 LOW-G — was malformed pre-R7)', () => {
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
        // R7 LOW-G — kind separated from `malformed` so the route
        // handler can 200-ack new Resend event types instead of
        // recording bad_signature noise.
        expect(e.kind).toBe('unknown_event_type');
      }
    }
  });
});

// Resend's hosted unsubscribe page, and the List-Unsubscribe header Resend
// adds to every broadcast, flip the Resend CONTACT to unsubscribed — which
// Resend reports as `contact.updated` (there is no `email.unsubscribed`).
// The verifier must authenticate and parse that event so the route can
// mirror it into `marketing_unsubscribes` (tenant + email).
describe('resendBroadcastsWebhookVerifier.constructContactEvent', () => {
  const now = Math.floor(FROZEN_NOW.getTime() / 1000);
  function contactBody(data: Record<string, unknown>, type = 'contact.updated'): string {
    return JSON.stringify({ type, created_at: FROZEN_NOW.toISOString(), data });
  }

  it('parses a signed contact.updated into the fields the mirror needs', () => {
    const body = contactBody({
      id: 'c-1',
      audience_id: 'aud-1',
      segment_ids: ['seg-1'],
      email: 'Alice@Example.com',
      unsubscribed: true,
    });
    const event = resendBroadcastsWebhookVerifier.constructContactEvent(
      body,
      signPayload(body, 'msg_c1', now, SECRET),
      'msg_c1',
      String(now),
      SECRET,
    );
    expect(event).toEqual({
      id: 'msg_c1',
      type: 'contact.updated',
      createdAtUnixSeconds: now,
      data: {
        email: 'Alice@Example.com',
        audienceIds: ['aud-1', 'seg-1'],
        unsubscribed: true,
      },
    });
  });

  it('rejects a tampered contact.updated as bad_signature', () => {
    const body = contactBody({ audience_id: 'aud-1', email: 'a@example.com', unsubscribed: true });
    const sig = signPayload(body, 'msg_c2', now, SECRET);
    const tampered = body.replace('a@example.com', 'b@example.com');
    expect(() =>
      resendBroadcastsWebhookVerifier.constructContactEvent(tampered, sig, 'msg_c2', String(now), SECRET),
    ).toThrow(expect.objectContaining({ kind: 'bad_signature' }));
  });

  it('is only for contact.updated — any other type is unknown_event_type', () => {
    const body = buildBody('email.delivered');
    expect(() =>
      resendBroadcastsWebhookVerifier.constructContactEvent(
        body,
        signPayload(body, 'msg_c3', now, SECRET),
        'msg_c3',
        String(now),
        SECRET,
      ),
    ).toThrow(expect.objectContaining({ kind: 'unknown_event_type' }));
  });

  // An opt-out we cannot attribute must still reach the route (which audits
  // it for manual follow-up) — only a missing address is unusable.
  it('a contact.updated without an audience/segment id still parses, with no ids', () => {
    const body = contactBody({ email: 'a@example.com', unsubscribed: true });
    const event = resendBroadcastsWebhookVerifier.constructContactEvent(
      body,
      signPayload(body, 'msg_c5', now, SECRET),
      'msg_c5',
      String(now),
      SECRET,
    );
    expect(event.data.audienceIds).toEqual([]);
    expect(event.data.unsubscribed).toBe(true);
  });

  it('a contact.updated without an email is malformed', () => {
    for (const data of [{ audience_id: 'aud-1', unsubscribed: true }]) {
      const body = contactBody(data);
      expect(() =>
        resendBroadcastsWebhookVerifier.constructContactEvent(
          body,
          signPayload(body, 'msg_c4', now, SECRET),
          'msg_c4',
          String(now),
          SECRET,
        ),
      ).toThrow(expect.objectContaining({ kind: 'malformed' }));
    }
  });
});
