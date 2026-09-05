/**
 * 108 PR-D T044 (US4 / US6 — FR-025, FR-030, FR-032, FR-053, FR-053a) —
 * `setContactMarketingOptOut`, every branch.
 *
 * The one use case behind BOTH toggles (staff on the member / audience page,
 * the contact themself in the portal); `actor.source` is the only difference.
 * Rules pinned here:
 *   - switching OFF never consults the suppression list (nothing to protect);
 *   - switching ON refuses when the address is suppressed — the person's own
 *     unsubscribe always wins (FR-025) — and refuses when the list cannot be
 *     read (re-enabling blind would override an unsubscribe nobody checked);
 *   - same-state is `unchanged` with NO audit row (FR-030b idempotency);
 *   - a removed contact has no marketing state → not_found;
 *   - the audit payload carries ids + source + the session role, never an
 *     address (FR-053a).
 *
 * `runInTenant` is stubbed (unit level); the same paths run on live Neon in
 * tests/integration/members/contact-marketing-opt-out.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(
    async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({ __tx: true }),
  ),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { setContactMarketingOptOut, asMemberId } from '@/modules/members';
import type { SetContactMarketingOptOutDeps } from '@/modules/members/application/use-cases/set-contact-marketing-opt-out';
import { asTenantContext } from '@/modules/tenants';
import {
  RECEIVES_MARKETING,
  type Contact,
  type ContactId,
  type MarketingOptOut,
} from '@/modules/members/domain/contact';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const CONTACT = '22222222-2222-4222-8222-222222222222' as ContactId;
const STAFF = 'a6c5b1a2-0000-4000-8000-00000000aaaa';
const SELF_USER = 'a6c5b1a2-0000-4000-8000-00000000bbbb';
const NOW = new Date('2026-09-06T10:00:00Z');
const EMAIL = 'secondary@example.com';

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    tenantId: 'test-tenant',
    contactId: CONTACT,
    memberId,
    firstName: 'Sec',
    lastName: 'Ondary',
    email: EMAIL,
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en',
    dateOfBirth: null,
    linkedUserId: null,
    inviteBouncedAt: null,
    art14AttestedAt: null,
    marketing: RECEIVES_MARKETING,
    isPrimary: false,
    removedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  } as Contact;
}

function makeDeps(opts: {
  found?: Contact | null;
  suppressed?: boolean | 'throws';
  repoOutcome?: 'changed' | 'unchanged' | 'not_found' | 'error';
  auditFails?: boolean;
} = {}) {
  const found = opts.found === undefined ? contact() : opts.found;
  const contactRepo = {
    findById: vi.fn().mockResolvedValue(
      found ? ok(found) : err({ code: 'repo.not_found' as const }),
    ),
    setMarketingOptOutInTx: vi.fn(async (_tx: unknown, _id: ContactId, next: MarketingOptOut) => {
      switch (opts.repoOutcome ?? 'changed') {
        case 'changed':
          return ok({ outcome: 'changed' as const, contact: contact({ marketing: next }) });
        case 'unchanged':
          return ok({ outcome: 'unchanged' as const, contact: found ?? contact() });
        case 'not_found':
          return err({ code: 'repo.not_found' as const });
        default:
          return err({ code: 'repo.unexpected' as const, cause: new Error('boom') });
      }
    }),
  };
  const audit = {
    record: vi.fn(),
    recordInTx: vi.fn().mockResolvedValue(
      opts.auditFails ? err({ code: 'repo.unexpected', cause: new Error('audit') }) : ok(undefined),
    ),
  };
  const marketingSuppression = {
    isSuppressed: vi.fn(async () => {
      if (opts.suppressed === 'throws') throw new Error('suppression db down');
      return opts.suppressed === true;
    }),
  };
  const deps: SetContactMarketingOptOutDeps = {
    tenant,
    contactRepo,
    audit,
    marketingSuppression,
    clock: { now: () => NOW },
  };
  return { deps, contactRepo, audit, marketingSuppression };
}

const staffOff = {
  contactId: CONTACT,
  state: 'off' as const,
  actor: { userId: STAFF, role: 'marketing', source: 'staff' as const },
  requestId: 'req-1',
};

describe('setContactMarketingOptOut — switching OFF', () => {
  beforeEach(() => vi.clearAllMocks());

  it('staff off → changed, writes the correlated triple (now, staff, actor) and audits opted_out', async () => {
    const { deps, contactRepo, audit, marketingSuppression } = makeDeps();
    const r = await setContactMarketingOptOut(staffOff, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('changed');
    if (r.value.outcome !== 'changed') return;
    expect(r.value.event).toBe('contact_marketing_opted_out');
    expect(contactRepo.setMarketingOptOutInTx).toHaveBeenCalledWith(
      { __tx: true },
      CONTACT,
      { optedOutAt: NOW, source: 'staff', byUserId: STAFF },
    );
    // OFF never consults the suppression list — nothing to protect.
    expect(marketingSuppression.isSuppressed).not.toHaveBeenCalled();
    expect(audit.recordInTx).toHaveBeenCalledTimes(1);
    const event = audit.recordInTx.mock.calls[0]![2];
    expect(event).toMatchObject({
      type: 'contact_marketing_opted_out',
      actorUserId: STAFF,
      requestId: 'req-1',
      payload: {
        member_id: memberId,
        contact_id: CONTACT,
        source: 'staff',
        actor_role: 'marketing',
      },
    });
  });

  it('self off → source self in both the row and the audit payload (FR-032)', async () => {
    const { deps, contactRepo, audit } = makeDeps();
    const r = await setContactMarketingOptOut(
      { ...staffOff, actor: { userId: SELF_USER, role: 'member', source: 'self' } },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(contactRepo.setMarketingOptOutInTx).toHaveBeenCalledWith(
      expect.anything(),
      CONTACT,
      { optedOutAt: NOW, source: 'self', byUserId: SELF_USER },
    );
    expect(audit.recordInTx.mock.calls[0]![2]).toMatchObject({
      actorUserId: SELF_USER,
      payload: { source: 'self', actor_role: 'member' },
    });
  });

  it('off on a suppressed address still proceeds (opt-out is additive to the unsubscribe)', async () => {
    const { deps, marketingSuppression } = makeDeps({ suppressed: true });
    const r = await setContactMarketingOptOut(staffOff, deps);
    expect(r.ok).toBe(true);
    expect(marketingSuppression.isSuppressed).not.toHaveBeenCalled();
  });

  it('FR-053a: no email address anywhere in the audit event', async () => {
    const { deps, audit } = makeDeps();
    await setContactMarketingOptOut(staffOff, deps);
    const serialised = JSON.stringify(audit.recordInTx.mock.calls[0]![2]);
    expect(serialised).not.toContain('@');
    expect(serialised).not.toContain(EMAIL);
  });
});

describe('setContactMarketingOptOut — switching ON', () => {
  beforeEach(() => vi.clearAllMocks());
  const staffOn = { ...staffOff, state: 'on' as const };
  const optedOut = contact({ marketing: { optedOutAt: NOW, source: 'staff', byUserId: STAFF as never } });

  it('on (not suppressed) → changed with the all-null shape, audits opted_in', async () => {
    const { deps, contactRepo, audit, marketingSuppression } = makeDeps({ found: optedOut });
    const r = await setContactMarketingOptOut(staffOn, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.outcome !== 'changed') throw new Error('expected changed');
    expect(r.value.event).toBe('contact_marketing_opted_in');
    expect(marketingSuppression.isSuppressed).toHaveBeenCalledWith(EMAIL);
    expect(contactRepo.setMarketingOptOutInTx).toHaveBeenCalledWith(
      expect.anything(),
      CONTACT,
      { optedOutAt: null, source: null, byUserId: null },
    );
    expect(audit.recordInTx.mock.calls[0]![2]).toMatchObject({
      type: 'contact_marketing_opted_in',
      payload: { member_id: memberId, contact_id: CONTACT, source: 'staff' },
    });
  });

  it('on for a suppressed address → suppressed; nothing written, nothing audited (FR-025)', async () => {
    const { deps, contactRepo, audit } = makeDeps({ found: optedOut, suppressed: true });
    const r = await setContactMarketingOptOut(staffOn, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('suppressed');
    expect(contactRepo.setMarketingOptOutInTx).not.toHaveBeenCalled();
    expect(audit.recordInTx).not.toHaveBeenCalled();
  });

  it('on while the suppression list cannot be read → suppression_unavailable; nothing written', async () => {
    const { deps, contactRepo } = makeDeps({ found: optedOut, suppressed: 'throws' });
    const r = await setContactMarketingOptOut(staffOn, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('suppression_unavailable');
    expect(contactRepo.setMarketingOptOutInTx).not.toHaveBeenCalled();
  });
});

describe('setContactMarketingOptOut — idempotency and refusals', () => {
  beforeEach(() => vi.clearAllMocks());

  it('same state → unchanged with NO audit row (FR-030b)', async () => {
    const { deps, audit } = makeDeps({ repoOutcome: 'unchanged' });
    const r = await setContactMarketingOptOut(staffOff, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('unchanged');
    expect(audit.recordInTx).not.toHaveBeenCalled();
  });

  it('unknown contact → not_found; the tx is never opened', async () => {
    const { deps, contactRepo } = makeDeps({ found: null });
    const r = await setContactMarketingOptOut(staffOff, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('not_found');
    expect(contactRepo.setMarketingOptOutInTx).not.toHaveBeenCalled();
  });

  it('removed contact → not_found (a removed contact has no marketing state)', async () => {
    const { deps, contactRepo } = makeDeps({
      found: contact({ removedAt: new Date('2026-05-01') }),
    });
    const r = await setContactMarketingOptOut(staffOff, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('not_found');
    expect(contactRepo.setMarketingOptOutInTx).not.toHaveBeenCalled();
  });

  it('contact removed between the pre-read and the locked write → not_found', async () => {
    const { deps, audit } = makeDeps({ repoOutcome: 'not_found' });
    const r = await setContactMarketingOptOut(staffOff, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('not_found');
    expect(audit.recordInTx).not.toHaveBeenCalled();
  });

  it('repo failure inside the tx → server_error (thrown → rolled back)', async () => {
    const { deps } = makeDeps({ repoOutcome: 'error' });
    const r = await setContactMarketingOptOut(staffOff, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('server_error');
  });

  it('audit failure inside the tx → server_error (the write does not commit without its audit row)', async () => {
    const { deps } = makeDeps({ auditFails: true });
    const r = await setContactMarketingOptOut(staffOff, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('server_error');
  });

  it('pre-read repo failure → server_error', async () => {
    const { deps, contactRepo } = makeDeps();
    contactRepo.findById.mockResolvedValueOnce(
      err({ code: 'repo.unexpected', cause: new Error('pool') }),
    );
    const r = await setContactMarketingOptOut(staffOff, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('server_error');
  });

  it('an unexpected throw inside the tx → server_error, never an unhandled rejection', async () => {
    const { deps, contactRepo } = makeDeps();
    contactRepo.setMarketingOptOutInTx.mockRejectedValueOnce(new Error('connection reset'));
    const r = await setContactMarketingOptOut(staffOff, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('server_error');
  });

  it('defaults the clock to the wall clock when none is injected', async () => {
    const { deps, contactRepo } = makeDeps();
    const { clock: _clock, ...withoutClock } = deps;
    const before = Date.now();
    await setContactMarketingOptOut(staffOff, withoutClock);
    const next = contactRepo.setMarketingOptOutInTx.mock.calls[0]![2] as MarketingOptOut;
    expect(next.optedOutAt).toBeInstanceOf(Date);
    expect((next.optedOutAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });
});
