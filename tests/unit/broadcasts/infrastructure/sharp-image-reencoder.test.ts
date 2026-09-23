/**
 * F119 review finding F2-3 — the sharp `ImageReencoderPort` adapter.
 *
 * An inline E-Blast image is served from a PUBLIC, unauthenticated blob URL to
 * every recipient. A photo off a phone carries an EXIF block with GPS
 * co-ordinates, the capture time and the device serial — the member's office
 * location, published. These cases prove the strip is real against actual
 * libvips output, not asserted against a fake.
 *
 * Fixtures are built in-process with sharp (a few hundred bytes each) rather
 * than committed, so nothing binary enters the repo and the EXIF payload is
 * visible in the test that depends on it.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { sharpImageReencoder } from '@/modules/broadcasts/infrastructure/sharp-image-reencoder';

/** libvips carries the GPS tags in IFD3; sharp's `withExif` keys by IFD. */
const GPS_BANGKOK = {
  GPSLatitudeRef: 'N',
  GPSLatitude: '13/1 45/1 0/1',
  GPSLongitudeRef: 'E',
  GPSLongitude: '100/1 30/1 0/1',
};

async function jpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 24, height: 16, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .withExif({ IFD0: { Copyright: 'SweCham-Secret-Office', Make: 'ACME-Phone' }, IFD3: GPS_BANGKOK })
    .jpeg()
    .toBuffer();
}

describe('sharpImageReencoder — EXIF / GPS strip', () => {
  it('a JPEG carrying EXIF + GPS is re-encoded WITHOUT the metadata', async () => {
    const input = await jpegWithExif();
    // Guard the fixture itself: if sharp ever stops writing EXIF here, the
    // assertion below would pass for the wrong reason.
    expect((await sharp(input).metadata()).exif).toBeDefined();
    expect(input.includes(Buffer.from('SweCham-Secret-Office'))).toBe(true);

    const r = await sharpImageReencoder.reencode(new Uint8Array(input), 'image/jpeg');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const out = Buffer.from(r.value.bytes);
    expect((await sharp(out).metadata()).exif).toBeUndefined();
    expect(out.includes(Buffer.from('SweCham-Secret-Office'))).toBe(false);
    expect(out.includes(Buffer.from('ACME-Phone'))).toBe(false);
    // The GPS rationals are binary, so assert on the absence of the whole
    // EXIF block plus the APP1/Exif marker rather than on a decoded value.
    expect(out.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
    expect(r.value.mime).toBe('image/jpeg');
  });

  it('the picture survives: same dimensions, still a decodable JPEG', async () => {
    const r = await sharpImageReencoder.reencode(new Uint8Array(await jpegWithExif()), 'image/jpeg');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const meta = await sharp(Buffer.from(r.value.bytes)).metadata();
    expect(meta.format).toBe('jpeg');
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 24, height: 16 });
  });

  it('a PNG round-trips as a PNG and keeps its pixels', async () => {
    const input = await sharp({ create: { width: 10, height: 8, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } })
      .png()
      .toBuffer();
    const r = await sharpImageReencoder.reencode(new Uint8Array(input), 'image/png');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const meta = await sharp(Buffer.from(r.value.bytes)).metadata();
    expect(meta.format).toBe('png');
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 10, height: 8 });
  });

  it('an animated GIF keeps ALL its frames (a silently-frozen banner is a regression, not a strip)', async () => {
    // A hand-written minimal GIF89a: 1x1, two frames, 100 ms apart. Written by
    // hand rather than by sharp because sharp cannot easily EMIT a multi-page
    // GIF from `create`, and because a fixture the adapter did not produce is
    // the one worth testing. Bytes: header · logical screen + 2-colour GCT ·
    // (GCE · image descriptor · 2-bit LZW frame) × 2 · trailer.
    const animatedGif = Buffer.from(
      '47494638396101000100800000000000ffffff' + // GIF89a, 1x1, GCT {black,white}
        '21f904040a0000002c00000000010001000002024401' + '00' + // frame 1
        '21f904040a0000002c00000000010001000002024c01' + '00' + // frame 2
        '3b', // trailer
      'hex',
    );
    expect((await sharp(animatedGif, { animated: true }).metadata()).pages).toBe(2);
    // The control that makes this test discriminate: decode WITHOUT
    // `{ animated: true }` and the second frame is silently lost.
    const naive = await sharp(animatedGif).gif().toBuffer();
    expect((await sharp(naive, { animated: true }).metadata()).pages).toBe(1);

    const r = await sharpImageReencoder.reencode(new Uint8Array(animatedGif), 'image/gif');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const outMeta = await sharp(Buffer.from(r.value.bytes), { animated: true }).metadata();
    expect(outMeta.format).toBe('gif');
    expect(outMeta.pages).toBe(2);
  });

  it('bytes that are not an image at all are refused (fail-closed — we cannot strip what we cannot decode)', async () => {
    const r = await sharpImageReencoder.reencode(new Uint8Array(Buffer.from('MZ\x90\x00 not an image')), 'image/png');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('decode_failed');
    expect(r.error.reason.length).toBeLessThanOrEqual(201);
  });

  it('a JPEG declared as image/png is refused — the declared type drives the blob key and the mail client', async () => {
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .jpeg()
      .toBuffer();
    const r = await sharpImageReencoder.reencode(new Uint8Array(jpeg), 'image/png');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('decode_failed');
    expect(r.error.reason).toContain('image/png');
  });
});
