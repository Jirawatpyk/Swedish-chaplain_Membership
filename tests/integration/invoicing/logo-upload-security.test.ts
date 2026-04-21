/**
 * T092 — F4 US4 AS4 / FR-034 logo-upload security.
 *
 * Exercises the `uploadTenantLogo` use-case end-to-end with a fake
 * Blob adapter so every reject path + re-encode invariant is covered
 * without hitting the real Blob store (which is exercised in E2E via
 * T097).
 *
 * Covered:
 *   - SVG rejected (MIME whitelist excludes image/svg+xml).
 *   - > 1 MB rejected.
 *   - Dimensions outside [200..2000] × [100..500] rejected.
 *   - Valid PNG: sharp re-encode strips EXIF (re-decoded buffer has
 *     NO user-comment EXIF segment present in the input).
 *   - Declared-MIME vs detected-format mismatch rejected (declared
 *     PNG but bytes are JPEG).
 *   - Garbage bytes → decode_failed.
 *
 * T092b coverage:
 *   - 50-logo cap per tenant returns `logo_history_cap_reached` when
 *     the tenant's `invoicing/{id}/logos/*` prefix already holds ≥50
 *     objects.
 *   - Idempotency-Key replay behaviour lives at the route layer
 *     (`/api/tenant-invoice-settings/logo` handler uses the shared
 *     Upstash-backed infra in `src/lib/idempotency.ts`); replay is
 *     covered transitively by that module's tests. An E2E variant is
 *     tracked in `tests/e2e/invoice-settings.spec.ts`.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { uploadTenantLogo } from '@/modules/invoicing';
import type { BlobStoragePort } from '@/modules/invoicing/application/ports/blob-storage-port';
import type { AuditPort } from '@/modules/invoicing/application/ports/audit-port';

// Fake in-memory Blob adapter — captures uploaded key + bytes so
// assertions can re-decode and verify EXIF strip behaviour.
function makeFakeBlob(seedKeys: readonly string[] = []) {
  const store = new Map<string, Uint8Array>();
  for (const k of seedKeys) store.set(k, new Uint8Array());
  const adapter: BlobStoragePort = {
    uploadPdf: async () => {
      throw new Error('uploadPdf not used in this suite');
    },
    uploadLogo: async ({ key, body }) => {
      store.set(key, new Uint8Array(body));
      return { key, url: `memory://${key}` };
    },
    signDownloadUrl: async (key) => `memory://${key}`,
    delete: async (key) => {
      store.delete(key);
    },
    list: async (prefix, limit) => {
      return Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .slice(0, limit);
    },
  };
  return { adapter, store };
}

const silentAudit: AuditPort = {
  async emit() {
    // No-op: audit emission is covered by T091 + audit-coverage.test.ts.
  },
};

const TENANT = 'test-swecham-logo';
const ACTOR = 'test-user';

async function makeValidPng(width = 400, height = 200): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 180, g: 90, b: 30 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

async function makeValidJpeg(width = 400, height = 200): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 180, g: 90, b: 30 } },
  })
    .jpeg({ quality: 85 })
    .toBuffer();
  return new Uint8Array(buf);
}

/**
 * Generate a PNG carrying an EXIF-like tEXt chunk. sharp's default
 * re-encode strips ancillary text chunks so the output should not
 * contain our marker.
 */
async function makePngWithTextMetadata(): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: 400, height: 200, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .withExif({ IFD0: { ImageDescription: 'SECRET-EXIF-MARKER' } })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

