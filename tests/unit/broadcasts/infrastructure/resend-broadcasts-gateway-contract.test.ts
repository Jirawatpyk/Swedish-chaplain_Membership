import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createResendContractFake } from '../../../support/broadcasts/resend-contract-fake';

const fake = createResendContractFake();
vi.mock('@/modules/broadcasts/infrastructure/resend/resend-broadcasts-client', () => ({
  getResendBroadcastsClient: () => fake.client,
}));

import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';

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
});
