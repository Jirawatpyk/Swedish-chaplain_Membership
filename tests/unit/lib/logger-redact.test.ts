/**
 * T032 unit test — F5 logger redaction (PAN + Stripe secrets).
 *
 * Two layers:
 *   1. Path-based redaction (pino built-in) — asserts every F5-added
 *      field path in REDACT_PATHS resolves to `[REDACTED]`.
 *   2. Value-pattern redaction — asserts `redactPanValues()` catches
 *      bare PAN strings (Visa/Amex/MC/Disc) even when the field name
 *      is unexpected.
 *
 * PCI DSS SAQ-A invariant: no raw PAN, CVV, or Stripe secret may
 * appear in ANY log line. A regression here is a Review-Gate blocker.
 */
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { PAN_REGEX, REDACT_PATHS, redactPanValues } from '@/lib/logger';

describe('F5 logger path-based redaction (T032)', () => {
  // Build a minimal pino logger mirroring the prod redact config +
  // formatter; capture output into an in-memory buffer for assertion.
  function captureLog(log: Record<string, unknown>): string {
    const chunks: string[] = [];
    const logger = pino(
      {
        level: 'info',
        redact: { paths: REDACT_PATHS, censor: '[REDACTED]', remove: false },
        formatters: {
          log(object) {
            return redactPanValues(object) as Record<string, unknown>;
          },
        },
      },
      {
        write(chunk: string) {
          chunks.push(chunk);
        },
      } as unknown as NodeJS.WritableStream,
    );
    logger.info(log, 'test');
    return chunks.join('');
  }

  it.each([
    'card_number',
    'cardNumber',
    'card_cvc',
    'cardCvc',
    // PCI guardian Finding 2 — CVV variant coverage
    'cvv',
    'cvv2',
    'csc',
    'cid',
    'security_code',
    'card_security_code',
    'cvc_check',
    'stripe_secret_key',
    'stripeSecretKey',
    'stripe_webhook_secret',
    'stripeWebhookSecret',
    'Stripe-Signature',
    // PCI guardian R3 — header casing variants
    'STRIPE-SIGNATURE',
    'StripeSignature',
    // OBS-Q1 + LOG-GAP — F5 gateway error reason field defence-in-depth
    'processorReason',
    'reason',
  ])('redacts top-level field %s', (field) => {
    const out = captureLog({ [field]: 'secret-value-12345' });
    expect(out).not.toContain('secret-value-12345');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts nested card object en bloc', () => {
    const out = captureLog({
      card: {
        number: '4242424242424242',
        cvc: '123',
        exp_month: 12,
        exp_year: 2030,
      },
    });
    expect(out).not.toContain('4242424242424242');
    expect(out).not.toContain('123');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts nested one-level card fields', () => {
    const out = captureLog({
      body: {
        card_number: '5555555555554444',
      },
    });
    expect(out).not.toContain('5555555555554444');
    expect(out).toContain('[REDACTED]');
  });

  it('LOG-GAP: redacts gateway-error `reason` at the `error.reason` shape', () => {
    const out = captureLog({
      error: {
        kind: 'permanent',
        reason: 'sk_live_FORBIDDEN_DETAIL_THAT_MUST_NOT_LEAK',
      },
    });
    expect(out).not.toContain('sk_live_FORBIDDEN_DETAIL');
    expect(out).toContain('[REDACTED]');
  });

  it('LOG-GAP: redacts gateway-error `reason` at the `result.error.reason` shape', () => {
    const out = captureLog({
      result: {
        error: {
          kind: 'permanent',
          reason: 'sk_live_RESULT_WRAPPED_FORBIDDEN_DETAIL',
        },
      },
    });
    expect(out).not.toContain('sk_live_RESULT_WRAPPED_FORBIDDEN_DETAIL');
    expect(out).toContain('[REDACTED]');
  });

  it('LOG-GAP: redacts top-level `reason` (spread serialization shape)', () => {
    const out = captureLog({
      kind: 'permanent',
      reason: 'sk_live_TOP_LEVEL_FORBIDDEN_DETAIL',
    });
    expect(out).not.toContain('sk_live_TOP_LEVEL_FORBIDDEN_DETAIL');
    expect(out).toContain('[REDACTED]');
  });

  // Round 7 W-R6-1 — F8 mark-paid-offline route logs F4 internal
  // reason under the `f4Reason` key to disambiguate from the result
  // envelope's own `reason`. Path-based redaction is verbatim, so the
  // bare `reason`/`*.reason` paths above do NOT cover `f4Reason`.
  // Round 6 W-R5-1 added explicit `f4Reason` + `*.f4Reason` entries
  // to REDACT_PATHS — these tests pin that contract so a future
  // refactor that drops the entries surfaces immediately.
  // Constitution Principle IV (NON-NEGOTIABLE PCI DSS).

  it('Round 7 W-R6-1: redacts top-level `f4Reason`', () => {
    const out = captureLog({
      f4Reason: 'F4_INTERNAL_SCHEMA_DETAIL_THAT_MUST_NOT_LEAK',
    });
    expect(out).not.toContain('F4_INTERNAL_SCHEMA_DETAIL');
    expect(out).toContain('[REDACTED]');
  });

  it('Round 7 W-R6-1: redacts nested `error.f4Reason`', () => {
    const out = captureLog({
      error: {
        kind: 'f4_failure',
        f4Reason: 'F4_NESTED_DETAIL_THAT_MUST_NOT_LEAK',
      },
    });
    expect(out).not.toContain('F4_NESTED_DETAIL');
    expect(out).toContain('[REDACTED]');
  });

  // Staff-review R2 R024 (2026-04-28): negative assertion that a
  // synthetic Stripe webhook payload — the most common shape that
  // could leak `client_secret` or raw event body via stripe-webhook
  // logging — never surfaces those fields in a log line. Defense-in-
  // depth on Constitution Principle IV (NON-NEGOTIABLE).
  it('redacts Stripe webhook synthetic payload — clientSecret + rawBody never appear', () => {
    const synthetic = {
      requestId: 'req-r024',
      stripeEventId: 'evt_test_r024',
      eventType: 'payment_intent.succeeded',
      // Fields that MUST be redacted away from any stripe-webhook
      // log line per `specs/009-online-payment/saq-a-attestation.md § 2`.
      clientSecret: 'pi_test_r024_secret_HIGHLY_SENSITIVE',
      client_secret: 'pi_test_r024_secret_HIGHLY_SENSITIVE_snake',
      rawBody: '{"object":"event","data":{"object":{"object":"payment_intent","id":"pi_test_r024"}}}',
      raw_body: '{"object":"event","duplicate":true}',
      'Stripe-Signature': 't=1714348800,v1=ABCDEF1234567890',
    };
    const out = captureLog(synthetic);
    expect(out).not.toContain('HIGHLY_SENSITIVE');
    expect(out).not.toContain('"object":"event"');
    expect(out).not.toContain('t=1714348800');
    expect(out).toContain('[REDACTED]');
  });
});

