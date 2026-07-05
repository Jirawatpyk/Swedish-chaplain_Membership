import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createResendContractFake } from '../../../support/broadcasts/resend-contract-fake';

const fake = createResendContractFake();
vi.mock('@/modules/broadcasts/infrastructure/resend/resend-broadcasts-client', () => ({
  getResendBroadcastsClient: () => fake.client,
}));

import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';
import { stripAngleBrackets } from '@/modules/broadcasts/infrastructure/resend/bare-email';

// Minimal valid createBroadcast input; individual tests override `name`/`fromName`.
function input(over: Partial<Parameters<typeof resendBroadcastsGateway.createBroadcast>[0]>) {
  return {
    audienceId: 'aud_fake_1',
    subject: 'Hi',
    htmlBody: '<p>hi</p>',
    fromName: 'SweCham',
    fromEmail: 'noreply@zyncdata.app',
    replyToEmail: 'noreply@zyncdata.app',
    broadcastNameForResendDashboard: 'SweCham — Hi',
    tenantDisplayName: 'SweCham',
    locale: 'en' as const,
    ...over,
  };
}

describe('resendBroadcastsGateway.createBroadcast — Resend contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts a <=70-code-point name', async () => {
    await expect(resendBroadcastsGateway.createBroadcast(input({}))).resolves.toMatchObject({ broadcastId: 'bcast_fake_1' });
  });

  it('rejects a >70-code-point name (the #2 regression guard)', async () => {
    const longName = 'x'.repeat(71);
    await expect(resendBroadcastsGateway.createBroadcast(input({ broadcastNameForResendDashboard: longName }))).rejects.toThrow();
  });

  it('composes a single-wrapped from when fromEmail is bare', async () => {
    await expect(resendBroadcastsGateway.createBroadcast(input({ fromName: 'E2E Alpha Co via TSCC', fromEmail: 'noreply@zyncdata.app' }))).resolves.toMatchObject({ broadcastId: 'bcast_fake_1' });
  });

  it('does NOT double-wrap when fromEmail is "Name <email>" (the #3 regression guard)', async () => {
    // Before the fix this produced `… <SweCham <noreply@…>>` and the fake (like
    // real Resend) rejects the nested `<>`.
    await expect(resendBroadcastsGateway.createBroadcast(input({ fromName: 'E2E Alpha Co via TSCC', fromEmail: 'SweCham <noreply@zyncdata.app>' }))).resolves.toMatchObject({ broadcastId: 'bcast_fake_1' });
  });

  it('strips angle brackets from fromName so a `<Acme>` company name yields a valid `from` (Finding B)', async () => {
    // `composeBroadcastFromName` interpolates the member company name raw. A
    // name with `<`/`>` (e.g. `<Acme> via SweCham`) previously produced
    // `from: "<Acme> via SweCham <noreply@…>"` — an invalid RFC 5322 address
    // the contract-fake (like real Resend) now rejects. After stripping, the
    // `from` is `Acme via SweCham <noreply@…>` and the create succeeds.
    await expect(
      resendBroadcastsGateway.createBroadcast(
        input({ fromName: '<Acme> via SweCham', fromEmail: 'noreply@zyncdata.app' }),
      ),
    ).resolves.toMatchObject({ broadcastId: 'bcast_fake_1' });
  });

  it('stripAngleBrackets removes < and > and collapses whitespace (direct)', () => {
    expect(stripAngleBrackets('<Acme> via SweCham')).toBe('Acme via SweCham');
    expect(stripAngleBrackets('Acme> <Corp via TSCC')).toBe('Acme Corp via TSCC');
    expect(stripAngleBrackets('  Plain Name  ')).toBe('Plain Name');
    expect(stripAngleBrackets('No brackets here')).toBe('No brackets here');
  });
});

