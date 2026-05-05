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