describe('F5 PAN_REGEX value-pattern (T032 defence-in-depth, post-PCI-guardian Findings 1+R1)', () => {
  it.each([
    // Visa (13, 16, 19 digits)
    '4242424242424242',
    '4000056655665556',
    '4111111111111',
    // Mastercard legacy 51-55
    '5555555555554444',
    '5105105105105100',
    // Mastercard 2-series (R1 expansion)
    '2221000000000009',
    '2720990000000006',
    // Amex (15-digit)
    '378282246310005',
    '371449635398431',
    // Discover 6011 + 65
    '6011111111111117',
    '6500000000000002',
    // UnionPay (R1 — Thai market relevance)
    '6212341111111111',
    // JCB
    '3530111333300000',
    // Diners Club International (36-prefix only; 30x/38x not in scope)
    '36227206271667',
  ])('matches known PAN %s', (pan) => {
    expect(PAN_REGEX.test(pan)).toBe(true);
  });

  it.each([
    'hello world',
    'pi_test_abc123',
    'ch_test_xyz789',
    'pk_test_abcdef',
    '2020-04-23', // date
    '1234567890123', // Thai tax id — starts with 1, doesn't match
    '0100000000000', // phone-ish, starts with 0
    '', // empty string
    '4', // single digit (post-tighten — length gate rejects)
    '42', // 2 digits — too short for any card scheme
    '4242', // still too short
  ])('does NOT match non-PAN value %s', (value) => {
    expect(PAN_REGEX.test(value)).toBe(false);
  });
});

