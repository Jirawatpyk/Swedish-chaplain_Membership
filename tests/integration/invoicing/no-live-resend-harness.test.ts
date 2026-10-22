/**
 * The integration setup replaces the transactional `emailSender` with a
 * fake (tests/integration-setup.ts). Without it, any suite that calls the
 * outbox dispatcher sends every pending row on the shared dev branch through
 * the real Resend key. This file is the positive control that the default
 * mock is in force for a suite that does not mock the sender itself. It
 * lives in `invoicing/` so the nightly rotation sweeps it.
 */
import { describe, expect, it, vi } from 'vitest';
import { emailSender } from '@/modules/auth/infrastructure/email/resend-client';

describe('integration harness: no live transactional email', () => {
  it('emailSender is the setup-file fake, not the Resend client', async () => {
    expect(vi.isMockFunction(emailSender.send)).toBe(true);
    const result = await emailSender.send({
      to: 'no-live-resend@swecham.test',
      subject: 'harness check',
      html: '<p>harness check</p>',
      text: 'harness check',
    });
    expect(result.ok && result.value.messageId).toMatch(/^integration-mock-/);
  });
});
