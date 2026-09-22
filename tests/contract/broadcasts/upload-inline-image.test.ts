/**
 * T063 (F7.1a US2) — Contract test for `uploadInlineImage` use-case.
 *
 * Verifies upload pipeline per contracts/image-upload.md § 1.1:
 *   - size cap (5 MB)
 *   - MIME allowlist
 *   - content-hash dedup
 *   - ClamAV verdict fail-closed
 *   - filename sanitisation
 *   - blobUrl ↔ default-allowlist hostname match
 *
 * RED-first per Constitution Principle II.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { uploadInlineImage } from '@/modules/broadcasts/application/use-cases/upload-inline-image';
import type {
  ImageAllowlistPort,
  Hostname,
} from '@/modules/broadcasts/application/ports/image-allowlist-port';
import type { VirusScannerPort } from '@/modules/broadcasts/application/ports/virus-scanner-port';
import type { ImageMimeType, ImageStoragePort } from '@/modules/broadcasts/application/ports/image-storage-port';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type { BroadcastImagesRepo } from '@/modules/broadcasts/application/ports/broadcast-images-repo';
import type { ImageReencoderPort } from '@/modules/broadcasts/application/ports/image-reencoder-port';

const TENANT = 'tenant_swe' as never;
const ACTOR = 'user_mem_42';
const ACTOR_EMAIL = 'm@example.com';
const DRAFT = '11111111-1111-1111-1111-111111111111';
// F119 T033 — the use case now takes the OWNER (a draft is a `broadcasts`
// row) and the ACTOR (a member upload carries `member_id` in the audit).
const OWNER = { kind: 'broadcast', id: DRAFT } as const;
const MEMBER_ACTOR = { role: 'member', memberId: '22222222-2222-2222-2222-222222222222' } as const;

const PNG_4MB = Buffer.alloc(4 * 1024 * 1024, 0x42);
const JPG_6MB = Buffer.alloc(6 * 1024 * 1024, 0x42);
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface DepsOverride {
  scanVerdict?: 'clean' | 'infected' | 'error';
  existingBlobUrl?: string | null;
}

const makeDeps = (
  o?: DepsOverride,
): {
  allowlistPort: ImageAllowlistPort;
  scanner: VirusScannerPort;
  storage: ImageStoragePort;
  audit: AuditPort;
  imagesRepo: BroadcastImagesRepo;
  reencoder: ImageReencoderPort;
} => {
  const allowlistPort: ImageAllowlistPort = {
    withTx: vi.fn(async <T>(_t: never, fn: (tx: unknown) => Promise<T>) =>
      fn(null),
    ),
    findByTenantId: vi.fn().mockResolvedValue([
      { hostname: 'assets.swecham.zyncdata.app' as Hostname, isDefault: true },
    ]),
    seedDefaults: vi.fn().mockResolvedValue(undefined),
    add: vi.fn(),
    remove: vi.fn(),
  };
  const scanner: VirusScannerPort = {
    scan: vi.fn().mockResolvedValue(
      o?.scanVerdict === 'infected'
        ? { verdict: 'infected', signature: 'EICAR-Test', durationMs: 12 }
        : o?.scanVerdict === 'error'
        ? { verdict: 'error', reason: 'unreachable', durationMs: 50 }
        : { verdict: 'clean', durationMs: 18 },
    ),
  };
  const storage: ImageStoragePort = {
    // ROUND-3 #1 — the probe is tri-state: `present` carries the ref, `absent`
    // is a real 404. (`unknown` — a `head` that FAILED — is exercised in
    // `tests/unit/broadcasts/application/eblast-image-lifecycle.test.ts`.)
    existsByContentHash: vi.fn().mockResolvedValue(
      o?.existingBlobUrl
        ? {
            status: 'present',
            blobUrl: o.existingBlobUrl,
            blobKey: 'broadcasts/images/tenant_swe/cached.png',
          }
        : { status: 'absent' },
    ),
    put: vi.fn().mockResolvedValue({
      blobUrl: 'https://assets.swecham.zyncdata.app/broadcasts/images/tenant_swe/abc.png',
      blobKey: 'broadcasts/images/tenant_swe/abc.png',
      contentHash: 'abc',
    }),
    delete: vi.fn(),
  };
  const audit: AuditPort = { emit: vi.fn().mockResolvedValue(undefined), emitTyped: vi.fn().mockResolvedValue(undefined) };
  const imagesRepo: BroadcastImagesRepo = {
    withTx: vi.fn(async <T>(_t: never, fn: (tx: unknown) => Promise<T>) => fn(null)),
    record: vi.fn(async (_t: never, input: Record<string, unknown>) => ({ id: 'img-1', ...input })) as never,
    listByOwner: vi.fn(),
    markDeletedByOwner: vi.fn(),
    listMarked: vi.fn(),
    markDeletedForMember: vi.fn(async () => []),
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
  // F2-3 — pass-through by default: the PIPELINE ORDER and the
  // hash-on-re-encoded-bytes rule are what these cases pin; the real
  // metadata strip is the sharp adapter's own unit test.
  const reencoder: ImageReencoderPort = {
    reencode: vi.fn(async (bytes: Uint8Array, mime: ImageMimeType) => ({
      ok: true as const,
      value: { bytes, mime },
    })),
  } as never;
  return { allowlistPort, scanner, storage, audit, imagesRepo, reencoder };
};

describe('uploadInlineImage contract — T063 (F7.1a US2)', () => {
  it('4 MB PNG succeeds, returns blobUrl matching default allowlist hostname', async () => {
    const deps = makeDeps();
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      requestId: 'req-001',
      fileBytes: Buffer.concat([PNG_HEADER, Buffer.alloc(PNG_4MB.length - 8, 0)]),
      filename: 'banner.png',
      mimeType: 'image/png',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.blobUrl).toContain('assets.swecham.zyncdata.app');
      expect(r.value.allowlistedHostname).toBe('assets.swecham.zyncdata.app');
      expect(typeof r.value.contentHash).toBe('string');
      expect(r.value.contentHash.length).toBeGreaterThan(8);
    }
  });

  it('6 MB JPG rejected with broadcast_image_too_large + audit + no scan', async () => {
    const deps = makeDeps();
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      requestId: 'req-002',
      fileBytes: JPG_6MB,
      filename: 'huge.jpg',
      mimeType: 'image/jpeg',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('broadcast_image_too_large');
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ eventType: 'broadcast_image_too_large' }),
    );
    expect(deps.scanner.scan).not.toHaveBeenCalled();
    expect(deps.storage.put).not.toHaveBeenCalled();
  });

  it('ClamAV verdict=infected → reject + audit + NO storage write (pipeline-order invariant)', async () => {
    const deps = makeDeps({ scanVerdict: 'infected' });
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      requestId: 'req-003',
      fileBytes: PNG_4MB,
      filename: 'evil.png',
      mimeType: 'image/png',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('broadcast_image_unsafe');
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'broadcast_image_unsafe',
        payload: expect.objectContaining({ verdict: 'infected' }),
      }),
    );
    expect(deps.storage.put).not.toHaveBeenCalled();
  });

  it('ClamAV verdict=error → fail-closed reject + audit emits with verdict=error (TA-M2 closure)', async () => {
    const deps = makeDeps({ scanVerdict: 'error' });
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      requestId: 'req-004',
      fileBytes: PNG_4MB,
      filename: 'x.png',
      mimeType: 'image/png',
    });
    expect(r.ok).toBe(false);
    expect(deps.storage.put).not.toHaveBeenCalled();
    // PR-review fix TA-M2 — pin the fail-closed audit branch. A future
    // refactor that swallows the scanner-error audit emit (turning
    // 422 reject into a silent fail-open class of bug) would break here.
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'broadcast_image_unsafe',
        payload: expect.objectContaining({ verdict: 'error' }),
      }),
    );
  });

  it('duplicate upload (same content-hash) returns existing blobUrl, no second storage write', async () => {
    const existing =
      'https://assets.swecham.zyncdata.app/broadcasts/images/tenant_swe/cached.png';
    const deps = makeDeps({ existingBlobUrl: existing });
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      requestId: 'req-005',
      fileBytes: PNG_4MB,
      filename: 'banner.png',
      mimeType: 'image/png',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.blobUrl).toBe(existing);
    expect(deps.storage.put).not.toHaveBeenCalled();
  });

  it('rejects non-image MIME (text/html) without scanning', async () => {
    const deps = makeDeps();
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      requestId: 'req-006',
      fileBytes: Buffer.from('<script>alert(1)</script>'),
      filename: 'evil.html',
      mimeType: 'text/html',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('broadcast_image_invalid_mime');
    expect(deps.scanner.scan).not.toHaveBeenCalled();
  });

  it('sanitises filename at boundary (FR-013 critique E6)', async () => {
    const deps = makeDeps();
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      requestId: 'req-007',
      fileBytes: PNG_4MB,
      filename: '<script>alert(1)</script>.png',
      mimeType: 'image/png',
    });
    expect(r.ok).toBe(true);
    const putCall = (deps.storage.put as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(JSON.stringify(putCall)).not.toContain('<script>');
  });

  it('auto-allowlists blob hostname after successful upload (C1/E1 verify-run fix)', async () => {
    const deps = makeDeps();
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      requestId: 'req-008',
      fileBytes: PNG_4MB,
      filename: 'banner.png',
      mimeType: 'image/png',
    });
    expect(r.ok).toBe(true);
    // After successful storage.put returning the Vercel Blob URL,
    // the use-case MUST idempotently seed the resulting hostname into
    // the tenant allowlist so the subsequent submit-time validation
    // accepts the <img src=blobUrl> the editor inserted.
    expect(deps.allowlistPort.seedDefaults).toHaveBeenCalledWith(
      TENANT,
      expect.arrayContaining([
        expect.stringMatching(/assets\.swecham\.zyncdata\.app/),
      ]),
    );
  });

  it('does NOT auto-allowlist when upload is rejected (oversize)', async () => {
    const deps = makeDeps();
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      requestId: 'req-009',
      fileBytes: JPG_6MB,
      filename: 'huge.jpg',
      mimeType: 'image/jpeg',
    });
    expect(r.ok).toBe(false);
    expect(deps.allowlistPort.seedDefaults).not.toHaveBeenCalled();
  });

  // PR-review fix 2026-05-21 R4-M3 — pin SF-M4 storage_unavailable
  // regex-narrowing. Without these tests, a future Vercel Blob SDK
  // rename of error classes would silently route ALL storage failures
  // through the `throw e` rethrow at upload-inline-image.ts:226 → 500
  // instead of 503, regressing the SF-M4 fix unobserved.
  it.each([
    'BlobAccessError',
    'BlobStoreSuspendedError',
    'BlobClientTokenExpiredError',
    'BlobServiceRateLimited',
    'BlobServiceNotAvailable',
  ])(
    'storage.put rejects with %s → maps to storage_unavailable err (SF-M4 regression net)',
    async (errName) => {
      const deps = makeDeps();
      (deps.storage.put as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error(`${errName}: simulated outage`), {
          name: errName,
        }),
      );
      const r = await uploadInlineImage(deps, {
        tenantId: TENANT,
        actorUserId: ACTOR,
        actorEmail: ACTOR_EMAIL,
        owner: OWNER,
        actor: MEMBER_ACTOR,
        requestId: `req-blob-${errName}`,
        fileBytes: PNG_4MB,
        filename: 'ok.png',
        mimeType: 'image/png',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('storage_unavailable');
    },
  );

  it('storage.put rejects with non-Blob error → rethrows (does NOT mask as storage_unavailable)', async () => {
    const deps = makeDeps();
    (deps.storage.put as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('UnrelatedError: simulated unknown failure'),
    );
    await expect(
      uploadInlineImage(deps, {
        tenantId: TENANT,
        actorUserId: ACTOR,
        actorEmail: ACTOR_EMAIL,
        owner: OWNER,
        actor: MEMBER_ACTOR,
        requestId: 'req-unrelated',
        fileBytes: PNG_4MB,
        filename: 'ok.png',
        mimeType: 'image/png',
      }),
    ).rejects.toThrow('UnrelatedError');
  });

  // -------------------------------------------------------------------------
  // F2-6 — a 0-byte File passes MIME + the `> MAX_BYTES` cap, gets scanned and
  // PUT, and only then violates the DB CHECK `byte_size BETWEEN 1 AND 5 MB` →
  // 500 plus an orphan blob with no row, which the sweep (keyed on marked ROWS)
  // can never see. The refusal has to sit ABOVE the scanner.
  // -------------------------------------------------------------------------
  it('a 0-byte file is refused before the scanner and before storage.put', async () => {
    const deps = makeDeps();
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      requestId: 'req-empty',
      fileBytes: Buffer.alloc(0),
      filename: 'empty.png',
      mimeType: 'image/png',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('broadcast_image_empty');
    expect(deps.scanner.scan).not.toHaveBeenCalled();
    expect(deps.storage.put).not.toHaveBeenCalled();
    expect(deps.storage.existsByContentHash).not.toHaveBeenCalled();
    expect(deps.imagesRepo.record).not.toHaveBeenCalled();
  });

  /**
   * ROUND-2 T-4 — the OTHER end of the same DB CHECK
   * (`byte_size BETWEEN 1 AND 5 MB`). The input-size guard sits above the
   * scanner, but the re-encoder is what decides the bytes that are actually
   * stored, and it can in principle hand back nothing. Without this arm an
   * empty re-encode would be PUT and then violate the CHECK inside
   * `recordImage`'s transaction: a 500 for the member plus an orphan blob with
   * no row, which the sweep — keyed on marked ROWS — can never see.
   */
  it('T-4: a re-encode that returns ZERO bytes is refused, and nothing is stored or recorded', async () => {
    const deps = makeDeps();
    vi.mocked(deps.reencoder.reencode).mockResolvedValue({
      ok: true,
      value: { bytes: new Uint8Array(0), mime: 'image/png' },
    });
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      requestId: 'req-reencoded-empty',
      fileBytes: Buffer.concat([PNG_HEADER, Buffer.alloc(500, 0x05)]),
      filename: 'vanished.png',
      mimeType: 'image/png',
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('broadcast_image_empty');
    // The scan DID run (the input was non-empty); storage and the row did not.
    expect(deps.scanner.scan).toHaveBeenCalledTimes(1);
    expect(deps.storage.put).not.toHaveBeenCalled();
    expect(deps.storage.existsByContentHash).not.toHaveBeenCalled();
    expect(deps.imagesRepo.record).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // F2-3 — member-uploaded bytes go to a PUBLIC blob URL. A phone photo carries
  // EXIF/GPS, so the co-ordinates of the member's office would be served to
  // every recipient. Re-encode strips it — AFTER the ClamAV verdict (never
  // decode unscanned bytes) and BEFORE hashing (so dedup keys the bytes that
  // are actually stored).
  // -------------------------------------------------------------------------
  it('re-encodes after the scan and before hashing; the hash + size are of the RE-ENCODED bytes', async () => {
    const deps = makeDeps();
    const clean = Buffer.concat([PNG_HEADER, Buffer.alloc(1016, 0x11)]);
    const order: string[] = [];
    vi.mocked(deps.scanner.scan).mockImplementation(async () => {
      order.push('scan');
      return { verdict: 'clean', durationMs: 5 };
    });
    vi.mocked(deps.reencoder.reencode).mockImplementation(async () => {
      order.push('reencode');
      return { ok: true, value: { bytes: new Uint8Array(clean), mime: 'image/png' } };
    });
    vi.mocked(deps.storage.existsByContentHash).mockImplementation(async () => {
      order.push('hash');
      return { status: 'absent' };
    });

    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      // WITH exif — different bytes, therefore a different sha256.
      fileBytes: Buffer.concat([PNG_HEADER, Buffer.alloc(3000, 0x99)]),
      requestId: 'req-exif',
      filename: 'phone-photo.png',
      mimeType: 'image/png',
    });

    expect(r.ok).toBe(true);
    // ROUND-2 R-H2 — `existsByContentHash` is now asked TWICE: once as the
    // dedup short-circuit, and once again inside `recordImage`'s transaction
    // while the content-hash advisory lock is held, because a whole sweep pass
    // fits between the two and would otherwise delete the bytes out from under
    // the row about to be inserted. The pipeline ORDER this test pins is
    // unchanged: scan → re-encode → hash.
    expect(order).toEqual(['scan', 'reencode', 'hash', 'hash']);
    // The bytes that reach storage are the re-encoded ones…
    const put = vi.mocked(deps.storage.put).mock.calls[0]![0];
    expect(Buffer.from(put.bytes)).toEqual(clean);
    // …and both the hash and the recorded byte size describe THOSE bytes.
    const expectedHash = createHash('sha256').update(clean).digest('hex');
    if (r.ok) expect(r.value.contentHash).toBe(expectedHash);
    expect(put.contentHash).toBe(expectedHash);
    const recorded = vi.mocked(deps.imagesRepo.record).mock.calls[0]![1];
    expect(recorded.byteSize).toBe(clean.length);
    expect(recorded.contentHash).toBe(expectedHash);
  });

  it('a re-encode that cannot decode the bytes is refused, and nothing is stored', async () => {
    const deps = makeDeps();
    vi.mocked(deps.reencoder.reencode).mockResolvedValue({
      ok: false,
      error: { kind: 'decode_failed', reason: 'unsupported image format' },
    });
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      requestId: 'req-undecodable',
      fileBytes: Buffer.concat([PNG_HEADER, Buffer.alloc(500, 0x01)]),
      filename: 'not-really.png',
      mimeType: 'image/png',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('broadcast_image_invalid_mime');
    expect(deps.storage.put).not.toHaveBeenCalled();
    expect(deps.imagesRepo.record).not.toHaveBeenCalled();
    // The member really did send bytes we cannot decode, so the security
    // signal is truthful and stays.
    const kinds = vi
      .mocked(deps.audit.emit)
      .mock.calls.map((c) => (c[1] as { eventType: string }).eventType);
    expect(kinds).toContain('broadcast_image_unsafe');
  });

  /**
   * ROUND-2 R-M3 (audit truth). Every throw out of sharp used to be
   * `decode_failed`, so a libvips OOM, a missing native binding or a hung
   * decode — all SERVER faults — reached the member as a permanent 415 and
   * were written into the audit log as `broadcast_image_unsafe`, a statement
   * about something the member did not do.
   */
  it('R-M3: a re-encoder OUTAGE is a 503-class refusal with NO unsafe audit row', async () => {
    const deps = makeDeps();
    vi.mocked(deps.reencoder.reencode).mockResolvedValue({
      ok: false,
      error: { kind: 'reencoder_unavailable', reason: 'reencode timeout after 15000ms' },
    });
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      requestId: 'req-reencoder-down',
      fileBytes: Buffer.concat([PNG_HEADER, Buffer.alloc(500, 0x01)]),
      filename: 'fine.png',
      mimeType: 'image/png',
    });

    expect(r.ok).toBe(false);
    // `storage_unavailable` is the route's existing 503 class.
    if (!r.ok) expect(r.error.kind).toBe('storage_unavailable');
    expect(deps.storage.put).not.toHaveBeenCalled();
    expect(deps.imagesRepo.record).not.toHaveBeenCalled();
    // Nothing is known about the bytes, so nothing claims they were unsafe.
    const kinds = vi
      .mocked(deps.audit.emit)
      .mock.calls.map((c) => (c[1] as { eventType: string }).eventType);
    expect(kinds).not.toContain('broadcast_image_unsafe');
  });

  it('a re-encode that grows past the 5 MB cap is refused on the OUTPUT size', async () => {
    const deps = makeDeps();
    vi.mocked(deps.reencoder.reencode).mockResolvedValue({
      ok: true,
      value: { bytes: new Uint8Array(6 * 1024 * 1024), mime: 'image/png' },
    });
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      requestId: 'req-grew',
      fileBytes: Buffer.concat([PNG_HEADER, Buffer.alloc(4 * 1024 * 1024, 0x22)]),
      filename: 'grew.png',
      mimeType: 'image/png',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('broadcast_image_too_large');
    expect(deps.storage.put).not.toHaveBeenCalled();
  });

  it('does NOT auto-allowlist when upload is rejected (scanner verdict=infected)', async () => {
    const deps = makeDeps({ scanVerdict: 'infected' });
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      owner: OWNER,
      actor: MEMBER_ACTOR,
      requestId: 'req-010',
      fileBytes: PNG_4MB,
      filename: 'evil.png',
      mimeType: 'image/png',
    });
    expect(r.ok).toBe(false);
    expect(deps.allowlistPort.seedDefaults).not.toHaveBeenCalled();
  });
});