describe('F5 redactPanValues recursive walk (T032)', () => {
  it('redacts bare PAN in top-level field with unexpected name', () => {
    const out = redactPanValues({
      customMessage: '4242424242424242', // not in REDACT_PATHS
    });
    expect(out).toEqual({ customMessage: '[REDACTED]' });
  });

  it('redacts bare PAN in nested 4-level structure (Stripe event shape)', () => {
    const out = redactPanValues({
      event: {
        data: {
          object: {
            payment_method_details: {
              legacy_pan_leak: '4242424242424242',
            },
          },
        },
      },
    });
    expect(JSON.stringify(out)).toContain('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain('4242424242424242');
  });

  it('redacts PAN inside array values', () => {
    const out = redactPanValues({
      audit_chain: ['user-action', '4242424242424242', 'another-event'],
    });
    expect((out as { audit_chain: string[] }).audit_chain).toEqual([
      'user-action',
      '[REDACTED]',
      'another-event',
    ]);
  });

  it('does NOT mutate the input object', () => {
    const input = { card_number_leak: '4242424242424242' };
    const original = JSON.stringify(input);
    redactPanValues(input);
    expect(JSON.stringify(input)).toBe(original);
  });

  it('preserves non-PAN strings untouched', () => {
    const input = {
      intent_id: 'pi_test_abc123',
      charge_id: 'ch_test_xyz',
      amount: 10000,
      currency: 'THB',
    };
    expect(redactPanValues(input)).toEqual(input);
  });

  it('is safe against deeply-nested inputs (depth bound)', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i++) {
      deep = { nested: deep };
    }
    // Should not throw/stack-overflow
    expect(() => redactPanValues(deep)).not.toThrow();
  });

  it('handles null / undefined / primitives without error', () => {
    expect(redactPanValues(null)).toBe(null);
    expect(redactPanValues(undefined)).toBe(undefined);
    expect(redactPanValues(42)).toBe(42);
    expect(redactPanValues(true)).toBe(true);
    expect(redactPanValues('4242424242424242')).toBe('[REDACTED]');
  });

  // PCI guardian Finding 1 — space / hyphen formatted PANs must also
  // be caught. These used to evade the anchored digit-only regex.
  it.each([
    '4242 4242 4242 4242',
    '4242-4242-4242-4242',
    '5555 5555 5555 4444',
    '3782 822463 10005', // Amex pretty-print
    '  4242424242424242 ', // leading/trailing spaces not part of PAN shape
  ])('redacts pretty-printed PAN %s', (pretty) => {
    // First 4 cases: internal separators are stripped and match.
    // Last case (leading/trailing whitespace): shape regex rejects,
    // stays unchanged — documents the boundary that we don't trim
    // outer whitespace (prose/logging concern, not a PAN concern).
    const out = redactPanValues({ note: pretty });
    const value = (out as { note: string }).note;
    if (pretty.trim() === pretty) {
      expect(value).toBe('[REDACTED]');
    } else {
      // Only outer-whitespace case — input passes through unchanged.
      // A caller that logs trimmed values is covered by the
      // internal-separator cases above.
      expect(value).toBe(pretty);
    }
  });

  it('redacts nested object-in-array leaks (PCI guardian test gap Axis 8)', () => {
    const out = redactPanValues({
      items: [{ pan: '4242424242424242' }, { ok: 'value' }],
    });
    const items = (out as { items: Array<{ pan?: string; ok?: string }> }).items;
    expect(items[0]?.pan).toBe('[REDACTED]');
    expect(items[1]?.ok).toBe('value');
  });

  it('passes through Symbol and BigInt without error (PCI guardian Axis 10)', () => {
    const sym = Symbol('test');
    expect(redactPanValues(sym)).toBe(sym);
    expect(redactPanValues(42n)).toBe(42n);
  });
});

