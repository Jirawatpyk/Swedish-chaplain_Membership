/**
 * #408 — `cronReadOnlyGuard`, the READ_ONLY_MODE short-circuit every
 * `vercel.json` cron route calls right after its Bearer check.
 *
 * Vercel Cron invokes every route with GET, and `src/proxy.ts` freezes only
 * POST/PUT/PATCH/DELETE, so the emergency write freeze never reached a cron.
 * The guard answers 200 (not 503) so the scheduler does not retry-storm, and
 * logs one line naming the route — nothing else, no PII.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({ flags: { readOnlyMode: false } }));
const infoMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/env', () => ({ env: envMock }));
vi.mock('@/lib/logger', () => ({
  logger: { info: infoMock, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { cronReadOnlyGuard } from '@/lib/cron-read-only-guard';

beforeEach(() => {
  envMock.flags.readOnlyMode = false;
  infoMock.mockReset();
});

describe('cronReadOnlyGuard (#408)', () => {
  it('freeze OFF → null, and logs nothing', () => {
    expect(cronReadOnlyGuard('/api/cron/outbox-purge')).toBeNull();
    expect(infoMock).not.toHaveBeenCalled();
  });

  it('freeze ON → 200 { ok, skipped, reason: read_only_mode }', async () => {
    envMock.flags.readOnlyMode = true;
    const res = cronReadOnlyGuard('/api/cron/outbox-purge');
    expect(res).not.toBeNull();
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ok: true, skipped: true, reason: 'read_only_mode' });
  });

  it('freeze ON → exactly one info line carrying only the route', () => {
    envMock.flags.readOnlyMode = true;
    cronReadOnlyGuard('/api/cron/broadcasts/dispatch-scheduled');
    expect(infoMock).toHaveBeenCalledTimes(1);
    expect(infoMock).toHaveBeenCalledWith(
      { route: '/api/cron/broadcasts/dispatch-scheduled' },
      'cron.read_only_mode.skipped',
    );
  });
});
