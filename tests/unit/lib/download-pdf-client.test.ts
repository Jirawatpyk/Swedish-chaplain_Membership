/**
 * Round 6 — unit test for the shared `downloadPdf` client helper
 * (`src/lib/download-pdf-client.ts`).
 *
 * Verifies the fetch+blob+toast dance covers every documented status
 * branch from the F4 PDF routes (admin + portal). Mocks `fetch` to
 * return synthetic responses; spies on DOM APIs to verify the blob
 * URL → anchor click → revoke sequence executes for the 200 path.
 *
 * Scope covers the parity claims from R4-SF-H-A / R4-SF-H-B and the
 * R5-UX-M1 success-callback for fast-cache feedback.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { downloadPdf, type PdfDownloadDeps } from '@/lib/download-pdf-client';

/** Toast collector for assertions. */
type Capture = {
  warnings: string[];
  errors: string[];
};

function makeDeps(
  overrides?: Partial<PdfDownloadDeps>,
): { deps: PdfDownloadDeps; capture: Capture } {
  const capture: Capture = { warnings: [], errors: [] };
  const deps: PdfDownloadDeps = {
    url: 'https://example.test/api/invoices/inv-1/pdf',
    fallbackFilename: 'fallback.pdf',
    toasts: {
      forbidden: 'forbidden-msg',
      notFound: 'notFound-msg',
      unavailable: 'unavailable-msg',
      sessionExpired: 'sessionExpired-msg',
      rateLimited: 'rateLimited-msg',
      pending: 'pending-msg',
      failed: (reason) => `failed-msg:${reason}`,
    },
    toastWarning: (msg) => capture.warnings.push(msg),
    toastError: (msg) => capture.errors.push(msg),
    ...overrides,
  };
  return { deps, capture };
}

/** Build a synthetic Response with optional Content-Disposition. */
function makeResponse(
  status: number,
  init?: { body?: Blob | object; contentDisposition?: string },
): Response {
  const headers = new Headers();
  if (init?.contentDisposition !== undefined) {
    headers.set('Content-Disposition', init.contentDisposition);
  }
  if (init?.body instanceof Blob) {
    return new Response(init.body, { status, headers });
  }
  if (init?.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    return new Response(JSON.stringify(init.body), { status, headers });
  }
  return new Response(null, { status, headers });
}

