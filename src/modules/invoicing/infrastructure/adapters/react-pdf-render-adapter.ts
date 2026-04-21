/**
 * T046 — @react-pdf/renderer adapter (F4).
 *
 * Renders a React tree → Uint8Array + sha256. **Byte-deterministic**
 * (SC-003 / CP-5.2): runs purely from input props with a fixed date
 * string and a seeded `Math.random` stub during render (see
 * `pdf/deterministic-render.ts` for the why). Registration of
 * Sarabun fonts happens once at module-init.
 */
import { renderToStream } from '@react-pdf/renderer';
import { createHash } from 'node:crypto';
import type {
  PdfRenderPort,
  PdfRenderInput,
  PdfRenderResult,
} from '../../application/ports/pdf-render-port';
import { Sha256Hex } from '../../domain/value-objects/sha256-hex';
import { registerSarabun } from '../pdf/fonts/register-sarabun';
import { InvoiceTemplate } from '../pdf/templates/invoice-template';
import { withSeededRandom } from '../pdf/deterministic-render';
import { invoicingMetrics } from '@/lib/metrics';

registerSarabun();

async function streamToBytes(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export const reactPdfRenderAdapter: PdfRenderPort = {
  async render(input: PdfRenderInput): Promise<PdfRenderResult> {
    // T113 — `invoicing_pdf_render_duration_ms` histogram. Fires on
    // every render (invoice, receipt, credit-note, void-overlay,
    // preview) labelled by `kind` so per-template p95 regressions
    // surface without aggregating every variant into one noisy metric.
    const renderStartedAt = performance.now();
    const element = InvoiceTemplate(input);
    const bytes = await withSeededRandom(input, async () => {
      const stream = await renderToStream(element);
      return streamToBytes(stream);
    });
    // createHash('sha256').digest('hex') ALWAYS returns 64-char
    // lowercase hex by construction — `Sha256Hex.ofUnsafe` re-validates
    // as belt-and-suspenders, costs O(64) regex.
    const sha256 = Sha256Hex.ofUnsafe(createHash('sha256').update(bytes).digest('hex'));
    invoicingMetrics.pdfRenderDurationMs(
      input.kind,
      performance.now() - renderStartedAt,
    );
    return { bytes, sha256 };
  },
};
