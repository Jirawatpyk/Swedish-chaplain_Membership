/**
 * F8 Phase 4 Wave I3 / T100 spec — Resend transactional renewal gateway.
 *
 * Test scope:
 *   - Resend SDK invocation with idempotency-key header
 *   - HTML + plain-text both rendered
 *   - Resend error code → SendRenewalEmailError mapping (4xx, 5xx, unsubscribed, etc.)
 *   - Retry budget (3 attempts on transient failures, fixed delays)
 *   - FROM address resolution (env override + fallback)
 *   - Reply-to threading from input
 *   - Stub-equivalent inputs (stepId / templateId parsing)
 */
import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest';

type SendResponse = {
  data: { id: string } | null;
  error: { name: string; message: string } | null;
};
const sendMock = vi.hoisted(() =>
  vi.fn(
    async (_input: Record<string, unknown>): Promise<SendResponse> => ({
      data: { id: 'mock-resend-id-1' },
      error: null,
    }),
  ),
);

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

// Mock React Email render — JSDOM render is ~500ms per call which
// blows the test timeout on retry-budget exhaustion paths (4 calls).
// Tests don't validate HTML content; that's covered by the template
// snapshot tests.
// Minimal mock of @react-email/components — `render()` returns a
// placeholder string instantly. JSDOM render of the full template is
// ~500ms-2s per call; under 4-attempt retry-exhaustion paths that
// blows the 30s test timeout. The template content is validated by
// the dedicated template test file (copy.test.ts +
// dual-format-date-footer.test.ts), so this gateway test only needs
// to verify Resend invocation semantics.
vi.mock('@react-email/components', () => ({
  render: vi.fn(
    async () =>
      '<html><body>Rendered renewal reminder template stub for Anna at Acme Co — ' +
      'this is mocked HTML content with enough length to satisfy the basic ' +
      'sanity assertion in the test suite.</body></html>',
  ),
  // Component re-exports — return-as-is JSX-friendly stubs so the
  // template tree doesn't error on element creation. The render is
  // mocked anyway so these don't actually need to render correctly.
  Html: ({ children }: { children?: unknown }) => children as never,
  Head: () => null as never,
  Body: ({ children }: { children?: unknown }) => children as never,
  Container: ({ children }: { children?: unknown }) => children as never,
  Section: ({ children }: { children?: unknown }) => children as never,
  Text: ({ children }: { children?: unknown }) => children as never,
  Button: ({ children }: { children?: unknown }) => children as never,
  Preview: () => null as never,
}));

