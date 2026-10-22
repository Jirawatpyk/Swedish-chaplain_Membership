/**
 * The integration setup replaces the transactional `emailSender` with a
 * fake (tests/integration-setup.ts). Without it, any suite that calls the
 * outbox dispatcher sends every pending row on the shared dev branch through
 * the real Resend key. This file is the positive control that the default
 * mock is in force for a suite that does not mock the sender itself. It
 * lives in `invoicing/` so the nightly rotation sweeps it.
 */
import { Resend } from 'resend';
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
    expect(result).toMatchObject({
      ok: true,
      value: { messageId: expect.stringMatching(/^integration-mock-/) },
    });
  });

  it('a Resend client built directly (the F8 renewal gateway) sends through the fake', async () => {
    const client = new Resend('re_harness_check');
    // Checked before sending, so a regression fails without a live call.
    expect(vi.isMockFunction(client.emails.send)).toBe(true);
    const response = await client.emails.send({
      from: 'harness@swecham.test',
      to: 'no-live-resend@swecham.test',
      subject: 'harness check',
      text: 'harness check',
    });
    expect(response).toMatchObject({ data: { id: expect.stringMatching(/^integration-mock-/) }, error: null });
    expect(typeof client.broadcasts.create).toBe('function');
  });
});
