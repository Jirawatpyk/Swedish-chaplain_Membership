/**
 * E3 — Stripe webhook verifier adapter unit tests.
 *
 * Uses the REAL Stripe SDK (`stripe.webhooks.generateTestHeaderString`)
 * to build fixture signatures — pure crypto, no network. Exercises the
 * 5 reject branches + the success path projection, hardening the
 * reason-discriminator surface the route handler narrows on.
 *
 * NO DB, NO HTTP, NO MSW — this is a pure function on
 * `(rawBody, sigHeader, endpointSecret)` so it belongs in unit tests
 * (cf. spec §5b alternate-placement clause).
 */
import { describe, it, expect } from 'vitest';
import Stripe from 'stripe';
import { stripeWebhookVerifier } from '@/modules/payments/infrastructure/stripe/stripe-webhook-verifier';
import { WebhookSignatureError } from '@/modules/payments/infrastructure/stripe/errors';

const ENDPOINT_SECRET = 'whsec_test_group_e3_fixture_secret';

// A minimally shaped payment_intent.succeeded event. We only rely on
// `id` + `type` + `data.object.id` reaching the Application envelope
// (the rest is intentionally stripped by the verifier projector).
const validEventBody = JSON.stringify({
  id: 'evt_test_e3_success',
  type: 'payment_intent.succeeded',
  api_version: '2025-09-30.clover',
  livemode: false,
  created: Math.floor(Date.now() / 1000),
  account: 'acct_test_e3',
  data: {
    object: {
      id: 'pi_test_e3',
      latest_charge: 'ch_test_e3',
    },
  },
});

function makeSigHeader(body: string, opts?: { timestamp?: number }): string {
  return Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: ENDPOINT_SECRET,
    ...(opts?.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
  });
}

