/**
 * F119 T058 — `saveFormattedVersion`, the refusal arms the route contract
 * suites (`admin-eblast-version-content-rules`, `…-version-concurrency`,
 * `…-rbac`) do not reach. The sanitiser is a stub here so each sanitiser
 * outcome can be forced; the real policy is exercised by the contract suite.
 */
import { describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import type { HtmlSanitizerPort } from '@/modules/broadcasts/application/ports/html-sanitizer-port';
import {
  saveFormattedVersion,
  type SaveFormattedVersionDeps,
  type SaveFormattedVersionInput,
} from '@/modules/broadcasts/application/use-cases/approval/save-formatted-version';
import {
  makeApprovalBroadcast,
  makeApprovalVersion,
  makeFakeApprovalStore,
  makeFakeImageAllowlist,
  makeRecordingF7Audit,
} from '../../../helpers/eblast-approval-fakes';

const TOKEN = new Date('2026-09-24T08:30:00.000Z');
const V0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
const WORKING = makeApprovalVersion({ versionNo: 1, updatedAt: TOKEN });
const passThrough: HtmlSanitizerPort = { sanitize: (html: string) => html };

function setup(opts: { broadcast?: Broadcast | null; versions?: typeof WORKING[]; sanitizer?: HtmlSanitizerPort } = {}) {
  const broadcast = opts.broadcast === undefined ? makeApprovalBroadcast({ status: 'in_design' }) : opts.broadcast;
  const store = makeFakeApprovalStore({ broadcasts: broadcast ? [broadcast] : [], versions: opts.versions ?? [V0, WORKING] });
  const audit = makeRecordingF7Audit();
  const deps: SaveFormattedVersionDeps = {
    tenant: asTenantContext('test-tenant'),
    broadcastsRepo: store.broadcastsRepo,
    versionsRepo: store.versionsRepo,
    sanitizer: opts.sanitizer ?? passThrough,
    imageAllowlist: makeFakeImageAllowlist(),
    audit,
    clock: { now: () => store.now },
  };
  const run = (patch: Partial<SaveFormattedVersionInput> = {}) =>
    saveFormattedVersion(deps, {
      broadcastId: makeApprovalBroadcast().broadcastId,
      actorUserId: '44444444-4444-4444-8444-444444444444',
      requestId: null,
      subject: 'Subject',
      bodyHtml: '<p>Body</p>',
      bodySource: '{}',
      noteToMember: null,
      expectedUpdatedAt: TOKEN,
      ...patch,
    });
  return { store, audit, run };
}

describe('saveFormattedVersion — refusal arms', () => {
  it('a blank subject → subject_invalid empty, before any read', async () => {
    const { store, run } = setup();
    expect(await run({ subject: '   ' })).toEqual({ ok: false, error: { kind: 'subject_invalid', reason: 'empty' } });
    expect(store.broadcastsRepo.withTx).not.toHaveBeenCalled();
  });

  it('a body over 200 KB after sanitising → body_too_large; a sanitiser that throws → server_error', async () => {
    const big = await setup().run({ bodyHtml: `<p>${'x'.repeat(200 * 1024)}</p>` });
    expect(big.ok ? null : big.error.kind).toBe('body_too_large');
    const broken = setup({ sanitizer: { sanitize: vi.fn(() => { throw new Error('dompurify down'); }) } });
    expect(await broken.run()).toEqual({ ok: false, error: { kind: 'server_error', errKind: 'sanitizer_unavailable' } });
  });

  it('an unknown / other-tenant id → not_found with the probe audited', async () => {
    const { audit, run } = setup({ broadcast: null });
    expect(await run()).toEqual({ ok: false, error: { kind: 'not_found' } });
    expect(audit.events.map((e) => e.eventType)).toEqual(['broadcast_cross_tenant_probe']);
  });

  it('a row that left in_design → stage_changed; in_design without a working copy → no_working_copy (neither probed)', async () => {
    const sent = setup({ broadcast: makeApprovalBroadcast({ status: 'awaiting_member_approval', currentRound: 1 }) });
    expect(await sent.run()).toEqual({ ok: false, error: { kind: 'stage_changed', status: 'awaiting_member_approval' } });
    const bare = setup({ versions: [V0] });
    expect(await bare.run()).toEqual({ ok: false, error: { kind: 'no_working_copy' } });
    expect([...sent.audit.events, ...bare.audit.events]).toHaveLength(0);
  });

  it('a whitespace-only note is stored as no note', async () => {
    const { store, run } = setup();
    expect((await run({ noteToMember: '  ' })).ok).toBe(true);
    expect(store.versionsRepo.rows()[1]!.noteToMember).toBeNull();
  });

  it('a working copy that vanished under the lock → server_error, never a phantom save', async () => {
    const { store, run } = setup();
    store.versionsRepo.updateWorkingCopy.mockResolvedValueOnce(null);
    expect(await run()).toEqual({ ok: false, error: { kind: 'server_error', errKind: 'Error' } });
  });
});