describe('downloadPdf — happy path', () => {
  // jsdom is the default Vitest env in this project, so window/document
  // are present.
  // Note: spy variables typed as `any` because Vitest's MockInstance
  // signature varies by overload and the strict ReturnType<typeof vi.spyOn>
  // doesn't preserve the inferred function signature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createObjectUrlSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let revokeObjectUrlSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let appendChildSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let removeChildSpy: any;
  const FAKE_BLOB_URL = 'blob:fake-url-123';

  beforeAll(() => {
    // jsdom doesn't implement URL.createObjectURL / revokeObjectURL by
    // default — stub them on the global URL.
    if (typeof URL.createObjectURL !== 'function') {
      (URL as unknown as { createObjectURL: () => string }).createObjectURL =
        () => FAKE_BLOB_URL;
    }
    if (typeof URL.revokeObjectURL !== 'function') {
      (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL =
        () => {
          /* noop */
        };
    }
  });

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
    createObjectUrlSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue(FAKE_BLOB_URL);
    revokeObjectUrlSpy = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {
        /* noop */
      });
    appendChildSpy = vi.spyOn(document.body, 'appendChild');
    removeChildSpy = vi.spyOn(document.body, 'removeChild');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('200 → blob URL, click anchor, defer revoke 100ms', async () => {
    const blob = new Blob(['fake pdf bytes'], { type: 'application/pdf' });
    fetchSpy.mockResolvedValue(makeResponse(200, { body: blob }));
    const { deps, capture } = makeDeps();
    await downloadPdf(deps);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(deps.url);
    expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
    expect(appendChildSpy).toHaveBeenCalledTimes(1);
    expect(removeChildSpy).toHaveBeenCalledTimes(1);
    // Revoke is deferred by 100 ms via setTimeout.
    expect(revokeObjectUrlSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(revokeObjectUrlSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrlSpy).toHaveBeenCalledWith(FAKE_BLOB_URL);
    expect(capture.warnings).toEqual([]);
    expect(capture.errors).toEqual([]);
  });

  it('200 + RFC 5987 Content-Disposition decodes filename', async () => {
    const blob = new Blob(['bytes'], { type: 'application/pdf' });
    fetchSpy.mockResolvedValue(
      makeResponse(200, {
        body: blob,
        // Thai filename URL-encoded per RFC 5987.
        // Hand-construct intentional: this test exercises the
        // client-side parser against synthetic header strings the
        // `buildAttachmentContentDisposition()` helper would reject
        // (it only emits well-formed values).
        // eslint-disable-next-line no-restricted-syntax
        contentDisposition: `attachment; filename*=UTF-8''%E0%B9%83%E0%B8%9A%E0%B9%80%E0%B8%AA%E0%B8%A3%E0%B9%87%E0%B8%88.pdf`,
      }),
    );
    const { deps } = makeDeps();
    // Stub createElement to capture the anchor's `download` attribute.
    const anchor = document.createElement('a');
    const createSpy = vi.spyOn(document, 'createElement').mockReturnValue(anchor);
    await downloadPdf(deps);
    expect(anchor.download).toBe('ใบเสร็จ.pdf');
    createSpy.mockRestore();
  });

  it('200 + malformed RFC 5987 percent-encoding falls back to plain filename + logs warn', async () => {
    const blob = new Blob(['bytes'], { type: 'application/pdf' });
    fetchSpy.mockResolvedValue(
      makeResponse(200, {
        body: blob,
        // Truncated percent-escape → decodeURIComponent throws.
        // Hand-construct intentional: helper rejects malformed input;
        // we need the malformed input here to exercise the parser's
        // fallback to the plain `filename=` parameter.
        // eslint-disable-next-line no-restricted-syntax
        contentDisposition: `attachment; filename*=UTF-8''bad%E0; filename="plain.pdf"`,
      }),
    );
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* noop */
    });
    const { deps } = makeDeps();
    const anchor = document.createElement('a');
    const createSpy = vi.spyOn(document, 'createElement').mockReturnValue(anchor);
    await downloadPdf(deps);
    expect(anchor.download).toBe('plain.pdf');
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('RFC 5987 filename decode failed'),
      expect.objectContaining({ encoded: 'bad%E0' }),
    );
    createSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('200 + missing Content-Disposition → uses fallbackFilename', async () => {
    const blob = new Blob(['bytes'], { type: 'application/pdf' });
    fetchSpy.mockResolvedValue(makeResponse(200, { body: blob }));
    const { deps } = makeDeps({ fallbackFilename: 'fallback-xyz.pdf' });
    const anchor = document.createElement('a');
    const createSpy = vi.spyOn(document, 'createElement').mockReturnValue(anchor);
    await downloadPdf(deps);
    expect(anchor.download).toBe('fallback-xyz.pdf');
    createSpy.mockRestore();
  });
});

