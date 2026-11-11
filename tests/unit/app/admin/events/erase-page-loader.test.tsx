/**
 * #89 — the erase page finds its registration BY ID, not by scanning the first
 * 500 rows of the event's detail (a registration past row 500 404'd, which
 * blocked a PDPA erasure). It still 404s when the registration is missing or
 * belongs to another event (path mismatch), and still redirects an
 * already-pseudonymised row back to the event.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const EVENT = '00000000-0000-4000-8000-000000000001';
const OTHER_EVENT = '00000000-0000-4000-8000-000000000002';
const REG = '00000000-0000-4000-8000-0000000000aa';

const deps = vi.hoisted(() => ({
  runLoadRegistrationForErase: vi.fn(),
  runLoadEventDetail: vi.fn(),
}));
vi.mock('@/lib/events-admin-deps', () => deps);
vi.mock('@/lib/env', () => ({ env: { features: { f6EventCreate: true } } }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/rbac', () => ({ requirePagePermission: vi.fn(async () => ({ user: { id: 'u1' } })) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromHeaders: () => ({ slug: 'swecham' }) }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));
const view = vi.hoisted(() => ({ renderErasePageBody: vi.fn(async () => null) }));
vi.mock(
  '@/app/(staff)/admin/events/[eventId]/registrations/[registrationId]/erase/_components/erase-page-view',
  () => view,
);
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));

const { default: ErasePiiPage } = await import(
  '@/app/(staff)/admin/events/[eventId]/registrations/[registrationId]/erase/page'
);

function open(eventId = EVENT) {
  return ErasePiiPage({ params: Promise.resolve({ eventId, registrationId: REG }) });
}

describe('erase page loader (#89)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the registration by id and renders it, with no event-detail scan', async () => {
    deps.runLoadRegistrationForErase.mockResolvedValueOnce({
      eventId: EVENT,
      attendeeName: 'Ploy Rattanakul',
      isPseudonymised: false,
    });
    await open();
    expect(deps.runLoadRegistrationForErase).toHaveBeenCalledWith('swecham', REG);
    expect(deps.runLoadEventDetail).not.toHaveBeenCalled();
    expect(view.renderErasePageBody).toHaveBeenCalledWith({
      eventId: EVENT,
      registrationId: REG,
      attendeeName: 'Ploy Rattanakul',
    });
  });

  it('404s a registration that does not exist in the tenant', async () => {
    deps.runLoadRegistrationForErase.mockResolvedValueOnce(null);
    await expect(open()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('404s a registration that belongs to another event (path mismatch)', async () => {
    deps.runLoadRegistrationForErase.mockResolvedValueOnce({
      eventId: OTHER_EVENT,
      attendeeName: 'Ploy',
      isPseudonymised: false,
    });
    await expect(open()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(view.renderErasePageBody).not.toHaveBeenCalled();
  });

  it('sends an already-pseudonymised row back to its event', async () => {
    deps.runLoadRegistrationForErase.mockResolvedValueOnce({
      eventId: EVENT,
      attendeeName: 'x',
      isPseudonymised: true,
    });
    await expect(open()).rejects.toThrow(`NEXT_REDIRECT /admin/events/${EVENT}`);
  });

  it('404s when the read throws', async () => {
    deps.runLoadRegistrationForErase.mockRejectedValueOnce(new Error('neon blip'));
    await expect(open()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
