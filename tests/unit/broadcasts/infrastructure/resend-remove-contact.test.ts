import { describe, expect, it, vi, beforeEach } from 'vitest';

const removeMock = vi.fn();
const removeAudMock = vi.fn();
vi.mock('@/modules/broadcasts/infrastructure/resend/resend-broadcasts-client', () => ({
  getResendBroadcastsClient: () => ({
    contacts: { remove: removeMock },
    audiences: { remove: removeAudMock },
  }),
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

describe('resendBroadcastsGateway.deleteAudience', () => {
  beforeEach(() => removeAudMock.mockReset());

  it('deleteAudience resolves on success', async () => {
    removeAudMock.mockResolvedValue({ data: { deleted: true, id: 'aud_1', object: 'audience' }, error: null });
    await expect(resendBroadcastsGateway.deleteAudience('aud_1')).resolves.toBeUndefined();
    expect(removeAudMock).toHaveBeenCalledWith('aud_1');
  });

  it('deleteAudience treats 404 (already gone) as success', async () => {
    removeAudMock.mockResolvedValue({ data: null, error: { statusCode: 404, message: 'not found' } });
    await expect(resendBroadcastsGateway.deleteAudience('gone')).resolves.toBeUndefined();
  });

  it('deleteAudience treats 410 Gone as already-absent (Finding H)', async () => {
    // Pre-fix a 410 fell through to classifyResendError → `permanent`, so the
    // cleanup row re-failed every cron tick forever. 410 must be idempotent
    // early-return like 404. Single call (no retry) proves it is NOT treated
    // as retryable either.
    removeAudMock.mockResolvedValue({ data: null, error: { statusCode: 410, message: 'gone' } });
    await expect(resendBroadcastsGateway.deleteAudience('gone-410')).resolves.toBeUndefined();
    expect(removeAudMock).toHaveBeenCalledTimes(1);
  });

  it('deleteAudience throws retryable on 5xx', async () => {
    vi.useFakeTimers();
    removeAudMock.mockResolvedValue({ data: null, error: { statusCode: 503, message: 'down' } });
    const p = resendBroadcastsGateway.deleteAudience('aud_1');
    const a = expect(p).rejects.toMatchObject({ name: 'GatewayThrowable', kind: 'retryable' });
    await vi.runAllTimersAsync(); await a; vi.useRealTimers();
  });
});