describe('F7 unsubscribe-token redaction (Round 3 T-F7-07)', () => {
  // Build a minimal pino logger mirroring the prod redact config.
  function captureLog(log: Record<string, unknown>): string {
    const chunks: string[] = [];
    const logger = pino(
      {
        level: 'info',
        redact: { paths: REDACT_PATHS, censor: '[REDACTED]', remove: false },
      },
      {
        write(chunk: string) {
          chunks.push(chunk);
        },
      } as unknown as NodeJS.WritableStream,
    );
    logger.info(log, 'test');
    return chunks.join('');
  }

  it('redacts top-level tokenPlaintext (Round 3 T-F7-07 — UnsubscribeRecipientInput field)', () => {
    const out = captureLog({
      tokenPlaintext: 'v1.eyJ0aWQiOiJ0ZW5hbnQifQ.deadbeefcafe',
      msg: 'test',
    });
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('v1.eyJ0aWQiOiJ0ZW5hbnQifQ.deadbeefcafe');
  });

  it('redacts nested *.tokenPlaintext (depth 2)', () => {
    const out = captureLog({
      input: { tokenPlaintext: 'v1.payload.signature' },
      msg: 'test',
    });
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('v1.payload.signature');
  });

  it('redacts unsubscribeToken alongside tokenPlaintext (both shapes covered)', () => {
    const out = captureLog({
      unsubscribeToken: 'v1.aaa.bbb',
      tokenPlaintext: 'v1.ccc.ddd',
      msg: 'test',
    });
    expect(out).not.toContain('v1.aaa.bbb');
    expect(out).not.toContain('v1.ccc.ddd');
  });
});

/**
 * R6 staff-review B3 fix — F7 PDPA/GDPR redact paths assertion.
 *
 * FR-042 (NON-NEGOTIABLE) requires pino logs to NEVER contain raw
 * recipient emails, raw email body content, raw subject lines, Resend
 * API keys or webhook secrets, unsubscribe-token plaintext, or session
 * cookies. The Round 3 commit f212c7c added the redact paths to
 * `src/lib/logger.ts:285–370` but the test file pinned only F5 PCI
 * paths — so a future refactor that breaks the F7 redact paths would
 * not be caught by CI. This block closes that test gap.
 */
