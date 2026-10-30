// @vitest-environment node
/**
 * Spec 141 RS1 — the renewals transactional gateway on the wire, through the
 * REAL `resend` SDK against a stubbed `fetch`. React Email's render is stubbed
 * (template content is pinned by the template tests); this file pins the
 * request the SDK builds from the gateway's call, so a bump that changes it
 * turns red. Slice 2 (RI1) deliberately moves the idempotency key from the
 * email headers to the HTTP `Idempotency-Key` and re-records these snapshots.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { json, stubWire } from './_wire';

vi.mock('@react-email/components', () => ({
  render: vi.fn(async (_el: unknown, opts?: { plainText?: boolean }) =>
    opts?.plainText ? 'Rendered text' : '<html><body>Rendered</body></html>',
  ),
  Html: ({ children }: { children?: unknown }) => children as never,
  Head: () => null as never,
  Body: ({ children }: { children?: unknown }) => children as never,
  Container: ({ children }: { children?: unknown }) => children as never,
  Section: ({ children }: { children?: unknown }) => children as never,
  Heading: ({ children }: { children?: unknown }) => children as never,
  Text: ({ children }: { children?: unknown }) => children as never,
  Button: ({ children }: { children?: unknown }) => children as never,
  Link: ({ children }: { children?: unknown }) => children as never,
  Hr: () => null as never,
  Img: () => null as never,
  Row: ({ children }: { children?: unknown }) => children as never,
  Column: ({ children }: { children?: unknown }) => children as never,
  Preview: () => null as never,
}));

vi.mock('@/lib/env', () => ({
  env: {
    resend: { apiKey: 're_contract_test_key', fromEmail: 'SweCham <test@swecham.example>' },
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

import {
  __setRetryDelaysForTesting,
  resendTransactionalRenewalGateway,
} from '@/modules/renewals/infrastructure/resend-transactional-renewal-gateway';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { SendRenewalEmailInput } from '@/modules/renewals/application/ports/renewal-gateway';

const INPUT: SendRenewalEmailInput = {
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
    renewal_link_url: 'https://swecham.example/portal/renewal/aaa?token=xyz',
  },
  idempotencyKey: 'reminder-event-id-1',
};

beforeAll(() => {
  vi.useRealTimers();
  __setRetryDelaysForTesting([0, 0, 0]);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('renewals gateway on the wire (spec 141)', () => {
  it('a reminder send', async () => {
    const calls = stubWire(() => json(200, { id: 'rs-1' }));
    const res = await resendTransactionalRenewalGateway.sendRenewalEmail(INPUT);
    expect(res.ok).toBe(true);
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": {
            "from": "SweCham <test@swecham.example>",
            "headers": {
              "idempotency-key": "reminder-event-id-1",
            },
            "html": "<html><body>Rendered</body></html>",
            "subject": "Renewal reminder: Regular membership in 30 days",
            "text": "Rendered text",
            "to": "admin@acme.example",
          },
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "POST",
          "url": "https://api.resend.com/emails",
        },
      ]
    `);
  });

  it('a reminder send with a reply-to', async () => {
    const calls = stubWire(() => json(200, { id: 'rs-2' }));
    await resendTransactionalRenewalGateway.sendRenewalEmail({
      ...INPUT,
      replyToEmail: 'office@swecham.example',
      replyToDisplayName: 'SweCham Office',
    } satisfies SendRenewalEmailInput);
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": {
            "from": "SweCham <test@swecham.example>",
            "headers": {
              "idempotency-key": "reminder-event-id-1",
            },
            "html": "<html><body>Rendered</body></html>",
            "reply_to": "SweCham Office <office@swecham.example>",
            "subject": "Renewal reminder: Regular membership in 30 days",
            "text": "Rendered text",
            "to": "admin@acme.example",
          },
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "POST",
          "url": "https://api.resend.com/emails",
        },
      ]
    `);
  });

  it('reads a 422 validation_error as a permanent failure, with no retry', async () => {
    const calls = stubWire(() => json(422, { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' }));
    const res = await resendTransactionalRenewalGateway.sendRenewalEmail(INPUT);
    expect(res).toMatchInlineSnapshot(`
      {
        "error": {
          "kind": "gateway_4xx",
          "message": "Invalid \`to\` field.",
          "retryable": false,
        },
        "ok": false,
      }
    `);
    expect(calls).toHaveLength(1);
  });

  // Added in review (recorded on 6.35, after the bump): the SDK turns a
  // thrown fetch into `statusCode: null`, which the gateway retries.
  it('reads a network failure as transient and retries it', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n === 1) throw new TypeError('fetch failed');
        return json(200, { id: 'msg-net' });
      }),
    );
    const res = await resendTransactionalRenewalGateway.sendRenewalEmail(INPUT);
    expect({ ok: res.ok, attempts: n }).toEqual({ ok: true, attempts: 2 });
  });

  it('reads a 500 as transient and retries it', async () => {
    const calls = stubWire((n) =>
      n === 1 ? json(500, { statusCode: 500, name: 'application_error', message: 'boom' }) : json(200, { id: 'msg-500' }),
    );
    const res = await resendTransactionalRenewalGateway.sendRenewalEmail(INPUT);
    expect({ ok: res.ok, attempts: calls.length }).toEqual({ ok: true, attempts: 2 });
  });
});
