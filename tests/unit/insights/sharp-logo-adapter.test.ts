/**
 * F9 US5 (T079/T075) — sharp logo adapter unit tests (FR-025a).
 *
 * Re-encodes PNG/JPEG/WebP, strips EXIF metadata (orientation), bounds output
 * dimensions, and rejects unsupported formats + non-image bytes. These pin the
 * safe-image-pipeline invariant the directory logo relies on.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { sharpLogoAdapter } from '@/modules/insights/infrastructure/logo/sharp-logo-adapter';

const u8 = (b: Buffer) => new Uint8Array(b);

async function makeImage(
  fmt: 'png' | 'jpeg' | 'webp' | 'tiff',
  width = 120,
  height = 80,
): Promise<Buffer> {
  const base = sharp({
    create: { width, height, channels: 3, background: { r: 12, g: 120, b: 90 } },
  });
  if (fmt === 'png') return base.png().toBuffer();
  if (fmt === 'jpeg') return base.jpeg().toBuffer();
  if (fmt === 'webp') return base.webp().toBuffer();
  return base.tiff().toBuffer();
}

describe('sharpLogoAdapter.reencode (FR-025a)', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('re-encodes %s and reports format/dims', async (fmt) => {
    const r = await sharpLogoAdapter.reencode(u8(await makeImage(fmt)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.format).toBe(fmt);
    expect(r.value.contentType).toBe(`image/${fmt}`);
    expect(r.value.width).toBe(120);
    expect(r.value.height).toBe(80);
    expect(r.value.bytes.length).toBeGreaterThan(0);
  });

  it('rejects an unsupported format (TIFF) without re-encoding', async () => {
    const r = await sharpLogoAdapter.reencode(u8(await makeImage('tiff')));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unsupported_format');
  });

  it('rejects non-image bytes with decode_failed', async () => {
    const r = await sharpLogoAdapter.reencode(new TextEncoder().encode('not an image at all'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('decode_failed');
  });

  it('bounds output dimensions to ≤ 800px (never enlarges aspect)', async () => {
    const r = await sharpLogoAdapter.reencode(u8(await makeImage('png', 2000, 1500)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.width).toBeLessThanOrEqual(800);
    expect(r.value.height).toBeLessThanOrEqual(800);
    expect(r.value.width).toBe(800); // 2000×1500 → fit inside 800 → 800×600
    expect(r.value.height).toBe(600);
  });

  it('strips EXIF orientation metadata on re-encode', async () => {
    const withExif = await sharp({
      create: { width: 100, height: 60, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    // sanity: the input carries EXIF orientation
    expect((await sharp(withExif).metadata()).orientation).toBe(6);

    const r = await sharpLogoAdapter.reencode(u8(withExif));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const outMeta = await sharp(Buffer.from(r.value.bytes)).metadata();
    expect(outMeta.orientation).toBeUndefined(); // EXIF stripped
  });
});
