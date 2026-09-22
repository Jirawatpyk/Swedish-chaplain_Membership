/**
 * F119 review finding F2-1 — DELETE /api/broadcasts/draft/[id] ("Discard draft").
 *
 * The route hard-deletes the `broadcasts` row. `broadcast_images.owner_id`
 * carries no FK (two possible parents), so nothing in the database reacted: the
 * image rows stayed live and un-stamped, the daily sweep reads
 * `deleted_at IS NOT NULL` and could therefore never see them, and the member's
 * uploaded photograph stayed at a PUBLIC, unauthenticated blob URL that no code
 * path could ever remove — not the sweep, not the Art. 17 / §33 erasure cascade.
 *
 * What this pins at the wire: the stamp runs, it runs in the DELETE's OWN
 * transaction, and the refusal paths (not-yours, not-a-draft) stamp nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const requireMemberContextMock = vi.fn();
const findByIdMock = vi.fn();
const markOwnerImagesRemovedMock = vi.fn(async () => 2);
const executeMock = vi.fn(async () => undefined);

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  runInTenant: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ execute: executeMock }),
}));
vi.mock('@/modules/broadcasts', () => ({
  parseBroadcastId: (id: string) =>
    /^[0-9a-f-]{36}$/i.test(id) ? { ok: true, value: id } : { ok: false, error: 'bad' },
  makeGetBroadcastDeps: () => ({ broadcastsRepo: { findById: findByIdMock } }),
  markOwnerImagesRemoved: (...args: unknown[]) => markOwnerImagesRemovedMock(...(args as [])),
  drizzleBroadcastImagesRepo: { __repo: true },
  f7AuditAdapter: { __audit: true },
}));

const DRAFT = '11111111-1111-1111-1111-111111111111';
const MEMBER = 'm-1';

const memberCtx = {
  current: { user: { id: 'user-member-1', role: 'member' as const } },
  tenant: { slug: 'test-tenant' },
  member: { memberId: MEMBER },
  memberId: MEMBER,
  requestId: 'req-1',
};

async function importRoute(): Promise<typeof import('@/app/api/broadcasts/draft/[id]/route')> {
  return import('@/app/api/broadcasts/draft/[id]/route');
}

function req(id = DRAFT): NextRequest {
  return new NextRequest(`http://localhost:3100/api/broadcasts/draft/${id}`, { method: 'DELETE' });
}

const params = (id = DRAFT): { params: Promise<{ id: string }> } => ({ params: Promise.resolve({ id }) });

describe('DELETE /api/broadcasts/draft/[id] — F2-1 image stamping', () => {
  beforeEach(() => {
    vi.resetModules();
    requireMemberContextMock.mockResolvedValue(memberCtx);
    findByIdMock.mockResolvedValue({
      broadcastId: DRAFT,
      status: 'draft',
      requestedByMemberId: MEMBER,
    });
    markOwnerImagesRemovedMock.mockClear();
    executeMock.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('204 and stamps the draft\'s images with reason draft_discarded, in the DELETE\'s own tx', async () => {
    const { DELETE } = await importRoute();
    const res = await DELETE(req(), params());
    expect(res.status).toBe(204);

    expect(markOwnerImagesRemovedMock).toHaveBeenCalledTimes(1);
    const [deps, input, tx] = markOwnerImagesRemovedMock.mock.calls[0]! as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
      { execute: unknown },
    ];
    expect(deps).toMatchObject({ imagesRepo: { __repo: true }, audit: { __audit: true } });
    expect(input).toMatchObject({
      owner: { kind: 'broadcast', id: DRAFT },
      reason: 'draft_discarded',
      actorUserId: 'user-member-1',
      actorRole: 'member',
      relatedMemberId: MEMBER,
    });
    // The SAME tx object the DELETE ran on — a stamp that commits separately
    // from the delete is the bug, in either direction.
    expect(tx.execute).toBe(executeMock);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('another member\'s draft → 404 and NOTHING is stamped or deleted', async () => {
    findByIdMock.mockResolvedValue({ broadcastId: DRAFT, status: 'draft', requestedByMemberId: 'someone-else' });
    const { DELETE } = await importRoute();
    expect((await DELETE(req(), params())).status).toBe(404);
    expect(markOwnerImagesRemovedMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('a submitted broadcast → 409 and NOTHING is stamped (images of a live E-Blast must survive)', async () => {
    findByIdMock.mockResolvedValue({ broadcastId: DRAFT, status: 'submitted', requestedByMemberId: MEMBER });
    const { DELETE } = await importRoute();
    expect((await DELETE(req(), params())).status).toBe(409);
    expect(markOwnerImagesRemovedMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('a stamp failure fails the whole request — no 204 over a half-done discard', async () => {
    markOwnerImagesRemovedMock.mockRejectedValueOnce(new Error('audit down'));
    const { DELETE } = await importRoute();
    const res = await DELETE(req(), params());
    expect(res.status).toBe(500);
  });
});