describe('stripeWebhookVerifier — verify + project', () => {
  it('accepts a freshly-signed body and projects to the allow-list envelope', () => {
    const sig = makeSigHeader(validEventBody);
    const envelope = stripeWebhookVerifier.constructEvent(
      validEventBody,
      sig,
      ENDPOINT_SECRET,
    );
    expect(envelope.id).toBe('evt_test_e3_success');
    expect(envelope.type).toBe('payment_intent.succeeded');
    expect(envelope.dataObject.id).toBe('pi_test_e3');
    // Allow-list hygiene — no raw Stripe fields beyond the declared set.
    const allowedKeys = new Set([
      'id',
      'type',
      'latestChargeId',
      'refundIds',
      'lastPaymentErrorCode',
      'disputeId',
      'amountSatang',
    ]);
    for (const k of Object.keys(envelope.dataObject)) {
      expect(allowedKeys.has(k), `disallowed key '${k}' leaked into envelope`).toBe(true);
    }
  });

  it('rejects a missing Stripe-Signature header with kind=missing_header', () => {
    try {
      stripeWebhookVerifier.constructEvent(validEventBody, '', ENDPOINT_SECRET);
      throw new Error('expected WebhookSignatureError');
    } catch (e) {
      expect(e).toBeInstanceOf(WebhookSignatureError);
      expect((e as WebhookSignatureError).kind).toBe('missing_header');
    }
  });

  it('rejects a body tampered post-signing with kind=tampered_body|bad_signature', () => {
    const sig = makeSigHeader(validEventBody);
    const tamperedBody = validEventBody.replace('pi_test_e3', 'pi_attacker');
    try {
      stripeWebhookVerifier.constructEvent(tamperedBody, sig, ENDPOINT_SECRET);
      throw new Error('expected WebhookSignatureError');
    } catch (e) {
      expect(e).toBeInstanceOf(WebhookSignatureError);
      // Stripe SDK's thrown message drives the textual match in the
      // adapter — accept either discriminator per spec 5b guidance.
      const kind = (e as WebhookSignatureError).kind;
      expect(['tampered_body', 'bad_signature']).toContain(kind);
    }
  });

  it('rejects a timestamp > 5 min in the past with kind=clock_skew', () => {
    const old = Math.floor(Date.now() / 1000) - 600; // 10 min old
    const sig = makeSigHeader(validEventBody, { timestamp: old });
    try {
      stripeWebhookVerifier.constructEvent(validEventBody, sig, ENDPOINT_SECRET);
      throw new Error('expected WebhookSignatureError');
    } catch (e) {
      expect(e).toBeInstanceOf(WebhookSignatureError);
      expect((e as WebhookSignatureError).kind).toBe('clock_skew');
    }
  });

  // Backend-dev review F-03 + Drizzle reviewer follow-up #2 (Group E,
  // 2026-04-24): pin the future-direction clock-skew check so a
  // regression that drops the `nowSec + 60 < t` guard is caught
  // immediately. PCI guardian flagged this branch as potentially
  // exploitable; on re-read the code IS correct, but the test must
  // exist to keep it that way.
  it('rejects a timestamp > 60s in the future with kind=clock_skew', () => {
    const future = Math.floor(Date.now() / 1000) + 120; // 2 min in the future
    const sig = makeSigHeader(validEventBody, { timestamp: future });
    try {
      stripeWebhookVerifier.constructEvent(validEventBody, sig, ENDPOINT_SECRET);
      throw new Error('expected WebhookSignatureError');
    } catch (e) {
      expect(e).toBeInstanceOf(WebhookSignatureError);
      expect((e as WebhookSignatureError).kind).toBe('clock_skew');
    }
  });

  it('rejects a bad-hex signature component with kind=bad_signature', () => {
    // Build a fresh-timestamp header but replace the v1 signature hex
    // with garbage so HMAC compare fails.
    const nowT = Math.floor(Date.now() / 1000);
    const sig = `t=${nowT},v1=deadbeefnothex_not_a_real_sig`;
    try {
      stripeWebhookVerifier.constructEvent(validEventBody, sig, ENDPOINT_SECRET);
      throw new Error('expected WebhookSignatureError');
    } catch (e) {
      expect(e).toBeInstanceOf(WebhookSignatureError);
      // Stripe SDK's text-based message classification lumps "bad hex"
      // into either `bad_signature` or `tampered_body` depending on
      // which SDK path trips first — accept either.
      const kind = (e as WebhookSignatureError).kind;
      expect(['bad_signature', 'tampered_body']).toContain(kind);
    }
  });
});

