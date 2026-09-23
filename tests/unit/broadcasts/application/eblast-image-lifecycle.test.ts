/**
 * F119 review findings F2-1 and F2-10 — the image row/blob lifecycle.
 *
 * F2-1 (PDPA BLOCKER). `broadcast_images.owner_id` has no FK, so nothing in
 * the database reacts when an owner row is HARD-deleted. Two paths hard-delete
 * one — "Discard draft" and the daily `pruneExpiredDrafts` — and neither
 * touched the image rows. The sweep reads `deleted_at IS NOT NULL`, so an
 * un-stamped row is invisible to it forever: the member's photograph stays at
 * a public, unauthenticated blob URL that no code path can ever remove,
 * including the Art. 17 / §33 erasure cascade.
 *
 * F2-10 (reliability + migration). The sweep counted live rows and then
 * deleted the blob with no lock, so a dedup insert landing between the two
 * left a LIVE row pointing at a 404. And blobs uploaded before 0304 have no
 * row at all but are still referenced by old `body_html` — a later dedup row
 * being marked would delete them out from under a live E-Blast.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markOwnerImagesRemoved } from '@/modules/broadcasts/application/use-cases/_mark-owner-images-removed';
import { reclaimOrphanedImages } from '@/modules/broadcasts/application/use-cases/reclaim-orphaned-images';
import { pruneExpiredDrafts } from '@/modules/broadcasts/application/use-cases/prune-expired-drafts';
import { uploadInlineImage } from '@/modules/broadcasts/application/use-cases/upload-inline-image';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type { BroadcastImageRecord } from '@/modules/broadcasts/application/ports/broadcast-images-repo';
import type { ImageAllowlistPort, Hostname } from '@/modules/broadcasts/application/ports/image-allowlist-port';
import type { VirusScannerPort } from '@/modules/broadcasts/application/ports/virus-scanner-port';
import {
  FAKE_TX,
  makeFakeBroadcastImagesRepo,
  makeFakeImageReencoder,
  makeFakeImageStorage,
} from '../../../helpers/eblast-approval-fakes';

const TENANT = 'tenant-swe' as never;
const NOW = new Date('2026-09-22T03:00:00Z');
const DRAFT = '11111111-1111-1111-1111-111111111111';
const MEMBER = '22222222-2222-2222-2222-222222222222';

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
    id: 'img-seed',
    tenantId: 'tenant-swe',
    ownerKind: 'broadcast',
    ownerId: DRAFT,
    contentHash: 'hash-a',
    blobUrl: 'https://assets.swecham.zyncdata.app/broadcasts/images/tenant-swe/hash-a.png',
    blobKey: 'broadcasts/images/tenant-swe/hash-a.png',
    mimeType: 'image/png',
    byteSize: 1024,
    uploadedByUserId: 'u-1',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    deletedAt: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// ROUND-2 R-H2 — the dedup probe runs OUTSIDE the lock recordImage takes
// ---------------------------------------------------------------------------
describe('uploadInlineImage — R-H2: the dedup short-circuit re-checks the blob UNDER the lock', () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(512, 7),
  ]);

  function makeUploadDeps(storageOpts: { readonly rejectDuplicatePut?: boolean } = {}) {
    const allowlistPort: ImageAllowlistPort = {
      withTx: vi.fn(async <T,>(_t: never, fn: (tx: unknown) => Promise<T>) => fn(null)),
      findByTenantId: vi
        .fn()
        .mockResolvedValue([{ hostname: 'assets.swecham.zyncdata.app' as Hostname, isDefault: true }]),
      seedDefaults: vi.fn().mockResolvedValue(undefined),
      add: vi.fn(),
      remove: vi.fn(),
    };
    const scanner: VirusScannerPort = {
      scan: vi.fn().mockResolvedValue({ verdict: 'clean', durationMs: 1 }),
    };
    return {
      allowlistPort,
      scanner,
      storage: makeFakeImageStorage(storageOpts),
      audit: makeAudit(),
      imagesRepo: makeFakeBroadcastImagesRepo(),
      reencoder: makeFakeImageReencoder(),
    };
  }

  /**
   * The window: `storage.existsByContentHash` is asked BEFORE `recordImage`
   * opens its transaction and takes `lockContentHash`. A full sweep pass —
   * lock, count 0 live rows, delete the blob, remove the row, commit — fits
   * entirely inside it. The upload then short-circuited on a "yes" that was
   * already stale and inserted a live row pointing at bytes that no longer
   * exist: a 404 in an E-Blast that is about to be approved.
   *
   * Modelled by making the lock itself the moment the sweep finishes — that is
   * exactly where the sweep releases its own hold on the same key.
   */
  it('a sweep that reclaims the deduped blob between the probe and the lock still leaves a live row AND stored bytes', async () => {
    const deps = makeUploadDeps();
    const contentHash = createHash('sha256').update(PNG).digest('hex');
    // Seed: the bytes are already in storage, so the pre-lock probe says yes.
    await deps.storage.put({
      tenantId: TENANT,
      bytes: new Uint8Array(PNG),
      contentHash,
      mimeType: 'image/png',
      sanitisedFilename: 'seed.png',
    });
    vi.mocked(deps.storage.put).mockClear();
    // The sweep completes while we wait for the advisory lock.
    vi.mocked(deps.imagesRepo.lockContentHash).mockImplementation(async () => {
      deps.storage.keys.clear();
    });

    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: 'u-1',
      actorEmail: 'u@example.com',
      requestId: 'req-race',
      fileBytes: PNG,
      filename: 'pic.png',
      mimeType: 'image/png',
      owner: { kind: 'broadcast', id: DRAFT },
      actor: { role: 'member', memberId: MEMBER },
    });

    expect(r.ok).toBe(true);
    // One live row …
    expect(deps.imagesRepo.rows).toHaveLength(1);
    expect(deps.imagesRepo.rows[0]!.deletedAt).toBeNull();
    // … and the bytes it points at are actually there. The re-PUT happens
    // under the lock, and the key is content-addressed so it is idempotent.
    expect(deps.storage.keys.size).toBe(1);
    expect(vi.mocked(deps.storage.put)).toHaveBeenCalledTimes(1);
    if (r.ok) expect(deps.storage.keys.has(deps.imagesRepo.rows[0]!.blobKey)).toBe(true);
  });

  it('the ordinary dedup hit (blob still there under the lock) does NOT re-upload', async () => {
    const deps = makeUploadDeps();
    const contentHash = createHash('sha256').update(PNG).digest('hex');
    await deps.storage.put({
      tenantId: TENANT,
      bytes: new Uint8Array(PNG),
      contentHash,
      mimeType: 'image/png',
      sanitisedFilename: 'seed.png',
    });
    vi.mocked(deps.storage.put).mockClear();

    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: 'u-1',
      actorEmail: 'u@example.com',
      requestId: 'req-dedup',
      fileBytes: PNG,
      filename: 'pic.png',
      mimeType: 'image/png',
      owner: { kind: 'broadcast', id: DRAFT },
      actor: { role: 'member', memberId: MEMBER },
    });

    expect(r.ok).toBe(true);
    expect(vi.mocked(deps.storage.put)).not.toHaveBeenCalled();
    expect(deps.imagesRepo.rows).toHaveLength(1);
  });

  /**
   * ROUND-3 #1 — the re-PUT was reached on a probe that knew NOTHING.
   *
   * The adapter answers `null` for every non-404 `head` failure: a Blob
   * rate-limit, an expired token, a service blip. Under the lock that `null`
   * was read as "the sweep took the bytes", so the upload re-PUT them — into a
   * store where `allowOverwrite: false` makes a PUT over an existing pathname
   * THROW. The throw was raised inside `imagesRepo.withTx`, so the row rolled
   * back and the member got a 500 — and on the fresh-upload leg the bytes had
   * already been written by the first PUT, leaving a blob with no row: exactly
   * the unreachable-bytes class F2-1 exists to close.
   *
   * A probe that failed is `'unknown'`, not `'absent'`. On `'unknown'` the
   * upload proceeds to the INSERT: either the first PUT succeeded (fresh leg)
   * or the dedup hit above was genuine (dedup leg), so the bytes are there in
   * both readings, and the sweep's lock is still held to keep them there.
   */
  it('a probe that FAILED under the lock (not a 404) does not re-PUT and still records the row', async () => {
    const deps = makeUploadDeps();
    const contentHash = createHash('sha256').update(PNG).digest('hex');
    await deps.storage.put({
      tenantId: TENANT,
      bytes: new Uint8Array(PNG),
      contentHash,
      mimeType: 'image/png',
      sanitisedFilename: 'seed.png',
    });
    vi.mocked(deps.storage.put).mockClear();
    // The SECOND probe — the one under the lock — is a `head` that errored.
    deps.storage.probeOverrides.set(2, 'unknown');

    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: 'u-1',
      actorEmail: 'u@example.com',
      requestId: 'req-probe-unknown',
      fileBytes: PNG,
      filename: 'pic.png',
      mimeType: 'image/png',
      owner: { kind: 'broadcast', id: DRAFT },
      actor: { role: 'member', memberId: MEMBER },
    });

    expect(r.ok).toBe(true);
    expect(deps.imagesRepo.rows).toHaveLength(1);
    expect(deps.imagesRepo.rows[0]!.deletedAt).toBeNull();
    // Nothing was re-uploaded on a "don't know", and the bytes are still there.
    expect(vi.mocked(deps.storage.put)).not.toHaveBeenCalled();
    expect(deps.storage.keys.size).toBe(1);
  });

  /**
   * ROUND-3 #1 — and when the probe genuinely says 404 but the bytes are back
   * by the time the re-PUT lands (another upload of the same file won the
   * race), `allowOverwrite: false` refuses it. The refusal means the object IS
   * at that content-addressed key, which is what the re-PUT wanted: it is a
   * success, not a 500 that discards the member's row.
   */
  it('a re-PUT refused as already-existing counts as stored, not as a failure', async () => {
    const deps = makeUploadDeps({ rejectDuplicatePut: true });
    const contentHash = createHash('sha256').update(PNG).digest('hex');
    await deps.storage.put({
      tenantId: TENANT,
      bytes: new Uint8Array(PNG),
      contentHash,
      mimeType: 'image/png',
      sanitisedFilename: 'seed.png',
    });
    vi.mocked(deps.storage.put).mockClear();
    // Probe 2 reports a real 404 while the bytes are, in fact, present.
    deps.storage.probeOverrides.set(2, 'absent');

    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: 'u-1',
      actorEmail: 'u@example.com',
      requestId: 'req-reput-exists',
      fileBytes: PNG,
      filename: 'pic.png',
      mimeType: 'image/png',
      owner: { kind: 'broadcast', id: DRAFT },
      actor: { role: 'member', memberId: MEMBER },
    });

    expect(r.ok).toBe(true);
    expect(deps.imagesRepo.rows).toHaveLength(1);
    // The re-PUT was attempted once and its refusal was absorbed.
    expect(vi.mocked(deps.storage.put)).toHaveBeenCalledTimes(1);
    expect(deps.storage.keys.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F2-1 — the shared stamp helper
// ---------------------------------------------------------------------------
describe('markOwnerImagesRemoved — F2-1', () => {
  it('stamps every live image of the owner IN THE CALLER\'S tx and audits one row each', async () => {
    const imagesRepo = makeFakeBroadcastImagesRepo([
      imageRow({ id: 'img-1', contentHash: 'hash-a' }),
      imageRow({ id: 'img-2', contentHash: 'hash-b' }),
      imageRow({ id: 'img-other', ownerId: 'other-draft' }),
    ]);
    const audit = makeAudit();
    const CALLER_TX = Symbol('caller-tx');

    const n = await markOwnerImagesRemoved(
      { imagesRepo, audit },
      {
        tenantId: TENANT,
        owner: { kind: 'broadcast', id: DRAFT },
        reason: 'draft_discarded',
        at: NOW,
        requestId: 'req-1',
        actorUserId: 'u-1',
        actorRole: 'member',
        relatedMemberId: MEMBER,
      },
      CALLER_TX,
    );

    expect(n).toBe(2);
    // Same tx object for the stamp AND for every audit row — the co-commit.
    expect(vi.mocked(imagesRepo.markDeletedByOwner).mock.calls[0]![3]).toBe(CALLER_TX);
    expect(audit.events.map((e) => e.tx)).toEqual([CALLER_TX, CALLER_TX]);
    expect(audit.events.map((e) => e.eventType)).toEqual([
      'broadcast_image_removed',
      'broadcast_image_removed',
    ]);
    expect(audit.events[0]!.payload).toMatchObject({
      related_member_id: MEMBER,
      owner_kind: 'broadcast',
      owner_id: DRAFT,
      image_id: 'img-1',
      content_hash: 'hash-a',
      blob_deleted: false,
      reason: 'draft_discarded',
      actor_role: 'member',
    });
    // The other owner's image is untouched.
    expect(imagesRepo.rows.find((r) => r.id === 'img-other')!.deletedAt).toBeNull();
  });

  it('carries related_member_id, never snake_case member_id (a deletion is not member activity)', async () => {
    const imagesRepo = makeFakeBroadcastImagesRepo([imageRow({ id: 'img-1' })]);
    const audit = makeAudit();
    await markOwnerImagesRemoved(
      { imagesRepo, audit },
      {
        tenantId: TENANT,
        owner: { kind: 'broadcast', id: DRAFT },
        reason: 'draft_pruned',
        at: NOW,
        requestId: 'r',
        actorUserId: 'system',
        actorRole: 'system',
        relatedMemberId: MEMBER,
      },
      FAKE_TX,
    );
    expect(Object.keys(audit.events[0]!.payload)).not.toContain('member_id');
  });

  it('an audit-emit failure propagates so the caller\'s tx rolls the stamp back', async () => {
    const imagesRepo = makeFakeBroadcastImagesRepo([imageRow({ id: 'img-1' })]);
    const audit = makeAudit();
    vi.mocked(audit.emit).mockRejectedValueOnce(new Error('audit down'));
    await expect(
      markOwnerImagesRemoved(
        { imagesRepo, audit },
        {
          tenantId: TENANT,
          owner: { kind: 'broadcast', id: DRAFT },
          reason: 'draft_discarded',
          at: NOW,
          requestId: 'r',
          actorUserId: 'u',
          actorRole: null,
          relatedMemberId: null,
        },
        FAKE_TX,
      ),
    ).rejects.toThrow('audit down');
  });
});

// ---------------------------------------------------------------------------
// F2-1 — the daily prune
// ---------------------------------------------------------------------------
describe('pruneExpiredDrafts — F2-1: a pruned draft takes its images with it', () => {
  it('stamps + audits the images of every pruned draft, in the SAME tx as the DELETE', async () => {
    const imagesRepo = makeFakeBroadcastImagesRepo([
      imageRow({ id: 'img-1', ownerId: 'draft-a' }),
      imageRow({ id: 'img-2', ownerId: 'draft-b', contentHash: 'hash-b' }),
      imageRow({ id: 'img-live', ownerId: 'draft-kept' }),
    ]);
    const audit = makeAudit();
    const TX = Symbol('prune-tx');
    const broadcastsRepo = {
      withTx: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) => fn(TX)),
      pruneExpiredDrafts: vi.fn(async () => ({
        prunedCount: 2,
        prunedDrafts: [
          { broadcastId: 'draft-a', requestedByMemberId: MEMBER },
          { broadcastId: 'draft-b', requestedByMemberId: null },
        ],
      })),
    } as never;

    const r = await pruneExpiredDrafts({
      tenant: { slug: 'tenant-swe' } as never,
      broadcastsRepo,
      imagesRepo,
      audit,
      clock: { now: () => NOW } as never,
      requestId: 'cron-prune-1',
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.prunedCount).toBe(2);
    // The DELETE and the batch's ONE stamp statement share one transaction
    // (ROUND-2 R-M1 — it used to be one stamp per draft).
    expect(vi.mocked(imagesRepo.markDeletedByOwners).mock.calls.map((c) => c[4])).toEqual([TX]);
    expect(vi.mocked(imagesRepo.markDeletedByOwners).mock.calls[0]![2]).toEqual(['draft-a', 'draft-b']);
    expect(audit.events.map((e) => e.tx)).toEqual([TX, TX]);
    expect(audit.events.map((e) => e.payload['reason'])).toEqual(['draft_pruned', 'draft_pruned']);
    expect(audit.events.map((e) => e.payload['related_member_id'])).toEqual([MEMBER, null]);
    // The cron has no session: 'system', never a fabricated role.
    expect(audit.events.map((e) => e.payload['actor_role'])).toEqual(['system', 'system']);
    // A draft that was not pruned keeps its image live.
    expect(imagesRepo.rows.find((r2) => r2.id === 'img-live')!.deletedAt).toBeNull();
  });

  /**
   * ROUND-2 R-M1. The DELETE had no LIMIT and the stamp ran once PER DRAFT,
   * all inside one transaction. A tenant that let drafts pile up (or a first
   * run after the 30-day window was introduced) would hold row locks on every
   * expired draft and issue N round-trips for the stamps, in one long-running
   * transaction — on a pooled Neon connection with `statement_timeout` dropped.
   *
   * Bounded batches, ONE stamp statement per batch, and the tick loops until a
   * short batch or the time budget.
   */
  it('R-M1: bounded batches — the LIMIT reaches the repo and the stamp is ONE call per batch, not per draft', async () => {
    const imagesRepo = makeFakeBroadcastImagesRepo([
      imageRow({ id: 'img-a', ownerId: 'draft-a' }),
      imageRow({ id: 'img-b', ownerId: 'draft-b', contentHash: 'hash-b' }),
      imageRow({ id: 'img-c', ownerId: 'draft-c', contentHash: 'hash-c' }),
    ]);
    const audit = makeAudit();
    const TX = Symbol('prune-tx');
    const pages = [
      {
        prunedCount: 2,
        prunedDrafts: [
          { broadcastId: 'draft-a', requestedByMemberId: MEMBER },
          { broadcastId: 'draft-b', requestedByMemberId: null },
        ],
      },
      {
        prunedCount: 1,
        prunedDrafts: [{ broadcastId: 'draft-c', requestedByMemberId: MEMBER }],
      },
    ];
    let page = 0;
    const pruneSpy = vi.fn(
      async (_t: unknown, _cutoff: unknown, _tx: unknown, _limit?: number) =>
        pages[page++] ?? { prunedCount: 0, prunedDrafts: [] },
    );
    const broadcastsRepo = {
      withTx: vi.fn(async <T,>(fn: (tx: unknown) => Promise<T>) => fn(TX)),
      pruneExpiredDrafts: pruneSpy,
    } as never;

    const r = await pruneExpiredDrafts({
      tenant: { slug: 'tenant-swe' } as never,
      broadcastsRepo,
      imagesRepo,
      audit,
      clock: { now: () => NOW } as never,
      requestId: 'cron-prune-2',
      batchSize: 2,
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.prunedCount).toBe(3);
    // The batch size reaches the SQL, as the 4th positional arg after tx.
    const pruneCalls = pruneSpy.mock.calls;
    expect(pruneCalls.map((c) => c[3])).toEqual([2, 2]);
    // A full batch is followed by another; the short one ends the loop.
    expect(pruneCalls).toHaveLength(2);
    // ONE stamp statement per batch — not one per draft.
    const stampCalls = vi.mocked(imagesRepo.markDeletedByOwners).mock.calls;
    expect(stampCalls).toHaveLength(2);
    expect(stampCalls[0]![2]).toEqual(['draft-a', 'draft-b']);
    expect(stampCalls[1]![2]).toEqual(['draft-c']);
    expect(vi.mocked(imagesRepo.markDeletedByOwner)).not.toHaveBeenCalled();
    // Every stamped row is still audited, each with ITS OWN draft's member.
    expect(audit.events).toHaveLength(3);
    const byImage = new Map(audit.events.map((e) => [e.payload['image_id'], e.payload]));
    expect(byImage.get('img-a')).toMatchObject({ related_member_id: MEMBER, reason: 'draft_pruned' });
    expect(byImage.get('img-b')).toMatchObject({ related_member_id: null });
    expect(byImage.get('img-c')).toMatchObject({ related_member_id: MEMBER });
  });
});

// ---------------------------------------------------------------------------
// F2-1 / F2-10 — the sweep
// ---------------------------------------------------------------------------
describe('reclaimOrphanedImages — F2-1 orphan arm + F2-10 races', () => {
  let audit: ReturnType<typeof makeAudit>;
  beforeEach(() => {
    audit = makeAudit();
  });

  it('F2-1 defence in depth: a LIVE row whose owner no longer exists is reaped too', async () => {
    const orphan = imageRow({ id: 'img-orphan', ownerId: 'deleted-draft', deletedAt: null });
    const imagesRepo = makeFakeBroadcastImagesRepo([orphan]);
    // Nothing is MARKED; the orphan is only visible to the new arm.
    vi.mocked(imagesRepo.listMarked).mockResolvedValue([]);
    vi.mocked(imagesRepo.listOrphaned).mockResolvedValue([orphan]);
    const storage = makeFakeImageStorage();

    const r = await reclaimOrphanedImages(
      { imagesRepo, storage, audit },
      { tenantId: TENANT, now: NOW, requestId: 'sweep-1' },
    );

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ rowsRemoved: 1, blobsDeleted: 1 });
    expect(storage.deleted).toEqual([orphan.blobKey]);
    expect(audit.events[0]!.payload).toMatchObject({
      image_id: 'img-orphan',
      blob_deleted: true,
      reason: 'sweep_orphaned',
      actor_role: 'system',
    });
  });

  /**
   * ROUND-3 #4 — T035 requires the image-sweep block to run under "its own
   * `SET LOCAL statement_timeout`" and nothing ever set one.
   *
   * Both of the sweep's per-row waits are unbounded without it. The advisory
   * lock blocks until whoever holds it commits, and
   * `isBlobReferencedByContent` is a sequential `position()` scan of
   * `broadcasts` + `broadcast_templates` run once PER SWEPT ROW — up to 400 a
   * tick. On a pooled Neon connection the app's own 5 s `statement_timeout` is
   * dropped (the pooler reports 0), so neither resolves on its own: the tick
   * runs until Vercel kills it at `maxDuration`, mid-sweep, with the blob
   * store and `broadcast_images` left disagreeing.
   *
   * It has to be the FIRST statement of the transaction — a bound set after
   * the statement it is meant to bound is not a bound.
   */
  it('ROUND-3 #4: every per-row tx bounds itself BEFORE it locks, counts or scans content', async () => {
    const a = imageRow({ id: 'img-1', deletedAt: NOW });
    const b = imageRow({ id: 'img-2', ownerId: 'draft-2', contentHash: 'hash-b', deletedAt: NOW });
    const imagesRepo = makeFakeBroadcastImagesRepo([a, b]);
    const order: string[] = [];
    vi.mocked(imagesRepo.setStatementTimeout).mockImplementation(async () => {
      order.push('timeout');
    });
    vi.mocked(imagesRepo.lockContentHash).mockImplementation(async () => {
      order.push('lock');
    });
    vi.mocked(imagesRepo.countLiveByContentHash).mockImplementation(async () => {
      order.push('count');
      return 0;
    });
    vi.mocked(imagesRepo.isBlobReferencedByContent).mockImplementation(async () => {
      order.push('content-scan');
      return false;
    });

    await reclaimOrphanedImages(
      { imagesRepo, storage: makeFakeImageStorage(), audit },
      { tenantId: TENANT, now: NOW, requestId: 's' },
    );

    // Once per row, first each time.
    expect(order).toEqual([
      'timeout',
      'lock',
      'count',
      'content-scan',
      'timeout',
      'lock',
      'count',
      'content-scan',
    ]);
    // A positive, finite bound in milliseconds, and the tx it belongs to.
    const [ms, tx] = vi.mocked(imagesRepo.setStatementTimeout).mock.calls[0]!;
    expect(ms).toBeGreaterThan(0);
    expect(Number.isFinite(ms)).toBe(true);
    expect(tx).toBe(FAKE_TX);
  });

  it('F2-10(a): the per-row tx takes the content-hash advisory lock BEFORE counting live rows', async () => {
    const marked = imageRow({ id: 'img-1', deletedAt: NOW });
    const imagesRepo = makeFakeBroadcastImagesRepo([marked]);
    const order: string[] = [];
    vi.mocked(imagesRepo.lockContentHash).mockImplementation(async () => {
      order.push('lock');
    });
    vi.mocked(imagesRepo.countLiveByContentHash).mockImplementation(async () => {
      order.push('count');
      return 0;
    });
    const storage = makeFakeImageStorage();

    await reclaimOrphanedImages({ imagesRepo, storage, audit }, { tenantId: TENANT, now: NOW, requestId: 's' });

    expect(order).toEqual(['lock', 'count']);
    expect(vi.mocked(imagesRepo.lockContentHash).mock.calls[0]![1]).toBe('hash-a');
  });

  /**
   * ROUND-2 S-3 (PDPA reach). The `sweep_referenced` arm kept the BYTES and
   * then removed the ROW anyway. With the row gone the image was reachable by
   * nothing ever again — not the marked arm (no row to stamp), not the orphan
   * arm (no row to anti-join), not the erasure cascade (which stamps rows).
   * The blob simply left the product's reach while still being served.
   *
   * It must stay a LIVE row instead: un-stamped, so the next erasure or the
   * orphan arm can still find it once the content that references it is gone.
   * Nothing was removed, so no `broadcast_image_removed` row is written.
   */
  it('S-3: a blob still referenced by live content keeps its BYTES *and* its row (un-stamped, still reachable)', async () => {
    const marked = imageRow({ id: 'img-1', deletedAt: NOW });
    const imagesRepo = makeFakeBroadcastImagesRepo([marked]);
    vi.mocked(imagesRepo.countLiveByContentHash).mockResolvedValue(0);
    vi.mocked(imagesRepo.isBlobReferencedByContent).mockResolvedValue(true);
    const storage = makeFakeImageStorage();

    const r = await reclaimOrphanedImages(
      { imagesRepo, storage, audit },
      { tenantId: TENANT, now: NOW, requestId: 's' },
    );

    expect(storage.deleted).toEqual([]);
    if (r.ok) expect(r.value).toMatchObject({ rowsRemoved: 0, blobsDeleted: 0, retained: 1 });
    // The row survives, and it is LIVE again — visible to the orphan arm and
    // to a future erasure stamp.
    expect(imagesRepo.rows.map((x) => x.id)).toEqual(['img-1']);
    expect(imagesRepo.rows[0]!.deletedAt).toBeNull();
    expect(vi.mocked(imagesRepo.remove)).not.toHaveBeenCalled();
    // Nothing was removed, so nothing claims it was.
    expect(audit.events).toEqual([]);
    expect(vi.mocked(imagesRepo.isBlobReferencedByContent).mock.calls[0]![1]).toBe(marked.blobUrl);
  });

  it('F2-10 (LOW): two marked rows sharing one hash delete the blob ONCE and count it once', async () => {
    const a = imageRow({ id: 'img-1', deletedAt: NOW });
    const b = imageRow({ id: 'img-2', ownerId: 'draft-2', deletedAt: NOW });
    const imagesRepo = makeFakeBroadcastImagesRepo([a, b]);
    vi.mocked(imagesRepo.countLiveByContentHash).mockResolvedValue(0);
    const storage = makeFakeImageStorage();

    const r = await reclaimOrphanedImages(
      { imagesRepo, storage, audit },
      { tenantId: TENANT, now: NOW, requestId: 's' },
    );

    expect(storage.deleted).toEqual([a.blobKey]);
    if (r.ok) expect(r.value).toMatchObject({ scanned: 2, rowsRemoved: 2, blobsDeleted: 1 });
    // Both rows are audited; only the first says the bytes went.
    expect(audit.events.map((e) => e.payload['blob_deleted'])).toEqual([true, false]);
  });

  /**
   * F7-1 (audit truth). The second row of a shared-hash batch was audited
   * "blob kept by reference" — but the bytes were GONE, deleted by the first
   * row a moment earlier. Each audit row must state what happened to the
   * bytes, and the three removed-row cases are three different facts.
   */
  it('F7-1: the second row of a shared-hash batch says the bytes were already deleted — never "kept"', async () => {
    const a = imageRow({ id: 'img-1', deletedAt: NOW });
    const b = imageRow({ id: 'img-2', ownerId: 'draft-2', deletedAt: NOW });
    const imagesRepo = makeFakeBroadcastImagesRepo([a, b]);
    vi.mocked(imagesRepo.countLiveByContentHash).mockResolvedValue(0);

    await reclaimOrphanedImages(
      { imagesRepo, storage: makeFakeImageStorage(), audit },
      { tenantId: TENANT, now: NOW, requestId: 's' },
    );

    expect(audit.events.map((e) => e.payload['blob_disposition'])).toEqual(['deleted', 'reclaimed_by_sibling']);
    const summaries = vi.mocked(audit.emit).mock.calls.map(([, e]) => e.summary);
    expect(summaries).toEqual([
      'E-Blast image swept (blob deleted)',
      'E-Blast image swept (blob already deleted by an earlier row of this sweep)',
    ]);
    expect(summaries.join(' ')).not.toMatch(/kept/);
  });

  it('the last-reference rule still holds: a live sibling row keeps the blob', async () => {
    const marked = imageRow({ id: 'img-1', deletedAt: NOW });
    const imagesRepo = makeFakeBroadcastImagesRepo([marked, imageRow({ id: 'img-live', ownerId: 'other' })]);
    const storage = makeFakeImageStorage();
    const r = await reclaimOrphanedImages(
      { imagesRepo, storage, audit },
      { tenantId: TENANT, now: NOW, requestId: 's' },
    );
    expect(storage.deleted).toEqual([]);
    if (r.ok) expect(r.value).toMatchObject({ rowsRemoved: 1, blobsDeleted: 0 });
  });
});