describe('F7 broadcasts redact paths (R6 B3 fix — FR-042 PDPA/GDPR)', () => {
  function captureLog(log: Record<string, unknown>): string {
    const chunks: string[] = [];
    const logger = pino(
      {
        level: 'info',
        redact: { paths: REDACT_PATHS, censor: '[REDACTED]', remove: false },
      },
      {
        write(chunk: string) {
          chunks.push(chunk);
        },
      } as unknown as NodeJS.WritableStream,
    );
    logger.info(log, 'test');
    return chunks.join('');
  }

  it.each([
    // Resend Broadcasts API key — separate product surface from F1
    // transactional Resend; rotation cadence independent.
    'RESEND_BROADCASTS_API_KEY',
    'resend_broadcasts_api_key',
    // Resend webhook signing secret (Svix HMAC).
    'RESEND_BROADCASTS_WEBHOOK_SECRET',
    'resend_broadcasts_webhook_secret',
    // Unsubscribe-token HMAC secret (independent from auth cookie).
    'UNSUBSCRIBE_TOKEN_SECRET',
    'unsubscribe_token_secret',
    'unsubscribeTokenSecret',
  ])('redacts F7 secret env-var %s', (field) => {
    const out = captureLog({ [field]: 'whsec_F7_HIGHLY_SENSITIVE_VALUE' });
    expect(out).not.toContain('F7_HIGHLY_SENSITIVE_VALUE');
    expect(out).toContain('[REDACTED]');
  });

  it.each([
    // Member-authored body content. DOMPurify-sanitised; logging would
    // still leak the broadcast subject + content to log aggregators.
    'body_html',
    // Recipient PII — the entire point of the F7 module is to send
    // marketing email; logging recipient lists would defeat the
    // suppression cascade and leak member directory.
    'recipient_emails',
    'recipientEmails',
    'recipient_email_lower',
    'recipientEmailLower',
    'custom_recipient_emails',
    // Unsubscribe-token plaintext — token compromise grants
    // suppression-trigger ability for the recipient identified by the
    // token's tenantId+email payload.
    'unsubscribe_token',
    'unsubscribeToken',
  ])('redacts F7 PII/content field %s', (field) => {
    const out = captureLog({
      [field]: '<p>Subject: Welcome 2026 — body of newsletter</p>',
    });
    expect(out).not.toContain('Welcome 2026');
    expect(out).not.toContain('newsletter');
    expect(out).toContain('[REDACTED]');
  });

  it.each([
    // Svix webhook headers — signature/id/timestamp tuple is required
    // for replay/forgery analysis if leaked, since the verifier accepts
    // any (id, ts, body) combo with a matching MAC.
    'svix-signature',
    'svixSignature',
    'svix-id',
    'svixId',
    'svix-timestamp',
  ])('redacts Svix webhook header %s', (field) => {
    const out = captureLog({
      [field]: 'v1,SECRET_MAC_VALUE_THAT_MUST_NOT_LEAK',
    });
    expect(out).not.toContain('SECRET_MAC_VALUE_THAT_MUST_NOT_LEAK');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts F7 PII at depth-1 nesting (audit-payload shape)', () => {
    const out = captureLog({
      audit: {
        payload: {
          recipient_emails: ['member-A@example.com', 'member-B@example.com'],
          body_html: '<p>Newsletter content</p>',
        },
      },
    });
    expect(out).toContain('[REDACTED]');
  });

  // R7 staff-review MED-S2 fix — explicit depth-2 assertions for
  // `audit.payload.<F7_PII_field>` shape that production webhook +
  // cron audit emits actually use. Without these, a future refactor
  // that drops the `*.*.body_html` / `*.*.recipient_emails` patterns
  // from REDACT_PATHS would not be caught by CI even though the
  // production log line is the EXACT shape we care about.
  it.each([
    [
      'audit.payload.body_html',
      { audit: { payload: { body_html: '<p>SECRET_NEWSLETTER_CONTENT</p>' } } },
      'SECRET_NEWSLETTER_CONTENT',
    ],
    [
      'audit.payload.recipient_emails',
      { audit: { payload: { recipient_emails: ['LIVE_CEO@example.com'] } } },
      'LIVE_CEO@example.com',
    ],
    [
      'audit.payload.recipientEmails (camelCase)',
      { audit: { payload: { recipientEmails: ['LIVE_CTO@example.com'] } } },
      'LIVE_CTO@example.com',
    ],
    [
      'audit.payload.custom_recipient_emails',
      { audit: { payload: { custom_recipient_emails: ['LIVE_CFO@example.com'] } } },
      'LIVE_CFO@example.com',
    ],
    [
      'audit.payload.recipient_email_lower',
      { audit: { payload: { recipient_email_lower: 'LIVE_COO@example.com' } } },
      'LIVE_COO@example.com',
    ],
  ])('depth-2 redact: %s', (_name, log, secret) => {
    const out = captureLog(log as Record<string, unknown>);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('synthetic F7 webhook log shape — no raw email/body/secret leaks', () => {
    const synthetic = {
      requestId: 'req-r6-b3',
      tenantId: 'swecham',
      broadcastId: 'bc-r6-b3',
      // Fields that MUST be redacted per FR-042.
      RESEND_BROADCASTS_WEBHOOK_SECRET: 'whsec_LIVE_HIGHLY_SENSITIVE',
      'svix-signature': 'v1,LIVE_SIGNATURE_VALUE',
      body_html: '<p>Quarterly newsletter — confidential member content</p>',
      recipient_emails: ['ceo@example.com', 'cfo@example.com'],
      unsubscribe_token: 'v1.eyJ0aWQiOiJzd2VjaGFtIn0.LIVE_TOKEN_MAC',
      tokenPlaintext: 'v1.eyJ0aWQiOiJzd2VjaGFtIn0.LIVE_TOKEN_MAC',
    };
    const out = captureLog(synthetic);
    expect(out).not.toContain('LIVE_HIGHLY_SENSITIVE');
    expect(out).not.toContain('LIVE_SIGNATURE_VALUE');
    expect(out).not.toContain('confidential member content');
    expect(out).not.toContain('ceo@example.com');
    expect(out).not.toContain('cfo@example.com');
    expect(out).not.toContain('LIVE_TOKEN_MAC');
    expect(out).toContain('[REDACTED]');
  });
});