// F5R3v2 H-6 (2026-05-16) — amount-projection equality tests.
//
// C-1 made amount projection defensive (try/catch around asSatang →
// fallback to undefined + logger.warn) for three object types
// (payment_intent / charge / dispute). Equally important is that the
// happy-path projection is BYTE-FAITHFUL: `envelope.dataObject.amountSatang`
// MUST equal `BigInt(raw.amount)` for every supported object type, with
// no silent transformation, scaling, or rounding. A future bug that
// (say) divided by 100 thinking Stripe sent baht-not-satang would silently
// halve every received amount — these tests pin the contract.
describe('stripeWebhookVerifier — amount projection (H-6)', () => {
  function signedBody(body: string): {
    body: string;
    sig: string;
  } {
    return { body, sig: makeSigHeader(body) };
  }

  it('payment_intent: amountSatang === BigInt(raw.amount) exactly', () => {
    const raw = 535_000; // 5,350.00 THB
    const body = JSON.stringify({
      id: 'evt_pi_amount',
      type: 'payment_intent.succeeded',
      api_version: '2025-09-30.clover',
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      account: 'acct_test',
      data: {
        object: {
          id: 'pi_amount_test',
          object: 'payment_intent',
          latest_charge: 'ch_amount_test',
          amount: raw,
        },
      },
    });
    const { sig } = signedBody(body);
    const envelope = stripeWebhookVerifier.constructEvent(body, sig, ENDPOINT_SECRET);
    expect(envelope.dataObject.amountSatang).toBeDefined();
    expect(envelope.dataObject.amountSatang).toBe(BigInt(raw));
  });

  it('charge: amountSatang === BigInt(raw.amount) exactly', () => {
    const raw = 250_000; // 2,500.00 THB
    const body = JSON.stringify({
      id: 'evt_ch_amount',
      type: 'charge.refunded',
      api_version: '2025-09-30.clover',
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      account: 'acct_test',
      data: {
        object: {
          id: 'ch_amount_test',
          object: 'charge',
          amount: raw,
          refunds: { data: [] },
        },
      },
    });
    const { sig } = signedBody(body);
    const envelope = stripeWebhookVerifier.constructEvent(body, sig, ENDPOINT_SECRET);
    expect(envelope.dataObject.amountSatang).toBe(BigInt(raw));
  });

  it('dispute: amountSatang === BigInt(raw.amount) exactly', () => {
    const raw = 100_000; // 1,000.00 THB
    const body = JSON.stringify({
      id: 'evt_dp_amount',
      type: 'charge.dispute.created',
      api_version: '2025-09-30.clover',
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      account: 'acct_test',
      data: {
        object: {
          id: 'dp_amount_test',
          object: 'dispute',
          amount: raw,
        },
      },
    });
    const { sig } = signedBody(body);
    const envelope = stripeWebhookVerifier.constructEvent(body, sig, ENDPOINT_SECRET);
    expect(envelope.dataObject.amountSatang).toBe(BigInt(raw));
  });

  it('payment_intent: zero amount projects as 0n (not undefined)', () => {
    // Edge case — a 0-amount payment_intent is rare but valid (e.g.,
    // setup_intent flow, $0 invoice for trial). asSatang accepts 0n.
    const body = JSON.stringify({
      id: 'evt_pi_zero',
      type: 'payment_intent.succeeded',
      api_version: '2025-09-30.clover',
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      account: 'acct_test',
      data: {
        object: {
          id: 'pi_zero_test',
          object: 'payment_intent',
          amount: 0,
        },
      },
    });
    const { sig } = signedBody(body);
    const envelope = stripeWebhookVerifier.constructEvent(body, sig, ENDPOINT_SECRET);
    expect(envelope.dataObject.amountSatang).toBe(0n);
  });

  it('payment_intent: negative amount triggers C-1 fallback (amountSatang omitted)', () => {
    // C-1 defensive: a negative amount (impossible under Stripe API
    // contract but plausible under fuzz / SDK drift / dispute-reversal)
    // MUST NOT throw — the verifier should warn + omit the field so
    // downstream use-cases stay alive.
    const body = JSON.stringify({
      id: 'evt_pi_negative',
      type: 'payment_intent.succeeded',
      api_version: '2025-09-30.clover',
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      account: 'acct_test',
      data: {
        object: {
          id: 'pi_negative_test',
          object: 'payment_intent',
          amount: -100,
        },
      },
    });
    const { sig } = signedBody(body);
    const envelope = stripeWebhookVerifier.constructEvent(body, sig, ENDPOINT_SECRET);
    // amountSatang field must be omitted (envelope still constructs).
    expect(envelope.dataObject.amountSatang).toBeUndefined();
    expect(envelope.dataObject.id).toBe('pi_negative_test');
  });

  it('payment_intent: missing amount field projects as undefined', () => {
    // No `amount` on the raw object → no projection attempt → omitted.
    const body = JSON.stringify({
      id: 'evt_pi_no_amount',
      type: 'payment_intent.succeeded',
      api_version: '2025-09-30.clover',
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      account: 'acct_test',
      data: {
        object: {
          id: 'pi_no_amount',
          object: 'payment_intent',
        },
      },
    });
    const { sig } = signedBody(body);
    const envelope = stripeWebhookVerifier.constructEvent(body, sig, ENDPOINT_SECRET);
    expect(envelope.dataObject.amountSatang).toBeUndefined();
  });
});
