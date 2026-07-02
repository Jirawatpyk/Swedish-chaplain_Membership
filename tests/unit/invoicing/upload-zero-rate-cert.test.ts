/**
 * 088 US8 UX-B1 (T061e-2) — unit test for `uploadZeroRateCert`.
 *
 * Pins the fail-closed pipeline (MIME → size → ClamAV scan → Blob) and the
 * pipeline-order invariant: bytes are NEVER uploaded before a clean verdict
 * (FR-024). Scanner + blob + clock are mocked (no live ClamAV / Blob).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  uploadZeroRateCert,
  type UploadZeroRateCertDeps,
} from '@/modules/invoicing/application/use-cases/upload-zero-rate-cert';
import type { VirusScanVerdict } from '@/modules/invoicing/application/ports/virus-scanner-port';

const TENANT = 'test-swecham';
const INVOICE_ID = '08800000-0000-4000-8000-0000000000c1';
const FIXED_NOW = '2026-07-02T10:00:00.000Z';
const FIXED_MS = new Date(FIXED_NOW).getTime();

function makeDeps(verdict: VirusScanVerdict = { verdict: 'clean', durationMs: 5 }): {
  deps: UploadZeroRateCertDeps;
  scan: ReturnType<typeof vi.fn>;
  uploadPdf: ReturnType<typeof vi.fn>;
  uploadLogo: ReturnType<typeof vi.fn>;
} {
  const scan = vi.fn(async () => verdict);
  const uploadPdf = vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` }));
  const uploadLogo = vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` }));
  const deps: UploadZeroRateCertDeps = {
    scanner: { scan },
    blob: {
      uploadPdf,
      uploadLogo,
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    },
    clock: { nowIso: () => FIXED_NOW },
  };
  return { deps, scan, uploadPdf, uploadLogo };
}

const baseInput = {
  tenantId: TENANT,
  invoiceId: INVOICE_ID,
  filename: 'cert.pdf',
  contentType: 'application/pdf',
  bytes: Buffer.from('%PDF-1.4 fake'),
};

describe('uploadZeroRateCert — fail-closed pipeline (FR-024)', () => {
  it('clean PDF → uploads via uploadPdf + returns a tenant/invoice-scoped key', async () => {
    const { deps, scan, uploadPdf, uploadLogo } = makeDeps();
    const r = await uploadZeroRateCert(deps, baseInput);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.blobKey).toBe(
      `invoicing/${TENANT}/zero-rate-certs/${INVOICE_ID}_${FIXED_MS}.pdf`,
    );
    expect(scan).toHaveBeenCalledOnce();
    expect(uploadPdf).toHaveBeenCalledOnce();
    expect(uploadLogo).not.toHaveBeenCalled();
    // Scan ran BEFORE the upload (pipeline-order invariant).
    expect(scan.mock.invocationCallOrder[0]!).toBeLessThan(
      uploadPdf.mock.invocationCallOrder[0]!,
    );
  });

  it('clean PNG → uploads via uploadLogo with a .png key', async () => {
    const { deps, uploadLogo, uploadPdf } = makeDeps();
    const r = await uploadZeroRateCert(deps, {
      ...baseInput,
      filename: 'cert.png',
      contentType: 'image/png',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.blobKey).toMatch(/\.png$/);
    expect(uploadLogo).toHaveBeenCalledOnce();
    expect(uploadPdf).not.toHaveBeenCalled();
  });

  it('clean JPEG → uploads via uploadLogo with a .jpg key', async () => {
    const { deps, uploadLogo } = makeDeps();
    const r = await uploadZeroRateCert(deps, {
      ...baseInput,
      filename: 'cert.jpg',
      contentType: 'image/jpeg',
      bytes: Buffer.from([0xff, 0xd8, 0xff]),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.blobKey).toMatch(/\.jpg$/);
    expect(uploadLogo).toHaveBeenCalledOnce();
  });

  it('infected → zero_rate_cert_unsafe + NO storage write (bytes not persisted)', async () => {
    const { deps, uploadPdf, uploadLogo } = makeDeps({
      verdict: 'infected',
      signature: 'EICAR-Test',
      durationMs: 12,
    });
    const r = await uploadZeroRateCert(deps, baseInput);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('zero_rate_cert_unsafe');
    expect(uploadPdf).not.toHaveBeenCalled();
    expect(uploadLogo).not.toHaveBeenCalled();
  });

  it('scanner error → zero_rate_cert_scan_failed + NO storage write (fail-closed)', async () => {
    const { deps, uploadPdf } = makeDeps({
      verdict: 'error',
      reason: 'unconfigured',
      durationMs: 1,
    });
    const r = await uploadZeroRateCert(deps, baseInput);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('zero_rate_cert_scan_failed');
    expect(uploadPdf).not.toHaveBeenCalled();
  });

  it('scanner timeout → zero_rate_cert_scan_failed + NO storage write', async () => {
    const { deps, uploadPdf } = makeDeps({ verdict: 'timeout', durationMs: 50_000 });
    const r = await uploadZeroRateCert(deps, baseInput);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('zero_rate_cert_scan_failed');
    expect(uploadPdf).not.toHaveBeenCalled();
  });

  it('oversize (>5 MB) → zero_rate_cert_too_large WITHOUT scanning or storing', async () => {
    const { deps, scan, uploadPdf } = makeDeps();
    const r = await uploadZeroRateCert(deps, {
      ...baseInput,
      bytes: Buffer.alloc(5 * 1024 * 1024 + 1, 0x42),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('zero_rate_cert_too_large');
    expect(scan).not.toHaveBeenCalled();
    expect(uploadPdf).not.toHaveBeenCalled();
  });

  it('bad MIME → zero_rate_cert_invalid_mime WITHOUT scanning or storing', async () => {
    const { deps, scan, uploadPdf, uploadLogo } = makeDeps();
    const r = await uploadZeroRateCert(deps, {
      ...baseInput,
      filename: 'evil.svg',
      contentType: 'image/svg+xml',
      bytes: Buffer.from('<svg/>'),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('zero_rate_cert_invalid_mime');
    expect(scan).not.toHaveBeenCalled();
    expect(uploadPdf).not.toHaveBeenCalled();
    expect(uploadLogo).not.toHaveBeenCalled();
  });
});