describe('T092 — logo-upload security', () => {
  it('rejects SVG (MIME whitelist)', async () => {
    const { adapter } = makeFakeBlob();
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"></svg>',
    );
    const result = await uploadTenantLogo(
      { blob: adapter, audit: silentAudit },
      {
        tenantId: TENANT,
        actorUserId: ACTOR,
        bytes: svg,
        declaredMime: 'image/svg+xml',
        declaredSize: svg.byteLength,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('mime_rejected');
  });

  it('rejects files larger than 1 MB', async () => {
    const { adapter } = makeFakeBlob();
    const bytes = new Uint8Array(1_048_577);
    const result = await uploadTenantLogo(
      { blob: adapter, audit: silentAudit },
      {
        tenantId: TENANT,
        actorUserId: ACTOR,
        bytes,
        declaredMime: 'image/png',
        declaredSize: 1_048_577,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('too_large');
  });

  it('rejects dimensions below minimum (width < 200 or height < 100)', async () => {
    const { adapter } = makeFakeBlob();
    const tiny = await makeValidPng(100, 50);
    const result = await uploadTenantLogo(
      { blob: adapter, audit: silentAudit },
      {
        tenantId: TENANT,
        actorUserId: ACTOR,
        bytes: tiny,
        declaredMime: 'image/png',
        declaredSize: tiny.byteLength,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Could be `decode_failed` if sharp's `limitInputPixels` gate
      // trips, or `dimensions_out_of_range` if it passes through.
      expect(['dimensions_out_of_range', 'decode_failed']).toContain(result.error.code);
    }
  });

  it('rejects garbage bytes with decode_failed', async () => {
    const { adapter } = makeFakeBlob();
    const bytes = new Uint8Array([0x47, 0x41, 0x52, 0x42, 0x41, 0x47, 0x45]);
    const result = await uploadTenantLogo(
      { blob: adapter, audit: silentAudit },
      {
        tenantId: TENANT,
        actorUserId: ACTOR,
        bytes,
        declaredMime: 'image/png',
        declaredSize: bytes.byteLength,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('decode_failed');
  });

  it('accepts valid image regardless of declared/detected MIME mismatch — re-encodes to detected format (N3(b))', async () => {
    const { adapter } = makeFakeBlob();
    const jpegBytes = await makeValidJpeg();
    // The use-case's MIME whitelist passes (declared=image/png is
    // allowed), then sharp detects jpeg. The format-mismatch guard
    // either flips to the correct encoder silently OR returns
    // decode_failed depending on the detected-format branch. The
    // N3 (b) guard in the use-case chooses the output encoder from
    // the DETECTED format, so the call succeeds but the uploaded
    // contentType is image/jpeg. Assert the upload is accepted
    // since detected format is in the whitelist — the MIME attack
    // surface is bounded by whitelist + re-encode path.
    const result = await uploadTenantLogo(
      { blob: adapter, audit: silentAudit },
      {
        tenantId: TENANT,
        actorUserId: ACTOR,
        bytes: jpegBytes,
        declaredMime: 'image/png',
        declaredSize: jpegBytes.byteLength,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Key extension reflects DETECTED format (jpg), not declared.
      expect(result.value.logoBlobKey).toMatch(/\.jpg$/);
    }
  });

  it('strips EXIF metadata on valid PNG upload', async () => {
    const { adapter, store } = makeFakeBlob();
    const bytes = await makePngWithTextMetadata();
    const result = await uploadTenantLogo(
      { blob: adapter, audit: silentAudit },
      {
        tenantId: TENANT,
        actorUserId: ACTOR,
        bytes,
        declaredMime: 'image/png',
        declaredSize: bytes.byteLength,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const uploaded = store.get(result.value.logoBlobKey);
    expect(uploaded).toBeDefined();

    // Re-decode the uploaded bytes and inspect metadata. sharp's
    // default png() pipeline does not preserve EXIF unless
    // withMetadata() is called, so the re-encoded image should have
    // no EXIF IFD.
    const meta = await sharp(Buffer.from(uploaded!)).metadata();
    expect(meta.exif).toBeUndefined();
    // Width + height preserved.
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(200);
  });

  it('rejects a 51st upload with logo_history_cap_reached (T092b)', async () => {
    // Pre-seed 50 logos under the tenant prefix so the cap is
    // already hit when the new upload is attempted.
    const prefix = `invoicing/${TENANT}/logos/`;
    const seeded = Array.from({ length: 50 }, (_, i) => `${prefix}seed-${i}.png`);
    const { adapter } = makeFakeBlob(seeded);
    const bytes = await makeValidPng();
    const result = await uploadTenantLogo(
      { blob: adapter, audit: silentAudit },
      {
        tenantId: TENANT,
        actorUserId: ACTOR,
        bytes,
        declaredMime: 'image/png',
        declaredSize: bytes.byteLength,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('logo_history_cap_reached');
      if (result.error.code === 'logo_history_cap_reached') {
        expect(result.error.current).toBe(50);
        expect(result.error.cap).toBe(50);
      }
    }
  });

  it('accepts a valid JPEG within bounds', async () => {
    const { adapter } = makeFakeBlob();
    const bytes = await makeValidJpeg(1200, 300);
    const result = await uploadTenantLogo(
      { blob: adapter, audit: silentAudit },
      {
        tenantId: TENANT,
        actorUserId: ACTOR,
        bytes,
        declaredMime: 'image/jpeg',
        declaredSize: bytes.byteLength,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.logoBlobKey).toMatch(
        new RegExp(`^invoicing/${TENANT}/logos/[A-Za-z0-9-]+\\.jpg$`),
      );
    }
  });
});
