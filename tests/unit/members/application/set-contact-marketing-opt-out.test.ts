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
import type { SetMarketingCommand } from '@/modules/members/application/ports/contact-repo';

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
  repoOutcome?: 'changed' | 'unchanged' | 'refused' | 'not_found' | 'error';
  auditFails?: boolean;
} = {}) {
  const found = opts.found === undefined ? contact() : opts.found;
  const contactRepo = {
    findById: vi.fn().mockResolvedValue(
      found ? ok(found) : err({ code: 'repo.not_found' as const }),
    ),
    setMarketingOptOutInTx: vi.fn(async (_tx: unknown, _id: ContactId, command: SetMarketingCommand) => {
      const next: MarketingOptOut =
        command.kind === 'off'
          ? { optedOutAt: command.at, source: command.actor, byUserId: command.byUserId }
          : RECEIVES_MARKETING;
      switch (opts.repoOutcome ?? 'changed') {
        case 'changed':
          return ok({ outcome: 'changed' as const, contact: contact({ marketing: next }) });
        case 'unchanged':
          return ok({ outcome: 'unchanged' as const, contact: found ?? contact() });
        case 'refused':
          // No `contact` on the refusal arm — the union makes reading it a
          // compile error (review types HIGH-1).
          return ok({ outcome: 'refused_self_opted_out' as const });
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
      { kind: 'off', actor: 'staff', byUserId: STAFF, at: NOW },
    );
    // ONE representation of "who is acting": the command's `actor`. There is
    // no second `source` field that could disagree with it (types MEDIUM-1).
    const command = contactRepo.setMarketingOptOutInTx.mock.calls[0]![2] as SetMarketingCommand;
    expect(Object.keys(command).sort()).toEqual(['actor', 'at', 'byUserId', 'kind']);
    // OFF never consults the suppression list — nothing to protect.
    expect(marketingSuppression.isSuppressed).not.toHaveBeenCalled();
    expect(audit.recordInTx).toHaveBeenCalledTimes(1);
    const event = audit.recordInTx.mock.calls[0]![2];
    expect(event).toMatchObject({
      type: 'contact_marketing_opted_out',
      actorUserId: STAFF,
      requestId: 'req-1',
      payload: {
        // Security review MEDIUM-1: a STAFF action is not member activity —
        // `related_member_id` keeps the row on the member timeline without
        // firing migration 0009's `last_activity_at` bump (same key as 0292).
        related_member_id: memberId,
        contact_id: CONTACT,
        source: 'staff',
        actor_role: 'marketing',
      },
    });
    expect(event.payload).not.toHaveProperty('member_id');
  });

  it('self off → source self; the payload carries `member_id` so the contact\'s own action counts as member activity', async () => {
    const { deps, contactRepo, audit } = makeDeps();
    const r = await setContactMarketingOptOut(
      { ...staffOff, actor: { userId: SELF_USER, role: 'member', source: 'self' } },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(contactRepo.setMarketingOptOutInTx).toHaveBeenCalledWith(
      expect.anything(),
      CONTACT,
      { kind: 'off', actor: 'self', byUserId: SELF_USER, at: NOW },
    );
    const event = audit.recordInTx.mock.calls[0]![2];
    expect(event).toMatchObject({
      actorUserId: SELF_USER,
      payload: { member_id: memberId, source: 'self', actor_role: 'member' },
    });
    expect(event.payload).not.toHaveProperty('related_member_id');
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
      expect.objectContaining({ kind: 'on', actor: expect.stringMatching(/^(staff|self)$/) }),
    );
    expect(audit.recordInTx.mock.calls[0]![2]).toMatchObject({
      type: 'contact_marketing_opted_in',
      payload: { related_member_id: memberId, contact_id: CONTACT, source: 'staff' },
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

/**
 * 108 PR-D review (privacy B-2, GDPR Art. 21(3) / PDPA §32) — a contact's OWN
 * opt-out is an objection to direct marketing, exactly like the unsubscribe
 * link. Staff cannot lift it (FR-025 AMENDMENT); and when a contact objects
 * over a staff-made opt-out, that objection is RECORDED (source becomes
 * `self`) so a later staff "on" cannot silently override it.
 */
describe('setContactMarketingOptOut — self opt-out takes precedence over staff (FR-025 amendment)', () => {
  beforeEach(() => vi.clearAllMocks());
  const selfOffContact = contact({ marketing: { optedOutAt: NOW, source: 'self', byUserId: SELF_USER as never } });
  const staffOffContact = contact({ marketing: { optedOutAt: NOW, source: 'staff', byUserId: STAFF as never } });

  it('staff "on" over a SELF opt-out → self_opted_out; nothing written, nothing audited', async () => {
    const { deps, contactRepo, audit, marketingSuppression } = makeDeps({ found: selfOffContact });
    const r = await setContactMarketingOptOut({ ...staffOff, state: 'on' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('self_opted_out');
    expect(contactRepo.setMarketingOptOutInTx).not.toHaveBeenCalled();
    expect(audit.recordInTx).not.toHaveBeenCalled();
    // Refused before the suppression lookup — the objection alone decides.
    expect(marketingSuppression.isSuppressed).not.toHaveBeenCalled();
  });

  it('the contact themself may switch back on after their own opt-out', async () => {
    const { deps, contactRepo } = makeDeps({ found: selfOffContact });
    const r = await setContactMarketingOptOut(
      { ...staffOff, state: 'on', actor: { userId: SELF_USER, role: 'member', source: 'self' } },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(contactRepo.setMarketingOptOutInTx).toHaveBeenCalledWith(
      expect.anything(),
      CONTACT,
      expect.objectContaining({ kind: 'on', actor: expect.stringMatching(/^(staff|self)$/) }),
    );
  });

  it('staff "on" over a STAFF opt-out is still allowed', async () => {
    const { deps } = makeDeps({ found: staffOffContact });
    const r = await setContactMarketingOptOut({ ...staffOff, state: 'on' }, deps);
    expect(r.ok).toBe(true);
  });

  it('self "off" over a STAFF opt-out is a CHANGE: the objection is recorded as source self and audited', async () => {
    const { deps, contactRepo, audit } = makeDeps({ found: staffOffContact });
    contactRepo.setMarketingOptOutInTx.mockResolvedValueOnce(
      ok({
        outcome: 'changed' as const,
        contact: contact({ marketing: { optedOutAt: NOW, source: 'self', byUserId: SELF_USER as never } }),
      }),
    );
    const r = await setContactMarketingOptOut(
      { ...staffOff, state: 'off', actor: { userId: SELF_USER, role: 'member', source: 'self' } },
      deps,
    );
    expect(r.ok && r.value.outcome).toBe('changed');
    expect(contactRepo.setMarketingOptOutInTx).toHaveBeenCalledWith(
      expect.anything(),
      CONTACT,
      { kind: 'off', actor: 'self', byUserId: SELF_USER, at: NOW },
    );
    expect(audit.recordInTx.mock.calls[0]![2]).toMatchObject({
      type: 'contact_marketing_opted_out',
      payload: { source: 'self' },
    });
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

  it('removed contact → `removed` (distinct from not_found so the route does not audit an in-tenant miss as a probe)', async () => {
    const { deps, contactRepo } = makeDeps({
      found: contact({ removedAt: new Date('2026-05-01') }),
    });
    const r = await setContactMarketingOptOut(staffOff, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('removed');
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
    const command = contactRepo.setMarketingOptOutInTx.mock.calls[0]![2] as SetMarketingCommand;
    expect(command.kind).toBe('off');
    if (command.kind !== 'off') return;
    expect(command.at).toBeInstanceOf(Date);
    expect(command.at.getTime()).toBeGreaterThanOrEqual(before);
  });
});

/**
 * Review cycle 13 (whole-branch MEDIUM-1) — the FR-025 AMENDMENT is also
 * enforced by the repo UNDER THE ROW LOCK: the use case passes the actor's
 * source and honours a `refused_self_opted_out` outcome (no audit, 409).
 * The pre-read fast path above stays; this closes the window between it and
 * the write.
 */
describe('setContactMarketingOptOut — the guard is re-checked under the lock (cycle 13)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('states the actor ONCE, in the command (no second source field to disagree)', async () => {
    const { deps, contactRepo } = makeDeps();
    await setContactMarketingOptOut(staffOff, deps);
    expect(contactRepo.setMarketingOptOutInTx).toHaveBeenCalledWith(
      { __tx: true },
      CONTACT,
      { kind: 'off', actor: 'staff', byUserId: STAFF, at: NOW },
    );
  });

  it('repo refuses under the lock (a self opt-out landed after the pre-read) → self_opted_out, NO audit', async () => {
    // The pre-read still sees a staff record, so the fast path lets the call
    // through; the locked row says `self` and the repo refuses.
    const { deps, audit } = makeDeps({
      found: contact({ marketing: { optedOutAt: NOW, source: 'staff', byUserId: STAFF as never } }),
      repoOutcome: 'refused',
    });
    const r = await setContactMarketingOptOut({ ...staffOff, state: 'on' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('self_opted_out');
    expect(audit.recordInTx).not.toHaveBeenCalled();
  });
});
