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
import { describe, expect, it, vi } from 'vitest';
import { uploadInlineImage } from '@/modules/broadcasts/application/use-cases/upload-inline-image';
import type {
  ImageAllowlistPort,
  Hostname,
} from '@/modules/broadcasts/application/ports/image-allowlist-port';
import type { VirusScannerPort } from '@/modules/broadcasts/application/ports/virus-scanner-port';
import type { ImageStoragePort } from '@/modules/broadcasts/application/ports/image-storage-port';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';

const TENANT = 'tenant_swe' as never;
const ACTOR = 'user_mem_42';
const ACTOR_EMAIL = 'm@example.com';
const DRAFT = '11111111-1111-1111-1111-111111111111';

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
} => {
  const allowlistPort: ImageAllowlistPort = {
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
    existsByContentHash: vi.fn().mockResolvedValue(
      o?.existingBlobUrl ?? null,
    ),
    put: vi.fn().mockResolvedValue({
      blobUrl: 'https://assets.swecham.zyncdata.app/broadcasts/images/tenant_swe/abc.png',
      contentHash: 'abc',
    }),
  };
  const audit: AuditPort = { emit: vi.fn().mockResolvedValue(undefined) };
  return { allowlistPort, scanner, storage, audit };
};

describe('uploadInlineImage contract — T063 (F7.1a US2)', () => {
  it('4 MB PNG succeeds, returns blobUrl matching default allowlist hostname', async () => {
    const deps = makeDeps();
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      draftId: DRAFT,
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
      draftId: DRAFT,
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
      draftId: DRAFT,
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

  it('ClamAV verdict=error → fail-closed reject', async () => {
    const deps = makeDeps({ scanVerdict: 'error' });
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      draftId: DRAFT,
      requestId: 'req-004',
      fileBytes: PNG_4MB,
      filename: 'x.png',
      mimeType: 'image/png',
    });
    expect(r.ok).toBe(false);
    expect(deps.storage.put).not.toHaveBeenCalled();
  });

  it('duplicate upload (same content-hash) returns existing blobUrl, no second storage write', async () => {
    const existing =
      'https://assets.swecham.zyncdata.app/broadcasts/images/tenant_swe/cached.png';
    const deps = makeDeps({ existingBlobUrl: existing });
    const r = await uploadInlineImage(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR,
      actorEmail: ACTOR_EMAIL,
      draftId: DRAFT,
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
      draftId: DRAFT,
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
      draftId: DRAFT,
      requestId: 'req-007',
      fileBytes: PNG_4MB,
      filename: '<script>alert(1)</script>.png',
      mimeType: 'image/png',
    });
    expect(r.ok).toBe(true);
    const putCall = (deps.storage.put as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(JSON.stringify(putCall)).not.toContain('<script>');
  });
});
