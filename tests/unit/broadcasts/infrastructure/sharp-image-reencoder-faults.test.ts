/**
 * ROUND-2 R-M3 + R-M4 + S-5 — the sharp re-encoder's FAULT behaviour.
 *
 * R-M3 (audit truth). Every throw out of sharp was mapped to `decode_failed`,
 * which the upload use case turns into a 415 plus a
 * `broadcast_image_unsafe { reason: 'reencode_failed' }` audit row. So a
 * libvips OOM, a missing native binding or a hung decode — all SERVER faults —
 * were recorded as the member having uploaded something unsafe. That is the
 * same audit-truth class this repo guards elsewhere: a row must not state
 * something its subject did not do.
 *
 * R-M4 / S-5 (bounds). A decode with no wall-clock bound can pin a function
 * for its whole `maxDuration`, and `.rotate()` on an ANIMATED image rotates the
 * frame STRIP — an orientation tag on an animated WebP would produce a
 * sideways, smeared banner.
 *
 * `sharp` is mocked here precisely because these branches cannot be reached
 * with real libvips on demand. The real strip, the real animation preservation
 * and the real malformed-input refusal are proven against actual libvips in
 * `sharp-image-reencoder.test.ts`; this file only covers what that one cannot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toBufferMock = vi.fn();
const rotateMock = vi.fn();
const metadataMock = vi.fn();
const sharpCtorMock = vi.fn();

vi.mock('sharp', () => ({ default: (...args: unknown[]) => sharpCtorMock(...args) }));
vi.mock('server-only', () => ({}));

/** A pipeline whose format methods all funnel into one `toBuffer`. */
function makePipeline(format: string) {
  const out = { toBuffer: toBufferMock };
  const pipeline = {
    metadata: metadataMock.mockResolvedValue({ format }),
    rotate: rotateMock,
    png: vi.fn(() => out),
    jpeg: vi.fn(() => out),
    webp: vi.fn(() => out),
    gif: vi.fn(() => out),
  };
  rotateMock.mockReturnValue(pipeline);
  return pipeline;
}

async function loadAdapter() {
  return (await import('@/modules/broadcasts/infrastructure/sharp-image-reencoder'))
    .sharpImageReencoder;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('sharpImageReencoder — fault taxonomy (R-M3)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a MALFORMED-INPUT throw stays `decode_failed` — the member really did send bytes we cannot decode', async () => {
    sharpCtorMock.mockImplementation(() => makePipeline('png'));
    toBufferMock.mockRejectedValue(
      new Error('VipsJpeg: Premature end of JPEG file'),
    );
    const adapter = await loadAdapter();

    const r = await adapter.reencode(PNG_BYTES, 'image/png');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('decode_failed');
  });

  it('a SERVER-fault throw is `reencoder_unavailable`, not a member-unsafe verdict', async () => {
    sharpCtorMock.mockImplementation(() => makePipeline('png'));
    toBufferMock.mockRejectedValue(new Error('Cannot allocate memory'));
    const adapter = await loadAdapter();

    const r = await adapter.reencode(PNG_BYTES, 'image/png');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('reencoder_unavailable');
  });

  it('a decompression bomb stays `decode_failed` — it is a refusal of the input, and must not be retried as an outage', async () => {
    sharpCtorMock.mockImplementation(() => makePipeline('png'));
    toBufferMock.mockRejectedValue(new Error('Input image exceeds pixel limit'));
    const adapter = await loadAdapter();

    const r = await adapter.reencode(PNG_BYTES, 'image/png');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('decode_failed');
  });

  it('a decode that never returns is abandoned at the timeout as `reencoder_unavailable`', async () => {
    vi.useFakeTimers();
    sharpCtorMock.mockImplementation(() => makePipeline('png'));
    toBufferMock.mockReturnValue(new Promise(() => undefined));
    const adapter = await loadAdapter();

    const pending = adapter.reencode(PNG_BYTES, 'image/png');
    await vi.advanceTimersByTimeAsync(15_000);
    const r = await pending;

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('reencoder_unavailable');
    expect(r.error.reason).toMatch(/timeout|timed out|15000/i);
  });
});

describe('sharpImageReencoder — bounds (R-M4 / S-5)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    toBufferMock.mockResolvedValue(Buffer.from([1, 2, 3]));
  });

  it('a still image is rotated so the EXIF orientation is baked in before the tag is dropped', async () => {
    sharpCtorMock.mockImplementation(() => makePipeline('jpeg'));
    const adapter = await loadAdapter();

    const r = await adapter.reencode(PNG_BYTES, 'image/jpeg');
    expect(r.ok).toBe(true);
    expect(rotateMock).toHaveBeenCalledTimes(1);
  });

  it.each(['image/gif', 'image/webp'] as const)(
    'an ANIMATED decode (%s) is NOT rotated — .rotate() turns the whole frame strip, not each frame',
    async (mime) => {
      sharpCtorMock.mockImplementation(() => makePipeline(mime === 'image/gif' ? 'gif' : 'webp'));
      const adapter = await loadAdapter();

      const r = await adapter.reencode(PNG_BYTES, mime);
      expect(r.ok).toBe(true);
      expect(rotateMock).not.toHaveBeenCalled();
    },
  );

  it('the decode-memory ceiling is 4096×4096, the house precedent from the logo adapter', async () => {
    sharpCtorMock.mockImplementation(() => makePipeline('png'));
    const adapter = await loadAdapter();

    await adapter.reencode(PNG_BYTES, 'image/png');
    const opts = sharpCtorMock.mock.calls[0]![1] as { limitInputPixels: number };
    expect(opts.limitInputPixels).toBe(4096 * 4096);
  });
});
