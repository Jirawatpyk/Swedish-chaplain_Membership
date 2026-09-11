/**
 * F114 T038 — `memberSelfUpdate` is gate-aware (FR-001 closes the bypass;
 * FR-004 Group A stays immediate; research R6).
 *
 *   gate = 'approval'  → the whitelist is `PORTAL_IMMEDIATE_CONTACT_FIELDS`
 *                        (`preferredLanguage`) ONLY; every Group B key
 *                        (firstName / lastName / phone / website / description)
 *                        is refused 403 with the existing
 *                        `member_self_update_forbidden` audit — the SAME event a
 *                        forged Group C key produces today.
 *   gate = 'immediate' → byte-identical to F3: the full flag-OFF set is accepted.
 *   gate omitted       → 'immediate' (every pre-F114 caller keeps its behaviour).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { memberSelfUpdate, type MemberSelfUpdateDeps } from '@/modules/members/application/use-cases/member-self-update';
import { asTenantContext } from '@/modules/tenants';
import { asContactId } from '@/modules/members/domain/contact';
import { asMemberId } from '@/modules/members/domain/member';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const contactId = asContactId('22222222-2222-4222-8222-222222222222');
const NOW = new Date('2026-09-11T08:00:00Z');

const member = { memberId, tenantId: 'test-tenant', status: 'active', website: null, description: null } as never;
const contact = { contactId, memberId, tenantId: 'test-tenant', firstName: 'A', lastName: 'B', phone: null, preferredLanguage: 'en', removedAt: null, isPrimary: true } as never;

function makeDeps() {
  const audit = { record: vi.fn(async () => ok(undefined)), recordInTx: vi.fn(async () => ok(undefined)) };
  const memberRepo = {
    findById: vi.fn(async () => ok(member)),
    findByIdInTx: vi.fn(async () => ok(member)),
    updateFieldsInTx: vi.fn(async (_tx: unknown, _id: unknown, patch: Record<string, unknown>) => ok({ ...(member as object), ...patch })),
  };
  const contactRepo = {
    findById: vi.fn(async () => ok(contact)),
    updateInTx: vi.fn(async (_tx: unknown, _id: unknown, patch: Record<string, unknown>) => ok({ ...(contact as object), ...patch, updatedAt: NOW })),
  };
  return { deps: { tenant, memberRepo, contactRepo, audit } as unknown as MemberSelfUpdateDeps, audit, memberRepo, contactRepo };
}

const call = (deps: MemberSelfUpdateDeps, rawBody: Record<string, unknown>, gate?: 'immediate' | 'approval') =>
  memberSelfUpdate(deps, {
    memberId,
    contactId,
    rawBody,
    actorUserId: 'a6c5b1a2-0000-4000-8000-00000000bbbb',
    requestId: 'req-1',
    ...(gate === undefined ? {} : { gate }),
  });

beforeEach(() => vi.clearAllMocks());

describe('memberSelfUpdate gate = approval (FR-001 / FR-004)', () => {
  it('accepts { primary_contact: { preferredLanguage } } and writes it immediately', async () => {
    const { deps, contactRepo, audit } = makeDeps();
    const r = await call(deps, { primary_contact: { preferredLanguage: 'th' } }, 'approval');
    expect(r.ok).toBe(true);
    expect(contactRepo.updateInTx).toHaveBeenCalledWith({}, contactId, { preferredLanguage: 'th' });
    expect(audit.recordInTx.mock.calls.map((c) => (c as unknown[])[2])).toEqual([
      expect.objectContaining({ type: 'contact_updated' }),
      expect.objectContaining({ type: 'member_self_updated' }),
    ]);
  });

  it.each([
    ['primary_contact.firstName', { primary_contact: { firstName: 'X' } }],
    ['primary_contact.lastName', { primary_contact: { lastName: 'X' } }],
    ['primary_contact.phone', { primary_contact: { phone: '+66812345678' } }],
    ['website', { website: 'https://x.example' }],
    ['description', { description: 'x' }],
  ])('refuses the Group B key %s with 403 + member_self_update_forbidden, writing nothing', async (dotted, body) => {
    const { deps, audit, contactRepo, memberRepo } = makeDeps();
    const r = await call(deps, body, 'approval');
    expect(r).toEqual({ ok: false, error: { type: 'forbidden', reason: `forbidden fields: ${dotted}` } });
    expect(audit.record).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({
        type: 'member_self_update_forbidden',
        // review privacy I-5 — a Group B key under the approval gate is a GATE
        // refusal, distinguishable from a forged Group C key
        payload: expect.objectContaining({ member_id: memberId, attempted_fields: [dotted], refusal: 'gate_narrowed' }),
      }),
    );
    expect(contactRepo.updateInTx).not.toHaveBeenCalled();
    expect(memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('a mixed body (Group A + Group B) is refused as a whole — nothing partial is written', async () => {
    const { deps, contactRepo } = makeDeps();
    const r = await call(deps, { primary_contact: { preferredLanguage: 'th', phone: '+66812345678' } }, 'approval');
    expect(r.ok).toBe(false);
    expect(contactRepo.updateInTx).not.toHaveBeenCalled();
  });
});

describe('memberSelfUpdate gate = immediate (byte-identical F3 path, SC-011)', () => {
  it.each(['immediate', undefined] as const)('gate %s accepts the full flag-OFF set', async (gate) => {
    const { deps, contactRepo, memberRepo, audit } = makeDeps();
    const r = await call(deps, { primary_contact: { firstName: 'Anna', phone: '+66812345678' }, website: 'https://x.example' }, gate);
    expect(r.ok).toBe(true);
    expect(contactRepo.updateInTx).toHaveBeenCalledWith({}, contactId, { firstName: 'Anna', phone: '+66812345678' });
    expect(memberRepo.updateFieldsInTx).toHaveBeenCalledWith({}, memberId, { website: 'https://x.example' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a Group C key is still forged in immediate mode (unchanged F3 guard)', async () => {
    const { deps, audit } = makeDeps();
    const r = await call(deps, { plan_id: 'x' }, 'immediate');
    expect(r).toEqual({ ok: false, error: { type: 'forbidden', reason: 'forbidden fields: plan_id' } });
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});
