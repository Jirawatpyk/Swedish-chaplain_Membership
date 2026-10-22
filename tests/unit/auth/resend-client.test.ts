/**
 * `emailSender` (resend-client.ts): Resend error → EmailError mapping and the
 * retry budget. Integration suites replace this module with a fake
 * (tests/integration-setup.ts), so this file is the only place the real
 * mapping runs.
 *   - permanent errors (validation_error, invalid_to_address) return
 *     invalid-recipient on the first call, no retry;
 *   - any other error or a throw is retried (1 s / 2 s / 4 s), then
 *     upstream-unavailable after 4 calls;
 *   - a later success returns its message id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SendResponse = {
  data: { id: string } | null;
  error: { name: string; message: string } | null;
};
const sendMock = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>): Promise<SendResponse> => ({
    data: { id: 'msg-1' },
    error: null,
  })),
);

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

import { emailSender } from '@/modules/auth/infrastructure/email/resend-client';

const MESSAGE = {
  to: 'someone@swecham.test',
  subject: 'Subject',
  html: '<p>Body</p>',
  text: 'Body',
};
const failure = (name: string): SendResponse => ({ data: null, error: { name, message: `${name} message` } });

describe('emailSender (Resend transactional)', () => {
  beforeEach(() => {
    sendMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the message id of a successful send', async () => {
    sendMock.mockResolvedValueOnce({ data: { id: 'msg-ok' }, error: null });
    await expect(emailSender.send(MESSAGE)).resolves.toEqual({ ok: true, value: { messageId: 'msg-ok' } });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it.each(['validation_error', 'invalid_to_address'])(
    'maps %s to invalid-recipient without retrying',
    async (name) => {
      sendMock.mockResolvedValue(failure(name));
      await expect(emailSender.send(MESSAGE)).resolves.toEqual({
        ok: false,
        error: { code: 'invalid-recipient', message: `${name} message` },
      });
      expect(sendMock).toHaveBeenCalledTimes(1);
    },
  );

  it('retries a transient error, then returns upstream-unavailable after 4 calls', async () => {
    sendMock.mockResolvedValue(failure('internal_server_error'));
    const pending = emailSender.send(MESSAGE);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    await expect(pending).resolves.toEqual({
      ok: false,
      error: { code: 'upstream-unavailable', message: 'Resend send failed after 3 retries' },
    });
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  it('retries a thrown error and returns the id of the next success', async () => {
    sendMock.mockRejectedValueOnce(new Error('socket hang up'));
    sendMock.mockResolvedValueOnce({ data: { id: 'msg-retry' }, error: null });
    const pending = emailSender.send(MESSAGE);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ ok: true, value: { messageId: 'msg-retry' } });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
