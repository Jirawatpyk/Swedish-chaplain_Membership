/**
 * F119 R17 — `listMemberBroadcastImages`, the GDPR export's read of every image
 * uploaded for the member's own E-Blasts.
 *
 * The projection is the contract: the archive never names a user (no uploader
 * id), and a stamped image's URL is about to be reclaimed, so it is not
 * re-published — only a live image carries `blobUrl`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '@/modules/members';
import type { BroadcastImageRecord } from '@/modules/broadcasts/application/ports/broadcast-images-repo';
import { listMemberBroadcastImages } from '@/modules/broadcasts/application/use-cases/list-member-broadcast-images';
import { FAKE_TX, makeFakeBroadcastImagesRepo } from '../../../helpers/eblast-approval-fakes';

const TENANT = { slug: 'tenant-swe' } as unknown as TenantContext;
const MEMBER = '22222222-2222-2222-2222-222222222222' as MemberId;
const BROADCAST = '11111111-1111-1111-1111-111111111111';

function imageRow(over: Partial<BroadcastImageRecord>): BroadcastImageRecord {
  return {
    id: 'img-1',
    tenantId: 'tenant-swe',
    ownerKind: 'broadcast',
    ownerId: BROADCAST,
    contentHash: 'hash-a',
    blobUrl: 'https://assets.swecham.zyncdata.app/broadcasts/images/tenant-swe/hash-a.png',
    blobKey: 'broadcasts/images/tenant-swe/hash-a.png',
    mimeType: 'image/png',
    byteSize: 1024,
    uploadedByUserId: 'uploader-1',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    deletedAt: null,
    ...over,
  };
}

describe('listMemberBroadcastImages (F119 R17)', () => {
  it('reads by member inside a tenant tx, keeps the URL of a live image only, and never carries the uploader', async () => {
    const imagesRepo = makeFakeBroadcastImagesRepo();
    const stampedAt = new Date('2026-09-10T00:00:00Z');
    vi.mocked(imagesRepo.listByMember).mockResolvedValue([
      imageRow({ id: 'img-live' }),
      imageRow({ id: 'img-stamped', contentHash: 'hash-b', deletedAt: stampedAt }),
    ]);

    const images = await listMemberBroadcastImages({ tenant: TENANT, imagesRepo }, { memberId: MEMBER, limit: 51 });

    expect(imagesRepo.listByMember).toHaveBeenCalledWith('tenant-swe', MEMBER, 51, FAKE_TX);
    expect(images).toEqual([
      {
        imageId: 'img-live',
        broadcastId: BROADCAST,
        contentHash: 'hash-a',
        mimeType: 'image/png',
        byteSize: 1024,
        createdAt: new Date('2026-09-01T00:00:00Z'),
        deletedAt: null,
        blobUrl: 'https://assets.swecham.zyncdata.app/broadcasts/images/tenant-swe/hash-a.png',
      },
      {
        imageId: 'img-stamped',
        broadcastId: BROADCAST,
        contentHash: 'hash-b',
        mimeType: 'image/png',
        byteSize: 1024,
        createdAt: new Date('2026-09-01T00:00:00Z'),
        deletedAt: stampedAt,
      },
    ]);
    expect(images[1]).not.toHaveProperty('blobUrl');
    expect(JSON.stringify(images)).not.toContain('uploader-1');
  });
});
