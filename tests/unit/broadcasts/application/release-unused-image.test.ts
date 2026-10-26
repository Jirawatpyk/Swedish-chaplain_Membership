/**
 * Spec 131 (layer 1) — `releaseUnusedImage`: an image uploaded and then left
 * out of the message (its description cancelled) is stamped for the next
 * daily sweep, instead of staying live at its public URL until the E-Blast is
 * retention-deleted years later.
 *
 * The release is allowed exactly where the upload was (`authorizeImageOwner`,
 * reused unchanged). It stamps ONE live row of THAT owner and audits
 * `broadcast_image_removed { reason: 'not_inserted' }` in the same
 * transaction; a failed audit fails the release, so no unevidenced stamp
 * commits. It never deletes bytes: the marked arm does, under the
 * last-reference rule, and restores the row if live content still embeds it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MemberId } from '@/modules/members';
import { releaseUnusedImage } from '@/modules/broadcasts/application/use-cases/release-unused-image';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type { BroadcastImageRecord } from '@/modules/broadcasts/application/ports/broadcast-images-repo';
import { FAKE_TX, makeFakeBroadcastImagesRepo } from '../../../helpers/eblast-approval-fakes';

const TENANT = 'tenant-swe' as never;
const NOW = new Date('2026-10-26T03:00:00Z');
const DRAFT = '11111111-1111-1111-1111-111111111111';
const OTHER_DRAFT = '33333333-3333-3333-3333-333333333333';
const MEMBER = '22222222-2222-2222-2222-222222222222' as MemberId;

function makeAudit(): AuditPort & { events: Array<{ tx: unknown; eventType: string; payload: Record<string, unknown> }> } {
  const events: Array<{ tx: unknown; eventType: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    emit: vi.fn(async (tx: unknown, e) => {
      events.push({ tx, eventType: e.eventType, payload: e.payload });
    }),
    emitTyped: vi.fn(async (tx: unknown, e) => {
      events.push({ tx, eventType: e.eventType, payload: e.payload as Record<string, unknown> });
    }),
  } as never;
}

function imageRow(over: Partial<BroadcastImageRecord> = {}): BroadcastImageRecord {
  return {
    id: 'img-1',
    tenantId: 'tenant-swe',
    ownerKind: 'broadcast',
    ownerId: DRAFT,
    contentHash: 'hash-a',
    blobUrl: 'https://assets.swecham.zyncdata.app/broadcasts/images/tenant-swe/hash-a.png',
    blobKey: 'broadcasts/images/tenant-swe/hash-a.png',
    mimeType: 'image/png',
    byteSize: 1024,
    uploadedByUserId: 'u-1',
    createdAt: new Date('2026-10-26T02:59:00Z'),
    deletedAt: null,
    ...over,
  };
}

function makeDeps(seed: readonly BroadcastImageRecord[], draftStatus: string = 'draft') {
  const imagesRepo = makeFakeBroadcastImagesRepo(seed);
  const audit = makeAudit();
  const broadcastsRepo = {
    findOwnedByMember: vi.fn(async (_t: never, memberId: MemberId, id: string) =>
      memberId === MEMBER && id === DRAFT
        ? { broadcast: { broadcastId: DRAFT, status: draftStatus, requestedByMemberId: MEMBER }, probeKind: null }
        : { broadcast: null, probeKind: 'cross_member' as const },
    ),
    findById: vi.fn(async (_t: never, id: string) =>
      id === DRAFT ? { broadcastId: DRAFT, status: draftStatus, requestedByMemberId: MEMBER } : null,
    ),
  };
  const templates = { findById: vi.fn(async () => null) };
  return {
    imagesRepo,
    audit,
    deps: {
      imagesRepo,
      audit,
      owner: { tenant: { slug: TENANT } as never, broadcastsRepo, templates, audit } as never,
    },
  };
}

const memberInput = (over: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  owner: { kind: 'broadcast' as const, id: DRAFT },
  imageId: 'img-1',
  actor: { kind: 'member' as const, memberId: MEMBER },
  actorUserId: 'u-1',
  actorRole: 'member',
  requestId: 'req-1',
  now: NOW,
  ...over,
});

describe('releaseUnusedImage — spec 131 layer 1', () => {
  it('stamps the row in the tx and audits not_inserted (blob_deleted false, related_member_id, never member_id)', async () => {
    const { deps, imagesRepo, audit } = makeDeps([imageRow()]);

    const r = await releaseUnusedImage(deps, memberInput());

    expect(r).toEqual({ ok: true, value: { released: true } });
    expect(imagesRepo.rows[0]!.deletedAt).toEqual(NOW);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.tx).toBe(FAKE_TX);
    expect(audit.events[0]!.eventType).toBe('broadcast_image_removed');
    expect(audit.events[0]!.payload).toMatchObject({
      image_id: 'img-1',
      owner_kind: 'broadcast',
      owner_id: DRAFT,
      blob_deleted: false,
      reason: 'not_inserted',
      related_member_id: MEMBER,
      actor_role: 'member',
    });
    expect(audit.events[0]!.payload).not.toHaveProperty('member_id');
  });

  it("another owner's or an already-stamped id releases nothing and audits nothing", async () => {
    const { deps, imagesRepo, audit } = makeDeps([
      imageRow({ id: 'img-other', ownerId: OTHER_DRAFT }),
      imageRow({ id: 'img-done', deletedAt: new Date('2026-10-25T00:00:00Z') }),
    ]);

    for (const imageId of ['img-other', 'img-done', 'img-missing']) {
      const r = await releaseUnusedImage(deps, memberInput({ imageId }));
      expect(r).toEqual({ ok: true, value: { released: false } });
    }
    expect(imagesRepo.rows.find((row) => row.id === 'img-other')!.deletedAt).toBeNull();
    expect(audit.events).toEqual([]);
  });

  it('a failed audit fails the release, so the caller tx rolls the stamp back', async () => {
    const { deps, audit } = makeDeps([imageRow()]);
    vi.mocked(audit.emitTyped).mockRejectedValueOnce(new Error('audit down'));

    await expect(releaseUnusedImage(deps, memberInput())).rejects.toThrow('audit down');
  });

  it('a refused owner stamps nothing: another member → not_found, a submitted draft for a member → closed', async () => {
    const other = makeDeps([imageRow()]);
    const r1 = await releaseUnusedImage(
      other.deps,
      memberInput({ actor: { kind: 'member', memberId: '99999999-9999-9999-9999-999999999999' } }),
    );
    expect(r1).toEqual({ ok: false, error: { kind: 'not_found' } });
    expect(other.imagesRepo.markDeletedById).not.toHaveBeenCalled();

    const submitted = makeDeps([imageRow()], 'submitted');
    const r2 = await releaseUnusedImage(submitted.deps, memberInput());
    expect(r2).toEqual({ ok: false, error: { kind: 'closed', status: 'submitted' } });
    expect(submitted.imagesRepo.rows[0]!.deletedAt).toBeNull();
  });

  it('staff release on a submitted E-Blast is allowed (the staff upload stages) and names the E-Blast member', async () => {
    const { deps, audit } = makeDeps([imageRow()], 'submitted');

    const r = await releaseUnusedImage(
      deps,
      memberInput({ actor: { kind: 'staff' }, actorUserId: 'staff-1', actorRole: 'marketing' }),
    );

    expect(r).toEqual({ ok: true, value: { released: true } });
    expect(audit.events[0]!.payload).toMatchObject({ related_member_id: MEMBER, actor_role: 'marketing' });
  });
});
