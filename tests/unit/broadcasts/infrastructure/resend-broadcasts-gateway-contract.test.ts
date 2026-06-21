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
