/**
 * #739 B3a — `renderAndUploadPdf` hands its callers a closed failure code,
 * `<step>:<ErrClass>`, never the thrown text. The reason reaches
 * `invoices.receipt_pdf_last_error`, `notifications_outbox.last_error` and
 * the `pdf_render_permanently_failed` audit row, and a drizzle error's
 * message quotes bound parameters (emails, names).
 */
import { describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logger';
import { renderAndUploadPdf } from '@/modules/invoicing/application/lib/render-and-upload';

class Wrapped extends Error {
  constructor(
    readonly kind: string,
    readonly reason: string,
  ) {
    super(kind);
  }
}

function deps(over: { render?: () => Promise<never>; upload?: () => Promise<never> }) {
  return {
    pdfRender: { render: vi.fn(over.render ?? (async () => ({ bytes: new Uint8Array([1]), sha256: 'x' }))) },
    blob: { uploadPdf: vi.fn(over.upload ?? (async () => ({}))) },
  } as unknown as Parameters<typeof renderAndUploadPdf>[0];
}

const input = { renderInput: {} as never, blobKey: 'k.pdf' };
const wrap = (kind: string, reason: string) => new Wrapped(kind, reason);

async function caught(p: Promise<unknown>): Promise<Wrapped> {
  try {
    await p;
  } catch (e) {
    return e as Wrapped;
  }
  throw new Error('expected a throw');
}

describe('renderAndUploadPdf failure reason (#739)', () => {
  it('a render failure is render:<ErrClass>, with no error text', async () => {
    class DrizzleQueryError extends Error {}
    const e = await caught(
      renderAndUploadPdf(
        deps({ render: async () => { throw new DrizzleQueryError('params: a@b.example'); } }),
        input,
        wrap,
      ),
    );
    expect(e.kind).toBe('pdf_render_failed');
    expect(e.reason).toBe('render:DrizzleQueryError');
  });

  it('an upload failure is upload:<ErrClass>', async () => {
    const e = await caught(
      renderAndUploadPdf(deps({ upload: async () => { throw new TypeError('a@b.example'); } }), input, wrap),
    );
    expect(e.kind).toBe('blob_upload_failed');
    expect(e.reason).toBe('upload:TypeError');
  });

  it('a prefix joins the step with an underscore, so the code stays one token', async () => {
    const e = await caught(
      renderAndUploadPdf(
        deps({ render: async () => { throw new Error('x'); } }),
        { ...input, reasonPrefix: 'annotation' },
        wrap,
      ),
    );
    expect(e.reason).toBe('annotation_render:Error');
  });

  it('a thrown non-Error is the unknown class', async () => {
    const e = await caught(
      renderAndUploadPdf(deps({ upload: async () => { throw 'a@b.example'; } }), input, wrap),
    );
    expect(e.reason).toBe('upload:unknown');
  });

  it('keeps a token-shaped code (SQLSTATE or errno) so the 10-year audit keeps the cause', async () => {
    const e = await caught(
      renderAndUploadPdf(
        deps({ upload: async () => { throw Object.assign(new TypeError('a@b.example'), { code: 'ECONNRESET' }); } }),
        input,
        wrap,
      ),
    );
    expect(e.reason).toBe('upload:TypeError:ECONNRESET');
  });

  it('the WARN line names the blob key, so it joins back to the invoice', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await caught(renderAndUploadPdf(deps({ render: async () => { throw new Error('x'); } }), input, wrap));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'render', blobKey: 'k.pdf', err: 'Error' }),
      'invoicing.pdf.render_and_upload_failed',
    );
    warn.mockRestore();
  });
});