describe('downloadPdf — error branches', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('425 → toastWarning(pending) when toasts.pending is set', async () => {
    fetchSpy.mockResolvedValue(makeResponse(425));
    const { deps, capture } = makeDeps();
    await downloadPdf(deps);
    expect(capture.warnings).toEqual(['pending-msg']);
    expect(capture.errors).toEqual([]);
  });

  it('425 → falls through to unavailable when toasts.pending is undefined (invoice variant)', async () => {
    fetchSpy.mockResolvedValue(makeResponse(425));
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* noop */
    });
    const { deps, capture } = makeDeps({
      toasts: {
        forbidden: 'forbidden-msg',
        unavailable: 'unavailable-msg',
        sessionExpired: 'sessionExpired-msg',
        rateLimited: 'rateLimited-msg',
      },
    });
    await downloadPdf(deps);
    expect(capture.errors).toEqual(['unavailable-msg']);
    consoleWarnSpy.mockRestore();
  });

  it('502 with code=receipt_pdf_failed → toastError(failed(reason))', async () => {
    fetchSpy.mockResolvedValue(
      makeResponse(502, {
        body: { error: { code: 'receipt_pdf_failed', reason: 'cron-budget-exhausted' } },
      }),
    );
    const { deps, capture } = makeDeps();
    await downloadPdf(deps);
    expect(capture.errors).toEqual(['failed-msg:cron-budget-exhausted']);
  });

  it('502 with unknown error code → toastError(unavailable)', async () => {
    fetchSpy.mockResolvedValue(
      makeResponse(502, { body: { error: { code: 'something_else' } } }),
    );
    const { deps, capture } = makeDeps();
    await downloadPdf(deps);
    expect(capture.errors).toEqual(['unavailable-msg']);
  });

  it('403 → toastError(forbidden)', async () => {
    fetchSpy.mockResolvedValue(makeResponse(403));
    const { deps, capture } = makeDeps();
    await downloadPdf(deps);
    expect(capture.errors).toEqual(['forbidden-msg']);
  });

  it('404 with toasts.notFound set → toastError(notFound)', async () => {
    fetchSpy.mockResolvedValue(makeResponse(404));
    const { deps, capture } = makeDeps();
    await downloadPdf(deps);
    expect(capture.errors).toEqual(['notFound-msg']);
  });

  it('404 without toasts.notFound → falls through to unavailable', async () => {
    fetchSpy.mockResolvedValue(makeResponse(404));
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* noop */
    });
    const { deps, capture } = makeDeps({
      toasts: {
        forbidden: 'forbidden-msg',
        unavailable: 'unavailable-msg',
        sessionExpired: 'sessionExpired-msg',
        rateLimited: 'rateLimited-msg',
      },
    });
    await downloadPdf(deps);
    expect(capture.errors).toEqual(['unavailable-msg']);
    consoleWarnSpy.mockRestore();
  });

  it('401 → toastError(sessionExpired)', async () => {
    fetchSpy.mockResolvedValue(makeResponse(401));
    const { deps, capture } = makeDeps();
    await downloadPdf(deps);
    expect(capture.errors).toEqual(['sessionExpired-msg']);
  });

  it('429 → toastWarning(rateLimited)', async () => {
    fetchSpy.mockResolvedValue(makeResponse(429));
    const { deps, capture } = makeDeps();
    await downloadPdf(deps);
    expect(capture.warnings).toEqual(['rateLimited-msg']);
  });

  it('500 unmapped → toastError(unavailable) + always-on console.warn (R4-SF-H-A)', async () => {
    fetchSpy.mockResolvedValue(makeResponse(500));
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* noop */
    });
    const { deps, capture } = makeDeps();
    await downloadPdf(deps);
    expect(capture.errors).toEqual(['unavailable-msg']);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[download-pdf] unmapped status',
      expect.objectContaining({ status: 500 }),
    );
    consoleWarnSpy.mockRestore();
  });

  it('fetch throws → toastError(unavailable) + always-on console.error', async () => {
    const networkErr = new TypeError('Failed to fetch');
    fetchSpy.mockRejectedValue(networkErr);
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* noop */
    });
    const { deps, capture } = makeDeps();
    await downloadPdf(deps);
    expect(capture.errors).toEqual(['unavailable-msg']);
    expect(consoleErrSpy).toHaveBeenCalledWith(
      '[download-pdf] unexpected client error',
      expect.objectContaining({ err: networkErr }),
    );
    consoleErrSpy.mockRestore();
  });
});
