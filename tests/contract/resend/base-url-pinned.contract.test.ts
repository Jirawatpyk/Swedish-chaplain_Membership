// @vitest-environment node
/**
 * Spec 141 slice 2 — every Resend client is built with an explicit
 * `baseUrl`, so RESEND_BASE_URL in the environment (read by resend@6.35 when a
 * client is built) can never send the Bearer key, or a member's email, to
 * another host. The env var is set BEFORE any client module loads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env['RESEND_BASE_URL'] = 'https://elsewhere.invalid';
});

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

import { emailSender } from '@/modules/auth/infrastructure/email/resend-client';
import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';
import {
  __setRetryDelaysForTesting,
  resendTransactionalRenewalGateway,
} from '@/modules/renewals/infrastructure/resend-transactional-renewal-gateway';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import { json, stubWire } from './_wire';

beforeEach(() => {
  vi.useRealTimers();
  __setRetryDelaysForTesting([0, 0, 0]);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RESEND_BASE_URL cannot move any Resend client (spec 141)', () => {
  it('the auth sender', async () => {
    const calls = stubWire(() => json(200, { id: 'msg-1' }));
    await emailSender.send({ to: 'member@example.com', subject: 'S', html: '<p>B</p>' });
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['api.resend.com']);
  });

  it('the Broadcasts gateway', async () => {
    const calls = stubWire(() => json(201, { object: 'audience', id: 'aud_1', name: 'probe' }));
    await resendBroadcastsGateway.createAudience('probe');
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['api.resend.com']);
  });

  it('the renewals gateway', async () => {
    const calls = stubWire(() => json(200, { id: 'rs-1' }));
    await resendTransactionalRenewalGateway.sendRenewalEmail({
      tenantId: 'tenanta',
      cycleId: asCycleId('00000000-0000-0000-0000-000000000c01'),
      stepId: 't-30.email',
      templateId: 'renewal.t-30.regular',
      recipient: {
        memberId: '00000000-0000-0000-0000-000000000aaa',
        toEmail: 'admin@acme.example',
        toName: 'Anna Adm',
        preferredLocale: 'en',
      },
      templateVariables: {
        member_first_name: 'Anna',
        member_company_name: 'Acme Co',
        cycle_expires_at: '2026-08-15T00:00:00Z',
        days_until_expiry: 30,
        renewal_link_url: 'https://swecham.example/portal/renewal/aaa',
      },
      idempotencyKey: 'reminder-event-id-1',
    });
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['api.resend.com']);
  });
});