vi.mock('@/lib/env', () => ({
  env: {
    resend: {
      apiKey: 'test-resend-key',
      fromEmail: 'SweCham <test@swecham.example>',
    },
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

import {
  resendTransactionalRenewalGateway,
  __setRetryDelaysForTesting,
} from '@/modules/renewals/infrastructure/resend-transactional-renewal-gateway';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';


const VALID_INPUT = {
  tenantId: 'tenanta',
  cycleId: asCycleId('00000000-0000-0000-0000-000000000c01'),
  stepId: 't-30.email',
  templateId: 'renewal.t-30.regular',
  recipient: {
    memberId: '00000000-0000-0000-0000-000000000aaa',
    toEmail: 'admin@acme.example',
    toName: 'Anna Adm',
    preferredLocale: 'en' as const,
  },
  templateVariables: {
    member_first_name: 'Anna',
    member_company_name: 'Acme Co',
    cycle_expires_at: '2026-08-15T00:00:00Z',
    days_until_expiry: 30,
    renewal_link_url: 'https://swecham.zyncdata.app/portal/renewal/aaa?token=xyz',
  },
  idempotencyKey: 'reminder-event-id-1',
};

describe('resendTransactionalRenewalGateway', () => {
  beforeAll(() => {
    // Opt out of the global fake-timers setup (tests/setup.ts) for
    // this file — the gateway's retry budget uses real setTimeout
    // for backoff, and fake timers cause indefinite hangs.
    vi.useRealTimers();
    // Skip real retry waits — 1ms × 3 = 3ms total instead of 7s.
    __setRetryDelaysForTesting([1, 1, 1]);
  });
  beforeEach(() => {
    sendMock.mockClear();
    sendMock.mockResolvedValue({
      data: { id: 'mock-resend-id-1' },
      error: null,
    });
  });

  describe('happy path', () => {
    it('sends with idempotency-key header + returns deliveryId + dispatchedAt', async () => {
      const result = await resendTransactionalRenewalGateway.sendRenewalEmail(
        VALID_INPUT,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.deliveryId).toBe('mock-resend-id-1');
      expect(result.value.dispatchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(sendMock).toHaveBeenCalledTimes(1);
      const sentArgs = sendMock.mock.calls[0]![0];
      expect(sentArgs.headers).toEqual({
        'idempotency-key': 'reminder-event-id-1',
      });
      expect(sentArgs.from).toBe('SweCham <test@swecham.example>');
      expect(sentArgs.to).toBe('admin@acme.example');
      expect(typeof sentArgs.subject).toBe('string');
      expect(typeof sentArgs.html).toBe('string');
      expect((sentArgs.html as string).length).toBeGreaterThan(100);
      expect(typeof sentArgs.text).toBe('string');
    });

    it('threads replyTo when provided (with display name)', async () => {
      await resendTransactionalRenewalGateway.sendRenewalEmail({
        ...VALID_INPUT,
        replyToEmail: 'reply@chamber.example',
        replyToDisplayName: 'Chamber Replies',
      });
      const sentArgs = sendMock.mock.calls[0]![0];
      expect(sentArgs.replyTo).toBe('Chamber Replies <reply@chamber.example>');
    });

    it('threads replyTo without display name', async () => {
      await resendTransactionalRenewalGateway.sendRenewalEmail({
        ...VALID_INPUT,
        replyToEmail: 'reply@chamber.example',
      });
      const sentArgs = sendMock.mock.calls[0]![0];
      expect(sentArgs.replyTo).toBe('reply@chamber.example');
    });

    it('subject interpolates placeholders correctly (template render is mocked; subject is computed by gateway directly)', async () => {
      await resendTransactionalRenewalGateway.sendRenewalEmail(VALID_INPUT);
      const sentArgs = sendMock.mock.calls[0]![0];
      // Subject is interpolated by the gateway BEFORE the template renders,
      // so this assertion validates the gateway's interpolation independent
      // of the React Email render path.
      expect(sentArgs.subject as string).toContain('Regular');
      expect(sentArgs.subject as string).toContain('30');
    });
  });

  describe('error mapping', () => {
    it('validation_error → gateway_4xx (permanent, no retry)', async () => {
      sendMock.mockResolvedValueOnce({
        data: null,
        error: { name: 'validation_error', message: 'invalid recipient' },
      });
      const result = await resendTransactionalRenewalGateway.sendRenewalEmail(
        VALID_INPUT,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('gateway_4xx');
      // Permanent — no retry, gateway called once.
      expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it('unsubscribed → recipient_unsubscribed', async () => {
      sendMock.mockResolvedValueOnce({
        data: null,
        error: { name: 'unsubscribed', message: 'recipient opted out' },
      });
      const result = await resendTransactionalRenewalGateway.sendRenewalEmail(
        VALID_INPUT,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('recipient_unsubscribed');
    });

    it('email_not_verified → recipient_email_unverified', async () => {
      sendMock.mockResolvedValueOnce({
        data: null,
        error: { name: 'email_not_verified', message: 'unverified' },
      });
      const result = await resendTransactionalRenewalGateway.sendRenewalEmail(
        VALID_INPUT,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('recipient_email_unverified');
    });

    it('5xx → retries 3 more times (4 total), then gateway_5xx', async () => {
      sendMock.mockResolvedValue({
        data: null,
        error: { name: 'rate_limit_exceeded', message: 'too many requests' },
      });
      const result = await resendTransactionalRenewalGateway.sendRenewalEmail(
        VALID_INPUT,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('gateway_5xx');
      // 1 initial + 3 retries = 4 calls
      expect(sendMock).toHaveBeenCalledTimes(4);
    }, 30_000);

    it('SDK exception → counted as 5xx + retried', async () => {
      sendMock.mockRejectedValue(new Error('connection refused'));
      const result = await resendTransactionalRenewalGateway.sendRenewalEmail(
        VALID_INPUT,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('gateway_5xx');
      expect(sendMock).toHaveBeenCalledTimes(4);
    }, 30_000);

    it('5xx then success on 2nd attempt → ok', async () => {
      sendMock
        .mockResolvedValueOnce({
          data: null,
          error: { name: 'rate_limit_exceeded', message: 'transient' },
        })
        .mockResolvedValueOnce({
          data: { id: 'retry-success-id' },
          error: null,
        });
      const result = await resendTransactionalRenewalGateway.sendRenewalEmail(
        VALID_INPUT,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.deliveryId).toBe('retry-success-id');
      expect(sendMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('input validation', () => {
    it('unknown stepId → template_variables_missing(offset_day)', async () => {
      const result = await resendTransactionalRenewalGateway.sendRenewalEmail({
        ...VALID_INPUT,
        stepId: 'invalid.email',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('template_variables_missing');
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('unknown templateId tier → template_variables_missing(tier)', async () => {
      const result = await resendTransactionalRenewalGateway.sendRenewalEmail({
        ...VALID_INPUT,
        templateId: 'renewal.t-30.unknown-tier',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('template_variables_missing');
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('templateId with hyphenated tier (thai-alumni) is recognized', async () => {
      const result = await resendTransactionalRenewalGateway.sendRenewalEmail({
        ...VALID_INPUT,
        stepId: 't-30.email',
        templateId: 'renewal.t-30.thai-alumni',
      });
      expect(result.ok).toBe(true);
    });
  });
});

/**
 * K14-2 (R13-W2) — `sanitizeResendErrorMessage` direct unit tests.
 *
 * Closes the Constitution Principle II gap on a security-critical
 * function: K13-3 introduced this regex pipeline to prevent Resend
 * account-scoped identifiers (API key prefixes, sending domains,
 * recipient emails) from persisting in `audit_log.payload.failure_
 * message` (5-year retention). The function was exported for
 * testability but never exercised — a regex regression would have
 * silently leaked PII for 5 years.
 *
 * Branches under test:
 *   1. API key prefix `re_xxx…` → `[REDACTED_KEY]`
 *   2. Email address → `[REDACTED_EMAIL]`
 *   3. Single-label domain (`example.com`) → `[REDACTED_DOMAIN]`
 *   4. Multi-label domain (K14-7 R13-S4 fix: `swecham.zyncdata.app`
 *      fully redacts, not leaving `swecham.` exposed)
 *   5. Combined (key + email + domain in one string)
 *   6. Truncation at exactly 100 chars (> 100 chars input)
 *   7. Pass-through for safe input (no regex matches → unchanged)
 */
describe('sanitizeResendErrorMessage (K14-2 R13-W2)', () => {
  // Re-import via dynamic import to dodge Vitest module-load timing
  // around the gateway-level mocks. The function is pure and has no
  // dependencies on the mocked Resend SDK / logger / metrics.
  let sanitize: (msg: string) => string;
  beforeAll(async () => {
    const mod = await import(
      '@/modules/renewals/infrastructure/resend-transactional-renewal-gateway'
    );
    sanitize = mod.sanitizeResendErrorMessage;
  });

  it('redacts a Resend API-key prefix', () => {
    const out = sanitize('Failed using key re_abc123def456 for sending');
    expect(out).toContain('[REDACTED_KEY]');
    expect(out).not.toContain('re_abc123def456');
  });

  it('redacts an email address', () => {
    const out = sanitize('Bounced for user@example.com');
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).not.toContain('user@example.com');
  });

  it('redacts a single-label domain', () => {
    const out = sanitize('Sender swecham.com is not verified');
    expect(out).toContain('[REDACTED_DOMAIN]');
    expect(out).not.toContain('swecham.com');
  });

  it('K14-7 (R13-S4): redacts a multi-label subdomain fully — no prefix leak', () => {
    const out = sanitize('Could not send from swecham.zyncdata.app');
    expect(out).toContain('[REDACTED_DOMAIN]');
    // Prior-K14 regex matched only `zyncdata.app`, leaving `swecham.`
    // unredacted. K14-7 multi-label LHS captures the entire FQDN.
    expect(out).not.toContain('swecham.zyncdata.app');
    expect(out).not.toContain('swecham.');
  });

  it('redacts ALL three patterns when combined in one string', () => {
    const out = sanitize(
      'Key re_abc12345 sent to user@example.com via swecham.zyncdata.app',
    );
    expect(out).toContain('[REDACTED_KEY]');
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).toContain('[REDACTED_DOMAIN]');
    expect(out).not.toMatch(/re_abc/);
    expect(out).not.toContain('user@example.com');
    expect(out).not.toContain('swecham.zyncdata.app');
  });

  it('truncates at 100 characters (cap applied AFTER redaction)', () => {
    // 200-char safe input — no regex matches → truncation only.
    const long = 'a'.repeat(200);
    const out = sanitize(long);
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it('passes through a safe input with no PII unchanged (within length cap)', () => {
    const safe = 'request timed out at upstream';
    expect(sanitize(safe)).toBe(safe);
  });

  it('empty string input returns empty string', () => {
    expect(sanitize('')).toBe('');
  });

  it('trims trailing whitespace after truncation', () => {
    // 99 chars + ' '.repeat(20) → after slice(0,100) = 99 chars + ' '
    // → trim() removes the trailing space.
    const input = 'a'.repeat(99) + '                    ';
    const out = sanitize(input);
    expect(out).toBe('a'.repeat(99));
  });

  it('K15-4 (R14-S2): redacts chamber-locale TLDs (.se, .th, .au, .uk, .de)', () => {
    // K15 extended the TLD allowlist to cover Swedish, Thai,
    // Australian, and other European chamber locales. Verify each
    // representative TLD is now redacted.
    const tlds = ['.se', '.th', '.au', '.uk', '.de', '.nl', '.fr'];
    for (const tld of tlds) {
      const out = sanitize(`Sender example${tld} is unverified`);
      expect(out).toContain('[REDACTED_DOMAIN]');
      expect(out).not.toContain(`example${tld}`);
    }
  });

  it('K15-5 (R14-S3): TLD outside allowlist passes through by design (e.g. .example, .invalid)', () => {
    // Closed-set design: novel/test TLDs intentionally pass through
    // unredacted because (a) `audit_log` is internal-only, (b) the
    // bounded TLD list is the trade-off for predictable false-
    // positive behaviour. This test pins the design — if the team
    // ever wants to redact ALL `.<tld>` patterns, they must
    // explicitly remove this test along with the regex change so
    // the intent shift is reviewed.
    const out = sanitize('domain.example is not a real TLD');
    expect(out).toContain('domain.example');
    expect(out).not.toContain('[REDACTED_DOMAIN]');
  });

  it('K15-5 (R14-S4): completes in <50ms on adversarial repetitive input (ReDoS guard)', () => {
    // The K14-7 multi-label regex `(?:[A-Za-z0-9-]+\.)+(?:com|...)`
    // has a `+` quantifier inside a non-capturing group. V8's NFA
    // regex engine handles this in linear time on the typical
    // bounded input; this test pins the timing guard so a future
    // engine swap or regex change that introduces catastrophic
    // backtracking is caught at CI time. Threshold 50ms is generous
    // (typical run is <1ms); adversarial input is bounded by the
    // 100-char truncate cap applied AFTER sanitize but the regex
    // runs first, so we test the unbounded-input case here.
    const adversarial = 'a.'.repeat(50) + 'xyz';
    const start = performance.now();
    sanitize(adversarial);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
