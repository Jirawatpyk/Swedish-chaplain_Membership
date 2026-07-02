/**
 * 088 US8 UX-B1 (T061e-4) — RTL test for the zero-rate cert-scan uploader.
 *
 * Rendered against the REAL en.json (a missing key would surface as
 * MISSING_MESSAGE). Covers: the native upload button; a successful upload
 * surfaces the blob key + filename to the parent; an infected upload shows a
 * role=alert error and does NOT surface a blob key; the client-side size
 * pre-check rejects >5 MB without a POST; the attached affordance + Remove.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ZeroRateCertUploader } from '@/app/(staff)/admin/invoices/_components/zero-rate-cert-uploader';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.useRealTimers();
});

function renderUploader(
  overrides: Partial<React.ComponentProps<typeof ZeroRateCertUploader>> = {},
) {
  const onUploaded = vi.fn();
  const onRemove = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ZeroRateCertUploader
        invoiceId="inv-1"
        attachedFilename={null}
        onUploaded={onUploaded}
        onRemove={onRemove}
        {...overrides}
      />
    </NextIntlClientProvider>,
  );
  return { onUploaded, onRemove };
}

function pdfFile(name = 'cert.pdf', sizeOverride?: number): File {
  const file = new File(['%PDF-1.4 fake'], name, { type: 'application/pdf' });
  if (sizeOverride !== undefined) {
    Object.defineProperty(file, 'size', { value: sizeOverride });
  }
  return file;
}

describe('ZeroRateCertUploader', () => {
  it('renders a native upload button as the primary input (≥44px)', () => {
    renderUploader();
    const btn = screen.getByRole('button', { name: /Attach certificate scan/i });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toContain('min-h-[44px]');
  });

  it('successful upload surfaces the blob key + filename via onUploaded', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ blobKey: 'invoicing/t/zero-rate-certs/inv-1_9.pdf' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { onUploaded } = renderUploader();
      const input = screen.getByLabelText(/Choose a certificate scan/i);
      fireEvent.change(input, { target: { files: [pdfFile()] } });

      await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
      expect(onUploaded).toHaveBeenCalledWith(
        'invoicing/t/zero-rate-certs/inv-1_9.pdf',
        'cert.pdf',
      );
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('/api/invoices/inv-1/zero-rate-cert-upload');
      expect(init.method).toBe('POST');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('infected upload shows a role=alert error and does NOT surface a blob key', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: { code: 'zero_rate_cert_unsafe' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { onUploaded } = renderUploader();
      const input = screen.getByLabelText(/Choose a certificate scan/i);
      fireEvent.change(input, { target: { files: [pdfFile('evil.pdf')] } });

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/virus scanner/i);
      expect(onUploaded).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('client-side size pre-check rejects a >5 MB file WITHOUT a POST', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { onUploaded } = renderUploader();
      const input = screen.getByLabelText(/Choose a certificate scan/i);
      fireEvent.change(input, {
        target: { files: [pdfFile('big.pdf', 6 * 1024 * 1024)] },
      });

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/larger than 5 MB/i);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(onUploaded).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('attached state shows the filename + Remove; Remove calls onRemove', () => {
    const { onRemove } = renderUploader({ attachedFilename: 'embassy-cert.pdf' });
    expect(screen.getByTestId('zero-rate-cert-attached')).toBeInTheDocument();
    expect(screen.getByText(/embassy-cert\.pdf/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Remove/i }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