describe('resendBroadcastsGateway.addContactsToAudience — 429 rate-limit handling (BUG-028)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  type Contact = Parameters<typeof resendBroadcastsGateway.addContactsToAudience>[1][number];
  const contact = (email: string): Contact => ({ emailLower: email }) as Contact;

  it('retries a single 429 with backoff and does NOT re-create the contacts that already succeeded', async () => {
    vi.useFakeTimers();
    // Contact A succeeds; contact B answers 429 once, then succeeds on retry.
    let call = 0;
    const createSpy = vi
      .spyOn(fake.client.contacts, 'create')
      .mockImplementation(async () => {
        call += 1;
        if (call === 2) {
          return {
            data: null,
            error: {
              statusCode: 429,
              message: 'Too many requests. You can only make 2 requests per second.',
              name: 'rate_limit_exceeded',
            },
          } as Awaited<ReturnType<typeof fake.client.contacts.create>>;
        }
        return { data: { id: `contact_${call}` }, error: null } as Awaited<
          ReturnType<typeof fake.client.contacts.create>
        >;
      });

    const promise = resendBroadcastsGateway.addContactsToAudience('aud_fake_1', [
      contact('a@example.com'),
      contact('b@example.com'),
    ]);
    // Only timer in play is the single 1s backoff for B's one 429 — no fixed
    // per-contact pacing exists anymore (that caused the dispatch timeout).
    await vi.advanceTimersByTimeAsync(1_500);
    await promise;

    // 3 calls total: A(ok), B(429), B(retry ok).
    expect(createSpy).toHaveBeenCalledTimes(3);
    const emails = createSpy.mock.calls.map((c) => (c[0] as { email: string }).email);
    // A is created exactly ONCE — the retry did not re-run the whole batch.
    expect(emails.filter((e) => e === 'a@example.com')).toHaveLength(1);
    expect(emails.filter((e) => e === 'b@example.com')).toHaveLength(2);
  });

  it('treats 429 as retryable (not permanent) — exhausts the backoff schedule before throwing', async () => {
    vi.useFakeTimers();
    const createSpy = vi.spyOn(fake.client.contacts, 'create').mockResolvedValue({
      data: null,
      error: { statusCode: 429, message: 'rate limited', name: 'rate_limit_exceeded' },
    } as Awaited<ReturnType<typeof fake.client.contacts.create>>);

    const settled = resendBroadcastsGateway
      .addContactsToAudience('aud_fake_1', [contact('x@example.com')])
      .then(() => 'resolved')
      .catch((e: unknown) => e);
    // Backoff schedule 1+2+4+8+16 = 31s across 5 retries.
    await vi.advanceTimersByTimeAsync(35_000);
    const outcome = await settled;

    // Initial attempt + 5 retries = 6 calls proves 429 flows through withRetry
    // (a 'permanent' classification would have thrown after a single call).
    expect(createSpy).toHaveBeenCalledTimes(6);
    expect(outcome).toBeInstanceOf(Error);
  });
});

describe('resendBroadcastsGateway.listAudiences — Resend contract', () => {
  it('maps created_at→createdAt and returns only live audiences after create×2 then remove×1', async () => {
    // The module-level `fake` is already wired into the gateway via the
    // top-of-file vi.mock — calling resendBroadcastsGateway.listAudiences()
    // goes through the REAL gateway impl (create→send→list mapping logic)
    // against the in-memory fake, never hitting real Resend.
    //
    // The createBroadcast describe-block above does not call audiences.create,
    // so the fake's audience counter is still 0 here.
    const r1 = await fake.client.audiences.create({ name: 'Audience Alpha' });
    const r2 = await fake.client.audiences.create({ name: 'Audience Beta' });
    expect(r1.data?.id).toBe('aud_fake_1');
    expect(r2.data?.id).toBe('aud_fake_2');

    // Remove the first one.
    await fake.client.audiences.remove('aud_fake_1');

    // Drive the REAL gateway method — this is the point of this test.
    // If the gateway mis-reads result.data instead of result.data.data, or
    // forgets to map created_at→createdAt, this assertion fails.
    const audiences = await resendBroadcastsGateway.listAudiences();

    expect(audiences).toHaveLength(1);
    expect(audiences[0]).toMatchObject({ id: 'aud_fake_2', name: 'Audience Beta' });
    // Proves the gateway maps snake_case created_at → camelCase createdAt (as Date).
    expect(audiences[0]?.createdAt).toBeInstanceOf(Date);
  });
});
