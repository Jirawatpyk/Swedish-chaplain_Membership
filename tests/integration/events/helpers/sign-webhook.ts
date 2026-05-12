/**
 * F6 webhook-signing test helper.
 *
 * Computes the HMAC-SHA256 signature for a given timestamp + raw body
 * using a tenant's active webhook secret, exactly as Zapier's
 * "Webhooks by Zapier" Crypto utility does in production:
 *
 *   message    = `${timestamp}.${rawBody}`
 *   signature  = hmac_sha256_hex(secret, message)
 *   header     = `sha256=${signature}`
 *
 * Reused across:
 *   - tests/integration/events/signature.test.ts (T038)
 *   - tests/integration/events/idempotency.test.ts (T039)
 *   - tests/integration/events/transactional-ingest.test.ts (T040)
 *   - tests/integration/events/tenant-isolation.test.ts (T042)
 *
 * Pure stdlib — no @/modules import — so this helper can be authored
 * AHEAD of the production-side `crypto-webhook-signature-verifier.ts`
 * adapter (T044) without circular dep.
 */
import { createHmac } from 'node:crypto';

export interface SignedWebhookBody {
  readonly rawBody: string;
  readonly timestamp: string;
  readonly signatureHeader: string;
}

/**
 * Sign an arbitrary JSON body for the F6 webhook receiver.
 *
 * Default `now()` is in Unix seconds matching the X-Chamber-Timestamp
 * header contract. Pass an explicit `timestampSeconds` for skew tests
 * (e.g., 6 minutes ago for the replay-rejection path).
 */
export function signWebhookBody(input: {
  readonly body: unknown;
  readonly secret: string;
  readonly timestampSeconds?: number;
}): SignedWebhookBody {
  const rawBody = JSON.stringify(input.body);
  const ts = (input.timestampSeconds ?? Math.floor(Date.now() / 1000)).toString();
  const message = `${ts}.${rawBody}`;
  const sig = createHmac('sha256', input.secret).update(message).digest('hex');
  return {
    rawBody,
    timestamp: ts,
    signatureHeader: `sha256=${sig}`,
  };
}

/**
 * Build a canonical `EventCreatePayloadV1`-shaped object for tests.
 * Caller can override any subset of fields.
 */
export function makeWebhookPayload(overrides?: {
  eventType?: 'attendee.registered' | 'purchase.completed';
  tenantSlug?: string;
  event?: Partial<{
    externalId: string;
    name: string;
    description: string | null;
    startDate: string;
    endDate: string | null;
    location: string | null;
    category: string | null;
    eventCreateUrl: string | null;
  }>;
  attendee?: Partial<{
    externalId: string;
    email: string;
    fullName: string;
    companyName: string | null;
    ticketType: string | null;
    ticketPricePaid: number | null;
    paymentStatus: 'paid' | 'pending' | 'refunded' | 'free';
    registeredAt: string;
  }>;
}): Record<string, unknown> {
  return {
    eventType: overrides?.eventType ?? 'attendee.registered',
    tenantSlug: overrides?.tenantSlug ?? 'test-swecham',
    event: {
      externalId: 'event_test_001',
      name: 'F6 Test Event',
      description: null,
      startDate: '2026-06-21T18:00:00+07:00',
      endDate: '2026-06-21T22:00:00+07:00',
      location: 'Anantara Riverside, Bangkok',
      category: 'networking',
      eventCreateUrl: 'https://events.example.com/f6-test',
      ...overrides?.event,
    },
    attendee: {
      externalId: 'att_test_001',
      email: 'jane@fogmaker.example',
      fullName: 'Jane Andersson',
      companyName: 'Fogmaker International AB',
      ticketType: 'Member — Free',
      ticketPricePaid: 0,
      paymentStatus: 'paid' as const,
      registeredAt: '2026-06-01T10:23:15Z',
      ...overrides?.attendee,
    },
  };
}
