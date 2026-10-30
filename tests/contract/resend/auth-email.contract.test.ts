// @vitest-environment node
/**
 * Spec 141 RS1 — the auth transactional sender (`emailSender`, password reset
 * and the outbox's verification / invitation / invoice / receipt mail) on the
 * wire, driven through the REAL `resend` SDK against a stubbed `fetch`.
 * Written on resend 4.8 (green by design); a bump that changes the request a
 * member's email rides on, or how the reply is read, turns it red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pin the env the sender reads at module load, so the recorded `from` is the
// hard-coded fallback on every machine, not each developer's RESEND_FROM_EMAIL.
vi.mock('@/lib/env', () => ({
  env: {
    resend: { apiKey: 're_contract_test_key', fromEmail: undefined },
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

import { emailSender } from '@/modules/auth/infrastructure/email/resend-client';
import { json, stubWire } from './_wire';

const MESSAGE = { to: 'member@example.com', subject: 'Reset your password', html: '<p>Body</p>' };

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('emailSender on the wire (spec 141)', () => {
  it('a plain send', async () => {
    const calls = stubWire(() => json(200, { id: 'msg-1' }));
    await expect(emailSender.send(MESSAGE)).resolves.toEqual({ ok: true, value: { messageId: 'msg-1' } });
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": {
            "from": "SweCham <noreply@dxtspace.com>",
            "html": "<p>Body</p>",
            "subject": "Reset your password",
            "to": "member@example.com",
          },
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "POST",
          "url": "https://api.resend.com/emails",
        },
      ]
    `);
  });

  it('a send with a text part', async () => {
    const calls = stubWire(() => json(200, { id: 'msg-2' }));
    await emailSender.send({ ...MESSAGE, text: 'Body' });
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": {
            "from": "SweCham <noreply@dxtspace.com>",
            "html": "<p>Body</p>",
            "subject": "Reset your password",
            "text": "Body",
            "to": "member@example.com",
          },
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "POST",
          "url": "https://api.resend.com/emails",
        },
      ]
    `);
  });

  it('a send with a PDF attachment (the invoice / receipt path)', async () => {
    const calls = stubWire(() => json(200, { id: 'msg-3' }));
    await emailSender.send({
      ...MESSAGE,
      attachments: [{ filename: 'INV-0001.pdf', content: new Uint8Array([0x25, 0x50, 0x44, 0x46]), contentType: 'application/pdf' }],
    });
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": {
            "attachments": [
              {
                "content": {
                  "data": [
                    37,
                    80,
                    68,
                    70,
                  ],
                  "type": "Buffer",
                },
                "content_type": "application/pdf",
                "filename": "INV-0001.pdf",
              },
            ],
            "from": "SweCham <noreply@dxtspace.com>",
            "html": "<p>Body</p>",
            "subject": "Reset your password",
            "to": "member@example.com",
          },
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "POST",
          "url": "https://api.resend.com/emails",
        },
      ]
    `);
  });

  it('reads a 422 validation_error as invalid-recipient, with no retry', async () => {
    const calls = stubWire(() => json(422, { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' }));
    await expect(emailSender.send(MESSAGE)).resolves.toMatchInlineSnapshot(`
      {
        "error": {
          "code": "invalid-recipient",
          "message": "Invalid \`to\` field.",
        },
        "ok": false,
      }
    `);
    expect(calls).toHaveLength(1);
  });

  it('reads a 500 as transient and retries it', async () => {
    vi.useFakeTimers();
    const calls = stubWire((n) =>
      n === 1 ? json(500, { statusCode: 500, name: 'application_error', message: 'boom' }) : json(200, { id: 'msg-4' }),
    );
    const sent = emailSender.send(MESSAGE);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(sent).resolves.toEqual({ ok: true, value: { messageId: 'msg-4' } });
    expect(calls).toHaveLength(2);
  });

  it('reads a network failure as transient and retries it', async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n === 1) throw new TypeError('fetch failed');
        return json(200, { id: 'msg-5' });
      }),
    );
    const sent = emailSender.send(MESSAGE);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(sent).resolves.toEqual({ ok: true, value: { messageId: 'msg-5' } });
    expect(n).toBe(2);
  });
});
