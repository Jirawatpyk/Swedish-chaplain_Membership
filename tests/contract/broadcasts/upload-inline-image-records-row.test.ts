/**
 * F119 T033 — every successful `uploadInlineImage` writes ONE
 * `broadcast_images` row and ONE `broadcast_image_uploaded` audit row, in
 * the same tenant tx (data-model § 4; spec § Audit trail).
 *
 * Payload rule (#336/#337 — migration 0009's `last_activity_at` trigger
 * fires on the snake_case key `member_id` and on NO other key):
 *   - a MEMBER upload carries `member_id` (uploading to one's own draft IS
 *     member activity — the member's recency moves);
 *   - a STAFF upload carries `related_member_id` instead and must NOT move
 *     it (the DB-level "moves / does not move" arm is exercised where the
 *     trigger lives: the live-Neon route suite, T146).
 * The payload never carries the blob URL. A refused upload (oversize,
 * infected, invalid MIME) writes no row at all.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MemberId } from '@/modules/members';
import { uploadInlineImage } from '@/modules/broadcasts/application/use-cases/upload-inline-image';
import type { ImageAllowlistPort, Hostname } from '@/modules/broadcasts/application/ports/image-allowlist-port';
import type { VirusScannerPort } from '@/modules/broadcasts/application/ports/virus-scanner-port';
import type { ImageStoragePort } from '@/modules/broadcasts/application/ports/image-storage-port';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type { BroadcastImagesRepo } from '@/modules/broadcasts/application/ports/broadcast-images-repo';
import { makeFakeImageReencoder } from '../../helpers/eblast-approval-fakes';

const TENANT = 'tenant-swe' as never;
const OWNER = '11111111-1111-1111-1111-111111111111';
const MEMBER = '22222222-2222-2222-2222-222222222222' as MemberId;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1024, 0)]);
const BLOB_URL = 'https://assets.swecham.zyncdata.app/broadcasts/images/tenant-swe/abc.png';
const BLOB_KEY = 'broadcasts/images/tenant-swe/abc.png';

function makeDeps(o?: { existing?: boolean; verdict?: 'clean' | 'infected' }) {
  const allowlistPort: ImageAllowlistPort = {
    withTx: vi.fn(async <T,>(_t: never, fn: (tx: unknown) => Promise<T>) => fn(null)),
    findByTenantId: vi.fn().mockResolvedValue([{ hostname: 'assets.swecham.zyncdata.app' as Hostname, isDefault: true }]),
    seedDefaults: vi.fn().mockResolvedValue(undefined),
    add: vi.fn(),
    remove: vi.fn(),
  };
  const scanner: VirusScannerPort = {
    scan: vi.fn().mockResolvedValue(
      o?.verdict === 'infected' ? { verdict: 'infected', signature: 'EICAR', durationMs: 1 } : { verdict: 'clean', durationMs: 1 },
    ),
  };
  const storage: ImageStoragePort = {
    // ROUND-3 #1 — tri-state probe: `present` (with the ref) or a real 404.
    existsByContentHash: vi
      .fn()
      .mockResolvedValue(
        o?.existing ? { status: 'present', blobUrl: BLOB_URL, blobKey: BLOB_KEY } : { status: 'absent' },
      ),
    put: vi.fn().mockResolvedValue({ blobUrl: BLOB_URL, blobKey: BLOB_KEY, contentHash: 'abc' }),
    delete: vi.fn(),
  };
  const audit: AuditPort = { emit: vi.fn().mockResolvedValue(undefined), emitTyped: vi.fn().mockResolvedValue(undefined) };
  const record = vi.fn(async (_t: never, input: Record<string, unknown>, _tx: unknown) => ({ id: 'img-1', ...input }));
  const imagesRepo: BroadcastImagesRepo = {
    withTx: vi.fn(async <T,>(_t: never, fn: (tx: unknown) => Promise<T>) => fn('tx-1')),
    record: record as never,
    listByOwner: vi.fn(),
    markDeletedByOwner: vi.fn(),
    listMarked: vi.fn(),
    markDeletedForMember: vi.fn(async () => []),
    listByMember: vi.fn(async () => []),
    // ROUND-2 R-M1 / S-3 — the batched prune stamp and the sweep's
    // keep-the-row arm. Unstubbed, either is an unexercised branch.
    markDeletedByOwners: vi.fn(async () => []),
    restoreLive: vi.fn(async () => undefined),
    listOrphaned: vi.fn(async () => []),
    lockContentHash: vi.fn(async () => undefined),
    isBlobReferencedByContent: vi.fn(async () => false),
    countLiveByContentHash: vi.fn(),
    remove: vi.fn(),
    // ROUND-3 #4 — the sweep's per-row `SET LOCAL statement_timeout`.
    setStatementTimeout: vi.fn(async () => undefined),
  };
  return { allowlistPort, scanner, storage, audit, imagesRepo, record, reencoder: makeFakeImageReencoder() };
}

const base = {
  tenantId: TENANT,
  actorUserId: 'user-1',
  actorEmail: 'u@example.com',
  requestId: 'req-1',
  fileBytes: PNG,
  filename: 'pic.png',
  mimeType: 'image/png',
};

describe('uploadInlineImage — records the image row + audit (T033)', () => {
  it('a success writes one broadcast_images row and one broadcast_image_uploaded audit row, in the same tx', async () => {
    const deps = makeDeps();
    const r = await uploadInlineImage(deps, {
      ...base,
      owner: { kind: 'broadcast', id: OWNER },
      actor: { role: 'member', memberId: MEMBER },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.imageId).toBe('img-1');
    expect(deps.record).toHaveBeenCalledTimes(1);
    const [, row, tx] = deps.record.mock.calls[0]!;
    expect(tx).toBe('tx-1');
    expect(row).toMatchObject({
      ownerKind: 'broadcast',
      ownerId: OWNER,
      blobUrl: BLOB_URL,
      blobKey: BLOB_KEY,
      mimeType: 'image/png',
      byteSize: PNG.byteLength,
      uploadedByUserId: 'user-1',
    });
    expect(typeof (row as { contentHash: string }).contentHash).toBe('string');
    expect(deps.audit.emitTyped).toHaveBeenCalledTimes(1);
    const [auditTx, event] = (deps.audit.emitTyped as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(auditTx).toBe('tx-1');
    expect(event).toMatchObject({ eventType: 'broadcast_image_uploaded', tenantId: TENANT, actorUserId: 'user-1' });
  });

  it('a MEMBER upload\'s payload carries snake_case `member_id` (the 0009 trigger key), never the blob URL', async () => {
    const deps = makeDeps();
    await uploadInlineImage(deps, { ...base, owner: { kind: 'broadcast', id: OWNER }, actor: { role: 'member', memberId: MEMBER } });
    const [, event] = (deps.audit.emitTyped as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = (event as { payload: Record<string, unknown> }).payload;
    expect(payload).toMatchObject({
      member_id: MEMBER,
      owner_kind: 'broadcast',
      owner_id: OWNER,
      image_id: 'img-1',
      byte_size: PNG.byteLength,
      mime_type: 'image/png',
      actor_role: 'member',
    });
    expect(typeof payload.content_hash).toBe('string');
    expect(payload).not.toHaveProperty('related_member_id');
    expect(payload).not.toHaveProperty('memberId');
    expect(JSON.stringify(payload)).not.toContain(BLOB_URL);
  });

  it('a STAFF upload carries `related_member_id` and NOT `member_id` (it must not move the member\'s recency)', async () => {
    const deps = makeDeps();
    await uploadInlineImage(deps, {
      ...base,
      owner: { kind: 'broadcast', id: OWNER },
      actor: { role: 'marketing', relatedMemberId: MEMBER },
    });
    const [, event] = (deps.audit.emitTyped as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = (event as { payload: Record<string, unknown> }).payload;
    expect(payload.related_member_id).toBe(MEMBER);
    expect(payload).not.toHaveProperty('member_id');
    expect(payload.actor_role).toBe('marketing');
  });

  it('a template image is recorded under owner_kind=template with related_member_id null', async () => {
    const deps = makeDeps();
    await uploadInlineImage(deps, {
      ...base,
      owner: { kind: 'template', id: OWNER },
      actor: { role: 'admin', relatedMemberId: null },
    });
    const [, row] = deps.record.mock.calls[0]!;
    expect(row).toMatchObject({ ownerKind: 'template', ownerId: OWNER });
    const [, event] = (deps.audit.emitTyped as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((event as { payload: Record<string, unknown> }).payload).toMatchObject({ owner_kind: 'template', related_member_id: null });
  });

  it('the dedup path (bytes already stored) still records a row — a second owner is a second reference', async () => {
    const deps = makeDeps({ existing: true });
    const r = await uploadInlineImage(deps, { ...base, owner: { kind: 'broadcast', id: OWNER }, actor: { role: 'member', memberId: MEMBER } });
    expect(r.ok).toBe(true);
    expect(deps.storage.put).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledTimes(1);
    expect(deps.record.mock.calls[0]![1]).toMatchObject({ blobKey: BLOB_KEY, blobUrl: BLOB_URL });
  });

  it('a refused upload (infected) writes no row and no uploaded audit', async () => {
    const deps = makeDeps({ verdict: 'infected' });
    const r = await uploadInlineImage(deps, { ...base, owner: { kind: 'broadcast', id: OWNER }, actor: { role: 'member', memberId: MEMBER } });
    expect(r.ok).toBe(false);
    expect(deps.record).not.toHaveBeenCalled();
    const types = (deps.audit.emitTyped as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as { eventType: string }).eventType);
    expect(types).not.toContain('broadcast_image_uploaded');
  });
});
