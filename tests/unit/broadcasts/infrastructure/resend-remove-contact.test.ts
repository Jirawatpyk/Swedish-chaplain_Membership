import { describe, expect, it, vi, beforeEach } from 'vitest';

const removeMock = vi.fn();
vi.mock('@/modules/broadcasts/infrastructure/resend/resend-broadcasts-client', () => ({
  getResendBroadcastsClient: () => ({ contacts: { remove: removeMock } }),
}));

import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';

describe('resendBroadcastsGateway.removeContactFromAudience', () => {
  beforeEach(() => removeMock.mockReset());

  it('resolves on a successful removal', async () => {
    removeMock.mockResolvedValue({ data: { deleted: true }, error: null });
    await expect(
      resendBroadcastsGateway.removeContactFromAudience('aud_1', 'a@x.io'),
    ).resolves.toBeUndefined();
    expect(removeMock).toHaveBeenCalledWith({ audienceId: 'aud_1', email: 'a@x.io' });
  });

  it('treats a 404 (contact/audience already absent) as success', async () => {
    removeMock.mockResolvedValue({ data: null, error: { statusCode: 404, message: 'not found' } });
    await expect(
      resendBroadcastsGateway.removeContactFromAudience('aud_1', 'gone@x.io'),
    ).resolves.toBeUndefined();
  });

  it('throws a retryable GatewayThrowable on a 5xx (after exhausting the retry budget)', async () => {
    // withRetry retries 5× with real setTimeout backoff (1+2+4+8+16s). Use fake
    // timers so the test does not hang ~31s.
    vi.useFakeTimers();
    removeMock.mockResolvedValue({ data: null, error: { statusCode: 503, message: 'down' } });
    const p = resendBroadcastsGateway.removeContactFromAudience('aud_1', 'a@x.io');
    const assertion = expect(p).rejects.toMatchObject({ name: 'GatewayThrowable', kind: 'retryable' });
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
  });
});
