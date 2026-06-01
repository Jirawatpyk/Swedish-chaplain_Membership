/**
 * Unit — bulkSendPortalInvite (go-live P1-17 / FR-018).
 *
 * Mocks the reused `invitePortal` use case + the repos so the orchestration
 * logic is tested in isolation: the 3-bucket mapping (invited / skipped /
 * failed), per-member best-effort (one member's error never aborts the loop),
 * idempotent already_linked → skipped, member-level skips (not_found / archived /
 * no_invitable_contact), and input validation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext } from '@/modules/tenants';

const invitePortalMock = vi.fn();
vi.mock('@/modules/members/application/use-cases/invite-portal', () => ({
  invitePortal: (...args: unknown[]) => invitePortalMock(...args),
}));

import {
  bulkSendPortalInvite,
  type BulkSendPortalInviteDeps,
} from '@/modules/members/application/use-cases/bulk-send-portal-invite';

const tenant = { slug: 'test-tenant' } as unknown as TenantContext;

const okR = <T>(value: T) => ({ ok: true as const, value });
const errR = <E>(error: E) => ({ ok: false as const, error });

// member fixtures keyed by id
const MEMBERS: Record<string, { status: string } | 'not_found' | 'repo_error'> = {};
// contacts keyed by member id
const CONTACTS: Record<string, Array<{ contactId: string; isPrimary: boolean }> | 'repo_error'> = {};
// invitePortal result keyed by contactId
const INVITE: Record<string, { ok: true; value: { contactId: string; userId: string; email: string } } | { ok: false; error: { code: string } }> = {};

type AuditResult = { ok: true; value: undefined } | { ok: false; error: { code: string } };
const auditRecord = vi.fn(async (): Promise<AuditResult> => okR(undefined));

function makeDeps(): BulkSendPortalInviteDeps {
  return {
    tenant,
    memberRepo: {
      findById: async (_ctx: unknown, memberId: string) => {
        const m = MEMBERS[memberId];
        if (m === 'not_found') return errR({ code: 'repo.not_found' });
        if (m === 'repo_error' || m === undefined) return errR({ code: 'repo.unexpected' });
        return okR(m);
      },
    } as unknown as BulkSendPortalInviteDeps['memberRepo'],
    contactRepo: {
      listByMember: async (_ctx: unknown, memberId: string) => {
        const c = CONTACTS[memberId];
        if (c === 'repo_error') return errR({ code: 'repo.unexpected' });
        return okR(c ?? []);
      },
    } as unknown as BulkSendPortalInviteDeps['contactRepo'],
    createUser: (async () => okR({ user: { id: 'u' } })) as unknown as BulkSendPortalInviteDeps['createUser'],
    audit: { record: auditRecord } as unknown as BulkSendPortalInviteDeps['audit'],
  };
}

const meta = { actorUserId: 'admin-1', requestId: 'req-1', sourceIp: '127.0.0.1' as string };

beforeEach(() => {
  for (const k of Object.keys(MEMBERS)) delete MEMBERS[k];
  for (const k of Object.keys(CONTACTS)) delete CONTACTS[k];
  for (const k of Object.keys(INVITE)) delete INVITE[k];
  invitePortalMock.mockReset();
  auditRecord.mockReset();
  auditRecord.mockResolvedValue(okR(undefined));
  // Default: invitePortal resolves from the INVITE map keyed by contactId.
  invitePortalMock.mockImplementation(async (_deps: unknown, input: { contactId: string }) => {
    return INVITE[input.contactId] ?? okR({ contactId: input.contactId, userId: `user-${input.contactId}`, email: `${input.contactId}@x.test` });
  });
});

const uuids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

describe('bulkSendPortalInvite — input validation', () => {
  it('empty member_ids → invalid_body', async () => {
    const r = await bulkSendPortalInvite({ action: 'send_portal_invite', member_ids: [] }, meta, makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('invalid_body');
  });

  it('> 100 member_ids → invalid_body (cap)', async () => {
    const r = await bulkSendPortalInvite({ action: 'send_portal_invite', member_ids: uuids(101) }, meta, makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('invalid_body');
  });

  it('duplicate member_ids → invalid_body', async () => {
    const [a] = uuids(1);
    const r = await bulkSendPortalInvite({ action: 'send_portal_invite', member_ids: [a!, a!] }, meta, makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('invalid_body');
  });
});

describe('bulkSendPortalInvite — 3-bucket per-member outcomes', () => {
  it('all-success: N active members with a primary contact → invited[N]', async () => {
    const [m1, m2, m3] = uuids(3);
    for (const [i, m] of [m1, m2, m3].entries()) {
      MEMBERS[m!] = { status: 'active' };
      CONTACTS[m!] = [{ contactId: `c${i}`, isPrimary: true }];
    }
    const r = await bulkSendPortalInvite({ action: 'send_portal_invite', member_ids: [m1!, m2!, m3!] }, meta, makeDeps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.counts).toEqual({ invited: 3, skipped: 0, failed: 0 });
    expect(r.value.invited.map((i) => i.memberId)).toEqual([m1, m2, m3]);
    expect(auditRecord).toHaveBeenCalledTimes(3); // member_portal_invite_queued per success
  });

  it('mixed batch maps each outcome to the right bucket; loop never aborts', async () => {
    const [mOk, mLinked, mNoEmail, mArchived, mNoContact, mNotFound, mInvalid, mTaken, mServer] = uuids(9);
    MEMBERS[mOk!] = { status: 'active' }; CONTACTS[mOk!] = [{ contactId: 'cOk', isPrimary: true }];
    MEMBERS[mLinked!] = { status: 'active' }; CONTACTS[mLinked!] = [{ contactId: 'cLinked', isPrimary: true }]; INVITE['cLinked'] = errR({ code: 'already_linked' });
    MEMBERS[mNoEmail!] = { status: 'active' }; CONTACTS[mNoEmail!] = [{ contactId: 'cNoEmail', isPrimary: true }]; INVITE['cNoEmail'] = errR({ code: 'no_email' });
    MEMBERS[mArchived!] = { status: 'archived' }; CONTACTS[mArchived!] = [{ contactId: 'cArch', isPrimary: true }];
    MEMBERS[mNoContact!] = { status: 'active' }; CONTACTS[mNoContact!] = [{ contactId: 'cNonPrim', isPrimary: false }]; // no primary
    MEMBERS[mNotFound!] = 'not_found';
    MEMBERS[mInvalid!] = { status: 'active' }; CONTACTS[mInvalid!] = [{ contactId: 'cInvalid', isPrimary: true }]; INVITE['cInvalid'] = errR({ code: 'invalid_email' });
    MEMBERS[mTaken!] = { status: 'active' }; CONTACTS[mTaken!] = [{ contactId: 'cTaken', isPrimary: true }]; INVITE['cTaken'] = errR({ code: 'email_taken' });
    MEMBERS[mServer!] = { status: 'active' }; CONTACTS[mServer!] = [{ contactId: 'cServer', isPrimary: true }]; INVITE['cServer'] = errR({ code: 'server_error' });

    const r = await bulkSendPortalInvite(
      { action: 'send_portal_invite', member_ids: [mOk!, mLinked!, mNoEmail!, mArchived!, mNoContact!, mNotFound!, mInvalid!, mTaken!, mServer!] },
      meta,
      makeDeps(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.counts).toEqual({ invited: 1, skipped: 5, failed: 3 });
    expect(r.value.invited.map((i) => i.memberId)).toEqual([mOk]);
    const skip = new Map(r.value.skipped.map((s) => [s.memberId, s.reason]));
    expect(skip.get(mLinked!)).toBe('already_linked');
    expect(skip.get(mNoEmail!)).toBe('no_email');
    expect(skip.get(mArchived!)).toBe('member_archived');
    expect(skip.get(mNoContact!)).toBe('no_invitable_contact');
    expect(skip.get(mNotFound!)).toBe('member_not_found');
    const fail = new Map(r.value.failed.map((f) => [f.memberId, f.code]));
    expect(fail.get(mInvalid!)).toBe('invalid_email');
    expect(fail.get(mTaken!)).toBe('email_taken');
    expect(fail.get(mServer!)).toBe('server_error');
  });

  it('member repo error (not not_found) → failed(server_error), not skipped', async () => {
    const [m] = uuids(1);
    MEMBERS[m!] = 'repo_error';
    const r = await bulkSendPortalInvite({ action: 'send_portal_invite', member_ids: [m!] }, meta, makeDeps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.failed).toEqual([{ memberId: m, code: 'server_error' }]);
  });

  it('contact list repo error → failed(server_error)', async () => {
    const [m] = uuids(1);
    MEMBERS[m!] = { status: 'active' };
    CONTACTS[m!] = 'repo_error';
    const r = await bulkSendPortalInvite({ action: 'send_portal_invite', member_ids: [m!] }, meta, makeDeps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.failed).toEqual([{ memberId: m, code: 'server_error' }]);
  });

  it('idempotent: re-invite of an already-linked member → skipped(already_linked), no audit', async () => {
    const [m] = uuids(1);
    MEMBERS[m!] = { status: 'active' };
    CONTACTS[m!] = [{ contactId: 'cL', isPrimary: true }];
    INVITE['cL'] = errR({ code: 'already_linked' });
    const r = await bulkSendPortalInvite({ action: 'send_portal_invite', member_ids: [m!] }, meta, makeDeps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.skipped).toEqual([{ memberId: m, reason: 'already_linked' }]);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('audit.record failure on success is best-effort — member still invited', async () => {
    const [m] = uuids(1);
    MEMBERS[m!] = { status: 'active' };
    CONTACTS[m!] = [{ contactId: 'cOk', isPrimary: true }];
    auditRecord.mockResolvedValue(errR({ code: 'repo.unexpected' }));
    const r = await bulkSendPortalInvite({ action: 'send_portal_invite', member_ids: [m!] }, meta, makeDeps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.counts.invited).toBe(1);
  });
});
