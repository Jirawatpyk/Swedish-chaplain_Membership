/**
 * #89 — `runLoadRegistrationForErase` reads one registration by id under the
 * tenant (the erase page used to scan the first 500 rows of the event detail).
 * It hands the page only the event id, the attendee name and whether the PII is
 * already pseudonymised; a miss or a repo error is `null` (the page 404s).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findById = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('@/modules/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/events')>()),
  makeEventRegistrationLookupForTenant: () => ({ findById }),
}));

const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ logger: { warn, error: vi.fn(), info: vi.fn() } }));

const { runLoadRegistrationForErase } = await import('@/lib/events-admin-deps');

const EVENT = '00000000-0000-4000-8000-000000000001';
const REG = '00000000-0000-4000-8000-0000000000aa';

describe('runLoadRegistrationForErase', () => {
  beforeEach(() => findById.mockReset());

  it('returns the event id, the attendee name and the pseudonymised flag', async () => {
    findById.mockResolvedValueOnce({
      ok: true,
      value: { eventId: EVENT, attendee: { name: 'Ploy Rattanakul' }, piiPseudonymisedAt: null },
    });
    await expect(runLoadRegistrationForErase('swecham', REG)).resolves.toEqual({
      eventId: EVENT,
      attendeeName: 'Ploy Rattanakul',
      isPseudonymised: false,
    });
    expect(findById).toHaveBeenCalledWith('swecham', REG);
  });

  it('reports a pseudonymised row as such', async () => {
    findById.mockResolvedValueOnce({
      ok: true,
      value: { eventId: EVENT, attendee: { name: 'h' }, piiPseudonymisedAt: new Date('2026-01-01T00:00:00Z') },
    });
    await expect(runLoadRegistrationForErase('swecham', REG)).resolves.toMatchObject({ isPseudonymised: true });
  });

  it('is null for a miss and for a repo error', async () => {
    findById.mockResolvedValueOnce({ ok: true, value: null });
    await expect(runLoadRegistrationForErase('swecham', REG)).resolves.toBeNull();
    findById.mockResolvedValueOnce({ ok: false, error: { code: 'db' } });
    await expect(runLoadRegistrationForErase('swecham', REG)).resolves.toBeNull();
  });

  it('logs a repo error (no attendee data), so a failed erasure lookup is not a silent 404', async () => {
    warn.mockReset();
    findById.mockResolvedValueOnce({ ok: false, error: { code: 'db_error' } });
    await runLoadRegistrationForErase('swecham', REG);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields] = warn.mock.calls[0]!;
    expect(fields).toMatchObject({ event: 'admin_erase_pii_lookup_failed', tenant_slug: 'swecham' });
    expect(JSON.stringify(fields)).not.toMatch(/attendee|name|email/i);
  });

  it('a miss is not logged', async () => {
    warn.mockReset();
    findById.mockResolvedValueOnce({ ok: true, value: null });
    await runLoadRegistrationForErase('swecham', REG);
    expect(warn).not.toHaveBeenCalled();
  });
});
