/**
 * F119 T059 — `sendVersionToMember`, the arms the route contract suites
 * (`admin-eblast-send-version`, `…-image-allowlist-recheck`, `…-rbac`,
 * `eblast-flag-matrix`) do not reach, plus the contact choice
 * (`chooseApprovalRecipient`). 100 % branch is pinned on this use case (T158).
 */
import { describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import { ApprovalDependencyError } from '@/modules/broadcasts/application/approval-dependency-error';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import type { HtmlSanitizerPort } from '@/modules/broadcasts/application/ports/html-sanitizer-port';
import { chooseApprovalRecipient } from '@/modules/broadcasts/application/use-cases/approval/_approval-recipient';
import {
  sendVersionToMember,
  type SendVersionToMemberDeps,
  type SendVersionToMemberInput,
} from '@/modules/broadcasts/application/use-cases/approval/send-version-to-member';
import {
  makeApprovalBroadcast,
  makeApprovalVersion,
  makeFakeApprovalStore,
  makeFakeImageAllowlist,
  makeFakePortalRecipients,
  makePortalContact,
  makeRecordingF7Audit,
} from '../../../helpers/eblast-approval-fakes';

const V0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
const WORKING = makeApprovalVersion({ versionNo: 1, noteToMember: null });
const MEMBER = '22222222-2222-4222-8222-222222222222';
const passThrough: HtmlSanitizerPort = { sanitize: (html: string) => html };

function setup(opts: { broadcast?: Broadcast; sanitizer?: HtmlSanitizerPort } = {}) {
  const store = makeFakeApprovalStore({
    broadcasts: [opts.broadcast ?? makeApprovalBroadcast({ status: 'in_design' })],
    versions: [V0, WORKING],
  });
  const audit = makeRecordingF7Audit();
  const deps: SendVersionToMemberDeps = {
    tenant: asTenantContext('test-tenant'),
    broadcastsRepo: store.broadcastsRepo,
    versionsRepo: store.versionsRepo,
    sanitizer: opts.sanitizer ?? passThrough,
    imageAllowlist: makeFakeImageAllowlist(),
    portalRecipients: makeFakePortalRecipients({ [MEMBER]: [makePortalContact()] }),
    outbox: store.outbox,
    audit,
    clock: { now: () => store.now },
  };
  const run = (patch: Partial<SendVersionToMemberInput> = {}) =>
    sendVersionToMember(deps, {
      broadcastId: makeApprovalBroadcast().broadcastId,
      actorUserId: '44444444-4444-4444-8444-444444444444',
      actorRole: null,
      requestId: null,
      ...patch,
    });
  return { store, audit, deps, run };
}

describe('sendVersionToMember — the arms the route suites do not reach', () => {
  it('no note → note_length 0; no session role → actor_role null (recorded as-is, never a literal)', async () => {
    const { audit, run } = setup();
    expect((await run()).ok).toBe(true);
    expect(audit.events[0]!.payload).toMatchObject({ note_length: 0, actor_role: null });
  });

  it('a working copy that vanished under the lock → server_error, nothing committed', async () => {
    const { store, run } = setup();
    store.versionsRepo.markSent.mockResolvedValueOnce(null);
    expect(await run()).toEqual({ ok: false, error: { kind: 'server_error', errKind: 'Error' } });
    expect(store.broadcastsRepo.rows.get(`test-tenant::${makeApprovalBroadcast().broadcastId}`)!.status).toBe('in_design');
    expect(store.outbox.rows()).toHaveLength(0);
  });

  it('a sanitiser that throws → server_error (sanitizer_unavailable), nothing sent', async () => {
    const { store, run } = setup({ sanitizer: { sanitize: vi.fn(() => { throw new Error('dompurify down'); }) } });
    expect(await run()).toEqual({ ok: false, error: { kind: 'server_error', errKind: 'sanitizer_unavailable' } });
    expect(store.versionsRepo.markSent).not.toHaveBeenCalled();
  });

  it('a body over 200 KB after sanitising → body_too_large', async () => {
    const { store, run } = setup();
    store.state.versions = [V0, { ...WORKING, bodyHtml: `<p>${'x'.repeat(200 * 1024)}</p>` }];
    const r = await run();
    expect(r.ok ? null : r.error.kind).toBe('body_too_large');
  });

  it('an image refusal with no request id is audited under the use case\'s own id', async () => {
    const { store, audit, run } = setup();
    store.state.versions = [V0, { ...WORKING, bodyHtml: '<img src="https://elsewhere.example/p.png" alt="p">' }];
    const r = await run();
    expect(r.ok ? null : r.error.kind).toBe('image_source_not_allowlisted');
    expect(audit.emit).toHaveBeenCalledWith(null, expect.objectContaining({ requestId: 'send-version-to-member' }));
  });

  // F119 round-4 B3 — the route logs this errKind; a failed portal-contact read
  // names the dependency and its repo code rather than a bare `Error`.
  it('a portal-contact read that fails → server_error naming the dependency, nothing sent', async () => {
    const { deps, store, run } = setup();
    vi.mocked(deps.portalRecipients.listActivePortalContacts).mockRejectedValueOnce(
      new ApprovalDependencyError('portal_contacts', 'repo.unexpected'),
    );
    expect(await run()).toEqual({
      ok: false,
      error: { kind: 'server_error', errKind: 'ApprovalDependencyError:portal_contacts:repo.unexpected' },
    });
    expect(store.outbox.rows()).toHaveLength(0);
  });

  it('the allow-list read failing → server_error before any lock is taken', async () => {
    const { deps, store, run } = setup();
    vi.mocked(deps.imageAllowlist.findByTenantId).mockRejectedValueOnce(new TypeError('pool exhausted'));
    expect(await run()).toEqual({ ok: false, error: { kind: 'server_error', errKind: 'TypeError' } });
    expect(store.broadcastsRepo.withTx).not.toHaveBeenCalled();
  });
});

// F119 round-4 B1 (FR-033) — the send carries the save's concurrency token.
// A marketing user whose screen was clean but stale sent the content another
// user had just saved without ever seeing it; the check is the save's own.
describe('sendVersionToMember — expectedUpdatedAt (FR-033, round-4 B1)', () => {
  it('a stale token → version_changed carrying the current working copy; nothing sent, nothing audited or enqueued', async () => {
    const { store, audit, run } = setup();
    const r = await run({ expectedUpdatedAt: new Date(WORKING.updatedAt.getTime() - 60_000) });
    expect(r).toEqual({ ok: false, error: { kind: 'version_changed', current: WORKING } });
    expect(store.versionsRepo.markSent).not.toHaveBeenCalled();
    expect(store.broadcastsRepo.applyTransition).not.toHaveBeenCalled();
    expect(store.outbox.rows()).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it('the token the client holds → sent', async () => {
    const { store, run } = setup();
    const r = await run({ expectedUpdatedAt: new Date(WORKING.updatedAt.getTime()) });
    expect(r.ok ? r.value.round : r.error).toBe(1);
    expect(store.outbox.rows()).toHaveLength(1);
  });

  it('no token (a caller that sends no body) → sent, as before', async () => {
    const { store, run } = setup();
    expect((await run()).ok).toBe(true);
    expect(store.versionsRepo.markSent).toHaveBeenCalledTimes(1);
  });
});

describe('chooseApprovalRecipient — who at the member company is emailed', () => {
  const submitter = makePortalContact({ contactId: 'c-3', linkedUserId: 'u-submitter', isPrimary: false });
  const primary = makePortalContact({ contactId: 'c-2', linkedUserId: 'u-primary', isPrimary: true });
  const other = makePortalContact({ contactId: 'c-1', linkedUserId: 'u-other', isPrimary: false });

  it('the submitter first; else the primary; else the lowest contact id; nobody → null', () => {
    expect(chooseApprovalRecipient([other, primary, submitter], 'u-submitter')).toBe(submitter);
    expect(chooseApprovalRecipient([other, primary], 'u-submitter')).toBe(primary);
    expect(chooseApprovalRecipient([submitter, other], null)).toBe(other);
    expect(chooseApprovalRecipient([], 'u-submitter')).toBeNull();
  });
});
