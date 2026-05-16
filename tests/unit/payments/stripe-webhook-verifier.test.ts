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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Stripe from 'stripe';
import { stripeWebhookVerifier } from '@/modules/payments/infrastructure/stripe/stripe-webhook-verifier';
import { WebhookSignatureError } from '@/modules/payments/infrastructure/stripe/errors';
import { logger } from '@/lib/logger';

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
  // F5R3v3 L-6 (2026-05-16) — `signedBody` helper deleted; the
  // inline `makeSigHeader(body)` form matches the older tests in
  // this file and removes a 6-line indirection.

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
    const envelope = stripeWebhookVerifier.constructEvent(body, makeSigHeader(body), ENDPOINT_SECRET);
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
    const envelope = stripeWebhookVerifier.constructEvent(body, makeSigHeader(body), ENDPOINT_SECRET);
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
    const envelope = stripeWebhookVerifier.constructEvent(body, makeSigHeader(body), ENDPOINT_SECRET);
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
          // L-1: include latest_charge so the test remains decoupled
          // from the verifier's projection-field ordering.
          latest_charge: 'ch_zero_test',
          amount: 0,
        },
      },
    });
    const envelope = stripeWebhookVerifier.constructEvent(body, makeSigHeader(body), ENDPOINT_SECRET);
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
          latest_charge: 'ch_negative_test',
          amount: -100,
        },
      },
    });
    const envelope = stripeWebhookVerifier.constructEvent(body, makeSigHeader(body), ENDPOINT_SECRET);
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
          latest_charge: 'ch_no_amount',
        },
      },
    });
    const envelope = stripeWebhookVerifier.constructEvent(body, makeSigHeader(body), ENDPOINT_SECRET);
    expect(envelope.dataObject.amountSatang).toBeUndefined();
    // Missing field is NOT a projection failure — the flag stays unset.
    expect(envelope.dataObject.amountProjectionFailed).toBeUndefined();
  });
});

// F5R3v3 H-6 + H-4 + M-6 (2026-05-16) — extra C-1 fallback coverage:
//   - fractional / NaN / Infinity amounts (BigInt() throws)
//   - amountProjectionFailed flag is set on every failure path
//   - logger.error fires with the right shape for SRE alerting
//   - all 3 object types (payment_intent / charge / dispute) exercise
//     the C-1 catch independently
describe('stripeWebhookVerifier — C-1 fallback coverage (H-4 flag + M-6 log)', () => {
  let loggerErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
  });

  function makeBody(opts: {
    eventId: string;
    objectType: 'payment_intent' | 'charge' | 'dispute';
    amount: number;
  }): string {
    const dataObject: Record<string, unknown> = {
      id: `${opts.objectType.slice(0, 2)}_test`,
      object: opts.objectType,
      amount: opts.amount,
    };
    if (opts.objectType === 'charge') {
      dataObject['refunds'] = { data: [] };
    }
    return JSON.stringify({
      id: opts.eventId,
      type: 'payment_intent.succeeded',
      api_version: '2025-09-30.clover',
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      account: 'acct_h4_test',
      data: { object: dataObject },
    });
  }

  // NB: NaN and Infinity cannot reach the verifier via real Stripe
  // webhooks — JSON.stringify(NaN|Infinity) emits `null`, and the
  // `typeof raw['amount'] === 'number'` gate in the verifier filters
  // them out before projectAmountSafely runs. The relevant unit-level
  // coverage for `asSatang(BigInt(NaN))` lives in tests/unit/lib/
  // money.test.ts (parseSatang NaN guard).
  it.each([
    ['payment_intent' as const, 100.5, 'fractional triggers BigInt() throw'],
    ['payment_intent' as const, -100, 'negative triggers asSatang RangeError'],
    ['charge' as const, -50, 'charge: negative triggers C-1 fallback'],
    ['dispute' as const, -25, 'dispute: negative triggers C-1 fallback'],
  ])(
    '%s amount=%p (%s) → amountProjectionFailed=true + logger.error',
    (objectType, amount, _label) => {
      const eventId = `evt_h4_${objectType}_${String(amount).replace(/[^a-z0-9]/gi, '')}`;
      const body = makeBody({ eventId, objectType, amount });
      const sig = makeSigHeader(body);
      const envelope = stripeWebhookVerifier.constructEvent(
        body,
        sig,
        ENDPOINT_SECRET,
      );

      // H-4 flag: must be set so downstream consumers gate on it.
      expect(envelope.dataObject.amountProjectionFailed).toBe(true);
      // amountSatang field must be omitted (never substitute fake 0).
      expect(envelope.dataObject.amountSatang).toBeUndefined();

      // M-6 logger.error: SRE depends on this for triage.
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
      const [ctx, msg] = loggerErrorSpy.mock.calls[0]!;
      expect(msg).toBe('stripe-webhook-verifier.amount_projection_failed');
      const c = ctx as Record<string, unknown>;
      expect(c['eventId']).toBe(eventId);
      expect(c['objectType']).toBe(objectType);
      expect(c['account']).toBe('acct_h4_test');
      expect(c['livemode']).toBe(false);
      expect(c['rawAmount']).toBe(amount);
      // errKind is either 'RangeError' (asSatang) or 'RangeError'/'SyntaxError'
      // (BigInt) — both Error subclasses; we assert presence + non-empty.
      expect(typeof c['errKind']).toBe('string');
      expect((c['errKind'] as string).length).toBeGreaterThan(0);
    },
  );

  it('happy path (positive integer) does NOT fire logger.error and amountProjectionFailed stays unset', () => {
    const body = makeBody({
      eventId: 'evt_happy',
      objectType: 'payment_intent',
      amount: 535_000,
    });
    const sig = makeSigHeader(body);
    const envelope = stripeWebhookVerifier.constructEvent(
      body,
      sig,
      ENDPOINT_SECRET,
    );
    expect(envelope.dataObject.amountSatang).toBe(535_000n);
    expect(envelope.dataObject.amountProjectionFailed).toBeUndefined();
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });
});
